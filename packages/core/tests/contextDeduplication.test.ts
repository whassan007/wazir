import { describe, it, expect } from 'vitest';
import {
  deduplicateContextParts,
  computeUsableBudget,
  computeUtilization,
} from '../src/services/contextCompiler.js';
import type { ContextPart } from '../src/types/context.js';

const part = (kind: ContextPart['kind'], label: string, content: string): ContextPart => ({
  kind,
  label,
  content,
  priority: 'optional',
});

describe('deduplicateContextParts', () => {
  it('removes exact duplicates and keeps first occurrence', () => {
    const p1 = part('conversation', 'turn 1', 'hello world');
    const p2 = part('conversation', 'turn 1', 'hello world');
    const p3 = part('conversation', 'turn 1', 'hello world');
    const { deduplicated, removedCount } = deduplicateContextParts([p1, p2, p3]);

    expect(deduplicated).toHaveLength(1);
    expect(removedCount).toBe(2);
    expect(deduplicated[0]).toBe(p1);
  });

  it('preserves parts with different content', () => {
    const a = part('conversation', 'turn 1', 'content a');
    const b = part('conversation', 'turn 1', 'content b');
    const { deduplicated, removedCount } = deduplicateContextParts([a, b]);

    expect(deduplicated).toHaveLength(2);
    expect(removedCount).toBe(0);
  });

  it('preserves parts with different labels', () => {
    const a = part('conversation', 'turn 1', 'same content');
    const b = part('conversation', 'turn 2', 'same content');
    const { deduplicated } = deduplicateContextParts([a, b]);

    expect(deduplicated).toHaveLength(2);
  });

  it('preserves parts with different kinds', () => {
    const a = part('conversation', 'x', 'same');
    const b = part('system', 'x', 'same');
    const { deduplicated } = deduplicateContextParts([a, b]);

    expect(deduplicated).toHaveLength(2);
  });

  it('handles empty array gracefully', () => {
    const { deduplicated, removedCount } = deduplicateContextParts([]);
    expect(deduplicated).toHaveLength(0);
    expect(removedCount).toBe(0);
  });

  it('does not mutate the input array', () => {
    const p = part('system', 'sys', 'content');
    const input = [p, p];
    deduplicateContextParts(input);
    expect(input).toHaveLength(2);
  });
});

describe('computeUsableBudget', () => {
  it('subtracts output, tool schema, and safety reserves from effective context', () => {
    const usable = computeUsableBudget({
      effectiveContextTokens: 96000,
      reserveOutputTokens: 8000,
      reserveToolSchemaTokens: 5000,
      reserveSafetyTokens: 5000,
    });
    expect(usable).toBe(78000);
  });

  it('returns 0 when reserves exceed effective context', () => {
    const usable = computeUsableBudget({
      effectiveContextTokens: 1000,
      reserveOutputTokens: 2000,
      reserveToolSchemaTokens: 0,
      reserveSafetyTokens: 0,
    });
    expect(usable).toBe(0);
  });
});

describe('computeUtilization', () => {
  it('computes exact fractional utilization of usable budget', () => {
    expect(computeUtilization(39000, 78000)).toBeCloseTo(0.5);
    expect(computeUtilization(58500, 78000)).toBeCloseTo(0.75);
  });

  it('caps at 1.0 when input exceeds budget', () => {
    expect(computeUtilization(100000, 78000)).toBe(1);
  });

  it('returns 1.0 when usable budget is zero to avoid division by zero', () => {
    expect(computeUtilization(0, 0)).toBe(1);
    expect(computeUtilization(500, 0)).toBe(1);
  });
});
