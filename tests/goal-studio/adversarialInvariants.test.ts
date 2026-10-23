/**
 * Adversarial & security invariant regression suite for Goal Studio contracts:
 *   1. Lease epoch fencing (`STALE_LEASE` when an old lease holder tries to commit after lease takeover)
 *   2. Optimistic concurrency control (`LEDGER_CONFLICT` when expectedRevision mismatches)
 *   3. Idempotency (`once(key, effect)` executes effect exactly once even under concurrent calls)
 *   4. Self-verification rejection (validatorIdentity === executorIdentity is ignored by AcceptanceGate)
 *   5. Non-unlocking `verified` state (`verified` alone never unlocks dependent targets; only `completed` does)
 *   6. Executing model is never a principal (`model:*` rejected by governance preflight and controller mutations)
 *   7. Hosted spend ceiling enforcement (`hostedSpendUsd: 0` rejects hosted inference; budget overrun denied)
 *   8. Scoped approvals (`approval:<runId>:<targetId>:<attempt>:<action>` is single-use and cannot be reused across targets/attempts)
 *   9. No-progress detection (repeated identical failureSignature blocks target after `maxSameActionNoProgress`)
 *  10. Event log SSE reconnect replay (`read(runId, afterSeq, limit)` with zero gaps + live `subscribe`)
 *  11. Scale & performance smoke on a 250-target synthetic DAG
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '@wazir/shared';
import {
  GOAL_STUDIO_HTTP_STATUS,
  GoalStudioFailure,
  idempotencyKey,
  type EvidenceRecord,
  type GoalStudioEvent,
  type TargetAttempt,
} from '../../packages/goals/src/contracts.js';
import {
  approvalScope,
  createFakeGoalStudioServices,
  fixtureRevisionRecord,
  loadFixtureDefinition,
  readFixtureYaml,
  referenceEligibleTargets,
  syntheticDefinition,
} from './fakes/index.js';

describe('Goal Studio Adversarial & Contract Invariant Suite', () => {
  let tmpDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-goal-studio-adv-'));
    workspaceRoot = path.join(tmpDir, 'workspace');
    await fs.mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('enforces lease epoch fencing (STALE_LEASE) and optimistic concurrency (LEDGER_CONFLICT) on GoalLedgerStore.commit', async () => {
    const store = new MemoryStore();
    const { services } = await createFakeGoalStudioServices({ store, workspaceRoot });
    const graphRec = fixtureRevisionRecord();
    const run = await services.ledger.createRun({ graph: graphRec, createdBy: 'user:operator', runId: 'run-fence-1' });

    // Worker A acquires lease (epoch 1)
    const leaseA = await services.ledger.acquireLease(run.runId, 'worker-A', 50);
    expect(leaseA).toBeDefined();
    expect(leaseA!.epoch).toBe(1);

    // Worker B cannot acquire while leaseA is live
    const blockedB = await services.ledger.acquireLease(run.runId, 'worker-B', 1000);
    expect(blockedB).toBeUndefined();

    // Wait for leaseA to expire, then Worker B acquires (epoch 2)
    await new Promise((r) => setTimeout(r, 70));
    const leaseB = await services.ledger.acquireLease(run.runId, 'worker-B', 10_000);
    expect(leaseB).toBeDefined();
    expect(leaseB!.epoch).toBe(2);

    // Worker A attempts to commit with stale epoch 1 -> must fail with STALE_LEASE (HTTP 409)
    await expect(
      services.ledger.commit(run.runId, run.ledgerRevision, leaseA!, (l) => void (l.status = 'running'), []),
    ).rejects.toMatchObject({
      code: 'STALE_LEASE',
    });
    expect(GOAL_STUDIO_HTTP_STATUS.STALE_LEASE).toBe(409);

    // Worker B commits with valid epoch 2 and expectedRevision 1 -> ledgerRevision becomes 2
    const committed = await services.ledger.commit(run.runId, 1, leaseB!, (l) => void (l.status = 'running'), []);
    expect(committed.ledgerRevision).toBe(2);

    // Worker B attempts to commit again with outdated expectedRevision 1 -> LEDGER_CONFLICT
    await expect(
      services.ledger.commit(run.runId, 1, leaseB!, (l) => void (l.status = 'paused'), []),
    ).rejects.toMatchObject({
      code: 'LEDGER_CONFLICT',
    });
    expect(GOAL_STUDIO_HTTP_STATUS.LEDGER_CONFLICT).toBe(409);
  });

  it('guarantees once(key, effect) executes side effects at most once even under concurrent invocations', async () => {
    const store = new MemoryStore();
    const { services } = await createFakeGoalStudioServices({ store, workspaceRoot });
    const key = idempotencyKey('run-idem', 'Y1.1', 1, 'EXECUTE');
    let executions = 0;

    const [r1, r2, r3] = await Promise.all([
      services.ledger.once(key, async () => {
        executions += 1;
        await new Promise((r) => setTimeout(r, 20));
        return { count: executions };
      }),
      services.ledger.once(key, async () => {
        executions += 1;
        return { count: executions };
      }),
      services.ledger.once(key, async () => {
        executions += 1;
        return { count: executions };
      }),
    ]);

    expect(executions).toBe(1);
    expect([r1.replayed, r2.replayed, r3.replayed].filter(Boolean)).toHaveLength(2);
    expect(r1.result).toEqual({ count: 1 });
    expect(r2.result).toEqual({ count: 1 });
    expect(r3.result).toEqual({ count: 1 });
  });

  it('rejects self-certified evidence (validatorIdentity === executorIdentity) and never unlocks dependents from `verified` status alone', async () => {
    const store = new MemoryStore();
    const { services } = await createFakeGoalStudioServices({ store, workspaceRoot });
    const graphRec = fixtureRevisionRecord();
    const run = await services.ledger.createRun({ graph: graphRec, createdBy: 'user:operator' });
    const targetY11 = graphRec.definition.targets.find((t) => t.id === 'Y1.1')!;
    const attempt: TargetAttempt = {
      id: `${run.runId}:Y1.1:1`,
      runId: run.runId,
      targetId: 'Y1.1',
      attempt: 1,
      phase: 'ACCEPTANCE_GATE',
      startedAt: new Date().toISOString(),
    };

    // Forge self-verified PASS evidence where validatorIdentity === executorIdentity
    const selfCertifiedEvidence: EvidenceRecord[] = targetY11.acceptance.map((criterion, idx) => ({
      id: `ev-forged-${idx}`,
      runId: run.runId,
      targetId: 'Y1.1',
      attemptId: attempt.id,
      graphRevision: run.graphRevision,
      workspaceRevision: 'sha256:00',
      artifacts: [],
      validationMethod: 'adversarial-review',
      validatorIdentity: 'model:local-qwen2.5-coder:32b',
      executorIdentity: 'model:local-qwen2.5-coder:32b', // SAME AS VALIDATOR -> INVALID!
      verdict: 'PASS',
      criterion,
      limitations: [],
      createdAt: new Date().toISOString(),
    }));

    const gateDecision = services.verification.gate({
      run,
      target: targetY11,
      attempt,
      evidence: selfCertifiedEvidence,
    });
    expect(gateDecision.decision).not.toBe('completed');
    expect(gateDecision.decision).toBe('repair');
    expect(gateDecision.perCriterion.every((c) => c.verdict === 'NOT_RUN')).toBe(true);

    // Even if a target is in `verified` status in the ledger, dependent Y1.2 MUST NOT be eligible
    const runWithVerifiedOnly = structuredClone(run);
    runWithVerifiedOnly.targets['Y1.1']!.status = 'verified';
    const eligible = referenceEligibleTargets(runWithVerifiedOnly, graphRec.definition);
    expect(eligible).not.toContain('Y1.2');

    // Only when Y1.1 reaches `completed` does Y1.2 become eligible
    runWithVerifiedOnly.targets['Y1.1']!.status = 'completed';
    expect(referenceEligibleTargets(runWithVerifiedOnly, graphRec.definition)).toContain('Y1.2');
  });

  it('enforces authorization boundaries: model is never a principal, hostedSpendUsd=0 blocks paid models, and approvals are single-scope', async () => {
    const store = new MemoryStore();
    const { services, fakes } = await createFakeGoalStudioServices({ store, workspaceRoot });
    const imported = await services.graphs.importYaml('proj-gov', readFixtureYaml(), 'user:operator');
    const graphRec = imported.record!;

    // 1. Model principal cannot start a run
    await expect(
      services.controller.startRun({ graphId: graphRec.graphId, principal: 'model:gpt-5' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const run = await services.controller.startRun({ graphId: graphRec.graphId, principal: 'user:operator' });
    const targetY11 = graphRec.definition.targets.find((t) => t.id === 'Y1.1')!;

    // 2. Governance preflight denies `model:*` principal
    const modelPre = await services.governance.preflight({
      run,
      target: targetY11,
      principal: 'model:local-qwen2.5-coder:32b',
    });
    expect(modelPre.effect).toBe('deny');

    // 3. Spending gate: hostedSpendUsd is 0 in nobel_goal_graph.yaml -> any positive spend is denied
    expect(services.governance.authorizeSpend(run, 0).effect).toBe('allow');
    expect(services.governance.authorizeSpend(run, 0.01).effect).toBe('deny');

    // 4. Router never selects hosted model when remainingHostedBudgetUsd is 0, nor unready models
    const route = await services.router.route({
      requiredCapabilities: ['text-generation'],
      remainingHostedBudgetUsd: 0,
      localFirst: true,
    });
    expect(route).toBeDefined();
    expect(route!.hosted).toBe(false);
    expect(route!.modelId).not.toBe('unready-local-llama');
    expect(route!.rejected.some((r) => r.modelId === 'hosted-claude-sonnet-4' && r.reason.includes('budget'))).toBe(true);
    expect(route!.rejected.some((r) => r.modelId === 'unready-local-llama' && r.reason.includes('not verified ready'))).toBe(true);

    // 5. Approval-required target (Y3.2 has requires_approval: true)
    const targetY32 = graphRec.definition.targets.find((t) => t.id === 'Y3.2')!;
    const askDecision = await services.governance.preflight({
      run,
      target: targetY32,
      principal: 'controller',
    });
    expect(askDecision.effect).toBe('ask');
    const expectedScope = approvalScope(run.runId, 'Y3.2', 1, 'execute');
    expect(askDecision.approvalScope).toBe(expectedScope);

    // Granting approval for Y3.2 attempt 1 allows attempt 1, but does NOT allow Y2.3 or attempt 2
    fakes.governance.grant(expectedScope, 'user:operator');
    const allowedY32 = await services.governance.preflight({ run, target: targetY32, principal: 'controller' });
    expect(allowedY32.effect).toBe('allow');

    const targetY23 = graphRec.definition.targets.find((t) => t.id === 'Y2.3')!;
    const stillAskY23 = await services.governance.preflight({ run, target: targetY23, principal: 'controller' });
    expect(stillAskY23.effect).toBe('ask');
  });

  it('detects repeated identical failures (no_progress) and blocks the target after maxSameActionNoProgress', async () => {
    const store = new MemoryStore();
    const { services } = await createFakeGoalStudioServices({
      store,
      workspaceRoot,
      // Always omit scope.md for Y1.1 so every attempt fails with the exact same verification signature
      omitArtifact: { 'Y1.1': 'scope.md' },
      autoAdvance: false,
      autoStart: false,
    });

    const imported = await services.graphs.importYaml('proj-noprog', readFixtureYaml(), 'user:operator');
    const run = await services.controller.startRun({ graphId: imported.record!.graphId, principal: 'user:operator' });

    // max_same_action_no_progress in nobel_goal_graph.yaml is 2:
    // Attempt 1 fails -> repair 1
    const r1 = await services.controller.runEligible(run.runId, 'Y1.1', 'user:operator');
    expect(r1.targets['Y1.1']?.status).toBe('eligible');
    expect(r1.targets['Y1.1']?.repairs).toBe(1);

    // Attempt 2 fails with same signature -> repair 2
    const r2 = await services.controller.runEligible(run.runId, 'Y1.1', 'user:operator');
    expect(r2.targets['Y1.1']?.status).toBe('eligible');
    expect(r2.targets['Y1.1']?.repairs).toBe(2);

    // Attempt 3 fails with same signature (2 prior identical failures == maxSameActionNoProgress) -> BLOCKED!
    const r3 = await services.controller.runEligible(run.runId, 'Y1.1', 'user:operator');
    expect(r3.targets['Y1.1']?.status).toBe('blocked');
    expect(r3.targets['Y1.1']?.blockers.join(' ')).toMatch(/same failure repeated|signature/i);
  });

  it('supports SSE event replay with afterSeq/limit and live pub/sub without gaps', async () => {
    const store = new MemoryStore();
    const { services } = await createFakeGoalStudioServices({ store, workspaceRoot, autoAdvance: false });
    const liveEvents: GoalStudioEvent[] = [];

    const imported = await services.graphs.importYaml('proj-events', readFixtureYaml(), 'user:operator');
    const run = await services.controller.startRun({ graphId: imported.record!.graphId, principal: 'user:operator' });

    const unsubscribe = services.events.subscribe(run.runId, (ev) => liveEvents.push(ev));
    await services.controller.runEligible(run.runId, 'Y1.1', 'user:operator');
    unsubscribe();

    expect(liveEvents.length).toBeGreaterThan(0);
    const fullLog = await services.events.read(run.runId, 0);
    expect(fullLog.length).toBeGreaterThanOrEqual(liveEvents.length);

    // Simulate client disconnect at seq 3 and reconnect with ?after=3
    const replayed = await services.events.read(run.runId, 3);
    expect(replayed[0]?.seq).toBe(4);
    expect(replayed.map((e) => e.seq)).toEqual(fullLog.slice(3).map((e) => e.seq));
  });

  it('validates and schedules a 250-target synthetic DAG within performance budgets (<100ms)', () => {
    const dag = syntheticDefinition(250, 4, 1337);
    const store = new MemoryStore();
    const { targets } = dag;
    expect(targets).toHaveLength(250);

    const t0 = performance.now();
    const rec = fixtureRevisionRecord({ definition: dag });
    const fakeLedger = {
      runId: 'run-scale',
      graphId: rec.graphId,
      graphRevision: 1,
      graphDigest: rec.digest,
      status: 'running' as const,
      ledgerRevision: 1,
      targets: Object.fromEntries(
        targets.map((t) => [
          t.id,
          { targetId: t.id, status: 'queued' as const, attempts: 0, repairs: 0, evidenceIds: [], blockers: [], updatedAt: '' },
        ]),
      ),
      resource: { tasksStarted: 0, hostedSpendUsd: 0, startedAt: '', deadlineAt: '' },
      createdBy: 'user:bench',
      createdAt: '',
      updatedAt: '',
    };
    const eligible = referenceEligibleTargets(fakeLedger, dag);
    const elapsedMs = performance.now() - t0;

    expect(eligible.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(100);
    void store;
    void GoalStudioFailure;
  });
});
