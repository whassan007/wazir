import { describe, it, expect, vi } from 'vitest';
import { ContextCompactionService } from '@wazir/core';
import type { ContextPart } from '@wazir/core';

describe('/compact command integration (Stage 6)', () => {
  it('compacts context on manual request and computes token savings accurately', async () => {
    const compaction = new ContextCompactionService({
      config: {
        autoThreshold: 0.75,
        targetUtilization: 0.45,
        preserveRecentTailRatio: 0.5,
        minimumTokensToReclaim: 50,
      },
    });

    const parts: ContextPart[] = [
      { kind: 'system', label: 'System', content: 'You are Wazir.', priority: 'critical', category: 'PINNED' },
      { kind: 'task', label: 'Task', content: 'Audit memory usage', priority: 'critical', category: 'PINNED' },
      ...Array.from({ length: 10 }, (_, i) => ({
        kind: 'conversation' as const,
        label: `Turn ${i + 1}`,
        content: `Extensive diagnostic log data from turn ${i + 1}: ${'x'.repeat(200)}`,
        priority: 'optional' as const,
        category: 'COMPRESSIBLE' as const,
      })),
    ];

    compaction.createInitialSnapshot({
      executionId: 'exec-manual-1',
      modelId: 'qwen2.5-coder',
      effectiveContextWindow: 32000,
      parts,
    });

    const res = await compaction.compact({
      executionId: 'exec-manual-1',
      trigger: 'USER',
      reason: 'Manual /compact command invocation',
      force: true,
    });

    expect(res.status).toBe('compacted');
    expect(res.metrics).toBeDefined();
    expect(res.metrics!.beforeTokens).toBeGreaterThan(res.metrics!.afterTokens);
    expect(res.metrics!.tokensSaved).toBeGreaterThan(0);
    expect(res.metrics!.trigger).toBe('USER');
    expect(res.metrics!.reason).toBe('Manual /compact command invocation');

    const reductionPct = ((res.metrics!.tokensSaved / res.metrics!.beforeTokens) * 100).toFixed(1);
    expect(Number(reductionPct)).toBeGreaterThan(0);

    const latest = compaction.getLatestSnapshot('exec-manual-1');
    expect(latest).toBeDefined();
    expect(latest!.generation).toBe(2);
    expect(latest!.pinned.length).toBe(2);
    expect(latest!.compressed).toBeDefined();
  });
});
