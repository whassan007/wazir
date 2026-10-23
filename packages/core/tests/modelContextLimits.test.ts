import { describe, it, expect } from 'vitest';
import { resolveModelContextLimits } from '../src/services/modelContextLimits.js';
import type { ModelRecord } from '../src/types/model.js';

function record(overrides: Partial<ModelRecord> = {}): ModelRecord {
  return {
    id: 'model-x',
    name: 'Model X',
    provider: 'anthropic',
    family: 'claude',
    contextMax: 200_000,
    capabilities: ['generalChat'],
    toolCalling: true,
    structuredOutput: false,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: false,
    memory: undefined,
    runtimeCompatibility: 'any',
    local: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as ModelRecord;
}

describe('resolveModelContextLimits', () => {
  it('resolves a hosted known model from record provenance', () => {
    const limits = resolveModelContextLimits(
      record({
        id: 'claude-opus-4-8',
        contextMax: 1_000_000,
        maxOutputTokens: 128_000,
        maxInputTokens: 1_000_000,
        contextAccounting: 'shared',
        contextLimitSource: 'provider-api',
        reasoning: true,
      }),
    );

    expect(limits.modelId).toBe('claude-opus-4-8');
    expect(limits.contextWindowTokens).toBe(1_000_000);
    expect(limits.maxOutputTokens).toBe(128_000);
    expect(limits.maxInputTokens).toBe(1_000_000);
    expect(limits.source).toBe('provider-api');
    expect(limits.known).toBe(true);
    expect(limits.runtimeContextConfigurable).toBe(false);
    expect(limits.runtimeContextTokens).toBeUndefined();
    expect(limits.accounting).toBe('shared');
    expect(limits.reasoningAccounting).toBe('unknown');
    expect(limits.notes.length).toBeGreaterThan(0);
  });

  it('uses the loaded instance context and a configurable runtime for a local model', () => {
    const limits = resolveModelContextLimits(
      record({ local: true, runtimeCompatibility: ['ollama'], contextLimitSource: 'runtime-discovered', configuredContext: 8_192, contextMax: 32_768 }),
      { runtimeId: 'ollama', contextTokens: 16_384 },
    );

    expect(limits.contextWindowTokens).toBe(32_768);
    expect(limits.runtimeContextTokens).toBe(16_384);
    expect(limits.runtimeContextConfigurable).toBe(true);
    expect(limits.source).toBe('runtime-discovered');
    expect(limits.accounting).toBe('unknown');
  });

  it('falls back to the configured context when no instance is loaded', () => {
    const limits = resolveModelContextLimits(
      record({ local: true, contextLimitSource: 'operator-configured', configuredContext: 8_192, contextMax: 8_192 }),
    );
    expect(limits.runtimeContextTokens).toBe(8_192);
  });

  it('honours an explicit runtimeContextConfigurable override', () => {
    const limits = resolveModelContextLimits(record({ local: false }), undefined, { runtimeContextConfigurable: true });
    expect(limits.runtimeContextConfigurable).toBe(true);
  });

  it('reports no window for a default-unknown record even though contextMax is a number', () => {
    const limits = resolveModelContextLimits(record({ contextMax: 32_768, contextLimitSource: 'default-unknown' }));

    expect(limits.contextWindowTokens).toBeUndefined();
    expect(limits.known).toBe(false);
    expect(limits.source).toBe('default-unknown');
  });

  it('treats a legacy record without contextLimitSource as provider-documented', () => {
    const limits = resolveModelContextLimits(record({ contextMax: 128_000 }));

    expect(limits.source).toBe('provider-documented');
    expect(limits.known).toBe(true);
    expect(limits.contextWindowTokens).toBe(128_000);
    expect(limits.notes.some((n) => n.includes('legacy'))).toBe(true);
  });

  it('marks reasoning as not-supported for non-reasoning models', () => {
    const limits = resolveModelContextLimits(record({ reasoning: false }));
    expect(limits.reasoningAccounting).toBe('not-supported');
  });
});
