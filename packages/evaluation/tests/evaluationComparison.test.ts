import { describe, it, expect } from 'vitest';
import type { ExecutionRecord } from '@wazir/core';
import { EvaluationService } from '../src/index.js';

describe('EvaluationRecord & Multi-Dimensional Comparison', () => {
  const evalService = new EvaluationService();

  const makeFakeRecord = (params: {
    id: string;
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    passed: boolean;
    wallTimeMs: number;
    compactedTokens: number;
  }): ExecutionRecord => {
    return {
      execution: {
        id: params.id,
        taskId: `task-${params.id}`,
        runtimeId: 'lmstudio',
        modelId: 'qwen2.5-coder-7b',
        status: params.passed ? 'completed' : 'failed',
        createdAt: new Date(Date.now() - params.wallTimeMs),
        completedAt: new Date(),
      },
      task: {
        id: `task-${params.id}`,
        title: 'Long Horizon Context Task',
      },
      toolCalls: [
        {
          id: 'call-1',
          tool: 'read_file',
          input: {},
          ok: true,
          durationMs: 100,
          policyEffect: 'allow',
          policyRule: 'default',
          at: new Date(),
        },
      ],
      filesChanged: ['src/core.ts'],
      checks: [
        {
          name: 'build',
          ok: params.passed,
          durationMs: 200,
          command: 'npm run build',
        },
      ],
      errors: params.passed ? [] : ['Build failed'],
      policyDecisions: [],
      events: [
        {
          id: 'ev-1',
          executionId: params.id,
          type: 'context.snapshot.created',
          timestamp: new Date(),
          data: { tokens: params.inputTokens },
        },
        {
          id: 'ev-2',
          executionId: params.id,
          type: 'context.revision.completed',
          timestamp: new Date(),
          data: { tokensDeduplicated: 500, tokensSuperseded: 800, tokensSummarized: params.compactedTokens },
        },
      ],
      usage: {
        input: params.inputTokens,
        output: params.outputTokens,
        total: params.inputTokens + params.outputTokens,
      },
      workspaceState: {
        workspaceId: 'ws-1',
        revision: 4,
      },
    };
  };

  it('26 & 27. EvaluationRecord captures model calls and input/output tokens accurately', () => {
    const record = makeFakeRecord({
      id: 'rec-1',
      modelCalls: 12,
      inputTokens: 45000,
      outputTokens: 2500,
      passed: true,
      wallTimeMs: 12000,
      compactedTokens: 8000,
    });

    const evalRecord = evalService.buildEvaluationRecord(record);

    expect(evalRecord.identity.runId).toBe('eval-rec-1');
    expect(evalRecord.model.inputTokens.value).toBe(45000);
    expect(evalRecord.model.inputTokens.kind).toBe('measured');
    expect(evalRecord.model.outputTokens.value).toBe(2500);
  });

  it('28 & 29. EvaluationRecord captures context metrics and handles unavailable metrics honestly', () => {
    const record = makeFakeRecord({
      id: 'rec-context',
      modelCalls: 10,
      inputTokens: 50000,
      outputTokens: 3000,
      passed: true,
      wallTimeMs: 15000,
      compactedTokens: 12000,
    });

    const evalRecord = evalService.buildEvaluationRecord(record);

    expect(evalRecord.context.peakContextTokens.value).toBeGreaterThanOrEqual(50000);
    expect(evalRecord.context.tokensRemovedDeduplication.value).toBe(500);
    expect(evalRecord.context.tokensRemovedSuperseded.value).toBe(800);
    expect(evalRecord.context.tokensSummarized.value).toBe(12000);

    // Unavailable cache metrics reported honestly without fabrication
    expect(evalRecord.context.cacheReadTokens.kind).toBe('unavailable');
    expect(evalRecord.context.cacheWriteTokens.kind).toBe('unavailable');
  });

  it('30. performs deterministic baseline vs candidate comparison across independent dimensions', () => {
    const baselineRec = makeFakeRecord({
      id: 'base-1',
      modelCalls: 31,
      inputTokens: 160000,
      outputTokens: 10000,
      passed: true,
      wallTimeMs: 552000,
      compactedTokens: 15000,
    });

    const candidateRec = makeFakeRecord({
      id: 'cand-1',
      modelCalls: 20,
      inputTokens: 108000,
      outputTokens: 7500,
      passed: true,
      wallTimeMs: 379000,
      compactedTokens: 25000,
    });

    const baseEval = evalService.buildEvaluationRecord(baselineRec);
    const candEval = evalService.buildEvaluationRecord(candidateRec);

    const comparison = evalService.compareDimensions(baseEval, candEval);

    expect(comparison.verdict).toBe('CANDIDATE_BETTER');
    expect(comparison.dimensions.modelCalls.delta).toBe(-11);
    expect(comparison.dimensions.inputTokens.delta).toBeLessThan(0);
    expect(comparison.dimensions.wallTimeMs.delta).toBeLessThan(0);
    expect(comparison.improvements.length).toBeGreaterThan(0);
    expect(comparison.regressions.length).toBe(0);
    expect(comparison.summary).toContain('CANDIDATE_BETTER');
  });
});
