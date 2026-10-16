import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { VerificationEngine } from '@wazir/core';
import { MemoryStore, JsonFileStore } from '@wazir/shared';
import {
  MetaOptimizerService,
  BenchmarkService,
  EvaluationService,
  RegressionGuard,
  SelfImprovementSupervisor,
  parseImprovementModes,
  redactImprovementText,
} from '../src/index.js';

describe('Self-Improvement Verification, Promotion Integrity & Supervisor Unit Suite', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-si-unit-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('fails closed when VerificationEngine is missing required BUILD/TEST oracles', async () => {
    const evaluationService = new EvaluationService();
    const benchmarkService = new BenchmarkService(evaluationService);
    const emptyVerificationEngine = new VerificationEngine({ projectRoot: tmpDir });

    const optimizer = new MetaOptimizerService({
      benchmarkService,
      evaluationService,
      verificationEngine: emptyVerificationEngine,
      store: new MemoryStore(),
    });

    const plan = optimizer.designExperiment({
      hypothesis: {
        id: 'hyp-missing-oracle',
        opportunityId: 'opp-1',
        domain: 'context_policy',
        targetComponent: 'ContextCompiler',
        proposedChange: 'Adjust recency weight',
        expectedMetricEffect: { metric: 'input_tokens', direction: 'decrease', expectedDelta: -0.1 },
        possibleRegressions: ['task_success'],
        requiredBenchmark: ['CONTEXT_STRESS'],
        successThreshold: 1000,
      },
    });

    const [candidate] = await optimizer.generateCandidates(plan, 1);
    const verification = await optimizer.verifyCandidate(candidate);

    expect(verification.allPassed).toBe(false);
    expect(verification.buildPassed).toBe(false);
    expect(verification.unitTestsPassed).toBe(false);
    expect(verification.errors).toContain('MISSING_ORACLE: BUILD');
    expect(verification.errors).toContain('MISSING_ORACLE: TEST');
  });

  it('verifies source-code candidate in git worktree and rejects promotion if worktree is mutated after verification', async () => {
    execFileSync('git', ['init'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.email', 'test@wazir.local'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.name', 'Wazir Test'], { cwd: tmpDir });
    await fs.writeFile(path.join(tmpDir, 'index.js'), 'export const v = 1;\n', 'utf8');
    execFileSync('git', ['add', 'index.js'], { cwd: tmpDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const verificationEngine = new VerificationEngine({ projectRoot: tmpDir });
    verificationEngine.registerOracle({
      type: 'BUILD',
      async verify() {
        return { exitCode: 0, status: 'PASS', output: 'build ok' };
      },
    });
    verificationEngine.registerOracle({
      type: 'TEST',
      async verify() {
        return { exitCode: 0, status: 'PASS', output: 'test ok' };
      },
    });

    const store = new MemoryStore();
    const evaluationService = new EvaluationService();
    const benchmarkService = new BenchmarkService(evaluationService);
    const optimizer = new MetaOptimizerService({
      benchmarkService,
      evaluationService,
      verificationEngine,
      store,
    });

    const plan = optimizer.designExperiment({
      hypothesis: {
        id: 'hyp-worktree',
        opportunityId: 'opp-wt',
        domain: 'routing',
        targetComponent: 'Router',
        proposedChange: 'Tune routing weight',
        expectedMetricEffect: { metric: 'input_tokens', direction: 'decrease', expectedDelta: -0.1 },
        possibleRegressions: ['task_success'],
        requiredBenchmark: ['CODE_REPAIR'],
        successThreshold: 500,
      },
    });

    const [candidate] = await optimizer.generateCandidates(plan, 1);
    candidate.worktreePath = tmpDir;

    const verif = await optimizer.verifyCandidate(candidate);
    expect(verif.allPassed).toBe(true);

    // Mutate worktree file after verification -> fingerprint changes -> promoteCandidate must deny
    await fs.writeFile(path.join(tmpDir, 'index.js'), 'export const v = 2; // tampered\n', 'utf8');
    const saved = optimizer.getCandidate(candidate.candidateId)!;
    const promo = await optimizer.promoteCandidate(saved, { operatorApproved: true });
    expect(promo.success).toBe(false);
    expect(promo.reason).toContain('stale verification evidence');
  });

  it('rejects fabricated candidate promotion and persists verified candidates across restart', async () => {
    const storePath = path.join(tmpDir, 'meta-state.json');
    const store1 = new JsonFileStore(storePath);
    const evaluationService = new EvaluationService();
    const benchmarkService = new BenchmarkService(evaluationService);
    const benchTask = {
      id: 'persist-task-1',
      name: 'Persist Task',
      category: 'CONTEXT_STRESS' as const,
      description: 'Test persistence',
      prompt: 'Run task',
      expectedFiles: ['a.ts'],
      mutationRequired: true,
    };
    benchmarkService.register(benchTask);

    const optimizer1 = new MetaOptimizerService({
      benchmarkService,
      evaluationService,
      store: store1,
    });

    const plan = optimizer1.designExperiment({
      hypothesis: {
        id: 'hyp-persist',
        opportunityId: 'opp-persist',
        domain: 'context_policy',
        targetComponent: 'ContextCompiler',
        proposedChange: 'Reduce recency weight',
        expectedMetricEffect: { metric: 'input_tokens', direction: 'decrease', expectedDelta: -0.2 },
        possibleRegressions: ['task_success'],
        requiredBenchmark: ['CONTEXT_STRESS'],
        successThreshold: 600,
        configMutations: [
          {
            type: 'WEIGHT_ADJUSTMENT',
            path: 'contextWeights.recencyRelevance',
            oldValue: 0.8,
            newValue: 0.4,
            rationale: 'Reduce context bloat',
          },
        ],
      },
      tasks: ['persist-task-1'],
    });

    const [candidate] = await optimizer1.generateCandidates(plan, 1);

    // Fabricated candidate that was never verified or evaluated must be rejected
    const fabricated = {
      ...structuredClone(candidate),
      candidateId: 'cand-fabricated-999',
      status: 'VERIFIED' as const,
    };
    const fabPromo = await optimizer1.promoteCandidate(fabricated, { operatorApproved: true });
    expect(fabPromo.success).toBe(false);
    expect(fabPromo.reason).toContain('PROMOTION_DENIED');

    let calls = 0;
    await optimizer1.evaluateCandidates({
      plan,
      candidates: [candidate],
      tasks: [benchTask],
      runner: {
        id: 'runner-1',
        name: 'Runner 1',
        async run(t) {
          calls++;
          return {
            execution: {
              id: `exec-${calls}`,
              taskId: t.id,
              runtimeId: 'local',
              modelId: 'qwen',
              status: 'completed',
              createdAt: new Date(),
              completedAt: new Date(),
            },
            task: {
              id: t.id,
              type: 'coding',
              title: t.name,
              input: t.prompt,
              requirements: {},
              priority: 'normal',
              status: 'completed',
              createdAt: new Date(),
            },
            policyDecisions: [],
            toolCalls: [],
            filesChanged: ['a.ts'],
            checks: [{ name: 'test', command: 'npm test', ok: true, durationMs: 50 }],
            errors: [],
            events: [],
            usage: { input: calls > 1 ? 400 : 900, output: 100 },
          };
        },
      },
    });

    // Hydrate a second optimizer instance from the same store (simulating process restart)
    const store2 = new JsonFileStore(storePath);
    const optimizer2 = new MetaOptimizerService({
      benchmarkService,
      evaluationService,
      store: store2,
    });
    await optimizer2.hydrate();

    const rehydratedCandidate = optimizer2.getCandidate(candidate.candidateId);
    expect(rehydratedCandidate).toBeDefined();
    expect(rehydratedCandidate?.status).toBe('VERIFIED');

    const promo = await optimizer2.promoteCandidate(rehydratedCandidate!, { operatorApproved: true });
    expect(promo.success).toBe(true);
    expect(optimizer2.getActiveConfig().id).toBe(candidate.config.id);

    // Rollback across restart
    const rolledBack = await optimizer2.rollback(candidate.candidateId);
    expect(rolledBack.id).toBe('cfg-default');
  });

  it('marks benchmark suite with runner errors as INCONCLUSIVE (ZERO_REAL_EXECUTIONS)', async () => {
    const evaluationService = new EvaluationService();
    const benchmarkService = new BenchmarkService(evaluationService);
    const task = {
      id: 'err-task-1',
      name: 'Errored Task',
      category: 'CODE_REPAIR' as const,
      description: 'Fails to schedule',
      prompt: 'Fix bug',
    };
    benchmarkService.register(task);

    const optimizer = new MetaOptimizerService({
      benchmarkService,
      evaluationService,
       regressionGuard: new RegressionGuard(),
      store: new MemoryStore(),
    });

    const plan = optimizer.designExperiment({
      hypothesis: {
        id: 'hyp-err',
        opportunityId: 'opp-err',
        domain: 'routing',
        targetComponent: 'Router',
        proposedChange: 'Change routing',
        expectedMetricEffect: { metric: 'input_tokens', direction: 'decrease', expectedDelta: -0.1 },
        possibleRegressions: [],
        requiredBenchmark: ['CODE_REPAIR'],
        successThreshold: 500,
      },
      tasks: ['err-task-1'],
    });

    const candidates = await optimizer.generateCandidates(plan, 1);
    const results = await optimizer.evaluateCandidates({
      plan,
      candidates,
      tasks: [task],
      runner: {
        id: 'failing-runner',
        name: 'Failing Runner',
        async run() {
          throw new Error('No runtime available');
        },
      },
    });

    expect(results[0].decision).toBe('INCONCLUSIVE');
    expect(results[0].regressionGuard?.qualified).toBe(false);
    expect(results[0].regressionGuard?.inconclusiveReasons.some((r) => r.includes('ZERO_REAL_EXECUTIONS'))).toBe(true);
  });

  it('supervises observation, incident deduplication, recommendations, pause/stop, and crash recovery', async () => {
    expect(parseImprovementModes('harden,optimize')).toEqual(['harden', 'optimize']);
    expect(() => parseImprovementModes('invalid')).toThrow();
    expect(redactImprovementText('token=sk-1234567890abcdef')).toContain('[REDACTED]');

    const store = new MemoryStore();
    // Simulate a previously interrupted attempt
    await store.put('supervisor/state', {
      schema: 1,
      instanceId: 'old-instance',
      pid: 99999,
      phase: 'EXPERIMENTING',
      modes: ['harden'],
      cycles: 1,
      failures: 0,
      consecutiveFailures: 0,
      nextRunAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      activeAttempt: 'interrupted-attempt-1',
    });

    let currentTime = 1_000_000;
    const supervisor = new SelfImprovementSupervisor({
      store,
      now: () => currentTime,
      intervalMs: 5_000,
      maxCycles: 3,
      busy: async () => false,
      observe: async () => [
        { source: 'exec-1', kind: 'tool_protocol_failure', summary: 'INVALID_JSON_ACTION at turn 2' },
        { source: 'exec-1', kind: 'tool_protocol_failure', summary: 'INVALID_JSON_ACTION at turn 2' },
        { source: 'exec-2', kind: 'tool_protocol_failure', summary: 'INVALID_JSON_ACTION at turn 4' },
      ],
      diagnose: async () => [
        {
          signature: 'custom-opt-1',
          mode: 'optimize',
          category: 'HIGH_CONTEXT_GROWTH',
          targetComponent: 'ContextCompiler',
          summary: 'High context growth observed',
          proposedAction: 'Lower recency weight',
          evidence: { avgTokens: 78000 },
        },
      ],
    });

    await supervisor.initialize(['harden', 'optimize']);
    const recoveredAttempt = await store.get<any>('supervisor/attempts/interrupted-attempt-1');
    expect(recoveredAttempt?.decision).toBe('INCONCLUSIVE');
    expect(recoveredAttempt?.reason).toContain('INTERRUPTED');

    const tick1 = await supervisor.tick();
    expect(tick1.phase).toBe('BLOCKED');
    expect(tick1.cycles).toBe(1);

    const incidents = await store.list('supervisor/incidents/');
    expect(incidents).toHaveLength(1);
    expect((incidents[0].value as any).count).toBe(2);

    const recs = await store.list('supervisor/recommendations/');
    expect(recs.length).toBeGreaterThanOrEqual(2);

    // Pause control
    await store.put('supervisor/control', 'pause');
    const paused = await supervisor.tick();
    expect(paused.phase).toBe('PAUSED');

    // Stop control
    await store.put('supervisor/control', 'stop');
    const stopped = await supervisor.tick();
    expect(stopped.phase).toBe('STOPPED');
  });
});
