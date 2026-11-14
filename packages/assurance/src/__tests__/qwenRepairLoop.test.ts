/**
 * A083 — WFA Counterexample-Guided Repair Loop Compatibility with `WazirQwenAgent`
 *
 * Verifies:
 *  1. `WazirQwenAgent` drives `@wazir/assurance`'s `AssuranceRepairOrchestrator`:
 *     - Revision 1 has an implementation bug caught by a `SolverAdapter` returning
 *       `Verdict.COUNTEREXAMPLE` with a concrete witness;
 *     - `WazirQwenAgent` inspects the witness, reads & fixes `src/controller.ts` via
 *       3-stage `edit` without touching `specs/`, reaching `Verdict.BOUNDED_PASS` +
 *       `Verdict.PROVED` on Revision 2.
 *  2. `SPEC_WRITE_FENCE` (`specs/**`) via `PolicyEngine` (`SPEC_WRITE_FENCE_RULE`) and
 *     `hashSpecsTree` / `SpecTamperError` / `specWriteFenceBlocker` deterministically
 *     block and fail closed if a rogue model turn attempts `edit`, `multi_edit`, `write`,
 *     or `shell` writes against `specs/safety.als`.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('@wazir/core', () => import('../../../core/src/index.js'));

import {
  PolicyEngine,
  type AgentRuntime,
  type AgentTurn,
  type ChatMessage,
} from '../../../core/src/index.js';
import {
  SPEC_WRITE_FENCE_BLOCKER,
  SPEC_WRITE_FENCE_RULE,
  specWriteFenceBlocker,
} from '../../../core/src/services/policyEngine.js';
import { WazirQwenAgent } from '../../../agents/src/qwenCore/wazirQwenAgent.js';
import { ToolRegistry, defaultTools, executeTool } from '../../../tools/src/registry.js';
import {
  AssuranceRepairOrchestrator,
  EvidenceLedger,
  GitWorkspace,
  LedgerEvidenceSink,
  RegressionObligationStore,
  SpecTamperError,
  Verdict,
  hashSpecsTree,
  type FormalTool,
  type ImplementationTask,
  type ImplementationWorker,
  type Obligation,
  type RepairTask,
  type SolverAdapter,
  type VerificationResult,
  type WorkspaceVcs,
} from '../index.js';

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      chmodSync(dir, 0o755);
      chmodSync(join(dir, 'specs'), 0o755);
    } catch {
      // best effort cleanup
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

async function drainTurns(iter: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const turns: AgentTurn[] = [];
  for await (const turn of iter) {
    turns.push(turn);
  }
  return turns;
}

function createPolicyGovernedRuntime(options: {
  projectRoot: string;
  executionId: string;
  role: 'implementation' | 'repair' | 'verification' | 'spec-author';
  generate: AgentRuntime['generate'];
  deniedCalls?: Array<{ tool: string; rule: string; reasons: string[] }>;
}): { runtime: AgentRuntime; policyEngine: PolicyEngine } {
  const registry = new ToolRegistry(
    defaultTools.filter((t) =>
      ['read', 'read_many_files', 'write', 'edit', 'multi_edit', 'search', 'glob', 'shell'].includes(
        t.descriptor.name,
      ),
    ),
  );
  const policyEngine = new PolicyEngine({
    projectRoot: options.projectRoot,
    networkAllowed: false,
  });
  policyEngine.registerSpecFence(options.executionId, { role: options.role });

  const runtime: AgentRuntime = {
    tools: registry.forModel(),
    runtimeCapabilities: { nativeToolCalling: true },
    generate: options.generate,
    async executeTool(name, input) {
      const decision = await policyEngine.authorize({
        tool: name,
        input,
        executionId: options.executionId,
        projectRoot: options.projectRoot,
      });
      if (decision.decision !== 'allow') {
        options.deniedCalls?.push({
          tool: name,
          rule: decision.rule,
          reasons: decision.reasons,
        });
        return {
          ok: false,
          output: '',
          error: `POLICY_DENIED (${decision.rule}): ${decision.reasons.join('; ')}`,
          failureClass: 'POLICY_DENIED',
          durationMs: 0,
        };
      }
      return executeTool(registry, name, input, {
        projectRoot: options.projectRoot,
        executionId: options.executionId,
        policyEngine,
      });
    },
  };

  return { runtime, policyEngine };
}

describe('A083 — WazirQwenAgent + @wazir/assurance Counterexample-Guided Repair Loop', () => {
  it('1. Repairs a Revision-1 COUNTEREXAMPLE witness via 3-stage edit on src/controller.ts without touching specs/, reaching BOUNDED_PASS + PROVED on Revision 2', async () => {
    const root = makeTempDir('wazir-qwen-wfa-ok-');
    const wsDir = join(root, 'worktree');
    const storeDir = join(root, 'regression-store');
    const ledgerPath = join(root, 'ledger', 'evidence.jsonl');

    const ws = GitWorkspace.init(wsDir);
    mkdirSync(join(wsDir, 'specs'), { recursive: true });
    mkdirSync(join(wsDir, 'src'), { recursive: true });

    const safetySpec = [
      'module safety',
      'sig ControllerState { distance: Int, stoppingDistance: Int, brakeApplied: Bool }',
      'assert SafeBraking {',
      '  all s: ControllerState | s.distance <= s.stoppingDistance implies s.brakeApplied = True',
      '}',
      'check SafeBraking for 6',
      '',
    ].join('\n');
    writeFileSync(join(wsDir, 'specs', 'safety.als'), safetySpec, 'utf8');
    writeFileSync(
      join(wsDir, 'specs', 'manifest.yaml'),
      'id: SAFE_BRAKING\nversion: "1.0"\nstatus: approved\n',
      'utf8',
    );
    ws.commitAll('initial frozen safety spec', 'rev-0-spec');

    const initialSpecsHash = hashSpecsTree(join(wsDir, 'specs'));
    const store = new RegressionObligationStore(storeDir, { forbiddenRoots: [wsDir] });
    const ledger = new EvidenceLedger(ledgerPath);
    const sink = new LedgerEvidenceSink(ledger);

    const agent = new WazirQwenAgent({ maxTurns: 10, maxRepairCycles: 2 });
    const observedRepairPrompts: string[] = [];

    const qwenWorker: ImplementationWorker = {
      async run(task: ImplementationTask | RepairTask, workspace: WorkspaceVcs) {
        const gws = workspace as GitWorkspace;
        const execId = `exec-${task.id}`;
        const role = task.kind === 'repair' ? 'repair' : 'implementation';

        if (task.kind === 'implementation') {
          let turn = 0;
          const { runtime } = createPolicyGovernedRuntime({
            projectRoot: gws.dir,
            executionId: execId,
            role,
            async *generate() {
              turn += 1;
              if (turn === 1) {
                // Revision 1: writes buggy margin `stoppingDistance - 2` (misses distance in [stoppingDistance-1, stoppingDistance])
                yield {
                  type: 'tool_call',
                  toolCallId: 'impl_write_1',
                  toolName: 'write',
                  toolInput: {
                    path: 'src/controller.ts',
                    content: [
                      'export interface BrakingInput {',
                      '  distance: number;',
                      '  stoppingDistance: number;',
                      '}',
                      '',
                      'export function shouldApplyBrake(input: BrakingInput): boolean {',
                      '  if (input.distance <= input.stoppingDistance - 2) {',
                      '    return true;',
                      '  }',
                      '  return false;',
                      '}',
                      '',
                    ].join('\n'),
                  },
                };
                yield { type: 'completed', finishReason: 'tool_calls' };
              } else {
                yield { type: 'token', content: 'Implemented initial shouldApplyBrake controller.' };
                yield { type: 'completed', finishReason: 'stop' };
              }
            },
          });

          const turns = await drainTurns(
            agent.run(
              {
                modelId: 'qwen3-coder',
                taskDescription: task.prompt,
                taskType: 'coding',
                projectRoot: gws.dir,
              },
              runtime,
            ),
          );
          expect(turns.at(-1)?.kind).toBe('done');
          gws.commitAll('rev-1: initial buggy controller');
          return { label: 'rev-1-buggy' };
        }

        // Repair task: WazirQwenAgent receives concrete counterexample witness in task.prompt
        observedRepairPrompts.push(task.prompt);
        let turn = 0;
        const seenMessages: ChatMessage[][] = [];

        const { runtime } = createPolicyGovernedRuntime({
          projectRoot: gws.dir,
          executionId: execId,
          role,
          async *generate(req) {
            turn += 1;
            seenMessages.push(structuredClone(req.messages));
            if (turn === 1) {
              // Parallel read of both frozen spec (read-only allowed!) and buggy controller
              yield {
                type: 'tool_call',
                toolCallId: 'rep_read_spec',
                toolName: 'read',
                toolInput: { path: 'specs/safety.als' },
              };
              yield {
                type: 'tool_call',
                toolCallId: 'rep_read_ctrl',
                toolName: 'read',
                toolInput: { path: 'src/controller.ts' },
              };
              yield { type: 'completed', finishReason: 'tool_calls' };
            } else if (turn === 2) {
              // Fix controller using 3-stage edit (with shifted indentation exercising Stage 2 line_trimmed)
              yield {
                type: 'tool_call',
                toolCallId: 'rep_edit_ctrl',
                toolName: 'edit',
                toolInput: {
                  path: 'src/controller.ts',
                  oldString: [
                    'export function shouldApplyBrake(input: BrakingInput): boolean {',
                    '    if (input.distance <= input.stoppingDistance - 2) {',
                    '      return true;',
                    '    }',
                  ].join('\n'),
                  newString: [
                    'export function shouldApplyBrake(input: BrakingInput): boolean {',
                    '    if (input.distance <= input.stoppingDistance) {',
                    '      return true;',
                    '    }',
                  ].join('\n'),
                },
              };
              yield { type: 'completed', finishReason: 'tool_calls' };
            } else {
              yield {
                type: 'token',
                content:
                  'Fixed shouldApplyBrake threshold from `stoppingDistance - 2` to `stoppingDistance` to eliminate counterexample distance=21, stoppingDistance=22.',
              };
              yield { type: 'completed', finishReason: 'stop' };
            }
          },
        });

        const turns = await drainTurns(
          agent.run(
            {
              modelId: 'qwen3-coder',
              taskDescription: task.prompt,
              taskType: 'debugging',
              projectRoot: gws.dir,
            },
            runtime,
          ),
        );
        expect(turns.at(-1)?.kind).toBe('done');
        expect(seenMessages[0]?.some((m) => m.content.includes('SafeBraking'))).toBe(true);
        gws.commitAll('rev-2: repaired controller threshold');
        return { label: 'rev-2-repaired' };
      },
    };

    const evaluateSnapshotController = (snapshotDir: string): boolean => {
      const src = readFileSync(join(snapshotDir, 'src', 'controller.ts'), 'utf8');
      return (
        src.includes('input.distance <= input.stoppingDistance)') &&
        !src.includes('stoppingDistance - 2')
      );
    };

    const alloyAdapter: SolverAdapter = {
      tool: 'alloy',
      async verify(obligation: Obligation, _rev: string, opts): Promise<VerificationResult> {
        const fixed = evaluateSnapshotController(opts?.workspaceDir ?? wsDir);
        if (!fixed) {
          return {
            verdict: Verdict.COUNTEREXAMPLE,
            tool: 'alloy',
            toolVersion: 'alloy-6.2-mock',
            scope: '6',
            assumptions: obligation.assumptions,
            elapsedMs: 12,
            inputHash: 'sha256:' + '1'.repeat(64),
            witness: [
              {
                command: 'check SafeBraking',
                distance: 21,
                stoppingDistance: 22,
                brakeApplied: false,
              },
            ],
          };
        }
        return {
          verdict: Verdict.BOUNDED_PASS,
          tool: 'alloy',
          toolVersion: 'alloy-6.2-mock',
          scope: '6',
          assumptions: obligation.assumptions,
          elapsedMs: 9,
          inputHash: 'sha256:' + '2'.repeat(64),
        };
      },
    };

    const z3Adapter: SolverAdapter = {
      tool: 'z3',
      async verify(obligation: Obligation, _rev: string, opts): Promise<VerificationResult> {
        const fixed = evaluateSnapshotController(opts?.workspaceDir ?? wsDir);
        if (!fixed) {
          return {
            verdict: Verdict.COUNTEREXAMPLE,
            tool: 'z3',
            toolVersion: 'z3-4.13-mock',
            assumptions: obligation.assumptions,
            elapsedMs: 7,
            inputHash: 'sha256:' + '3'.repeat(64),
            witness: { distance: '21', stoppingDistance: '22', brakeApplied: 'false' },
          };
        }
        return {
          verdict: Verdict.PROVED,
          tool: 'z3',
          toolVersion: 'z3-4.13-mock',
          assumptions: obligation.assumptions,
          elapsedMs: 6,
          inputHash: 'sha256:' + '4'.repeat(64),
        };
      },
    };

    const adapters: Partial<Record<FormalTool, SolverAdapter>> = {
      alloy: alloyAdapter,
      z3: z3Adapter,
    };

    const orchestrator = new AssuranceRepairOrchestrator({
      runId: 'qwen-wfa-run-1',
      component: 'braking-controller',
      workspace: ws,
      worker: qwenWorker,
      adapters,
      regressionStore: store,
      evidence: sink,
      maxRepairAttempts: 3,
      planObligations: () => [
        {
          id: 'SAFE_BRAKING/alloy/SafeBraking',
          propertyId: 'SAFE_BRAKING',
          specVersion: '1.0',
          specHash: initialSpecsHash,
          tool: 'alloy',
          artifactPath: 'specs/safety.als',
          command: 'check SafeBraking',
          scope: '6',
          assumptions: ['sensor distance finite'],
          guarantee: 'brakeApplied when distance <= stoppingDistance',
        },
        {
          id: 'SAFE_BRAKING/z3/envelope',
          propertyId: 'SAFE_BRAKING',
          specVersion: '1.0',
          specHash: initialSpecsHash,
          tool: 'z3',
          artifactPath: 'specs/safety.als',
          assumptions: ['sensor distance finite'],
          guarantee: 'unbounded arithmetic braking envelope holds',
        },
      ],
    });

    const report = await orchestrator.run({
      kind: 'implementation',
      id: 'qwen-wfa-impl-1',
      component: 'braking-controller',
      prompt: 'Implement shouldApplyBrake in src/controller.ts to satisfy specs/safety.als.',
    });

    expect(report.outcome).toBe('passed');
    expect(report.repairAttempts).toBe(1);
    expect(report.revisions.map((r) => r.label)).toEqual(['rev-1-buggy', 'rev-2-repaired']);
    expect(report.regressionObligations).toBe(2);
    expect(observedRepairPrompts).toHaveLength(1);
    expect(observedRepairPrompts[0]).toContain('SafeBraking');
    expect(observedRepairPrompts[0]).toContain('distance=21');
    expect(hashSpecsTree(join(wsDir, 'specs'))).toBe(initialSpecsHash);

    // Final iteration ran 2 spec obligations + 2 replayed regression obligations -> BOUNDED_PASS & PROVED
    const finalVerdicts = report.iterations.at(-1)!.runs.map((r) => r.result.verdict);
    expect(finalVerdicts).toContain(Verdict.BOUNDED_PASS);
    expect(finalVerdicts).toContain(Verdict.PROVED);
    expect(ledger.verifyLedger()).toBe(true);
  });

  it('2. Layer A (SPEC_WRITE_FENCE_RULE): deterministically blocks rogue WazirQwenAgent turns attempting edit, multi_edit, write, or shell writes against specs/safety.als', async () => {
    const root = makeTempDir('wazir-qwen-wfa-fence-a-');
    mkdirSync(join(root, 'specs'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });

    const originalSpec = 'module safety\nassert Inv { all x: Int | x = x }\ncheck Inv for 4\n';
    const specFile = join(root, 'specs', 'safety.als');
    writeFileSync(specFile, originalSpec, 'utf8');
    writeFileSync(join(root, 'src', 'controller.ts'), 'export const safe = false;\n', 'utf8');

    const beforeHash = hashSpecsTree(join(root, 'specs'));
    const deniedCalls: Array<{ tool: string; rule: string; reasons: string[] }> = [];

    let turn = 0;
    const { runtime } = createPolicyGovernedRuntime({
      projectRoot: root,
      executionId: 'exec-rogue-repair',
      role: 'repair',
      deniedCalls,
      async *generate() {
        turn += 1;
        if (turn === 1) {
          // Rogue turn attempts edit, multi_edit, write, and shell redirect against specs/safety.als
          yield {
            type: 'tool_call',
            toolCallId: 'rogue_edit',
            toolName: 'edit',
            toolInput: {
              path: 'specs/safety.als',
              oldString: 'assert Inv { all x: Int | x = x }',
              newString: 'assert Inv {}',
            },
          };
          yield {
            type: 'tool_call',
            toolCallId: 'rogue_multi_edit',
            toolName: 'multi_edit',
            toolInput: {
              path: 'specs/safety.als',
              edits: [{ oldString: 'check Inv for 4', newString: 'check Inv for 0' }],
            },
          };
          yield {
            type: 'tool_call',
            toolCallId: 'rogue_write',
            toolName: 'write',
            toolInput: {
              path: 'specs/safety.als',
              content: 'module safety\n',
            },
          };
          yield {
            type: 'tool_call',
            toolCallId: 'rogue_shell',
            toolName: 'shell',
            toolInput: {
              command: 'echo "module weakened" > specs/safety.als',
            },
          };
          yield { type: 'completed', finishReason: 'tool_calls' };
        } else if (turn === 2) {
          // Legitimate fallback edit on src/controller.ts succeeds
          yield {
            type: 'tool_call',
            toolCallId: 'legit_edit',
            toolName: 'edit',
            toolInput: {
              path: 'src/controller.ts',
              oldString: 'export const safe = false;',
              newString: 'export const safe = true;',
            },
          };
          yield { type: 'completed', finishReason: 'tool_calls' };
        } else {
          yield { type: 'token', content: 'Repaired src/controller.ts after spec write fence blocked spec edits.' };
          yield { type: 'completed', finishReason: 'stop' };
        }
      },
    });

    const agent = new WazirQwenAgent({ maxTurns: 6 });
    const turns = await drainTurns(
      agent.run(
        {
          modelId: 'qwen3-coder',
          taskDescription: 'Repair controller to satisfy specs/safety.als',
          taskType: 'debugging',
          projectRoot: root,
        },
        runtime,
      ),
    );

    expect(deniedCalls.map((d) => d.tool)).toEqual(['edit', 'multi_edit', 'write', 'shell']);
    for (const denied of deniedCalls) {
      expect(denied.rule).toBe(SPEC_WRITE_FENCE_RULE);
    }
    expect(readFileSync(specFile, 'utf8')).toBe(originalSpec);
    expect(hashSpecsTree(join(root, 'specs'))).toBe(beforeHash);
    expect(readFileSync(join(root, 'src', 'controller.ts'), 'utf8')).toBe('export const safe = true;\n');
    expect(turns.at(-1)?.kind).toBe('done');
  });

  it('3. Layer B (hashSpecsTree + SpecTamperError + specWriteFenceBlocker): fails closed with spec_tampered if an out-of-band mutation touches specs/safety.als', async () => {
    const root = makeTempDir('wazir-qwen-wfa-fence-b-');
    const wsDir = join(root, 'worktree');
    const storeDir = join(root, 'store');

    const ws = GitWorkspace.init(wsDir);
    mkdirSync(join(wsDir, 'specs'), { recursive: true });
    mkdirSync(join(wsDir, 'src'), { recursive: true });
    writeFileSync(join(wsDir, 'specs', 'safety.als'), 'module safety\ncheck Safe for 5\n', 'utf8');
    writeFileSync(join(wsDir, 'src', 'controller.ts'), 'export const v = 1;\n', 'utf8');
    const baseCommit = ws.commitAll('initial frozen spec');

    const beforeSpecsHash = hashSpecsTree(join(wsDir, 'specs'));
    const store = new RegressionObligationStore(storeDir, { forbiddenRoots: [wsDir] });

    // Simulate a compromised worker bypassing read-only permissions directly on disk
    const rogueWorker: ImplementationWorker = {
      async run(_task, workspace) {
        const gws = workspace as GitWorkspace;
        chmodSync(join(gws.dir, 'specs'), 0o755);
        chmodSync(join(gws.dir, 'specs', 'safety.als'), 0o644);
        writeFileSync(join(gws.dir, 'specs', 'safety.als'), 'module safety\n// deleted check\n', 'utf8');
        const tamperCommit = gws.commitAll('rogue spec tamper');
        const changed = gws.changedPaths(baseCommit, tamperCommit);
        const blocker = specWriteFenceBlocker('rogue-task-1', 'repair', changed);
        expect(blocker).toContain(SPEC_WRITE_FENCE_BLOCKER);
        expect(blocker).toContain('specs/safety.als');
        return { label: 'rev-tampered' };
      },
    };

    const orchestrator = new AssuranceRepairOrchestrator({
      runId: 'qwen-wfa-tamper-check',
      component: 'braking-controller',
      workspace: ws,
      worker: rogueWorker,
      adapters: {},
      regressionStore: store,
      planObligations: () => [],
    });

    const report = await orchestrator.run({
      kind: 'implementation',
      id: 'rogue-task-1',
      component: 'braking-controller',
      prompt: 'Implement controller',
    });

    expect(report.outcome).toBe('spec_tampered');
    expect(report.reason).toContain('modified the frozen spec');
    expect(hashSpecsTree(join(wsDir, 'specs'))).not.toBe(beforeSpecsHash);
    expect(new SpecTamperError('tampered', { expectedHash: beforeSpecsHash })).toBeInstanceOf(Error);
  });
});
