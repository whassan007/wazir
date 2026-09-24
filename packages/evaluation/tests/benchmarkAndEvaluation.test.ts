import { describe, it, expect } from 'vitest';
import type {
  ExecutionRecord,
  BenchmarkRunner,
  BenchmarkTask,
  BenchmarkExecutionContext,
} from '@wazir/core';
import {
  EvaluationService,
  BenchmarkService,
  BENCHMARK_CATEGORIES,
} from '../src/index.js';

describe('Gate 4 — Evaluation + Benchmark Framework', () => {
  const evalService = new EvaluationService({
    costPer1kInputTokens: 0.003,
    costPer1kOutputTokens: 0.015,
  });

  describe('Benchmark Categories & Canonical Tasks', () => {
    it('covers all 7 required benchmark categories', () => {
      const expectedCategories = [
        'CODE_REPAIR',
        'FEATURE_IMPLEMENTATION',
        'REPOSITORY_NAVIGATION',
        'CODE_INTELLIGENCE',
        'TOOL_USE',
        'CONTEXT_STRESS',
        'RECOVERY',
      ];

      expect(BENCHMARK_CATEGORIES).toEqual(expectedCategories);

      const benchService = new BenchmarkService(evalService);
      for (const cat of expectedCategories) {
        const tasks = benchService.listTasks(cat as any);
        expect(tasks.length).toBeGreaterThan(0);
        expect(tasks[0].category).toBe(cat);
      }
    });

    it('registers custom tasks and suites', () => {
      const benchService = new BenchmarkService(evalService);
      const customTask: BenchmarkTask = {
        id: 'custom-repair',
        name: 'Custom Repair Task',
        category: 'CODE_REPAIR',
        description: 'Test custom task',
        prompt: 'Fix bugs',
      };

      benchService.register(customTask);
      expect(benchService.getTask('custom-repair')).toBeDefined();
      expect(benchService.listTasks('CODE_REPAIR')).toContainEqual(customTask);
    });
  });

  describe('Controlled Task Execution in BenchmarkService', () => {
    it('executes a task in a controlled workspace and evaluates results', async () => {
      const benchService = new BenchmarkService(evalService);

      const mockRunner: BenchmarkRunner = {
        id: 'mock-agent-v1',
        name: 'Mock Coding Agent',
        async run(task: BenchmarkTask, ctx: BenchmarkExecutionContext): Promise<ExecutionRecord> {
          return {
            execution: {
              id: 'exec-bench-01',
              taskId: task.id,
              runtimeId: 'test-runtime',
              modelId: 'test-model',
              status: 'completed',
              createdAt: new Date(1000),
              startedAt: new Date(1000),
              completedAt: new Date(3500),
            },
            task: {
              id: task.id,
              type: 'benchmark',
              title: task.name,
              input: task.prompt,
              requirements: {},
              priority: 'normal',
              status: 'completed',
              createdAt: new Date(1000),
            },
            policyDecisions: [],
            toolCalls: [
              {
                id: 'tc-1',
                tool: 'fs_read',
                input: { path: 'src/math.ts' },
                ok: true,
                durationMs: 120,
                policyEffect: 'allow',
                policyRule: 'default',
                at: new Date(1500),
              },
              {
                id: 'tc-2',
                tool: 'fs_write',
                input: { path: 'src/math.ts', content: 'export function divide(a, b) { return b === 0 ? null : a / b; }' },
                ok: true,
                durationMs: 80,
                policyEffect: 'allow',
                policyRule: 'default',
                at: new Date(2000),
              },
            ],
            filesChanged: ['src/math.ts'],
            workspaceState: {
              workspaceId: 'ws-1',
              revision: 1,
              updatedAt: new Date(2000),
            },
            checks: [
              {
                workspaceRevision: 1,
                name: 'test',
                command: 'npm test',
                ok: true,
                output: 'All tests passed',
                durationMs: 450,
              },
            ],
            evidence: [
              {
                id: 'ev-test-1',
                type: 'TEST',
                revision: 1,
                command: 'npm test',
                exitCode: 0,
                durationMs: 450,
                output: 'All tests passed',
              },
            ],
            errors: [],
            usage: {
              input: 1200,
              output: 300,
              total: 1500,
            },
            events: [
              {
                id: 'e-1',
                executionId: 'exec-bench-01',
                type: 'generation.completed',
                timestamp: new Date(1800),
                data: { durationMs: 800, usage: { inputTokens: 1200, outputTokens: 300 } },
              },
              {
                id: 'e-2',
                executionId: 'exec-bench-01',
                type: 'turn.started',
                timestamp: new Date(1050),
                data: { turn: 1 },
              },
            ],
          };
        },
      };

      const result = await benchService.runTask('repair-failing-math-test', mockRunner);
      expect(result.taskId).toBe('repair-failing-math-test');
      expect(result.runnerId).toBe('mock-agent-v1');
      expect(result.scoreReport.passed).toBe(true);
      expect(result.scoreReport.metrics.taskSuccess).toBe(true);
      expect(result.scoreReport.metrics.physicalVerificationSuccess).toBe(true);
      expect(result.scoreReport.metrics.totalToolCalls).toBe(2);
      expect(result.scoreReport.metrics.totalModelCalls).toBe(1);
      expect(result.scoreReport.metrics.verificationLatencyMs).toBe(450);
    });

    it('runs an entire suite across a category', async () => {
      const benchService = new BenchmarkService(evalService);

      const mockRunner: BenchmarkRunner = {
        id: 'fast-runner',
        name: 'Fast Runner',
        async run(task: BenchmarkTask): Promise<ExecutionRecord> {
          return {
            execution: {
              id: `exec-${task.id}`,
              taskId: task.id,
              runtimeId: 'test-runtime',
              modelId: 'test-model',
              status: 'completed',
              createdAt: new Date(0),
              startedAt: new Date(0),
              completedAt: new Date(1000),
            },
            task: {
              id: task.id,
              type: 'benchmark',
              input: task.prompt,
              requirements: {},
              priority: 'normal',
              status: 'completed',
              createdAt: new Date(0),
            },
            policyDecisions: [],
            toolCalls: [],
            filesChanged: task.expectedFiles ?? [],
            workspaceState: {
              workspaceId: 'ws',
              revision: 1,
              updatedAt: new Date(),
            },
            checks: [
              {
                workspaceRevision: 1,
                name: 'test',
                command: 'test',
                ok: true,
                output: 'ok',
                durationMs: 100,
              },
            ],
            evidence: [
              {
                id: 'ev-test',
                type: 'TEST',
                revision: 1,
                command: 'test',
                exitCode: 0,
                durationMs: 100,
              },
              {
                id: 'ev-build',
                type: 'BUILD',
                revision: 1,
                command: 'build',
                exitCode: 0,
                durationMs: 100,
              },
            ],
            errors: [],
            usage: { input: 100, output: 50 },
            events: [],
          };
        },
      };

      const suiteResult = await benchService.runSuite('FEATURE_IMPLEMENTATION', mockRunner);
      expect(suiteResult.category).toBe('FEATURE_IMPLEMENTATION');
      expect(suiteResult.totalTasks).toBeGreaterThan(0);
      expect(suiteResult.passedTasks).toBe(suiteResult.totalTasks);
      expect(suiteResult.failedTasks).toBe(0);
      expect(suiteResult.aggregateMetrics.totalTokens).toBeGreaterThan(0);
    });
  });

  describe('Metric Recording Accuracy in EvaluationService', () => {
    it('accurately records model calls, tool calls, latency, tokens, cost, and compaction', () => {
      const record: ExecutionRecord = {
        execution: {
          id: 'exec-metrics-test',
          taskId: 'task-1',
          runtimeId: 'rt-1',
          modelId: 'model-1',
          status: 'completed',
          createdAt: new Date(10000),
          startedAt: new Date(10000),
          completedAt: new Date(18000), // 8000ms wall time
        },
        task: {
          id: 'task-1',
          type: 'coding',
          input: 'test',
          requirements: {},
          priority: 'normal',
          status: 'completed',
          createdAt: new Date(10000),
        },
        policyDecisions: [],
        toolCalls: [
          {
            id: 'tc-1',
            tool: 'fs_read',
            input: {},
            ok: true,
            durationMs: 150,
            policyEffect: 'allow',
            policyRule: 'rule',
            at: new Date(11000),
          },
          {
            id: 'tc-2',
            tool: 'fs_write',
            input: {},
            ok: true,
            durationMs: 250,
            policyEffect: 'allow',
            policyRule: 'rule',
            at: new Date(12000),
          },
        ],
        filesChanged: ['src/app.ts'],
        workspaceState: {
          workspaceId: 'ws',
          revision: 1,
          updatedAt: new Date(),
        },
        checks: [
          {
            workspaceRevision: 1,
            name: 'test',
            command: 'npm test',
            ok: true,
            output: 'ok',
            durationMs: 600,
          },
        ],
        evidence: [
          {
            id: 'ev-1',
            type: 'TEST',
            revision: 1,
            exitCode: 0,
            durationMs: 600,
          },
        ],
        errors: [],
        usage: {
          input: 5000,
          output: 1000,
          total: 6000,
        },
        events: [
          {
            id: 'ev-gen-1',
            executionId: 'exec-metrics-test',
            type: 'generation.completed',
            timestamp: new Date(11500),
            data: { durationMs: 2200 },
          },
          {
            id: 'ev-gen-2',
            executionId: 'exec-metrics-test',
            type: 'generation.completed',
            timestamp: new Date(14000),
            data: { durationMs: 1800 },
          },
          {
            id: 'ev-turn-1',
            executionId: 'exec-metrics-test',
            type: 'turn.started',
            timestamp: new Date(10000),
            data: { turn: 1 },
          },
          {
            id: 'ev-turn-2',
            executionId: 'exec-metrics-test',
            type: 'turn.started',
            timestamp: new Date(13000),
            data: { turn: 2 }, // turn 2 represents a repair / subsequent turn
          },
          {
            id: 'ev-compact',
            executionId: 'exec-metrics-test',
            type: 'context.compacted',
            timestamp: new Date(13500),
            data: { compactedTokens: 1400 },
          },
        ],
      };

      const report = evalService.evaluate(record);

      expect(report.passed).toBe(true);
      expect(report.metrics.taskSuccess).toBe(true);
      expect(report.metrics.physicalVerificationSuccess).toBe(true);
      expect(report.metrics.totalModelCalls).toBe(2);
      expect(report.metrics.totalToolCalls).toBe(2);
      expect(report.metrics.modelLatencyMs).toBe(4000); // 2200 + 1800
      expect(report.metrics.toolLatencyMs).toBe(400); // 150 + 250
      expect(report.metrics.verificationLatencyMs).toBe(600);
      expect(report.metrics.totalWallTimeMs).toBe(8000);
      expect(report.metrics.inputTokens).toBe(5000);
      expect(report.metrics.outputTokens).toBe(1000);
      expect(report.metrics.compactedTokens).toBe(1400);
      expect(report.metrics.repairCycles).toBe(1);

      // Cost calculation: (5000 / 1000) * 0.003 + (1000 / 1000) * 0.015 = 0.015 + 0.015 = 0.030 USD
      expect(report.metrics.costEstimateUsd).toBeCloseTo(0.03, 4);

      // Verify raw metrics alongside summary
      expect(report.metrics.rawMetrics).toBeDefined();
      expect(report.metrics.rawMetrics?.workspaceRevision).toBe(1);
      expect(report.metrics.rawMetrics?.filesChangedCount).toBe(1);
    });
  });

  describe('Non-Negotiable Invariant: Rejection Without Physical Verification Evidence', () => {
    it('rejects runs that claim success when no physical checks ran', () => {
      const record: ExecutionRecord = {
        execution: {
          id: 'exec-claim-only',
          taskId: 'task-fake',
          runtimeId: 'rt',
          modelId: 'model',
          status: 'completed',
          createdAt: new Date(),
        },
        task: {
          id: 'task-fake',
          type: 'coding',
          input: 'Fix everything',
          requirements: {},
          priority: 'normal',
          status: 'completed',
          createdAt: new Date(),
        },
        policyDecisions: [],
        toolCalls: [
          {
            id: 'tc-1',
            tool: 'fs_write',
            input: { path: 'src/file.ts' },
            ok: true,
            durationMs: 50,
            policyEffect: 'allow',
            policyRule: 'rule',
            at: new Date(),
          },
        ],
        filesChanged: ['src/file.ts'],
        workspaceState: {
          workspaceId: 'ws',
          revision: 1,
          updatedAt: new Date(),
        },
        checks: [], // NO CHECKS RUN!
        evidence: [], // NO PHYSICAL EVIDENCE!
        result: 'I have completely resolved the issue, and verified it works!',
        errors: [],
        events: [],
      };

      const report = evalService.evaluate(record);

      // Model claim != execution evidence!
      expect(report.passed).toBe(false);
      expect(report.metrics.physicalVerificationSuccess).toBe(false);
      expect(report.rejectionReason).toContain('REJECTED_WITHOUT_VERIFICATION');
    });

    it('rejects runs where checks are stale relative to final workspace revision', () => {
      const record: ExecutionRecord = {
        execution: {
          id: 'exec-stale-evidence',
          taskId: 'task-stale',
          runtimeId: 'rt',
          modelId: 'model',
          status: 'completed',
          createdAt: new Date(),
        },
        task: {
          id: 'task-stale',
          type: 'coding',
          input: 'Fix code',
          requirements: {},
          priority: 'normal',
          status: 'completed',
          createdAt: new Date(),
        },
        policyDecisions: [],
        toolCalls: [],
        filesChanged: ['src/a.ts', 'src/b.ts'],
        workspaceState: {
          workspaceId: 'ws',
          revision: 2, // Workspace was mutated to R2
          updatedAt: new Date(),
        },
        checks: [
          {
            workspaceRevision: 1, // Only ran at R1!
            name: 'test',
            command: 'npm test',
            ok: true,
            output: 'passed',
            durationMs: 200,
          },
        ],
        evidence: [
          {
            id: 'ev-test-r1',
            type: 'TEST',
            revision: 1, // Bound to R1, STALE at R2
            exitCode: 0,
            durationMs: 200,
          },
        ],
        acceptanceContract: {
          requiredEvidence: ['TEST'],
        },
        result: 'Passed tests at revision 1 and then modified revision 2',
        errors: [],
        events: [],
      };

      const report = evalService.evaluate(record);
      expect(report.passed).toBe(false);
      expect(report.metrics.physicalVerificationSuccess).toBe(false);
      expect(report.rejectionReason).toContain('REJECTED_WITHOUT_VERIFICATION');
    });

    it('rejects runs where test oracle failed (exit 1)', () => {
      const record: ExecutionRecord = {
        execution: {
          id: 'exec-failing-check',
          taskId: 'task-fail',
          runtimeId: 'rt',
          modelId: 'model',
          status: 'completed',
          createdAt: new Date(),
        },
        task: {
          id: 'task-fail',
          type: 'coding',
          input: 'Fix code',
          requirements: {},
          priority: 'normal',
          status: 'completed',
          createdAt: new Date(),
        },
        policyDecisions: [],
        toolCalls: [],
        filesChanged: ['src/code.ts'],
        workspaceState: {
          workspaceId: 'ws',
          revision: 1,
          updatedAt: new Date(),
        },
        checks: [
          {
            workspaceRevision: 1,
            name: 'test',
            command: 'npm test',
            ok: false,
            output: 'FAIL: 2 tests failed',
            durationMs: 300,
          },
        ],
        evidence: [
          {
            id: 'ev-fail',
            type: 'TEST',
            revision: 1,
            exitCode: 1,
            durationMs: 300,
          },
        ],
        result: 'I believe the fix is good even though test failed',
        errors: [],
        events: [],
      };

      const report = evalService.evaluate(record);
      expect(report.passed).toBe(false);
      expect(report.metrics.physicalVerificationSuccess).toBe(false);
    });
  });

  describe('Comparative Evaluation (Baseline vs Candidate)', () => {
    it('computes multidimensional deltas, improvements, and regressions', () => {
      const baselineReport = evalService.evaluate({
        execution: {
          id: 'exec-baseline',
          taskId: 'task-comp',
          runtimeId: 'rt',
          modelId: 'model-a',
          status: 'completed',
          createdAt: new Date(1000),
          completedAt: new Date(11000), // 10000ms
        },
        task: {
          id: 'task-comp',
          type: 'coding',
          input: 'task',
          requirements: {},
          priority: 'normal',
          status: 'completed',
          createdAt: new Date(1000),
        },
        policyDecisions: [],
        toolCalls: [
          { id: '1', tool: 't', input: {}, ok: true, durationMs: 100, policyEffect: 'allow', policyRule: 'r', at: new Date() },
          { id: '2', tool: 't', input: {}, ok: true, durationMs: 100, policyEffect: 'allow', policyRule: 'r', at: new Date() },
          { id: '3', tool: 't', input: {}, ok: true, durationMs: 100, policyEffect: 'allow', policyRule: 'r', at: new Date() },
          { id: '4', tool: 't', input: {}, ok: true, durationMs: 100, policyEffect: 'allow', policyRule: 'r', at: new Date() },
          { id: '5', tool: 't', input: {}, ok: true, durationMs: 100, policyEffect: 'allow', policyRule: 'r', at: new Date() },
          { id: '6', tool: 't', input: {}, ok: true, durationMs: 100, policyEffect: 'allow', policyRule: 'r', at: new Date() },
          { id: '7', tool: 't', input: {}, ok: true, durationMs: 100, policyEffect: 'allow', policyRule: 'r', at: new Date() },
        ],
        filesChanged: ['src/file.ts'],
        workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
        checks: [{ workspaceRevision: 1, name: 'test', command: 'test', ok: true, output: 'ok', durationMs: 200 }],
        evidence: [{ id: 'ev', type: 'TEST', revision: 1, exitCode: 0, durationMs: 200 }],
        errors: [],
        usage: { input: 10000, output: 2000 },
        events: [
          { id: 'g1', executionId: 'exec-baseline', type: 'generation.completed', timestamp: new Date(), data: { durationMs: 4000 } },
          { id: 'r1', executionId: 'exec-baseline', type: 'retry.scheduled', timestamp: new Date() },
          { id: 'r2', executionId: 'exec-baseline', type: 'retry.scheduled', timestamp: new Date() },
        ],
      });

      const candidateReport = evalService.evaluate({
        execution: {
          id: 'exec-candidate',
          taskId: 'task-comp',
          runtimeId: 'rt',
          modelId: 'model-b',
          status: 'completed',
          createdAt: new Date(1000),
          completedAt: new Date(4000), // 3000ms (7000ms faster)
        },
        task: {
          id: 'task-comp',
          type: 'coding',
          input: 'task',
          requirements: {},
          priority: 'normal',
          status: 'completed',
          createdAt: new Date(1000),
        },
        policyDecisions: [],
        toolCalls: [
          // Batched tool call / Code mode: only 1 tool call!
          { id: '1', tool: 'code_mode', input: {}, ok: true, durationMs: 200, policyEffect: 'allow', policyRule: 'r', at: new Date() },
        ],
        filesChanged: ['src/file.ts'],
        workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
        checks: [{ workspaceRevision: 1, name: 'test', command: 'test', ok: true, output: 'ok', durationMs: 180 }],
        evidence: [{ id: 'ev', type: 'TEST', revision: 1, exitCode: 0, durationMs: 180 }],
        errors: [],
        usage: { input: 3000, output: 500 }, // Far fewer tokens
        events: [
          { id: 'g1', executionId: 'exec-candidate', type: 'generation.completed', timestamp: new Date(), data: { durationMs: 1200 } },
        ],
      });

      const comparison = evalService.compare(baselineReport, candidateReport);

      expect(comparison.baseline.id).toBe('exec-baseline');
      expect(comparison.candidate.id).toBe('exec-candidate');

      // Deltas preserved across all dimensions
      expect(comparison.deltas.totalToolCallsDelta).toBe(-6); // 1 vs 7
      expect(comparison.deltas.wallTimeDeltaMs).toBe(-7000); // 3000 vs 10000
      expect(comparison.deltas.inputTokensDelta).toBe(-7000); // 3000 vs 10000
      expect(comparison.deltas.repairCyclesDelta).toBe(-2); // 0 vs 2
      expect(comparison.deltas.costDeltaUsd).toBeLessThan(0); // Cost decreased

      // Improvements detected
      expect(comparison.improvements.length).toBeGreaterThan(0);
      expect(comparison.improvements.some((i) => i.includes('tool calls'))).toBe(true);
      expect(comparison.improvements.some((i) => i.includes('repair cycles'))).toBe(true);
      expect(comparison.improvements.some((i) => i.includes('wall time'))).toBe(true);

      // Summary table contains structured comparison
      expect(comparison.summary).toContain('| Metric');
      expect(comparison.summary).toContain('Total Tool Calls');
      expect(comparison.summary).toContain('Est. Cost (USD)');
    });
  });
});
