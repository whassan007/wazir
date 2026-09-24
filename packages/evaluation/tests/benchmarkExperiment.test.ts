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
} from '../src/index.js';

describe('Benchmark Experiment: Single Trajectory vs Best-of-3 Solution Search', () => {
  const evalService = new EvaluationService({
    costPer1kInputTokens: 0.003,
    costPer1kOutputTokens: 0.015,
  });

  const benchmarkService = new BenchmarkService(evalService);

  it('measures task success, verification success, calls, repair cycles, tokens, cost, and wall time tradeoffs', async () => {
    const task = benchmarkService.getTask('repair-failing-math-test')!;
    expect(task).toBeDefined();

    // 1. Single Trajectory Runner (standard single pass with 40% flake/fail probability)
    const singleTrajectoryRunner: BenchmarkRunner = {
      id: 'single-trajectory',
      name: 'Single Trajectory Baseline',
      async run(t: BenchmarkTask, ctx: BenchmarkExecutionContext): Promise<ExecutionRecord> {
        const startTime = Date.now();
        // Single trajectory attempts once, encounters failure mode without parallel diversity
        const success = false; // simulates single trajectory getting stuck on edge-case

        return {
          execution: {
            id: 'exec-single-1',
            taskId: t.id,
            runtimeId: 'local-rt',
            modelId: 'qwen-coder',
            status: success ? 'completed' : 'failed',
            createdAt: new Date(startTime),
            startedAt: new Date(startTime),
            completedAt: new Date(startTime + 1800),
          },
          task: {
            id: t.id,
            type: 'benchmark',
            title: t.name,
            input: t.prompt,
            requirements: {},
            priority: 'normal',
            status: success ? 'completed' : 'failed',
            createdAt: new Date(startTime),
          },
          policyDecisions: [],
          toolCalls: [
            { id: 'tc-1', tool: 'read', input: { path: 'src/math.ts' }, ok: true, durationMs: 50, policyEffect: 'allow', policyRule: 'r', at: new Date() },
            { id: 'tc-2', tool: 'write', input: { path: 'src/math.ts', content: 'broken' }, ok: true, durationMs: 100, policyEffect: 'allow', policyRule: 'r', at: new Date() },
          ],
          filesChanged: ['src/math.ts'],
          usage: { input: 1200, output: 250, total: 1450 },
          workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
          checks: [
            { workspaceRevision: 1, name: 'test', command: 'npm test', ok: false, durationMs: 200 },
          ],
          evidence: [],
          errors: ['AssertionError: expected null to be 0'],
          events: [],
        };
      },
    };

    // 2. Best-of-3 Solution Search Runner (explores 3 diverse candidates, selects qualifying winner)
    const bestOf3Runner: BenchmarkRunner = {
      id: 'best-of-3-search',
      name: 'Best-of-3 Solution Search',
      async run(t: BenchmarkTask, ctx: BenchmarkExecutionContext): Promise<ExecutionRecord> {
        const startTime = Date.now();
        // Candidate A failed, Candidate B failed, Candidate C succeeded
        // Selection selects Candidate C
        return {
          execution: {
            id: 'exec-bestof3-winning-candidate',
            taskId: t.id,
            runtimeId: 'local-rt',
            modelId: 'qwen-coder',
            status: 'completed',
            createdAt: new Date(startTime),
            startedAt: new Date(startTime),
            completedAt: new Date(startTime + 3600),
          },
          task: {
            id: t.id,
            type: 'benchmark',
            title: t.name,
            input: t.prompt,
            requirements: {},
            priority: 'normal',
            status: 'completed',
            createdAt: new Date(startTime),
          },
          policyDecisions: [],
          toolCalls: [
            { id: 'tc-1', tool: 'read', input: { path: 'src/math.ts' }, ok: true, durationMs: 50, policyEffect: 'allow', policyRule: 'r', at: new Date() },
            { id: 'tc-2', tool: 'write', input: { path: 'src/math.ts', content: 'repaired' }, ok: true, durationMs: 120, policyEffect: 'allow', policyRule: 'r', at: new Date() },
            { id: 'tc-3', tool: 'test', input: {}, ok: true, durationMs: 150, policyEffect: 'allow', policyRule: 'r', at: new Date() },
          ],
          filesChanged: ['src/math.ts'],
          // Best of 3 consumes ~3x aggregate tokens across 3 trajectories
          usage: { input: 3600, output: 750, total: 4350 },
          workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
          checks: [
            { workspaceRevision: 1, name: 'test', command: 'npm test', ok: true, durationMs: 150 },
          ],
          evidence: [
            { id: 'ev-c', type: 'TEST', oracle: 'TEST', revision: 1, workspaceRevision: 1, exitCode: 0, durationMs: 150, status: 'PASS', evidenceHash: 'h-win' },
          ],
          errors: [],
          events: [],
        };
      },
    };

    // Run comparative benchmark
    const comparativeResult = await benchmarkService.runComparative(
      task.id,
      singleTrajectoryRunner,
      bestOf3Runner,
    );

    const baseScore = comparativeResult.baseline.scoreReport;
    const candScore = comparativeResult.candidate.scoreReport;
    const deltas = comparativeResult.comparison.deltas;

    // Report actual tradeoffs objectively:
    // Success delta: +1 (from 0 to 1)
    expect(deltas.taskSuccessDelta).toBe(1);
    expect(deltas.verificationSuccessDelta).toBe(1);

    // Compute / token delta: Best-of-3 consumed 3x tokens and cost
    expect(deltas.inputTokensDelta).toBeGreaterThan(0);
    expect(deltas.outputTokensDelta).toBeGreaterThan(0);
    expect(deltas.costDeltaUsd).toBeGreaterThan(0);
    expect(deltas.wallTimeDeltaMs).toBeGreaterThan(0);

    // Log the benchmark trade-off table
    console.log(comparativeResult.comparison.summary);
  });
});
