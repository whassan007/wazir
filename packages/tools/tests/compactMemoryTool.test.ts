import { describe, it, expect, vi } from 'vitest';
import { compactMemoryTool } from '../src/compactionTools.js';
import { PolicyEngine } from '@wazir/core';
import type { AgentContextCompressor, CompactionResult, ToolExecutionContext } from '@wazir/core';

describe('compactMemoryTool (Stage 6)', () => {
  it('has proper descriptor metadata and schema', () => {
    expect(compactMemoryTool.descriptor.name).toBe('compact_memory');
    expect(compactMemoryTool.descriptor.sideEffectClass).toBe('READ_ONLY');
    expect(compactMemoryTool.descriptor.permissions).toEqual([]);
    expect(compactMemoryTool.descriptor.inputSchema.required).toContain('reason');
  });

  it('is approved by PolicyEngine as controller compaction request', () => {
    const policy = new PolicyEngine({ projectRoot: '/tmp' });
    const decision = policy.classify({
      tool: 'compact_memory',
      input: { reason: 'Switching phases' },
    });
    expect(decision.decision).toBe('allow');
    expect(decision.rule).toBe('compaction-policy');
  });

  it('returns NO_EXECUTION_CONTEXT when executionId is missing', async () => {
    const ctx: ToolExecutionContext = { projectRoot: '/tmp' };
    const res = await compactMemoryTool.execute({ reason: 'testing' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('NO_EXECUTION_CONTEXT');
  });

  it('returns COMPACTION_SERVICE_UNAVAILABLE when compactor is absent', async () => {
    const ctx: ToolExecutionContext = { projectRoot: '/tmp', executionId: 'exec-1' };
    const res = await compactMemoryTool.execute({ reason: 'testing' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('COMPACTION_SERVICE_UNAVAILABLE');
  });

  it('successfully invokes compactor and returns structured metrics', async () => {
    const mockCompactor: AgentContextCompressor = {
      compact: vi.fn().mockResolvedValue({
        status: 'compacted',
        snapshotId: 'snap-99',
        metrics: {
          trigger: 'AGENT',
          reason: 'phase change',
          beforeTokens: 50000,
          afterTokens: 22000,
          tokensSaved: 28000,
          messagesBefore: 30,
          messagesAfter: 12,
          offloadedArtifacts: 2,
          offloadedBytes: 15000,
          compressionDurationMs: 120,
          deduplicatedCount: 3,
        },
      } as CompactionResult),
    };

    const ctx: ToolExecutionContext = {
      projectRoot: '/tmp',
      executionId: 'exec-success',
      compactor: mockCompactor,
    };

    const res = await compactMemoryTool.execute({ reason: 'phase change', force: true }, ctx);

    expect(res.ok).toBe(true);
    expect(mockCompactor.compact).toHaveBeenCalledWith({
      executionId: 'exec-success',
      trigger: 'AGENT',
      reason: 'phase change',
      force: true,
    });

    const parsed = JSON.parse(res.output);
    expect(parsed.status).toBe('compacted');
    expect(parsed.beforeTokens).toBe(50000);
    expect(parsed.afterTokens).toBe(22000);
    expect(parsed.tokensSaved).toBe(28000);
    expect(parsed.snapshotId).toBe('snap-99');
    expect(parsed.preservedTailMessages).toBe(12);
  });

  it('handles skipped compaction with clear explanation', async () => {
    const mockCompactor: AgentContextCompressor = {
      compact: vi.fn().mockResolvedValue({
        status: 'skipped',
        metrics: {
          trigger: 'AGENT',
          reason: 'Utilization is 35%, below threshold of 75%',
          beforeTokens: 20000,
          afterTokens: 20000,
          tokensSaved: 0,
          messagesBefore: 10,
          messagesAfter: 10,
          offloadedArtifacts: 0,
          offloadedBytes: 0,
          compressionDurationMs: 5,
          deduplicatedCount: 0,
        },
      } as CompactionResult),
    };

    const ctx: ToolExecutionContext = {
      projectRoot: '/tmp',
      executionId: 'exec-skip',
      compactor: mockCompactor,
    };

    const res = await compactMemoryTool.execute({ reason: 'check' }, ctx);

    expect(res.ok).toBe(true);
    const parsed = JSON.parse(res.output);
    expect(parsed.status).toBe('skipped');
    expect(parsed.reason).toContain('below threshold');
  });
});
