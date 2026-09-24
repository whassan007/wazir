import { describe, it, expect, beforeEach } from 'vitest';
import { StrategyLearningService } from '../src/services/strategyLearningService.js';
import { ModelIntelligenceService } from '../src/services/modelIntelligenceService.js';
import { MemoryService } from '@wazir/memory';
import { MemoryStore } from '@wazir/shared';
import type { ExecutionRecord } from '../types/execution.js';
import type { ProblemSignature } from '../types/strategyLearning.js';

describe('StrategyLearningService Unit & Lifecycle Tests', () => {
  let strategyService: StrategyLearningService;
  let memoryService: MemoryService;
  let store: MemoryStore;
  let modelIntelligenceService: ModelIntelligenceService;

  beforeEach(() => {
    store = new MemoryStore();
    memoryService = new MemoryService();
    modelIntelligenceService = new ModelIntelligenceService({ store });
    strategyService = new StrategyLearningService({
      store,
      memoryService,
      modelIntelligenceService,
      minEvidenceThreshold: 3,
    });
  });

  it('enforces INVARIANT: Past Success != Current Evidence', () => {
    expect(strategyService.verifyInvariant()).toBe(true);
  });

  it('extracts strategy only from verified runs and ignores unverified ones', async () => {
    const unverifiedRecord: ExecutionRecord = {
      execution: {
        id: 'exec-fail-001',
        taskId: 'task-fail-001',
        runtimeId: 'test-runtime',
        modelId: 'qwen-2.5-coder',
        status: 'failed',
        createdAt: new Date(),
      },
      task: {
        id: 'task-fail-001',
        prompt: 'Fix compile error in packages/core/src/types/index.ts',
        type: 'coding',
      } as any,
      toolCalls: [
        {
          id: 'call-1',
          tool: 'edit_file',
          input: { file: 'packages/core/src/types/index.ts' },
          ok: false,
          policyEffect: 'allow',
          policyRule: 'default',
          durationMs: 120,
          at: new Date(),
        },
      ],
      errors: ['TS2304: Cannot find name "NonExistent" in /home/wael/Code/Wazir/packages/core/src/types/index.ts:42:15'],
      events: [],
      filesChanged: ['packages/core/src/types/index.ts'],
      checks: [{ name: 'typecheck', command: 'tsc', ok: false, output: 'error', durationMs: 500 }],
      policyDecisions: [],
    };

    const extractResult = await strategyService.extractFromExecution(unverifiedRecord);
    expect(extractResult.strategy).toBeUndefined();
    expect(extractResult.antiStrategy).toBeDefined();
    expect(extractResult.antiStrategy?.antiPatternName).toBe('edit_before_reproduce');

    // Anti-strategy warning should now be returned on similar queries
    const warnings = strategyService.getRelevantWarnings({
      category: 'compile_failure',
      languages: ['typescript'],
      repositoryCharacteristics: ['monorepo', 'typed'],
    });
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].warningMessage).toContain('Edited files before reproducing');
  });

  it('extracts abstract structural approach and avoids literal filenames', async () => {
    const verifiedRecord: ExecutionRecord = {
      execution: {
        id: 'exec-pass-001',
        taskId: 'task-pass-001',
        runtimeId: 'test-runtime',
        modelId: 'qwen-2.5-coder',
        status: 'completed',
        createdAt: new Date(Date.now() - 5000),
        startedAt: new Date(Date.now() - 5000),
        completedAt: new Date(),
        workspaceRoot: '/test/repo/alpha',
      },
      task: {
        id: 'task-pass-001',
        prompt: 'Cross-package API migration: update TokenUsage across auth and core packages',
        type: 'coding',
      } as any,
      toolCalls: [
        {
          id: 'call-1',
          tool: 'search_code',
          input: { pattern: 'interface TokenUsage' },
          ok: true,
          policyEffect: 'allow',
          policyRule: 'default',
          durationMs: 80,
          at: new Date(),
        },
        {
          id: 'call-2',
          tool: 'find_callers',
          input: { symbol: 'TokenUsage' },
          ok: true,
          policyEffect: 'allow',
          policyRule: 'default',
          durationMs: 120,
          at: new Date(),
        },
        {
          id: 'call-3',
          tool: 'edit_file',
          input: { file: 'packages/core/src/types/tokens.ts' },
          ok: true,
          policyEffect: 'allow',
          policyRule: 'default',
          durationMs: 150,
          at: new Date(),
        },
        {
          id: 'call-4',
          tool: 'edit_file',
          input: { file: 'packages/auth/src/services/authService.ts' },
          ok: true,
          policyEffect: 'allow',
          policyRule: 'default',
          durationMs: 140,
          at: new Date(),
        },
        {
          id: 'call-5',
          tool: 'compile',
          input: { command: 'npm run build' },
          ok: true,
          policyEffect: 'allow',
          policyRule: 'default',
          durationMs: 800,
          at: new Date(),
        },
        {
          id: 'call-6',
          tool: 'run_tests',
          input: { command: 'npx vitest run' },
          ok: true,
          policyEffect: 'allow',
          policyRule: 'default',
          durationMs: 1200,
          at: new Date(),
        },
      ],
      filesChanged: ['packages/core/src/types/tokens.ts', 'packages/auth/src/services/authService.ts'],
      errors: [],
      events: [],
      checks: [
        { name: 'build', command: 'npm run build', ok: true, output: 'ok', durationMs: 800 },
        { name: 'test', command: 'npx vitest run', ok: true, output: 'ok', durationMs: 1200 },
      ],
      evaluation: {
        success: true,
        reasons: ['All checks passed'],
        filesChanged: ['packages/core/src/types/tokens.ts', 'packages/auth/src/services/authService.ts'],
        checks: [
          { name: 'build', command: 'npm run build', ok: true, output: 'ok', durationMs: 800 },
          { name: 'test', command: 'npx vitest run', ok: true, output: 'ok', durationMs: 1200 },
        ],
        evidence: [
          {
            id: 'ev-alpha-001',
            type: 'BUILD',
            exitCode: 0,
            status: 'PASS',
            revision: 1,
          },
        ],
        evaluatedAt: new Date(),
      },
      policyDecisions: [],
      usage: { input: 1500, output: 400, total: 1900 },
    };

    const extractResult = await strategyService.extractFromExecution(verifiedRecord);
    expect(extractResult.strategy).toBeDefined();
    const strategy = extractResult.strategy!;

    expect(strategy.problemSignature.category).toBe('api_migration');
    expect(strategy.languages).toContain('typescript');

    // Structural approach should not mention literal filenames
    for (const step of strategy.approach) {
      expect(step.action).not.toContain('packages/core/src/types/tokens.ts');
      expect(step.action).not.toContain('packages/auth/src/services/authService.ts');
    }

    // Sequence should contain find -> modify -> compile -> test -> verify
    const phases = strategy.approach.map((s) => s.phase);
    expect(phases).toContain('find');
    expect(phases).toContain('modify');
    expect(phases).toContain('compile');
    expect(phases).toContain('test');
    expect(strategy.usefulTools).toContain('search_code');
    expect(strategy.usefulTools).toContain('edit_file');

    // Confidence with 1 execution should be conservative
    expect(strategy.confidence).toBeLessThan(0.70);
  });

  it('evolves strategy as repeated verified evidence accumulates', async () => {
    const signature: ProblemSignature = {
      category: 'cross_package_feature',
      languages: ['typescript'],
      repositoryCharacteristics: ['monorepo', 'typed'],
    };

    const makeVerifiedRun = (id: string, tokens: number, repairCycles: number): ExecutionRecord => ({
      execution: {
        id,
        taskId: `task-${id}`,
        runtimeId: 'test-runtime',
        modelId: 'qwen-2.5-coder',
        status: 'completed',
        createdAt: new Date(),
      },
      task: {
        id: `task-${id}`,
        prompt: 'Cross-package feature implementation across monorepo packages',
        type: 'coding',
      } as any,
      toolCalls: [
        { id: '1', tool: 'search_code', input: {}, ok: true, policyEffect: 'allow', policyRule: 'default', durationMs: 50, at: new Date() },
        { id: '2', tool: 'edit_file', input: {}, ok: true, policyEffect: 'allow', policyRule: 'default', durationMs: 100, at: new Date() },
      ],
      filesChanged: ['a.ts', 'b.ts'],
      errors: [],
      events: [],
      checks: [{ name: 'test', command: 'test', ok: true, output: 'ok', durationMs: 500 }],
      evaluation: {
        success: true,
        reasons: ['Passed'],
        filesChanged: ['a.ts', 'b.ts'],
        checks: [{ name: 'test', command: 'test', ok: true, output: 'ok', durationMs: 500 }],
        evidence: [{ id: `ev-${id}`, type: 'TEST', exitCode: 0, status: 'PASS', revision: 1 }],
        evaluatedAt: new Date(),
      },
      policyDecisions: [],
      usage: { input: tokens - 200, output: 200, total: tokens },
    });

    const run1 = await strategyService.extractFromExecution(makeVerifiedRun('run-1', 4000, 2));
    expect(run1.strategy?.version).toBe(1);
    expect(run1.strategy?.executions).toBe(1);
    expect(run1.strategy?.confidence).toBeCloseTo(0.33, 1);

    const run2 = await strategyService.extractFromExecution(makeVerifiedRun('run-2', 3200, 1));
    expect(run2.strategy?.version).toBe(2);
    expect(run2.strategy?.executions).toBe(2);
    expect(run2.strategy?.confidence).toBeCloseTo(0.67, 1);

    const run3 = await strategyService.extractFromExecution(makeVerifiedRun('run-3', 2500, 0));
    expect(run3.strategy?.version).toBe(3);
    expect(run3.strategy?.executions).toBe(3);
    expect(run3.strategy?.confidence).toBe(1.0);
    expect(run3.strategy?.distributions?.avgTokens).toBe(3233);
  });
});
