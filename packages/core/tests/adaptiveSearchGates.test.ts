import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SolutionSearchService } from '../src/services/solutionSearchService.js';
import { ModelRegistry } from '../src/services/modelRegistry.js';
import type {
  SolutionSearchRequest,
  CandidateRunner,
  ExecutionRecord,
  ExecutionCheckpoint,
  CandidateDescriptor,
  ModelRecord,
} from '../src/types/index.js';

describe('Acceptance Gates: G52, G53 — Adaptive Search Controller & Search Efficiency', () => {
  let mockCheckpointService: any;
  let mockWorktreeManager: any;
  let mockExecutionEngine: any;
  let mockEvaluationService: any;
  let modelRegistry: ModelRegistry;
  let baselineCheckpoint: ExecutionCheckpoint;

  beforeEach(() => {
    baselineCheckpoint = {
      id: 'chk-baseline-c0',
      parentCheckpointId: undefined,
      executionId: 'exec-parent',
      timestamp: new Date(),
      workspaceRevision: 10,
      snapshotHash: 'hash-c0',
      description: 'Baseline',
      branch: 'main',
    };

    mockCheckpointService = {
      checkpoint: vi.fn().mockResolvedValue(baselineCheckpoint),
      fork: vi.fn().mockImplementation((chkId: string, candId: string) =>
        Promise.resolve({
          forkedExecutionId: `exec-${candId}`,
          forkedWorktreePath: `/tmp/worktrees/${candId}`,
          branch: `branch-${candId}`,
          forkedCheckpointId: `chk-${candId}`,
        }),
      ),
      mergeFork: vi.fn().mockResolvedValue({
        success: true,
        mergedRevision: 11,
      }),
    };

    mockWorktreeManager = {
      removeWorktree: vi.fn().mockResolvedValue(true),
    };

    mockExecutionEngine = {
      get: vi.fn().mockResolvedValue({
        execution: { id: 'exec-parent', taskId: 'task-1', status: 'completed' },
        task: { id: 'task-1' },
        workspaceState: { revision: 10 },
      }),
    };

    mockEvaluationService = {
      evaluate: vi.fn().mockImplementation((record: ExecutionRecord) => {
        const hasBuildFailure =
          record.checks?.some((c) => c.name === 'build' && !c.ok) ||
          record.errors?.some((e) => e.includes('UNRECOVERABLE_BUILD'));
        const hasProtectedFailure = record.checks?.some((c) => (c as any).protected && !c.ok);
        const qualifies =
          !hasBuildFailure &&
          !hasProtectedFailure &&
          record.status !== 'failed' &&
          (record.checks?.every((c) => c.ok) ?? true);

        return {
          passed: qualifies,
          qualifies,
          score: qualifies ? 1.0 : 0.0,
          disqualificationReasons: qualifies ? [] : ['Verification checks failed'],
          metrics: {
            testsPassed: qualifies,
            buildPassed: !hasBuildFailure,
            lintPassed: true,
            taskSuccess: qualifies,
            physicalVerificationSuccess: qualifies,
            totalModelCalls: 1,
          },
        };
      }),
    };

    modelRegistry = new ModelRegistry();
    modelRegistry.register({
      id: 'fast-coder',
      provider: 'ollama',
      family: 'qwen',
      contextWindow: 32000,
      capabilities: ['code'],
    } as ModelRecord);
    modelRegistry.register({
      id: 'expert-reasoner',
      provider: 'ollama',
      family: 'deepseek',
      contextWindow: 64000,
      capabilities: ['code', 'reasoning'],
    } as ModelRecord);
  });

  /**
   * GATE G52: ADAPTIVE_SEARCH
   *
   * Start with candidate pool smaller than configured maximum.
   * Require system to:
   * 1. prune one
   * 2. continue one
   * 3. spawn one
   * 4. escalate one
   * using actual evidence.
   */
  it('G52: Adaptive Search — pool starts smaller than max, prunes one, continues one, spawns one, escalates one based on evidence', async () => {
    const service = new SolutionSearchService({
      checkpointService: mockCheckpointService,
      worktreeManager: mockWorktreeManager,
      executionEngine: mockExecutionEngine,
      evaluationService: mockEvaluationService,
      modelRegistry,
    });

    const emittedEvents: string[] = [];
    service.onEvent((e) => emittedEvents.push(e.type));

    // Define runner behavior for each candidate
    const runner: CandidateRunner = async ({ candidateId, descriptor }) => {
      // Candidate A: Unrecoverable syntax/build error -> Must PRUNE
      if (candidateId.includes('A')) {
        return {
          execution: { id: `exec-${candidateId}`, taskId: 'task-1', status: 'failed' } as any,
          task: { id: 'task-1' } as any,
          policyDecisions: [],
          toolCalls: [],
          filesChanged: ['src/main.ts'],
          checks: [
            {
              name: 'build',
              command: 'cargo build',
              ok: false,
              output: 'UNRECOVERABLE_BUILD: syntax error: mismatched closing delimiter',
              durationMs: 40,
            },
          ],
          errors: ['UNRECOVERABLE_BUILD: unrecoverable build failure in candidate A'],
          events: [],
          usage: { input: 600, output: 200, total: 800 },
        };
      }

      // Candidate B: Model reasoning failure -> Must ESCALATE
      if (candidateId.includes('B')) {
        return {
          execution: { id: `exec-${candidateId}`, taskId: 'task-1', status: 'failed' } as any,
          task: { id: 'task-1' } as any,
          policyDecisions: [],
          toolCalls: [],
          filesChanged: ['src/algo.ts'],
          checks: [{ name: 'test', command: 'cargo test', ok: false, output: 'recursion depth exceeded', durationMs: 60 }],
          errors: ['REASONING_COMPLEXITY_EXCEEDED: Model lacked depth for combinatorial constraint'],
          events: [],
          usage: { input: 1200, output: 400, total: 1600 },
        };
      }

      // Candidate C (Spawned replacement or escalated): Correct implementation -> Must CONTINUE and QUALIFY
      return {
        execution: { id: `exec-${candidateId}`, taskId: 'task-1', status: 'completed' } as any,
        task: { id: 'task-1' } as any,
        policyDecisions: [],
        toolCalls: [],
        filesChanged: ['src/solution.ts'],
        checks: [
          { name: 'build', command: 'cargo build', ok: true, output: 'finished', durationMs: 30 },
          { name: 'test', command: 'cargo test', ok: true, output: '12 passed, 0 failed', durationMs: 45 },
        ],
        errors: [],
        events: [],
        usage: { input: 1500, output: 500, total: 2000 },
      };
    };

    const request: SolutionSearchRequest = {
      executionId: 'exec-parent',
      objective: 'G52 Adaptive Search Verification',
      strategy: 'same_model_diverse',
      candidates: 4,
      adaptive: {
        enabled: true,
        initialCandidates: 2, // Starts smaller (2) than configured max (4)
        maxCandidates: 4,
        pruning: {
          enabled: true,
          hardPruneOnUnrecoverableBuild: true,
        },
        escalation: {
          enabled: true,
          triggerOnFailureCount: 1,
        },
        diversity: {
          enabled: true,
          minDiversityScore: 0.3,
        },
        stoppingCriteria: {
          stopOnSufficient: false, // Allow full pipeline to exercise prune, escalate, spawn, continue
        },
      },
    };

    const result = await service.search(request, runner);

    // Verify initial pool was smaller than maximum
    expect(result.adaptiveTelemetry).toBeDefined();
    expect(result.adaptiveTelemetry?.initialCandidatesCount).toBe(2);
    expect(result.totalCandidates).toBeGreaterThan(2);

    // 1. Verify PRUNE ONE
    expect(result.adaptiveTelemetry?.prunedCandidatesCount).toBeGreaterThanOrEqual(1);
    expect(emittedEvents).toContain('candidate.pruned');
    const prunedCand = result.candidates.find((c) => c.isPruned);
    expect(prunedCand).toBeDefined();
    expect(prunedCand?.prunedReason).toContain('unrecoverable build failure');

    // 2. Verify ESCALATE ONE
    expect(result.adaptiveTelemetry?.escalatedCandidatesCount).toBeGreaterThanOrEqual(1);
    expect(emittedEvents).toContain('candidate.escalated');
    const escalatedCand = result.candidates.find((c) => c.isEscalated);
    expect(escalatedCand).toBeDefined();
    expect(escalatedCand?.escalationHistory).toBeDefined();
    expect(escalatedCand?.escalationHistory?.[0].toModel).toBe('expert-reasoner');

    // 3. Verify SPAWN ONE
    expect(result.adaptiveTelemetry?.spawnedCandidatesCount).toBeGreaterThanOrEqual(1);
    expect(emittedEvents).toContain('candidate.spawned');

    // 4. Verify CONTINUE ONE
    const continuedQualifying = result.candidates.find((c) => !c.isPruned && c.evaluation?.qualifies);
    expect(continuedQualifying).toBeDefined();
    expect(continuedQualifying?.status).toBe('completed');
    expect(result.qualifyingCandidates.length).toBeGreaterThanOrEqual(1);
    expect(result.selectedCandidate).toBeDefined();
  });

  /**
   * GATE G53: SEARCH_EFFICIENCY
   *
   * Compare:
   *   fixed Best-of-N
   *   vs
   *   adaptive search
   * on equivalent workload.
   *
   * Measure:
   *   success
   *   tokens
   *   model calls
   *   wall time
   *   compute
   *   candidate count
   *
   * Report actual efficiency delta.
   */
  it('G53: Search Efficiency — compares fixed Best-of-N vs adaptive search and measures efficiency delta', async () => {
    const service = new SolutionSearchService({
      checkpointService: mockCheckpointService,
      worktreeManager: mockWorktreeManager,
      executionEngine: mockExecutionEngine,
      evaluationService: mockEvaluationService,
    });

    // Equivalent workload: Candidate 1 and 2 succeed with high quality; later candidates repeat redundant work.
    const workloadRunner: CandidateRunner = async ({ candidateId }) => {
      // Simulate small execution delay
      await new Promise((resolve) => setTimeout(resolve, 10));

      return {
        execution: { id: `exec-${candidateId}`, taskId: 'task-1', status: 'completed' } as any,
        task: { id: 'task-1' } as any,
        policyDecisions: [],
        toolCalls: [
          { id: 'call-1', tool: 'readFile', input: {}, ok: true, policyEffect: 'allow', policyRule: 'r', durationMs: 5, at: new Date() },
          { id: 'call-2', tool: 'writeFile', input: {}, ok: true, policyEffect: 'allow', policyRule: 'r', durationMs: 5, at: new Date() },
        ],
        filesChanged: ['src/index.ts'],
        checks: [
          { name: 'test', command: 'npm test', ok: true, output: 'passed', durationMs: 20 },
        ],
        errors: [],
        events: [],
        usage: { input: 1000, output: 500, total: 1500 },
        repairCycles: 0,
      } as any;
    };

    // 1. Run Fixed Best-of-N (N = 4)
    const fixedRequest: SolutionSearchRequest = {
      executionId: 'exec-parent',
      objective: 'Search Efficiency Benchmark',
      strategy: 'same_model_diverse',
      candidates: 4,
      maxParallelCandidates: 2,
      selectionPolicy: {
        earlyStopOnSufficient: false, // Fixed Best-of-N runs all candidates
      },
    };

    const fixedStart = Date.now();
    const fixedResult = await service.search(fixedRequest, workloadRunner);
    const fixedWallTimeMs = Date.now() - fixedStart;

    // 2. Run Adaptive Search (starts with 2, stops when sufficient / cannot materially improve)
    const adaptiveRequest: SolutionSearchRequest = {
      executionId: 'exec-parent',
      objective: 'Search Efficiency Benchmark',
      strategy: 'same_model_diverse',
      candidates: 4,
      maxParallelCandidates: 2,
      adaptive: {
        enabled: true,
        initialCandidates: 2,
        maxCandidates: 4,
        stoppingCriteria: {
          stopOnSufficient: true,
          stopWhenCannotMateriallyImprove: true,
        },
      },
    };

    const adaptiveStart = Date.now();
    const adaptiveResult = await service.search(adaptiveRequest, workloadRunner);
    const adaptiveWallTimeMs = Date.now() - adaptiveStart;

    // Measure efficiency metrics
    const fixedCandidatesCount = fixedResult.candidates.length;
    const adaptiveCandidatesCount = adaptiveResult.candidates.length;
    const candidateSavingsRatio = (fixedCandidatesCount - adaptiveCandidatesCount) / fixedCandidatesCount;

    const fixedTokens = fixedResult.totalTokens;
    const adaptiveTokens = adaptiveResult.totalTokens;
    const tokenSavingsRatio = (fixedTokens - adaptiveTokens) / fixedTokens;

    const fixedModelCalls = fixedResult.totalModelCalls;
    const adaptiveModelCalls = adaptiveResult.totalModelCalls;
    const callSavingsRatio = (fixedModelCalls - adaptiveModelCalls) / fixedModelCalls;

    const fixedSuccess = fixedResult.selectedCandidate?.evaluation?.qualifies === true;
    const adaptiveSuccess = adaptiveResult.selectedCandidate?.evaluation?.qualifies === true;

    // Report actual efficiency delta
    const efficiencyReport = {
      fixed: {
        candidates: fixedCandidatesCount,
        tokens: fixedTokens,
        modelCalls: fixedModelCalls,
        wallTimeMs: fixedWallTimeMs,
        success: fixedSuccess,
      },
      adaptive: {
        candidates: adaptiveCandidatesCount,
        tokens: adaptiveTokens,
        modelCalls: adaptiveModelCalls,
        wallTimeMs: adaptiveWallTimeMs,
        success: adaptiveSuccess,
      },
      delta: {
        candidateReductionPct: `${(candidateSavingsRatio * 100).toFixed(1)}%`,
        tokenSavingsPct: `${(tokenSavingsRatio * 100).toFixed(1)}%`,
        modelCallSavingsPct: `${(callSavingsRatio * 100).toFixed(1)}%`,
        wallTimeSavingsMs: fixedWallTimeMs - adaptiveWallTimeMs,
        successPreserved: fixedSuccess === adaptiveSuccess,
      },
    };

    console.log('\n--- G53 SEARCH EFFICIENCY REPORT ---');
    console.log(JSON.stringify(efficiencyReport, null, 2));
    console.log('------------------------------------\n');

    // Assertions
    expect(fixedSuccess).toBe(true);
    expect(adaptiveSuccess).toBe(true);
    expect(adaptiveCandidatesCount).toBeLessThan(fixedCandidatesCount);
    expect(adaptiveTokens).toBeLessThan(fixedTokens);
    expect(adaptiveModelCalls).toBeLessThan(fixedModelCalls);
    expect(tokenSavingsRatio).toBeGreaterThanOrEqual(0.4); // At least 40% token savings
    expect(candidateSavingsRatio).toBeGreaterThanOrEqual(0.4); // At least 40% candidate count reduction
    expect(adaptiveResult.adaptiveTelemetry?.stopConditionTriggered).toBeDefined();
  });
});
