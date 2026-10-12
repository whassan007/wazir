import { describe, it, expect } from 'vitest';
import {
  type PromptCacheTelemetry,
  type CacheMetricStatus,
  type CacheMetricValue,
  type UsageRecord,
  createUnknownPromptCacheTelemetry,
  createUnsupportedPromptCacheTelemetry,
  normalizeCacheMetricValue,
  aggregateCacheMetricValues,
  aggregatePromptCacheTelemetry,
  serializePromptCacheTelemetry,
  deserializePromptCacheTelemetry,
  toPromptCacheTelemetry,
} from '../src/types/telemetry.js';
import { TelemetryCollector } from '../src/services/telemetryService.js';

describe('PromptCacheTelemetry Normalized Data Model', () => {
  it('creates and validates full telemetry with observed metrics', () => {
    const now = new Date('2026-09-24T12:00:00.000Z');
    const telemetry: PromptCacheTelemetry = {
      runtimeId: 'ollama-local',
      modelId: 'qwen2.5-coder:7b',
      executionId: 'exec-101',
      inputTokens: { value: 12000, status: 'OBSERVED' },
      cacheReadTokens: { value: 8500, status: 'OBSERVED' },
      cacheWriteTokens: { value: 3500, status: 'OBSERVED' },
      cacheHits: { value: 1, status: 'OBSERVED' },
      cacheMisses: { value: 0, status: 'OBSERVED' },
      source: 'OBSERVED',
      confidence: 'high',
      observedAt: now,
    };

    expect(telemetry.runtimeId).toBe('ollama-local');
    expect(telemetry.modelId).toBe('qwen2.5-coder:7b');
    expect(telemetry.executionId).toBe('exec-101');
    expect(telemetry.inputTokens.value).toBe(12000);
    expect(telemetry.inputTokens.status).toBe('OBSERVED');
    expect(telemetry.cacheReadTokens.value).toBe(8500);
    expect(telemetry.cacheReadTokens.status).toBe('OBSERVED');
    expect(telemetry.cacheWriteTokens.value).toBe(3500);
    expect(telemetry.cacheHits?.value).toBe(1);
    expect(telemetry.cacheMisses?.value).toBe(0);
    expect(telemetry.source).toBe('OBSERVED');
    expect(telemetry.confidence).toBe('high');
    expect(telemetry.observedAt).toEqual(now);
  });

  it('handles partial telemetry where some metrics are observed and others are unknown or unsupported', () => {
    const partial: PromptCacheTelemetry = {
      runtimeId: 'lmstudio-local',
      modelId: 'meta-llama-3.1-8b',
      executionId: 'exec-102',
      inputTokens: { value: 4096, status: 'OBSERVED' },
      cacheReadTokens: { value: 2048, status: 'OBSERVED' },
      cacheWriteTokens: { status: 'UNKNOWN' },
      cacheHits: { status: 'UNKNOWN' },
      source: 'OBSERVED',
      confidence: 'medium',
      observedAt: new Date(),
    };

    expect(partial.cacheReadTokens.value).toBe(2048);
    expect(partial.cacheReadTokens.status).toBe('OBSERVED');
    // Missing write tokens must remain UNKNOWN without coerced 0
    expect(partial.cacheWriteTokens.value).toBeUndefined();
    expect(partial.cacheWriteTokens.status).toBe('UNKNOWN');
    expect(partial.cacheHits?.value).toBeUndefined();
    expect(partial.cacheHits?.status).toBe('UNKNOWN');
  });

  it('correctly models unsupported provider without converting missing telemetry to zero', () => {
    const unsupported = createUnsupportedPromptCacheTelemetry({
      runtimeId: 'unsupported-runtime',
      modelId: 'basic-model',
      executionId: 'exec-103',
      inputTokens: 1500,
    });

    expect(unsupported.source).toBe('UNSUPPORTED');
    expect(unsupported.inputTokens.value).toBe(1500);
    expect(unsupported.inputTokens.status).toBe('OBSERVED');

    // Invariant: Missing cache metrics must remain UNKNOWN or UNSUPPORTED, never 0
    expect(unsupported.cacheReadTokens.status).toBe('UNSUPPORTED');
    expect(unsupported.cacheReadTokens.value).toBeUndefined();
    expect(unsupported.cacheWriteTokens.status).toBe('UNSUPPORTED');
    expect(unsupported.cacheWriteTokens.value).toBeUndefined();
    expect(unsupported.cacheHits?.status).toBe('UNSUPPORTED');
    expect(unsupported.cacheHits?.value).toBeUndefined();
    expect(unsupported.cacheReadTokens.value).not.toBe(0);
    expect(unsupported.cacheWriteTokens.value).not.toBe(0);
  });

  it('correctly handles unknown metrics and preserves undefined value', () => {
    const unknownRecord = createUnknownPromptCacheTelemetry({
      runtimeId: 'unknown-runtime',
      modelId: 'unknown-model',
      executionId: 'exec-104',
    });

    expect(unknownRecord.source).toBe('UNKNOWN');
    expect(unknownRecord.inputTokens.status).toBe('UNKNOWN');
    expect(unknownRecord.inputTokens.value).toBeUndefined();
    expect(unknownRecord.cacheReadTokens.status).toBe('UNKNOWN');
    expect(unknownRecord.cacheReadTokens.value).toBeUndefined();
    expect(unknownRecord.cacheWriteTokens.status).toBe('UNKNOWN');
    expect(unknownRecord.cacheWriteTokens.value).toBeUndefined();
  });

  it('preserves a real observed zero cache hits as 0 with OBSERVED status', () => {
    const zeroHit: PromptCacheTelemetry = {
      runtimeId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      executionId: 'exec-105',
      inputTokens: { value: 5000, status: 'OBSERVED' },
      cacheReadTokens: { value: 0, status: 'OBSERVED' },
      cacheWriteTokens: { value: 5000, status: 'OBSERVED' },
      cacheHits: { value: 0, status: 'OBSERVED' },
      cacheMisses: { value: 1, status: 'OBSERVED' },
      source: 'OBSERVED',
      confidence: 'high',
      observedAt: new Date(),
    };

    // Zero cache read tokens is a legitimate measured 0, distinguishable from missing / undefined
    expect(zeroHit.cacheReadTokens.value).toBe(0);
    expect(zeroHit.cacheReadTokens.status).toBe('OBSERVED');
    expect(zeroHit.cacheHits?.value).toBe(0);
    expect(zeroHit.cacheHits?.status).toBe('OBSERVED');
    expect(zeroHit.cacheMisses?.value).toBe(1);
    expect(zeroHit.cacheMisses?.status).toBe('OBSERVED');
  });

  it('normalizes raw metric values according to provenance without zero coercion', () => {
    expect(normalizeCacheMetricValue(undefined)).toEqual({ value: undefined, status: 'UNKNOWN' });
    expect(normalizeCacheMetricValue(null)).toEqual({ value: undefined, status: 'UNKNOWN' });
    expect(normalizeCacheMetricValue(NaN)).toEqual({ value: undefined, status: 'UNKNOWN' });
    expect(normalizeCacheMetricValue(0)).toEqual({ value: 0, status: 'OBSERVED' });
    expect(normalizeCacheMetricValue(250)).toEqual({ value: 250, status: 'OBSERVED' });
    expect(normalizeCacheMetricValue({ value: 300, status: 'ESTIMATED' })).toEqual({
      value: 300,
      status: 'ESTIMATED',
    });
    expect(normalizeCacheMetricValue({ status: 'UNSUPPORTED' })).toEqual({
      value: undefined,
      status: 'UNSUPPORTED',
    });
  });

  it('serializes and deserializes cleanly across JSON roundtrip', () => {
    const original: PromptCacheTelemetry = {
      runtimeId: 'lmstudio',
      modelId: 'qwen3-coder',
      executionId: 'exec-roundtrip',
      inputTokens: { value: 8000, status: 'OBSERVED' },
      cacheReadTokens: { value: 6000, status: 'OBSERVED' },
      cacheWriteTokens: { status: 'UNKNOWN' },
      cacheHits: { value: 1, status: 'OBSERVED' },
      source: 'OBSERVED',
      confidence: 'high',
      observedAt: new Date('2026-09-24T10:00:00.000Z'),
    };

    const serialized = serializePromptCacheTelemetry(original);
    const jsonStr = JSON.stringify(serialized);
    const parsed = JSON.parse(jsonStr);
    const deserialized = deserializePromptCacheTelemetry(parsed);

    expect(deserialized.runtimeId).toBe(original.runtimeId);
    expect(deserialized.modelId).toBe(original.modelId);
    expect(deserialized.executionId).toBe(original.executionId);
    expect(deserialized.inputTokens).toEqual(original.inputTokens);
    expect(deserialized.cacheReadTokens).toEqual(original.cacheReadTokens);
    expect(deserialized.cacheWriteTokens.status).toBe('UNKNOWN');
    expect(deserialized.cacheWriteTokens.value).toBeUndefined();
    expect(deserialized.cacheHits).toEqual(original.cacheHits);
    expect(deserialized.source).toBe('OBSERVED');
    expect(deserialized.confidence).toBe('high');
    expect(deserialized.observedAt.getTime()).toBe(original.observedAt.getTime());
  });

  it('aggregates multiple telemetry records preserving provenance semantics', () => {
    const r1: PromptCacheTelemetry = {
      runtimeId: 'runtime-1',
      modelId: 'model-a',
      executionId: 'exec-agg',
      inputTokens: { value: 1000, status: 'OBSERVED' },
      cacheReadTokens: { value: 400, status: 'OBSERVED' },
      cacheWriteTokens: { value: 600, status: 'OBSERVED' },
      cacheHits: { value: 1, status: 'OBSERVED' },
      source: 'OBSERVED',
      observedAt: new Date('2026-09-24T10:00:00.000Z'),
    };

    const r2: PromptCacheTelemetry = {
      runtimeId: 'runtime-1',
      modelId: 'model-a',
      executionId: 'exec-agg',
      inputTokens: { value: 2000, status: 'OBSERVED' },
      cacheReadTokens: { value: 1500, status: 'OBSERVED' },
      cacheWriteTokens: { value: 500, status: 'OBSERVED' },
      cacheHits: { value: 1, status: 'OBSERVED' },
      source: 'OBSERVED',
      observedAt: new Date('2026-09-24T10:05:00.000Z'),
    };

    const agg = aggregatePromptCacheTelemetry([r1, r2])!;
    expect(agg).toBeDefined();
    expect(agg.inputTokens.value).toBe(3000);
    expect(agg.inputTokens.status).toBe('OBSERVED');
    expect(agg.cacheReadTokens.value).toBe(1900);
    expect(agg.cacheReadTokens.status).toBe('OBSERVED');
    expect(agg.cacheWriteTokens.value).toBe(1100);
    expect(agg.cacheWriteTokens.status).toBe('OBSERVED');
    expect(agg.cacheHits?.value).toBe(2);
    expect(agg.source).toBe('OBSERVED');
  });

  it('aggregates mixed observed, estimated, and unknown telemetry records gracefully', () => {
    const observedRec: PromptCacheTelemetry = {
      runtimeId: 'r1',
      modelId: 'm1',
      executionId: 'e1',
      inputTokens: { value: 1000, status: 'OBSERVED' },
      cacheReadTokens: { value: 200, status: 'OBSERVED' },
      cacheWriteTokens: { status: 'UNKNOWN' },
      source: 'OBSERVED',
      observedAt: new Date(),
    };

    const estimatedRec: PromptCacheTelemetry = {
      runtimeId: 'r1',
      modelId: 'm1',
      executionId: 'e1',
      inputTokens: { value: 2000, status: 'OBSERVED' },
      cacheReadTokens: { value: 800, status: 'ESTIMATED' },
      cacheWriteTokens: { status: 'UNKNOWN' },
      source: 'ESTIMATED',
      observedAt: new Date(),
    };

    const agg = aggregatePromptCacheTelemetry([observedRec, estimatedRec])!;
    expect(agg.inputTokens.value).toBe(3000);
    expect(agg.cacheReadTokens.value).toBe(1000);
    // When mixing observed and estimated, the status becomes ESTIMATED
    expect(agg.cacheReadTokens.status).toBe('ESTIMATED');
    expect(agg.cacheWriteTokens.status).toBe('UNKNOWN');
    expect(agg.cacheWriteTokens.value).toBeUndefined();
    expect(agg.source).toBe('ESTIMATED');
  });

  it('integrates seamlessly with TelemetryCollector and UsageRecord aggregation', () => {
    const collector = new TelemetryCollector();

    const t1: PromptCacheTelemetry = {
      runtimeId: 'ollama',
      modelId: 'llama3:8b',
      executionId: 'exec-collector-1',
      inputTokens: { value: 1000, status: 'OBSERVED' },
      cacheReadTokens: { value: 400, status: 'OBSERVED' },
      cacheWriteTokens: { value: 100, status: 'OBSERVED' },
      source: 'OBSERVED',
      observedAt: new Date(),
    };

    const record1 = collector.recordModelCall({
      executionId: 'exec-collector-1',
      modelId: 'llama3:8b',
      runtimeId: 'ollama',
      provider: 'ollama',
      inputTokens: 1000,
      outputTokens: 200,
      wallTimeMs: 150,
      promptCache: t1,
    });

    expect(record1.promptCache).toBeDefined();
    expect(record1.promptCache?.cacheReadTokens.value).toBe(400);
    expect(record1.physical.cacheReadTokens).toBe(400);

    const t2: PromptCacheTelemetry = {
      runtimeId: 'ollama',
      modelId: 'llama3:8b',
      executionId: 'exec-collector-1',
      inputTokens: { value: 1200, status: 'OBSERVED' },
      cacheReadTokens: { value: 600, status: 'OBSERVED' },
      cacheWriteTokens: { value: 50, status: 'OBSERVED' },
      source: 'OBSERVED',
      observedAt: new Date(),
    };

    collector.recordModelCall({
      executionId: 'exec-collector-1',
      modelId: 'llama3:8b',
      runtimeId: 'ollama',
      provider: 'ollama',
      inputTokens: 1200,
      outputTokens: 300,
      wallTimeMs: 180,
      promptCache: t2,
    });

    const report = collector.aggregateAll();
    expect(report.promptCache).toBeDefined();
    expect(report.promptCache?.inputTokens.value).toBe(2200);
    expect(report.promptCache?.cacheReadTokens.value).toBe(1000);
    expect(report.promptCache?.cacheWriteTokens.value).toBe(150);
    expect(report.promptCache?.source).toBe('OBSERVED');
  });

  it('converts PromptCacheMetrics from runtime adapters to PromptCacheTelemetry using toPromptCacheTelemetry', () => {
    const rawMetrics = {
      inputTokens: { value: 3000, status: 'OBSERVED' as CacheMetricStatus },
      cacheReadTokens: { value: 1200, status: 'OBSERVED' as CacheMetricStatus },
      cacheWriteTokens: { status: 'UNKNOWN' as CacheMetricStatus },
      hit: true,
      provider: 'ollama',
    };

    const normalized = toPromptCacheTelemetry({
      runtimeId: 'ollama-local',
      modelId: 'deepseek-coder',
      executionId: 'exec-conv',
      metrics: rawMetrics,
    });

    expect(normalized.runtimeId).toBe('ollama-local');
    expect(normalized.modelId).toBe('deepseek-coder');
    expect(normalized.executionId).toBe('exec-conv');
    expect(normalized.inputTokens.value).toBe(3000);
    expect(normalized.cacheReadTokens.value).toBe(1200);
    expect(normalized.cacheWriteTokens.value).toBeUndefined();
    expect(normalized.cacheWriteTokens.status).toBe('UNKNOWN');
    expect(normalized.cacheHits?.value).toBe(1);
    expect(normalized.source).toBe('OBSERVED');
  });
});
