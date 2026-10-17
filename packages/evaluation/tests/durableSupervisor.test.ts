import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '@wazir/shared';
import {
  DurableImprovementSupervisor,
  VALID_LIFECYCLE_TRANSITIONS,
} from '../src/durableImprovementSupervisor.js';
import { BenchmarkService } from '../src/benchmarkService.js';
import { EvaluationService } from '../src/evaluationService.js';
import { MetaOptimizerService } from '../src/metaOptimizerService.js';
import type {
  ImprovementOpportunity,
  ImprovementHypothesis,
  BenchmarkTask,
  BenchmarkRunner,
} from '@wazir/core';

describe('DurableImprovementSupervisor: State Machine, Fencing & Crash Resilience', () => {
  let store: MemoryStore;
  let supervisor: DurableImprovementSupervisor;

  beforeEach(() => {
    store = new MemoryStore();
    supervisor = new DurableImprovementSupervisor({
      supervisorId: 'sup-alpha',
      store,
      leaseDurationMs: 5_000,
    });
  });

  it('validates legal lifecycle state transitions and rejects illegal ones', async () => {
    const attempt = await supervisor.initAttempt({ attemptId: 'att-test-1' });
    expect(attempt.state).toBe('DISCOVERED');
    expect(attempt.stateVersion).toBe(1);

    // DISCOVERED -> QUALIFIED_FOR_EXPERIMENT is valid
    const s1 = await supervisor.transitionTo('QUALIFIED_FOR_EXPERIMENT', 'Opportunity meets qualification threshold');
    expect(s1.state).toBe('QUALIFIED_FOR_EXPERIMENT');
    expect(s1.stateVersion).toBe(2);

    // QUALIFIED_FOR_EXPERIMENT -> COMMITTED is illegal without implementation, verification, benchmarking
    await expect(supervisor.transitionTo('COMMITTED', 'Premature commit')).rejects.toThrow(
      /INVALID_STATE_TRANSITION/,
    );

    // Follow valid path: PLANNED -> IMPLEMENTING -> VERIFYING -> BENCHMARKING -> READY_TO_COMMIT -> COMMITTED
    await supervisor.transitionTo('PLANNED', 'Plan registered');
    await supervisor.transitionTo('IMPLEMENTING', 'Generating candidates');
    await supervisor.transitionTo('VERIFYING', 'Verifying oracles');
    await supervisor.transitionTo('BENCHMARKING', 'Running comparative benchmarks');
    await supervisor.transitionTo('READY_TO_COMMIT', 'Candidate qualified');
    const finalRecord = await supervisor.transitionTo('COMMITTED', 'Committed to git');

    expect(finalRecord.state).toBe('COMMITTED');
    expect(finalRecord.history.length).toBe(8); // DISCOVERED + 7 valid transitions
  });

  it('enforces monotonic lease fencing to block concurrent split-brain supervisors', async () => {
    const attemptId = 'att-fencing-test';
    const lease1 = await supervisor.acquireLease(attemptId);
    expect(lease1.ownerId).toBe('sup-alpha');
    expect(lease1.fencingToken).toBe(1);

    // A rival supervisor attempts to acquire lease while first lease is still active
    const rivalSupervisor = new DurableImprovementSupervisor({
      supervisorId: 'sup-beta',
      store,
      leaseDurationMs: 5_000,
    });

    await expect(rivalSupervisor.acquireLease(attemptId)).rejects.toThrow(
      /SUPERVISOR_LEASE_CONFLICT/,
    );
  });

  it('recovers crashed attempts in volatile states into BLOCKED for inspection', async () => {
    const attemptId = 'att-crash-test';
    await supervisor.initAttempt({ attemptId });
    await supervisor.transitionTo('QUALIFIED_FOR_EXPERIMENT');
    await supervisor.transitionTo('PLANNED');
    await supervisor.transitionTo('IMPLEMENTING', 'Worker started generating candidates');

    // Simulate supervisor crash and process reboot with a fresh supervisor instance
    const rebootedSupervisor = new DurableImprovementSupervisor({
      supervisorId: 'sup-recovered',
      store,
    });

    const recovered = await rebootedSupervisor.resumeAttempt(attemptId);
    expect(recovered).not.toBeNull();
    // Because it crashed in IMPLEMENTING, recovery safely placed it into BLOCKED
    expect(recovered?.state).toBe('BLOCKED');
    expect(recovered?.reasons).toContain(
      'Interrupted during IMPLEMENTING; recovered to BLOCKED for safe inspection',
    );
  });

  it('integrates supervisor lifecycle transitions through MetaOptimizerService.executeImprovementCycle', async () => {
    const evalService = new EvaluationService();
    const benchService = new BenchmarkService(evalService);

    const testTask: BenchmarkTask = {
      id: 'task-opt-cycle',
      name: 'Sample Optimization Benchmark',
      category: 'CODE_REPAIR',
      description: 'Repair code',
      prompt: 'Fix bugs',
    };
    benchService.register(testTask);

    const optimizer = new MetaOptimizerService({
      benchmarkService: benchService,
      evaluationService: evalService,
      store,
      supervisor,
    });

    const opportunity: ImprovementOpportunity = {
      id: 'opp-cycle-1',
      category: 'HIGH_CONTEXT_GROWTH',
      component: 'ContextCompiler',
      observation: 'Context growth observed',
      evidence: 5,
      suspectedCause: 'Uncompacted tokens',
      metric: 'peak_context_tokens',
      baseline: 10_000,
      domain: 'context_policy',
      detectedAt: new Date(),
    };

    const hypothesis: ImprovementHypothesis = {
      id: 'hyp-cycle-1',
      opportunityId: 'opp-cycle-1',
      targetComponent: 'ContextCompiler',
      domain: 'context_policy',
      proposedChange: 'Compact context earlier',
      expectedMetricEffect: {
        metric: 'peak_context_tokens',
        expectedDelta: -2_000,
        direction: 'decrease',
      },
      possibleRegressions: ['task_success'],
      requiredBenchmark: ['CODE_REPAIR'],
      successThreshold: 8_500,
      configMutations: [
        {
          path: 'contextWeights.recencyRelevance',
          oldValue: 0.5,
          newValue: 0.8,
        },
      ],
    };

    let runnerCalls = 0;
    const mockRunner: BenchmarkRunner = {
      id: 'mock-cycle-runner',
      name: 'Mock Cycle Runner',
      async run(t: BenchmarkTask) {
        runnerCalls++;
        const isCandidate = runnerCalls > 1;
        return {
          id: `exec-${t.id}-${runnerCalls}`,
          taskId: t.id,
          runtimeId: 'mock-runtime',
          modelId: 'mock-model',
          status: 'completed',
          createdAt: new Date(),
          completedAt: new Date(),
          usage: {
            input: isCandidate ? 7_000 : 10_000,
            output: 200,
          },
        } as any;
      },
    };

    const result = await optimizer.executeImprovementCycle({
      opportunity,
      hypothesis,
      runner: mockRunner,
      tasks: [testTask],
    });

    expect(result.candidate).toBeDefined();
    expect(result.verification?.allPassed).toBe(true);
    expect(result.runResult?.decision).toBe('QUALIFIED');
    expect(result.attemptRecord?.state).toBe('READY_TO_COMMIT');
    expect(supervisor.getCurrentAttempt()?.state).toBe('READY_TO_COMMIT');
  });
});
