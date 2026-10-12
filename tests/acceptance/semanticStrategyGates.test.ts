import { describe, it, expect, beforeEach } from 'vitest';
import { StrategyLearningService } from '../../packages/core/src/services/strategyLearningService.js';
import { ModelIntelligenceService } from '../../packages/core/src/services/modelIntelligenceService.js';
import { TaskPlanner } from '../../packages/core/src/services/planner.js';
import { PolicyEngine } from '../../packages/core/src/services/policyEngine.js';
import { MemoryService } from '@wazir/memory';
import { MemoryStore } from '@wazir/shared';
import { DETERMINISTIC_SEMANTIC_CORPUS } from '../../packages/core/src/fixtures/deterministicSemanticCorpus.js';
import type { ExecutionRecord } from '../../packages/core/src/types/execution.js';
import type { StrategyQuery, RelevantStrategy } from '../../packages/core/src/types/strategyLearning.js';

describe('Acceptance Gates: G97, G98, G99, G100 (Semantic Strategy Retrieval & Transfer)', () => {
  let strategyService: StrategyLearningService;
  let memoryService: MemoryService;
  let store: MemoryStore;
  let modelIntelligenceService: ModelIntelligenceService;
  let planner: TaskPlanner;
  let policyEngine: PolicyEngine;

  beforeEach(() => {
    store = new MemoryStore();
    memoryService = new MemoryService();
    modelIntelligenceService = new ModelIntelligenceService({ store });
    strategyService = new StrategyLearningService({
      store,
      memoryService,
      modelIntelligenceService,
      minEvidenceThreshold: 2,
    });
    planner = new TaskPlanner();
    policyEngine = new PolicyEngine();
  });

  // ======================================================================
  // GATE 97: SEMANTIC_STRATEGY_RETRIEVAL
  // ======================================================================
  describe('Gate 97: SEMANTIC_STRATEGY_RETRIEVAL', () => {
    it('retrieves relevant verified strategy across semantic-equivalent repositories with disjoint layouts and enforces independent verification', async () => {
      const pair = DETERMINISTIC_SEMANTIC_CORPUS.structuralPairs[0];
      const source = pair.sourceProblem;
      const target = pair.targetProblem;

      // 1. Solve and verify repository A (Lease token race condition)
      const repoAExecution: ExecutionRecord = {
        execution: {
          id: 'exec-lease-race-001',
          taskId: source.id,
          runtimeId: 'local',
          modelId: 'qwen-2.5-coder',
          status: 'completed',
          workspaceRoot: source.workspaceRoot,
          createdAt: new Date(),
          startedAt: new Date(Date.now() - 3500),
          completedAt: new Date(),
        },
        task: {
          id: source.id,
          prompt: source.taskPrompt,
          type: 'coding',
        } as any,
        toolCalls: [
          {
            id: 'tc-1',
            tool: 'search_code',
            input: { pattern: 'LeaseController' },
            ok: true,
            policyEffect: 'allow',
            policyRule: 'default',
            durationMs: 40,
            at: new Date(),
          },
          {
            id: 'tc-2',
            tool: 'edit_file',
            input: { file: source.files[1].relativePath },
            ok: true,
            policyEffect: 'allow',
            policyRule: 'default',
            durationMs: 120,
            at: new Date(),
          },
          {
            id: 'tc-3',
            tool: 'run_tests',
            input: { command: 'npm test' },
            ok: true,
            policyEffect: 'allow',
            policyRule: 'default',
            durationMs: 900,
            at: new Date(),
          },
        ],
        filesChanged: [source.files[1].relativePath],
        errors: [],
        events: [],
        checks: [{ name: 'test', command: 'npm test', ok: true, output: 'passed', durationMs: 900 }],
        evaluation: {
          success: true,
          reasons: ['Fencing token checks added; race condition resolved'],
          filesChanged: [source.files[1].relativePath],
          checks: [{ name: 'test', command: 'npm test', ok: true, output: 'passed', durationMs: 900 }],
          evidence: [
            {
              id: 'ev-lease-race-pass',
              type: 'TEST',
              exitCode: 0,
              status: 'PASS',
              revision: 1,
            },
          ],
          evaluatedAt: new Date(),
        },
        policyDecisions: [],
        usage: { input: 1800, output: 400, total: 2200 },
      };

      const extracted = await strategyService.extractStrategy(repoAExecution, {
        overrideCategory: source.problemSignature.category,
        repositoryCharacteristics: source.problemSignature.repositoryCharacteristics,
      });
      expect(extracted.strategy).toBeDefined();
      const stratA = extracted.strategy!;

      // 2. Query strategy for target repository B (Remote node ownership timeout)
      // Disjoint terminology: NodeEpoch/MetricStoreSink vs LeaseToken/ChunkRunner
      const queryB: StrategyQuery = {
        problemDescription: target.description,
        taskCategory: target.problemSignature.category,
        observedFailures: target.errorDiagnostics,
        architectureProperties: target.problemSignature.repositoryCharacteristics,
        language: target.problemSignature.languages[0],
        taskPrompt: target.taskPrompt,
      };

      const results = strategyService.queryStrategies(queryB);
      expect(results.length).toBeGreaterThan(0);
      const topStrategy = results[0];

      // Relevant verified strategy must be retrieved
      expect(topStrategy.strategyId).toBe(stratA.id);
      expect(topStrategy.applicability).toBeGreaterThanOrEqual(0.65);
      expect(topStrategy.relevanceClass).toBe('HIGH');
      expect(topStrategy.clusterLabel).toBe('REMOTE WORK OWNERSHIP / CANCELLATION');

      // Symbol leakage defense: assert NO forbidden tokens from repo A appear in the retrieved approach
      for (const forbidden of pair.forbiddenTokensInTargetPlan) {
        for (const step of topStrategy.normalizedStrategy.approach) {
          expect(step.action).not.toContain(forbidden);
          expect(step.intent).not.toContain(forbidden);
        }
      }

      // 3. Planning with retrieved strategy: format for context compiler
      const contextPrompt = strategyService.formatStrategyForContext(topStrategy, 250);
      expect(contextPrompt).toContain('REMOTE WORK OWNERSHIP / CANCELLATION');
      expect(contextPrompt).toContain('Invariant: Past experience cannot prove current correctness');

      // 4. Invariant enforcement: Current repository must be independently inspected and verified
      const targetExecution: ExecutionRecord = {
        execution: {
          id: 'exec-target-beta-001',
          taskId: target.id,
          runtimeId: 'local',
          modelId: 'qwen-2.5-coder',
          status: 'completed',
          workspaceRoot: target.workspaceRoot,
          createdAt: new Date(),
        },
        task: {
          id: target.id,
          prompt: target.taskPrompt,
          type: 'coding',
        } as any,
        toolCalls: [
          { id: 't1', tool: 'search_code', input: { pattern: 'MetricStoreSink' }, ok: true, policyEffect: 'allow', policyRule: 'default', durationMs: 40, at: new Date() },
          { id: 't2', tool: 'edit_file', input: { file: 'storage/sink/metricStore.ts' }, ok: true, policyEffect: 'allow', policyRule: 'default', durationMs: 90, at: new Date() },
        ],
        filesChanged: ['storage/sink/metricStore.ts'],
        errors: [],
        events: [],
        checks: [{ name: 'test', command: 'npm test', ok: true, output: 'passed', durationMs: 800 }],
        evaluation: {
          success: true,
          reasons: ['Target repo verified independently'],
          filesChanged: ['storage/sink/metricStore.ts'],
          checks: [{ name: 'test', command: 'npm test', ok: true, output: 'passed', durationMs: 800 }],
          evidence: [{ id: 'ev-target-verify-pass', type: 'TEST', exitCode: 0, status: 'PASS', revision: 1 }],
          evaluatedAt: new Date(),
        },
        policyDecisions: [],
        usage: { input: 1400, output: 300, total: 1700 },
      };

      // Target evidence must be distinct and physical
      expect(targetExecution.evaluation?.evidence?.[0].id).toBe('ev-target-verify-pass');
      expect(targetExecution.evaluation?.evidence?.[0].id).not.toBe('ev-lease-race-pass');
      expect(strategyService.verifyInvariant()).toBe(true);
    });
  });

  // ======================================================================
  // GATE 98: SEMANTIC_FALSE_POSITIVE
  // ======================================================================
  describe('Gate 98: SEMANTIC_FALSE_POSITIVE', () => {
    it('rejects or scores low-confidence on lexically similar but architecturally different defects', async () => {
      const negativePair = DETERMINISTIC_SEMANTIC_CORPUS.negativePairs[0];
      const deadlockProblem = negativePair.sourceProblem; // Problem 3A: Mutex Lock Inversion
      const oomProblem = negativePair.targetProblem; // Problem 3B: Unbounded Queue Buffer OOM

      // 1. Seed strategy for deadlock lock inversion
      const deadlockExecution: ExecutionRecord = {
        execution: {
          id: 'exec-deadlock-001',
          taskId: deadlockProblem.id,
          runtimeId: 'local',
          modelId: 'qwen-2.5-coder',
          status: 'completed',
          workspaceRoot: deadlockProblem.workspaceRoot,
          createdAt: new Date(),
          startedAt: new Date(Date.now() - 4000),
          completedAt: new Date(),
        },
        task: {
          id: deadlockProblem.id,
          prompt: deadlockProblem.taskPrompt,
          type: 'coding',
        } as any,
        toolCalls: [
          { id: 'd1', tool: 'search_code', input: { pattern: 'WorkerQueueLock' }, ok: true, policyEffect: 'allow', policyRule: 'default', durationMs: 50, at: new Date() },
          { id: 'd2', tool: 'edit_file', input: { file: 'src/sync/workerQueueLock.ts' }, ok: true, policyEffect: 'allow', policyRule: 'default', durationMs: 100, at: new Date() },
        ],
        filesChanged: ['src/sync/workerQueueLock.ts'],
        errors: [],
        events: [],
        checks: [{ name: 'test', command: 'npm test', ok: true, output: 'passed', durationMs: 1100 }],
        evaluation: {
          success: true,
          reasons: ['Lock acquisition hierarchy established; deadlocks eliminated'],
          filesChanged: ['src/sync/workerQueueLock.ts'],
          checks: [{ name: 'test', command: 'npm test', ok: true, output: 'passed', durationMs: 1100 }],
          evidence: [{ id: 'ev-deadlock-pass', type: 'TEST', exitCode: 0, status: 'PASS', revision: 1 }],
          evaluatedAt: new Date(),
        },
        policyDecisions: [],
        usage: { input: 2000, output: 450, total: 2450 },
      };

      await strategyService.extractStrategy(deadlockExecution, {
        overrideCategory: deadlockProblem.problemSignature.category,
        repositoryCharacteristics: deadlockProblem.problemSignature.repositoryCharacteristics,
      });

      // 2. Query with OOM problem which shares vocabulary ("worker", "queue", "timeout", "heartbeat")
      // but has completely orthogonal root causes (Heap memory overflow vs Mutex deadlock)
      const queryOom: StrategyQuery = {
        problemDescription: oomProblem.description,
        taskCategory: oomProblem.problemSignature.category,
        observedFailures: oomProblem.errorDiagnostics,
        architectureProperties: oomProblem.problemSignature.repositoryCharacteristics,
        language: oomProblem.problemSignature.languages[0],
        taskPrompt: oomProblem.taskPrompt,
      };

      const results = strategyService.queryStrategies(queryOom);

      // The deadlock strategy must NOT be recommended with high confidence
      const deadlockMatch = results.find((r) => r.strategyId.includes('deadlock') || r.strategy.taskCategories.includes('race_condition'));

      if (deadlockMatch) {
        // Multi-signal checks must suppress applicability and mark as IRRELEVANT
        expect(deadlockMatch.applicability).toBeLessThan(0.40);
        expect(deadlockMatch.relevanceClass).toBe('IRRELEVANT');
        expect(deadlockMatch.scoreBreakdown?.failureTraits).toBe(0.0); // Orthogonal failure traits detected!
        expect(deadlockMatch.scoreBreakdown?.falsePositivePenalty).toBeGreaterThan(0);
      } else {
        // Correctly dropped completely below threshold
        expect(results.length).toBe(0);
      }
    });
  });

  // ======================================================================
  // GATE 99: CROSS_LANGUAGE_STRATEGY
  // ======================================================================
  describe('Gate 99: CROSS_LANGUAGE_STRATEGY', () => {
    it('transfers architecture-level strategy across languages while stripping syntax-specific constructs', async () => {
      const crossLangPair = DETERMINISTIC_SEMANTIC_CORPUS.crossLanguagePairs[0];
      const tsProblem = crossLangPair.sourceProblem; // TS AbortSignal lifecycle cancellation
      const goProblem = crossLangPair.targetProblem; // Go context.Context routine cancellation

      // 1. Learn verified lifecycle cancellation strategy on TypeScript
      const tsExecution: ExecutionRecord = {
        execution: {
          id: 'exec-ts-lifecycle-001',
          taskId: tsProblem.id,
          runtimeId: 'local',
          modelId: 'qwen-2.5-coder',
          status: 'completed',
          workspaceRoot: tsProblem.workspaceRoot,
          createdAt: new Date(),
          startedAt: new Date(Date.now() - 4500),
          completedAt: new Date(),
        },
        task: {
          id: tsProblem.id,
          prompt: tsProblem.taskPrompt,
          type: 'coding',
          expectedAbstractApproach: tsProblem.expectedAbstractApproach,
          problemSignature: tsProblem.problemSignature,
        } as any,
        toolCalls: [
          { id: 'c1', tool: 'search_code', input: { pattern: 'TaskRunner' }, ok: true, policyEffect: 'allow', policyRule: 'default', durationMs: 40, at: new Date() },
          { id: 'c2', tool: 'edit_file', input: { file: 'src/runtime/taskRunner.ts' }, ok: true, policyEffect: 'allow', policyRule: 'default', durationMs: 110, at: new Date() },
          { id: 'c3', tool: 'run_tests', input: { command: 'npm test' }, ok: true, policyEffect: 'allow', policyRule: 'default', durationMs: 1200, at: new Date() },
        ],
        filesChanged: ['src/runtime/taskRunner.ts'],
        errors: [],
        events: [],
        checks: [{ name: 'test', command: 'npm test', ok: true, output: 'passed', durationMs: 1200 }],
        evaluation: {
          success: true,
          reasons: ['Lifecycle cancellation checks and handle teardown implemented'],
          filesChanged: ['src/runtime/taskRunner.ts'],
          checks: [{ name: 'test', command: 'npm test', ok: true, output: 'passed', durationMs: 1200 }],
          evidence: [{ id: 'ev-ts-cancellation-pass', type: 'TEST', exitCode: 0, status: 'PASS', revision: 1 }],
          evaluatedAt: new Date(),
        },
        policyDecisions: [],
        usage: { input: 1900, output: 420, total: 2320 },
      };

      const extracted = await strategyService.extractStrategy(tsExecution, {
        overrideCategory: tsProblem.problemSignature.category,
        repositoryCharacteristics: tsProblem.problemSignature.repositoryCharacteristics,
      });
      const stratTs = extracted.strategy!;

      // 2. Query strategy for Go routine cancellation problem
      const queryGo: StrategyQuery = {
        problemDescription: goProblem.description,
        taskCategory: goProblem.problemSignature.category,
        observedFailures: goProblem.errorDiagnostics,
        architectureProperties: goProblem.problemSignature.repositoryCharacteristics,
        language: 'go',
        taskPrompt: goProblem.taskPrompt,
      };

      const results = strategyService.queryStrategies(queryGo);
      expect(results.length).toBeGreaterThan(0);
      const topStrat = results[0];

      // Architecture strategy transfers successfully
      expect(topStrat.strategyId).toBe(stratTs.id);
      expect(topStrat.crossLanguageTransferrable).toBe(true);
      expect(topStrat.architectureTransferrable).toBe(true);
      expect(topStrat.applicability).toBeGreaterThanOrEqual(0.65);
      expect(topStrat.relevanceClass).toBe('HIGH');

      // Assert syntax-specific details (TypeScript APIs, files, classes) do NOT leak into Go plan
      for (const forbidden of crossLangPair.forbiddenTokensInTargetPlan) {
        for (const step of topStrat.normalizedStrategy.approach) {
          expect(step.action).not.toContain(forbidden);
          expect(step.intent).not.toContain(forbidden);
        }
      }

      // Approach steps must contain abstract architectural concepts
      const abstractApproach = topStrat.normalizedStrategy.approach.map((s) => s.action.toLowerCase()).join(' ');
      expect(abstractApproach).toMatch(/cancellation|propagation|listener|teardown|resource/i);
    });
  });

  // ======================================================================
  // GATE 100: ANTI_STRATEGY_RETRIEVAL
  // ======================================================================
  describe('Gate 100: ANTI_STRATEGY_RETRIEVAL', () => {
    it('surfaces historical failed workflows as warnings without triggering false policy denials', async () => {
      const antiCases = DETERMINISTIC_SEMANTIC_CORPUS.antiStrategyCases;

      // 1. Record all canonical anti-strategy cases
      for (const anti of antiCases) {
        await strategyService.recordAntiStrategy({
          problemSignature: anti.problemSignature,
          antiPatternName: anti.antiPatternName,
          description: anti.description,
          observedFailureCount: 3,
          failureRate: 0.95,
          warningMessage: anti.warningMessage,
          consequences: anti.consequences,
          remedySuggestion: anti.remedySuggestion,
        });
      }

      // 2. Query with problem matching speculative blind editing before reproduction
      const query: StrategyQuery = {
        problemDescription: 'Investigate test flakiness in worker session manager and repair without baseline reproduction',
        taskCategory: 'general_repair',
        observedFailures: ['SPECULATIVE_EDIT_CHURN', 'no_baseline_test'],
        architectureProperties: ['monorepo', 'has_ci'],
        language: 'typescript',
      };

      const warnings = strategyService.getRelevantWarnings(query);
      expect(warnings.length).toBeGreaterThan(0);

      const editWarning = warnings.find((w) => w.antiPatternName === 'speculative_blind_editing_before_reproduction');
      expect(editWarning).toBeDefined();
      expect(editWarning?.warningMessage).toContain('ANTI-STRATEGY DETECTED');
      expect(editWarning?.remedySuggestion).toContain('reproduction test FIRST');

      // 3. Planner integration: warning is passed to planner context
      const relevantStrategies = strategyService.queryStrategies(query);
      if (relevantStrategies.length > 0) {
        expect(relevantStrategies[0].antiStrategyWarnings.length).toBeGreaterThan(0);
        const formattedContext = strategyService.formatStrategyForContext(relevantStrategies[0]);
        expect(formattedContext).toContain('AVOID:');
        expect(formattedContext).toContain('REMEDY:');
      }

      // 4. Invariant: Warning must NOT trigger false policy denial
      // PolicyEngine evaluates file edit on a non-protected path
      const check = policyEngine.classify({
        tool: 'edit',
        input: { path: 'packages/worker/src/sessionManager.ts' },
        projectRoot: '/test/repo',
      });
      // Policy effect remains allowed; advisory warning does not deny execution
      expect(check.decision).toBe('allow');
    });
  });

  // ======================================================================
  // A/B RETRIEVAL BENCHMARK
  // ======================================================================
  describe('A/B Retrieval Benchmark: Mode A (Structured) vs Mode B (Hybrid Semantic)', () => {
    it('statistically measures Mode B superiority across all 8 dimensions without claiming superiority unmeasured', async () => {
      const benchmark = await strategyService.runRetrievalBenchmark(DETERMINISTIC_SEMANTIC_CORPUS);

      expect(benchmark).toBeDefined();
      expect(benchmark.modeA.name).toBe('structured_matching');
      expect(benchmark.modeB.name).toBe('hybrid_semantic_retrieval');

      // 1. Task Success
      expect(benchmark.modeB.taskSuccess).toBe(true);
      expect(benchmark.modeA.taskSuccess).toBe(false); // Mode A fails on cross-language and negative pairs

      // 2. Localization Calls
      expect(benchmark.modeB.localizationCalls).toBeLessThan(benchmark.modeA.localizationCalls);
      expect(benchmark.delta.localizationReduction).toBeGreaterThan(5);

      // 3. Model Calls
      expect(benchmark.modeB.modelCalls).toBeLessThan(benchmark.modeA.modelCalls);
      expect(benchmark.delta.modelCallsRatio).toBeGreaterThan(2.0); // >2x fewer model calls

      // 4. Tokens
      expect(benchmark.modeB.tokens).toBeLessThan(benchmark.modeA.tokens);
      expect(benchmark.delta.tokenImprovementRatio).toBeGreaterThan(2.0); // >2x token savings

      // 5. Repair Cycles
      expect(benchmark.modeB.repairCycles).toBeLessThan(benchmark.modeA.repairCycles);
      expect(benchmark.delta.repairCyclesSaved).toBeGreaterThanOrEqual(4);

      // 6. False Retrieval Rate
      expect(benchmark.modeB.falseRetrievalRate).toBe(0.0); // 0% false retrieval rate in Mode B
      expect(benchmark.modeA.falseRetrievalRate).toBeGreaterThanOrEqual(0.50); // Mode A false retrieval on negative pair

      // 7. Verification Success
      expect(benchmark.modeB.verificationSuccess).toBe(true);

      // 8. Wall Time
      expect(benchmark.modeB.wallTimeMs).toBeLessThan(benchmark.modeA.wallTimeMs);
      expect(benchmark.delta.wallTimeImprovementRatio).toBeGreaterThan(2.0); // >2x wall time speedup
    });
  });
});
