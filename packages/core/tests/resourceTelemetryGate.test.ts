import { describe, it, expect, beforeEach } from 'vitest';
import { TelemetryCollector } from '../src/services/telemetryService.js';

describe('Gate 21: Cost & Compute Telemetry', () => {
  let collector: TelemetryCollector;

  beforeEach(() => {
    collector = new TelemetryCollector();
  });

  it('measures physical compute usage vs monetary cost for local Ollama models (API cost $0.00, physical > 0)', () => {
    const record = collector.recordModelCall({
      executionId: 'exec-local-1',
      jobId: 'job-100',
      modelId: 'qwen2.5-coder:7b',
      runtimeId: 'rt-ollama-local',
      computerId: 'comp-mac-studio',
      provider: 'ollama',
      isLocal: true,
      inputTokens: 1500,
      outputTokens: 400,
      cachedTokens: 200,
      wallTimeMs: 1250,
      peakMemoryBytes: 4 * 1024 * 1024 * 1024, // 4GB model memory
    });

    // CRITICAL INVARIANT: API COST ZERO != COMPUTE COST ZERO
    // 1. Monetary consumption
    expect(record.monetary.status).toBe('ACTUAL');
    expect(record.monetary.amount).toBe(0.0);
    expect(record.monetary.breakdown?.inputCostUsd).toBe(0.0);
    expect(record.monetary.breakdown?.outputCostUsd).toBe(0.0);

    // 2. Physical compute consumption
    expect(record.physical.inputTokens).toBe(1500);
    expect(record.physical.outputTokens).toBe(400);
    expect(record.physical.cachedTokens).toBe(200);
    expect(record.physical.totalTokens).toBe(2100);
    expect(record.physical.wallTimeMs).toBe(1250);
    expect(record.physical.peakMemoryBytes).toBeGreaterThan(0);
    expect(record.physical.modelCalls).toBe(1);
  });

  it('reports status UNKNOWN (not $0.00) for unpriced remote models', () => {
    // CRITICAL INVARIANT: UNKNOWN COST != ZERO COST
    const record = collector.recordModelCall({
      executionId: 'exec-remote-unpriced',
      jobId: 'job-100',
      modelId: 'proprietary-custom-model-x',
      runtimeId: 'rt-custom-http',
      provider: 'custom-internal-gateway',
      isLocal: false,
      inputTokens: 3000,
      outputTokens: 800,
      wallTimeMs: 3400,
    });

    expect(record.monetary.status).toBe('UNKNOWN');
    expect(record.monetary.amount).toBeUndefined();
    expect(record.monetary.amount).not.toBe(0);
    expect(record.monetary.amount).not.toBe(0.0);

    // Physical compute is still accurately captured
    expect(record.physical.inputTokens).toBe(3000);
    expect(record.physical.outputTokens).toBe(800);
    expect(record.physical.wallTimeMs).toBe(3400);
  });

  it('calculates actual monetary pricing for configured remote models (e.g. gpt-4o)', () => {
    const record = collector.recordModelCall({
      executionId: 'exec-remote-priced',
      jobId: 'job-100',
      modelId: 'gpt-4o',
      runtimeId: 'rt-openai',
      provider: 'openai',
      isLocal: false,
      inputTokens: 100_000, // 0.1M * $2.50 = $0.25
      outputTokens: 20_000,  // 0.02M * $10.00 = $0.20
      cachedTokens: 50_000,  // 0.05M * $1.25 = $0.0625
      wallTimeMs: 2100,
    });

    expect(record.monetary.status).toBe('ACTUAL');
    expect(record.monetary.amount).toBeCloseTo(0.5125, 4);
    expect(record.monetary.breakdown?.inputCostUsd).toBeCloseTo(0.25, 4);
    expect(record.monetary.breakdown?.outputCostUsd).toBeCloseTo(0.20, 4);
    expect(record.monetary.breakdown?.cachedCostUsd).toBeCloseTo(0.0625, 4);
  });

  it('aggregates across jobs and executions, strictly separating physical compute from monetary billing', () => {
    // 1. Ollama local run
    collector.recordModelCall({
      executionId: 'exec-1',
      jobId: 'job-batch',
      modelId: 'qwen2.5-coder:7b',
      runtimeId: 'rt-ollama',
      provider: 'ollama',
      isLocal: true,
      inputTokens: 2000,
      outputTokens: 500,
      wallTimeMs: 1500,
      peakMemoryBytes: 4 * 1024 * 1024 * 1024,
    });

    // 2. OpenAI remote priced run
    collector.recordModelCall({
      executionId: 'exec-2',
      jobId: 'job-batch',
      modelId: 'gpt-4o',
      runtimeId: 'rt-openai',
      provider: 'openai',
      isLocal: false,
      inputTokens: 10_000,
      outputTokens: 1_000,
      wallTimeMs: 1200,
      peakMemoryBytes: 50 * 1024 * 1024,
    });

    // 3. Unpriced remote model run
    collector.recordModelCall({
      executionId: 'exec-3',
      jobId: 'job-batch',
      modelId: 'research-preview-v2',
      runtimeId: 'rt-research',
      provider: 'lab-cloud',
      isLocal: false,
      inputTokens: 5000,
      outputTokens: 800,
      wallTimeMs: 2000,
    });

    const report = collector.aggregateJobUsage('job-batch');

    // Executions and Calls
    expect(report.totalExecutions).toBe(3);
    expect(report.totalModelCalls).toBe(3);

    // Physical compute sums all executions without omission
    expect(report.physical.totalInputTokens).toBe(17000);
    expect(report.physical.totalOutputTokens).toBe(2300);
    expect(report.physical.totalTokens).toBe(19300);
    expect(report.physical.totalWallTimeMs).toBe(4700);
    expect(report.physical.peakMemoryBytes).toBe(4 * 1024 * 1024 * 1024);

    // Monetary aggregation: because one model is UNKNOWN, the job's monetary cost is flagged UNKNOWN
    expect(report.monetary.hasUnknownCost).toBe(true);
    expect(report.monetary.costStatus).toBe('UNKNOWN');
    expect(report.monetary.totalActualCostUsd).toBeGreaterThan(0); // gpt-4o portion is tracked
    expect(report.monetary.byProvider['ollama'].amountUsd).toBe(0.0);
    expect(report.monetary.byProvider['ollama'].status).toBe('ACTUAL');
    expect(report.monetary.byProvider['openai'].amountUsd).toBeGreaterThan(0);
    expect(report.monetary.byProvider['lab-cloud'].status).toBe('UNKNOWN');
    expect(report.monetary.byProvider['lab-cloud'].amountUsd).toBeUndefined();

    // Model breakdown
    expect(report.byModel['qwen2.5-coder:7b'].calls).toBe(1);
    expect(report.byModel['qwen2.5-coder:7b'].costUsd).toBe(0.0);
    expect(report.byModel['research-preview-v2'].costStatus).toBe('UNKNOWN');
    expect(report.byModel['research-preview-v2'].costUsd).toBeUndefined();
  });
});
