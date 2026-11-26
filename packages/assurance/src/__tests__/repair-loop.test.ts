/**
 * Comprehensive unit and live E2E integration tests for the counterexample-guided repair loop,
 * regression obligations, holdout seed pool, GAM Appendix B governance case, and the
 * RED_SIGNAL_COMPLIANCE end-to-end demonstration (FORMAL_ASSURANCE.md §2.5, §3, DESIGN_REVIEW.md Finding 8).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  APPENDIX_B_COMPONENT,
  APPENDIX_B_PROPERTY,
  AssuranceRepairOrchestrator,
  AssuranceReplanner,
  CONTROLLER_PATH,
  EvidenceLedger,
  FormalTool,
  GitWorkspace,
  HoldoutSeedPool,
  ImplementationTask,
  ImplementationWorker,
  LedgerEvidenceSink,
  Obligation,
  RED_SIGNAL_COMPONENT,
  RED_SIGNAL_PROPERTY,
  RegressionObligationStore,
  RegressionStoreIntegrityError,
  RepairTask,
  SolverAdapter,
  Verdict,
  VerificationResult,
  WorkspaceVcs,
  controllerSource,
  defaultRegressionReplayer,
  hashSpecsTree,
  runGamAppendixBGovernanceCase,
  runRedSignalDemo,
  summarizeWitness,
  z3SolverAnswer,
} from '../index';

const tmpRoots: string[] = [];
function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // ignore
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function sampleObligation(overrides: Partial<Obligation> = {}): Obligation {
  return {
    id: 'PROP_A/z3/check_envelope',
    propertyId: 'PROP_A',
    specVersion: '1.0',
    specHash: 'sha256:' + 'a'.repeat(64),
    tool: 'z3',
    artifactPath: 'specs/prop_a/envelope.py',
    assumptions: ['a1', 'a2'],
    guarantee: 'g1',
    ...overrides,
  };
}

function makeFakeResult(verdict: Verdict, extra: Partial<VerificationResult> = {}): VerificationResult {
  return {
    verdict,
    tool: extra.tool ?? 'z3',
    toolVersion: 'fake-1.0',
    assumptions: ['a1'],
    elapsedMs: 5,
    inputHash: 'sha256:' + 'b'.repeat(64),
    ...extra,
  };
}

describe('RegressionObligationStore & HoldoutSeedPool (unit)', () => {
  it('rejects store roots located inside a forbidden disposable worktree', () => {
    const worktree = makeTmp('wazir-forbidden-wt-');
    expect(
      () => new RegressionObligationStore(join(worktree, '.assurance'), { forbiddenRoots: [worktree] }),
    ).toThrow(/outside disposable worktree/);
  });

  it('persists regressions idempotently, makes files read-only, and detects tampering or deletion', () => {
    const stateDir = makeTmp('wazir-reg-store-');
    const store = new RegressionObligationStore(join(stateDir, 'store'));
    const obl = sampleObligation();

    const r1 = store.save({
      propertyId: obl.propertyId,
      specHash: obl.specHash,
      specVersion: obl.specVersion,
      tool: 'z3',
      originVerdict: Verdict.COUNTEREXAMPLE,
      originObligation: obl,
      originRevision: { label: 'rev-1', commit: '1'.repeat(40) },
      originInputHash: 'sha256:1234',
      witness: { speed_m_per_s: '2', distance_to_stopline_m: '20', red: 'True' },
      fromHoldout: false,
    });
    const r2 = store.save({
      propertyId: obl.propertyId,
      specHash: obl.specHash,
      specVersion: obl.specVersion,
      tool: 'z3',
      originVerdict: Verdict.COUNTEREXAMPLE,
      originObligation: obl,
      originRevision: { label: 'rev-1', commit: '1'.repeat(40) },
      originInputHash: 'sha256:1234',
      witness: { speed_m_per_s: '2', distance_to_stopline_m: '20', red: 'True' },
      fromHoldout: false,
    });
    expect(r1.id).toBe(r2.id);
    expect(store.count({ propertyId: obl.propertyId, specHash: obl.specHash })).toBe(1);

    // Tamper with the stored JSON file -> list() must throw RegressionStoreIntegrityError
    const recordPath = join(stateDir, 'store', 'regressions', obl.propertyId, `${r1.id}.json`);
    chmodSync(recordPath, 0o644);
    writeFileSync(recordPath, JSON.stringify({ ...r1, fromHoldout: true }, null, 2));
    expect(() => store.list()).toThrow(RegressionStoreIntegrityError);

    // Delete the file -> list() must throw RegressionStoreIntegrityError
    unlinkSync(recordPath);
    expect(() => store.list()).toThrow(RegressionStoreIntegrityError);
  });

  it('persists repair attempt budget across process restarts (Finding 8)', () => {
    const stateDir = makeTmp('wazir-budget-');
    const store1 = new RegressionObligationStore(join(stateDir, 'store'));
    expect(store1.repairAttemptsUsed('run-42')).toBe(0);
    expect(store1.consumeRepairAttempt('run-42')).toBe(1);
    expect(store1.consumeRepairAttempt('run-42')).toBe(2);

    // Re-open store from disk in a fresh instance
    const store2 = new RegressionObligationStore(join(stateDir, 'store'));
    expect(store2.repairAttemptsUsed('run-42')).toBe(2);
    const replanner = new AssuranceReplanner(store2, {
      runId: 'run-42',
      component: 'planner',
      maxRepairAttempts: 2,
      specsPath: 'specs',
    });
    const witness = summarizeWitness('z3', { x: 1 });
    const next = replanner.nextRepairTask(
      { label: 'rev-2', commit: '2'.repeat(40) },
      'sha256:spec',
      [
        {
          propertyId: 'PROP_A',
          obligationId: 'PROP_A/z3/check',
          tool: 'z3',
          verdict: Verdict.COUNTEREXAMPLE,
          revision: { label: 'rev-2', commit: '2'.repeat(40) },
          regressionId: 'reg-1',
          fromHoldout: false,
          witness,
        },
      ],
    );
    expect(next).toBeNull();
  });

  it('draws deterministic fresh holdout seeds and never reuses disclosed or previously drawn seeds', () => {
    const stateDir = makeTmp('wazir-holdout-');
    const store = new RegressionObligationStore(join(stateDir, 'store'));
    const pool = new HoldoutSeedPool(store, 'PROP_A', 'sha256:spec_v1');

    pool.disclose([7, 42]);
    const batch1 = pool.draw(3);
    expect(batch1).toHaveLength(3);
    expect(batch1).not.toContain(7);
    expect(batch1).not.toContain(42);

    const batch2 = pool.draw(3);
    expect(batch2).toHaveLength(3);
    for (const s of batch2) {
      expect(batch1).not.toContain(s);
    }

    // Re-instantiating pool from the same store still remembers all used seeds
    const poolAgain = new HoldoutSeedPool(store, 'PROP_A', 'sha256:spec_v1');
    const batch3 = poolAgain.draw(2);
    for (const s of batch3) {
      expect([...batch1, ...batch2, 7, 42]).not.toContain(s);
    }
  });
});

describe('AssuranceRepairOrchestrator mechanics (unit)', () => {
  function initWorkspaceWithSpec(): { ws: GitWorkspace; wsDir: string; store: RegressionObligationStore } {
    const root = makeTmp('wazir-orch-');
    const wsDir = join(root, 'ws');
    const storeDir = join(root, 'state');
    const ws = GitWorkspace.init(wsDir);
    mkdirSync(join(wsDir, 'specs', 'prop_a'), { recursive: true });
    writeFileSync(join(wsDir, 'specs', 'prop_a', 'manifest.yaml'), 'id: PROP_A\nversion: "1.0"\n');
    ws.commitAll('initial spec', 'rev-0-spec');
    const store = new RegressionObligationStore(storeDir, { forbiddenRoots: [wsDir] });
    return { ws, wsDir, store };
  }

  it('rejects spec tampering if a worker modifies files under specs/ during implementation or repair', async () => {
    const { ws, wsDir, store } = initWorkspaceWithSpec();
    const specsBefore = hashSpecsTree(join(wsDir, 'specs'));

    const tamperingWorker: ImplementationWorker = {
      async run(_task: ImplementationTask | RepairTask, workspace: WorkspaceVcs) {
        const gws = workspace as GitWorkspace;
        // Bypass read-only mode to simulate a malicious worker chmodding specs/
        chmodSync(join(gws.dir, 'specs', 'prop_a'), 0o755);
        chmodSync(join(gws.dir, 'specs', 'prop_a', 'manifest.yaml'), 0o644);
        writeFileSync(join(gws.dir, 'specs', 'prop_a', 'manifest.yaml'), 'id: PROP_A\nversion: "1.0-weakened"\n');
        gws.commitAll('tamper spec', 'rev-1-tampered');
        return { label: 'rev-1-tampered' };
      },
    };

    const orchestrator = new AssuranceRepairOrchestrator({
      runId: 'tamper-run',
      component: 'comp',
      workspace: ws,
      worker: tamperingWorker,
      adapters: {},
      planObligations: () => [sampleObligation()],
      regressionStore: store,
    });

    const report = await orchestrator.run({
      kind: 'implementation',
      id: 'impl-1',
      component: 'comp',
      prompt: 'implement comp',
    });

    expect(report.outcome).toBe('spec_tampered');
    expect(report.specsHash).toBe(specsBefore);
    expect(report.iterations).toHaveLength(0);
  });

  it('stops after maxRepairAttempts (k) when counterexamples persist and reports exhausted', async () => {
    const { ws, store } = initWorkspaceWithSpec();
    const alwaysBuggyWorker: ImplementationWorker = {
      async run(task, workspace) {
        const gws = workspace as GitWorkspace;
        mkdirSync(join(gws.dir, 'src'), { recursive: true });
        const label = task.kind === 'implementation' ? 'rev-1-buggy' : `rev-${task.attempt + 1}-still-buggy`;
        writeFileSync(join(gws.dir, 'src', 'impl.py'), `# ${label}\n`);
        gws.commitAll(label, label);
        return { label };
      },
    };

    const failingZ3: SolverAdapter = {
      tool: 'z3',
      checkAvailability: async () => ({ available: true, version: '4.13.0' }),
      verify: async (obl) =>
        makeFakeResult(Verdict.COUNTEREXAMPLE, {
          witness: { speed_m_per_s: '3', distance_to_stopline_m: '25', red: 'True' },
          assumptions: obl.assumptions,
        }),
    };

    const orchestrator = new AssuranceRepairOrchestrator({
      runId: 'exhaust-run',
      component: 'comp',
      workspace: ws,
      worker: alwaysBuggyWorker,
      adapters: { z3: failingZ3 },
      planObligations: () => [sampleObligation()],
      regressionStore: store,
      maxRepairAttempts: 2,
    });

    const report = await orchestrator.run({
      kind: 'implementation',
      id: 'impl-1',
      component: 'comp',
      prompt: 'implement',
    });

    expect(report.outcome).toBe('exhausted');
    expect(report.repairAttempts).toBe(2);
    expect(report.revisions.map((r) => r.label)).toEqual([
      'rev-1-buggy',
      'rev-2-still-buggy',
      'rev-3-still-buggy',
    ]);
    // Same witness recurring does not duplicate the regression obligation
    expect(report.regressionObligations).toBe(1);
  });

  it('turns a holdout seed FALSIFIED verdict into a permanent regression and re-enters repair with fresh seeds next time', async () => {
    const { ws, store } = initWorkspaceWithSpec();
    const worker: ImplementationWorker = {
      async run(task, workspace) {
        const gws = workspace as GitWorkspace;
        mkdirSync(join(gws.dir, 'src'), { recursive: true });
        const label = task.kind === 'implementation' ? 'rev-1-overfit' : 'rev-2-generalized';
        writeFileSync(join(gws.dir, 'src', 'impl.py'), `REV = "${label}"\n`);
        gws.commitAll(label, label);
        return { label };
      },
    };

    let holdoutCall = 0;
    const verifaiAdapter: SolverAdapter = {
      tool: 'verifai',
      checkAvailability: async () => ({ available: true, version: '2.3.0' }),
      verify: async (obl, workspaceRev) => {
        const isHoldout = Boolean((obl.metadata as { holdout?: boolean } | undefined)?.holdout);
        if (workspaceRev === 'rev-1-overfit' && isHoldout) {
          holdoutCall++;
          return makeFakeResult(Verdict.FALSIFIED, {
            tool: 'verifai',
            seed: obl.seed,
            witness: {
              seed: obl.seed,
              sampleIndex: 4,
              rho: -1.25,
              params: { v0: 12, d0: 45 },
              trace: [{ t: 0, position_m: 55 }],
              holdout: true,
            },
          });
        }
        return makeFakeResult(Verdict.NOT_FALSIFIED, { tool: 'verifai', seed: obl.seed });
      },
    };

    const z3Adapter: SolverAdapter = {
      tool: 'z3',
      checkAvailability: async () => ({ available: true, version: '4.13.0' }),
      verify: async () => makeFakeResult(Verdict.PROVED, { tool: 'z3' }),
    };

    const orchestrator = new AssuranceRepairOrchestrator({
      runId: 'holdout-run',
      component: 'comp',
      workspace: ws,
      worker,
      adapters: { z3: z3Adapter, verifai: verifaiAdapter },
      planObligations: () => [
        sampleObligation(),
        sampleObligation({
          id: 'PROP_A/verifai/sim',
          tool: 'verifai',
          seed: 11,
          metadata: { samples: 10, holdoutSeeds: [] },
        }),
      ],
      regressionStore: store,
      regressionReplayers: { verifai: defaultRegressionReplayer },
      holdout: { seedsPerCheck: 2 },
    });

    const report = await orchestrator.run({
      kind: 'implementation',
      id: 'impl-1',
      component: 'comp',
      prompt: 'implement',
    });

    expect(holdoutCall).toBe(1);
    expect(report.outcome).toBe('passed');
    expect(report.repairAttempts).toBe(1);
    expect(report.witnesses).toHaveLength(1);
    expect(report.witnesses[0].fromHoldout).toBe(true);
    expect(report.regressionObligations).toBe(1);
    // 2 holdout seeds drawn on rev-1-overfit + 2 fresh holdout seeds drawn on rev-2-generalized = 4 distinct seeds
    expect(new Set(report.holdoutSeedsUsed).size).toBe(4);
  });

  it('rejects NOT_FALSIFIED-only obligation sets from returning outcome: passed (requires evaluateReleaseGate PASS with PROVED or BOUNDED_PASS)', async () => {
    const { ws, store } = initWorkspaceWithSpec();
    const worker: ImplementationWorker = {
      async run(_task, workspace) {
        const gws = workspace as GitWorkspace;
        mkdirSync(join(gws.dir, 'src'), { recursive: true });
        writeFileSync(join(gws.dir, 'src', 'impl.py'), 'REV = "rev-1"\n');
        gws.commitAll('rev-1', 'rev-1');
        return { label: 'rev-1' };
      },
    };

    const verifaiOnlyAdapter: SolverAdapter = {
      tool: 'verifai',
      checkAvailability: async () => ({ available: true, version: '2.3.0' }),
      verify: async (obl) => makeFakeResult(Verdict.NOT_FALSIFIED, { tool: 'verifai', seed: obl.seed }),
    };

    const orchestrator = new AssuranceRepairOrchestrator({
      runId: 'not-falsified-only-run',
      component: 'comp',
      workspace: ws,
      worker,
      adapters: { verifai: verifaiOnlyAdapter },
      planObligations: () => [
        sampleObligation({
          id: 'PROP_A/verifai/sim_only',
          tool: 'verifai',
          seed: 5,
          metadata: { samples: 10, holdoutSeeds: [] },
        }),
      ],
      regressionStore: store,
      holdout: { seedsPerCheck: 2 },
    });

    const report = await orchestrator.run({
      kind: 'implementation',
      id: 'impl-nf-only',
      component: 'comp',
      prompt: 'implement',
    });

    expect(report.outcome).toBe('blocked');
    expect(report.reason).toMatch(/only NOT_FALSIFIED/i);
  });
});

describe('GAM Appendix B governance case (unit + built-in engine)', () => {
  it('detects COUNTEREXAMPLE on as-built Appendix B and BOUNDED_PASS on remediated Appendix B with verified ledger and PASS release gate', async () => {
    const res = await runGamAppendixBGovernanceCase();
    expect(res.failures).toEqual([]);
    expect(res.passed).toBe(true);
    expect(res.asBuiltRun.result.verdict).toBe(Verdict.COUNTEREXAMPLE);
    expect(res.remediatedRun.result.verdict).toBe(Verdict.BOUNDED_PASS);
    expect(res.ledgerVerified).toBe(true);
    expect(res.recordValidation.valid).toBe(true);
    expect(res.record.component).toBe(APPENDIX_B_COMPONENT);
    expect(res.record.properties[APPENDIX_B_PROPERTY].specification_consistency).toBe(Verdict.BOUNDED_PASS);
    expect(res.record.release_gate.status).toBe('PASS');
  });
});

const hasLiveAssuranceTools = existsSync(resolve(process.cwd(), 'tools/z3-venv/bin/python3'));
describe.skipIf(!hasLiveAssuranceTools)('RED_SIGNAL_COMPLIANCE end-to-end demonstration (live tools)', () => {
  it(
    'runs the full counterexample-guided repair loop, regression replay, holdout seeds, negative controls, GAM Appendix B, ledger verification, and AssuranceRecord validation',
    async () => {
      const logs: string[] = [];
      const result = await runRedSignalDemo({
        verifaiSamples: 25,
        holdoutSeedsPerCheck: 2,
        includeGamAppendixB: true,
        log: (line) => logs.push(line),
      });

      expect(result.failures).toEqual([]);
      expect(result.passed).toBe(true);

      // 1. Live tools available
      for (const tool of ['z3', 'alloy', 'dafny', 'verifai'] as FormalTool[]) {
        expect(result.tools[tool]?.available).toBe(true);
      }

      // 2. rev-1-buggy -> Z3 COUNTEREXAMPLE with speed_m_per_s, distance_to_stopline_m, red=True
      expect(result.loop.revisions.map((r) => r.label)).toEqual(['rev-1-buggy', 'rev-2-repaired']);
      expect(result.initialZ3Counterexample).toBeDefined();
      expect(result.initialZ3Counterexample!.result.verdict).toBe(Verdict.COUNTEREXAMPLE);
      const z3Witness = result.initialZ3Counterexample!.result.witness as Record<string, unknown>;
      expect(z3Witness).toBeDefined();
      expect(z3Witness).toHaveProperty('speed_m_per_s');
      expect(z3Witness).toHaveProperty('distance_to_stopline_m');
      expect(String(z3Witness.red).toLowerCase()).toBe('true');

      // 3. Permanent regression obligation saved & repair task filed with witness
      expect(result.loop.regressionObligations).toBeGreaterThanOrEqual(1);
      const firstIteration = result.loop.iterations[0];
      expect(firstIteration.repairTask).toBeDefined();
      expect(firstIteration.repairTask!.witnesses.length).toBeGreaterThanOrEqual(1);
      expect(firstIteration.repairTask!.prompt).toContain(RED_SIGNAL_PROPERTY);

      // 4. Specs frozen and unchanged before and after repair
      expect(result.specsUnchanged).toBe(true);
      expect(result.specsHashBefore).toBe(result.specsHashAfter);

      // 5. Final revision (rev-2-repaired) obligations all pass
      expect(result.finalVerdicts[`${RED_SIGNAL_PROPERTY}/alloy/NoCrossOnRed`]).toBe(Verdict.BOUNDED_PASS);
      expect([Verdict.PROVED, Verdict.BOUNDED_PASS]).toContain(
        result.finalVerdicts[`${RED_SIGNAL_PROPERTY}/z3/stopping_envelope`],
      );
      const finalZ3 = result.loop.iterations.at(-1)?.runs.find((r) => r.kind === 'spec' && r.obligation.tool === 'z3');
      expect(z3SolverAnswer(finalZ3)).toBe('unsat');
      expect(result.finalVerdicts[`${RED_SIGNAL_PROPERTY}/dafny/stop_command`]).toBe(Verdict.PROVED);
      expect(result.finalVerdicts[`${RED_SIGNAL_PROPERTY}/verifai/red_signal_monitor`]).toBe(Verdict.NOT_FALSIFIED);
      expect(result.finalVerdicts[`${RED_SIGNAL_PROPERTY}/verifai/red_signal_monitor:holdout`]).toBe(
        Verdict.NOT_FALSIFIED,
      );

      // Saved regression re-ran and passed on rev-2-repaired
      const finalRegressions = result.loop.iterations.at(-1)?.runs.filter((r) => r.kind === 'regression') ?? [];
      expect(finalRegressions.length).toBeGreaterThanOrEqual(1);
      for (const regRun of finalRegressions) {
        expect([Verdict.PROVED, Verdict.BOUNDED_PASS, Verdict.NOT_FALSIFIED]).toContain(regRun.result.verdict);
      }

      // 6. Negative controls (NoCrossOnRedMutant in Alloy and --candidate mutant in Z3) both fail with COUNTEREXAMPLE
      expect(result.negativeControls).toHaveLength(2);
      for (const nc of result.negativeControls) {
        expect(nc.ok).toBe(true);
        expect(nc.run.result.verdict).toBe(Verdict.COUNTEREXAMPLE);
      }

      // 7. GAM Appendix B also passed
      expect(result.gamAppendixB).toBeDefined();
      expect(result.gamAppendixB!.passed).toBe(true);

      // 8. Hash-chained EvidenceLedger verified & AssuranceRecord schema-validated with release_gate: PASS
      expect(result.ledgerVerified).toBe(true);
      expect(result.ledgerEntries).toBeGreaterThan(6);
      expect(result.recordValidation.valid).toBe(true);
      expect(result.record.component).toBe(RED_SIGNAL_COMPONENT);
      expect(result.record.release_gate.status).toBe('PASS');
      expect(result.record.counterexamples_found).toBeGreaterThanOrEqual(1);
      expect(result.record.regression_obligations).toBeGreaterThanOrEqual(1);
    },
    180_000,
  );
});
