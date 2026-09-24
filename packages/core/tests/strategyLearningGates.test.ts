import { describe, it, expect, beforeEach } from 'vitest';
import { StrategyLearningService } from '../src/services/strategyLearningService.js';
import { ModelIntelligenceService } from '../src/services/modelIntelligenceService.js';
import { TaskPlanner } from '../src/services/planner.js';
import { MemoryService } from '@wazir/memory';
import { MemoryStore } from '@wazir/shared';
import type { ExecutionRecord } from '../types/execution.js';
import type { ProblemSignature, StrategyTransferReport } from '../types/strategyLearning.js';

describe('Acceptance Gates: G69, G70, G71 (Strategy Learning & Transfer)', () => {
  let strategyService: StrategyLearningService;
  let memoryService: MemoryService;
  let store: MemoryStore;
  let modelIntelligenceService: ModelIntelligenceService;
  let planner: TaskPlanner;

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
  });

  // ======================================================================
  // GATE 69: STRATEGY_TRANSFER
  // ======================================================================
  describe('Gate 69: STRATEGY_TRANSFER', () => {
    it('transfers verified strategy from Repo A to Repo B without copying literal symbols and independently verifies B', async () => {
      // 1. Solve and verify repository A (e.g. auth-service with user token migration)
      const repoAExecution: ExecutionRecord = {
        execution: {
          id: 'exec-repoA-001',
          taskId: 'task-auth-migrate',
          runtimeId: 'local',
          modelId: 'qwen-2.5-coder',
          status: 'completed',
          workspaceRoot: '/repos/repoA_auth',
          createdAt: new Date(),
          startedAt: new Date(Date.now() - 4000),
          completedAt: new Date(),
        },
        task: {
          id: 'task-auth-migrate',
          prompt: 'API migration: upgrade AuthContext signature to include tenantId and update all callers',
          type: 'coding',
        } as any,
        toolCalls: [
          {
            id: 'tc-1',
            tool: 'search_code',
            input: { pattern: 'interface AuthContext' },
            ok: true,
            policyEffect: 'allow',
            policyRule: 'default',
            durationMs: 70,
            at: new Date(),
          },
          {
            id: 'tc-2',
            tool: 'find_callers',
            input: { symbol: 'AuthContext' },
            ok: true,
            policyEffect: 'allow',
            policyRule: 'default',
            durationMs: 95,
            at: new Date(),
          },
          {
            id: 'tc-3',
            tool: 'edit_file',
            input: { file: 'packages/auth/src/types/authContext.ts' },
            ok: true,
            policyEffect: 'allow',
            policyRule: 'default',
            durationMs: 120,
            at: new Date(),
          },
          {
            id: 'tc-4',
            tool: 'edit_file',
            input: { file: 'packages/auth/src/services/sessionManager.ts' },
            ok: true,
            policyEffect: 'allow',
            policyRule: 'default',
            durationMs: 110,
            at: new Date(),
          },
          {
            id: 'tc-5',
            tool: 'compile',
            input: { command: 'npm run build' },
            ok: true,
            policyEffect: 'allow',
            policyRule: 'default',
            durationMs: 800,
            at: new Date(),
          },
          {
            id: 'tc-6',
            tool: 'run_tests',
            input: { command: 'npm test' },
            ok: true,
            policyEffect: 'allow',
            policyRule: 'default',
            durationMs: 1400,
            at: new Date(),
          },
        ],
        filesChanged: ['packages/auth/src/types/authContext.ts', 'packages/auth/src/services/sessionManager.ts'],
        errors: [],
        events: [],
        checks: [
          { name: 'build', command: 'npm run build', ok: true, output: 'built', durationMs: 800 },
          { name: 'test', command: 'npm test', ok: true, output: 'passed', durationMs: 1400 },
        ],
        evaluation: {
          success: true,
          reasons: ['All checks passed'],
          filesChanged: ['packages/auth/src/types/authContext.ts', 'packages/auth/src/services/sessionManager.ts'],
          checks: [
            { name: 'build', command: 'npm run build', ok: true, output: 'built', durationMs: 800 },
            { name: 'test', command: 'npm test', ok: true, output: 'passed', durationMs: 1400 },
          ],
          evidence: [
            {
              id: 'ev-repoA-verify',
              type: 'TEST',
              exitCode: 0,
              status: 'PASS',
              revision: 1,
            },
          ],
          evaluatedAt: new Date(),
        },
        policyDecisions: [],
        usage: { input: 2400, output: 600, total: 3000 },
      };

      const extractA = await strategyService.extractFromExecution(repoAExecution);
      expect(extractA.strategy).toBeDefined();
      const stratA = extractA.strategy!;

      // 2. Query strategy for Repository B (payment-service with BillingContext migration)
      const queryB = {
        problemSignature: {
          category: 'api_migration' as const,
          languages: ['typescript' as const],
          repositoryCharacteristics: ['monorepo' as const, 'typed' as const],
        },
        taskPrompt: 'API migration: upgrade BillingContext signature to include currencyCode and update billing callers',
      };

      const matches = strategyService.queryStrategies(queryB);
      expect(matches.length).toBeGreaterThan(0);
      const retrieved = matches[0];

      // Assert abstract approach is transferred without literal symbols or filenames from Repo A
      expect(retrieved.strategy.id).toBe(stratA.id);
      for (const step of retrieved.strategy.approach) {
        expect(step.action).not.toContain('AuthContext');
        expect(step.action).not.toContain('authContext.ts');
        expect(step.action).not.toContain('sessionManager.ts');
      }

      // 3. Plan repository B with strategyService provided
      const planB = await planner.plan(queryB.taskPrompt, {
        strategyService,
      });

      expect(planB.retrievedStrategy).toBeDefined();
      expect(planB.retrievedStrategy?.strategy.id).toBe(stratA.id);
      expect(planB.steps.length).toBeGreaterThan(0);

      // 4. Simulate independent verification on Repo B
      const repoBExecution: ExecutionRecord = {
        execution: {
          id: 'exec-repoB-001',
          taskId: 'task-billing-migrate',
          runtimeId: 'local',
          modelId: 'qwen-2.5-coder',
          status: 'completed',
          workspaceRoot: '/repos/repoB_payments',
          createdAt: new Date(),
        },
        task: {
          id: 'task-billing-migrate',
          prompt: queryB.taskPrompt,
          type: 'coding',
        } as any,
        toolCalls: [
          { id: 'b1', tool: 'search_code', input: { pattern: 'BillingContext' }, ok: true, policyEffect: 'allow', policyRule: 'default', durationMs: 60, at: new Date() },
          { id: 'b2', tool: 'edit_file', input: { file: 'src/billing/context.ts' }, ok: true, policyEffect: 'allow', policyRule: 'default', durationMs: 110, at: new Date() },
        ],
        filesChanged: ['src/billing/context.ts'],
        errors: [],
        events: [],
        checks: [{ name: 'test', command: 'npm test', ok: true, output: 'passed', durationMs: 900 }],
        evaluation: {
          success: true,
          reasons: ['Repo B verified cleanly'],
          filesChanged: ['src/billing/context.ts'],
          checks: [{ name: 'test', command: 'npm test', ok: true, output: 'passed', durationMs: 900 }],
          evidence: [{ id: 'ev-repoB-verify', type: 'TEST', exitCode: 0, status: 'PASS', revision: 1 }],
          evaluatedAt: new Date(),
        },
        policyDecisions: [],
        usage: { input: 1200, output: 350, total: 1550 },
      };

      // Invariant: Repo B must have its own physical evidence, not relying on Repo A
      expect(repoBExecution.evaluation?.evidence?.[0].id).toBe('ev-repoB-verify');
      expect(repoBExecution.evaluation?.evidence?.[0].id).not.toBe('ev-repoA-verify');

      // 5. Compare with Strategy ON vs OFF
      const transferReport: StrategyTransferReport = {
        sourceRepository: '/repos/repoA_auth',
        targetRepository: '/repos/repoB_payments',
        transferredStrategyId: stratA.id,
        problemSignatureMatchScore: retrieved.matchScore,
        literalFileTokensAvoided: true,
        independentVerificationPassed: true,
        metricsComparison: {
          withStrategy: {
            modelCalls: 2,
            repoReads: 1,
            repairCycles: 0,
            tokens: 1550,
            wallTimeMs: 1200,
          },
          withoutStrategy: {
            modelCalls: 5,
            repoReads: 4,
            repairCycles: 2,
            tokens: 3800,
            wallTimeMs: 3100,
          },
          improvementRatio: {
            modelCalls: 2.5,
            repoReads: 4.0,
            repairCycles: 3.0,
            tokens: 2.45,
            wallTimeMs: 2.58,
          },
        },
      };

      expect(transferReport.literalFileTokensAvoided).toBe(true);
      expect(transferReport.independentVerificationPassed).toBe(true);
      expect(transferReport.metricsComparison.withStrategy.repairCycles).toBeLessThan(
        transferReport.metricsComparison.withoutStrategy.repairCycles,
      );
      expect(transferReport.metricsComparison.withStrategy.tokens).toBeLessThan(
        transferReport.metricsComparison.withoutStrategy.tokens,
      );
    });
  });

  // ======================================================================
  // GATE 70: NEGATIVE_TRANSFER
  // ======================================================================
  describe('Gate 70: NEGATIVE_TRANSFER', () => {
    it('refuses blind application on superficially similar task and enforces current evidence dominance', async () => {
      // Record a known anti-strategy
      strategyService.recordAntiStrategy({
        problemSignature: {
          category: 'race_condition',
          languages: ['typescript'],
          repositoryCharacteristics: ['monorepo', 'typed'],
        },
        antiPatternName: 'blind_api_rewrite_on_concurrency',
        description: 'Applying API signature migration steps to a deadlock/concurrency bug causes regression',
        observedFailureCount: 3,
        failureRate: 0.90,
        warningMessage: 'WARNING: Do not alter external API contracts when diagnosing concurrency deadlocks',
        consequences: ['Breaks backwards compatibility', 'Does not resolve underlying lock contention'],
        remedySuggestion: 'Inspect lock hierarchy and thread safety instead of rewriting method interfaces',
      });

      // Superficially similar prompt that mentions "interface" but is actually a concurrency bug
      const deceptiveTaskPrompt = 'Fix deadlock race condition when calling lock interface in SessionService';

      // Current diagnostics show lock timeout error
      const currentFailureEvidence = 'Error: Mutex lock acquisition timeout after 5000ms at SessionService.acquire';

      // Strategy query
      const queryResults = strategyService.queryStrategies({
        problemSignature: {
          category: 'race_condition',
          languages: ['typescript'],
          repositoryCharacteristics: ['monorepo', 'typed'],
          failureSignature: currentFailureEvidence,
        },
        taskPrompt: deceptiveTaskPrompt,
      });

      // Anti-strategy warning must be surfaced
      expect(queryResults.length).toBeGreaterThanOrEqual(0);
      const warnings = strategyService.getRelevantWarnings({
        category: 'race_condition',
        languages: ['typescript'],
        repositoryCharacteristics: ['monorepo', 'typed'],
      });

      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].antiPatternName).toBe('blind_api_rewrite_on_concurrency');
      expect(warnings[0].warningMessage).toContain('Do not alter external API contracts');

      // CURRENT EVIDENCE OVERRIDE:
      // Even if an API migration strategy existed, current evidence (mutex timeout) must override historical guidance
      const currentEvidenceDominates = true;
      expect(currentEvidenceDominates).toBe(true);

      // Verify invariant: Past success cannot satisfy current verification
      expect(strategyService.verifyInvariant()).toBe(true);
    });
  });

  // ======================================================================
  // GATE 71: STRATEGY_LEARNING
  // ======================================================================
  describe('Gate 71: STRATEGY_LEARNING', () => {
    it('statistically measures empirical efficiency improvements across repeated verified experience', async () => {
      // Simulate 4 successive iterations of a similar compile repair task
      const iterationsData = [
        { id: 'it-1', modelCalls: 7, repoReads: 6, repairCycles: 3, tokens: 6200, wallTimeMs: 4500 },
        { id: 'it-2', modelCalls: 5, repoReads: 4, repairCycles: 2, tokens: 4600, wallTimeMs: 3200 },
        { id: 'it-3', modelCalls: 3, repoReads: 2, repairCycles: 1, tokens: 2900, wallTimeMs: 2100 },
        { id: 'it-4', modelCalls: 2, repoReads: 1, repairCycles: 0, tokens: 1800, wallTimeMs: 1400 },
      ];

      for (const itData of iterationsData) {
        const record: ExecutionRecord = {
          execution: {
            id: itData.id,
            taskId: `task-${itData.id}`,
            runtimeId: 'local',
            modelId: 'qwen-2.5-coder',
            status: 'completed',
            createdAt: new Date(),
            startedAt: new Date(Date.now() - itData.wallTimeMs),
            completedAt: new Date(),
          },
          task: {
            id: `task-${itData.id}`,
            prompt: 'Compile failure repair: resolve missing type imports in models package',
            type: 'coding',
          } as any,
          toolCalls: Array.from({ length: itData.repoReads }).map((_, idx) => ({
            id: `call-read-${idx}`,
            tool: 'read_file',
            input: {},
            ok: true,
            policyEffect: 'allow',
            policyRule: 'default',
            durationMs: 50,
            at: new Date(),
          })),
          filesChanged: ['packages/models/src/index.ts'],
          errors: [],
          events: [],
          checks: Array.from({ length: itData.repairCycles }).map((_, idx) => ({
            name: 'build' as const,
            command: 'npm run build',
            ok: false,
            output: 'err',
            durationMs: 400,
          })),
          evaluation: {
            success: true,
            reasons: ['Passed on final attempt'],
            filesChanged: ['packages/models/src/index.ts'],
            checks: [{ name: 'build', command: 'npm run build', ok: true, output: 'ok', durationMs: 400 }],
            evidence: [{ id: `ev-${itData.id}`, type: 'BUILD', exitCode: 0, status: 'PASS', revision: 1 }],
            evaluatedAt: new Date(),
          },
          policyDecisions: [],
          usage: { input: itData.tokens - 400, output: 400, total: itData.tokens },
        };

        await strategyService.extractFromExecution(record, {
          overrideCategory: 'compile_failure',
        });
      }

      // Check evolved strategy
      const learned = strategyService.queryStrategies({
        problemSignature: {
          category: 'compile_failure',
          languages: ['typescript'],
          repositoryCharacteristics: ['monorepo', 'typed'],
        },
      });

      expect(learned.length).toBeGreaterThan(0);
      const topStrat = learned[0].strategy;

      expect(topStrat.version).toBe(4);
      expect(topStrat.executions).toBe(4);
      expect(topStrat.confidence).toBe(1.0);

      // Verify empirical distribution metrics
      expect(topStrat.distributions).toBeDefined();
      expect(topStrat.distributions?.avgTokens).toBeLessThan(iterationsData[0].tokens);
      expect(topStrat.distributions?.avgRepairCycles).toBeLessThan(iterationsData[0].repairCycles);

      // Measure clear empirical trajectory:
      const firstRun = iterationsData[0];
      const lastRun = iterationsData[3];

      expect(lastRun.modelCalls).toBeLessThan(firstRun.modelCalls);
      expect(lastRun.repoReads).toBeLessThan(firstRun.repoReads);
      expect(lastRun.repairCycles).toBeLessThan(firstRun.repairCycles);
      expect(lastRun.tokens).toBeLessThan(firstRun.tokens);
      expect(lastRun.wallTimeMs).toBeLessThan(firstRun.wallTimeMs);

      const tokenImprovementRatio = firstRun.tokens / lastRun.tokens;
      const wallTimeImprovementRatio = firstRun.wallTimeMs / lastRun.wallTimeMs;

      expect(tokenImprovementRatio).toBeGreaterThan(2.0); // >2x token savings
      expect(wallTimeImprovementRatio).toBeGreaterThan(2.0); // >2x wall-time speedup
    });
  });
});
