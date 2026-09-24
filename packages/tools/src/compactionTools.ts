import type { Tool, ToolResult, ToolExecutionContext } from '@wazir/core';

export const COMPACT_MEMORY_SCHEMA = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description: 'Why context compaction is requested (e.g., completed exploration, moving from planning to implementation, or debugging resolved)',
    },
    force: {
      type: 'boolean',
      description: 'Force compaction even if below automatic utilization threshold',
    },
  },
  required: ['reason'],
};

/**
 * Autonomous agent tool for requesting controller-level context compaction.
 *
 * Invariant: The agent CANNOT directly erase or mutate its execution history.
 * This tool emits a REQUEST to ContextCompactionService which validates eligibility,
 * protects PINNED context, preserves recent turns, and produces an immutable snapshot.
 */
export const compactMemoryTool: Tool = {
  descriptor: {
    name: 'compact_memory',
    description:
      'Request the controller to perform semantic compaction on historical context. ' +
      'Pinned instructions and recent turns are protected. Durable execution history is never deleted.',
    inputSchema: COMPACT_MEMORY_SCHEMA,
    permissions: [],
    riskLevel: 'low',
    environment: 'local',
    sideEffectClass: 'READ_ONLY',
    concurrencySafety: 'exclusive',
    provenance: { source: 'system' },
  },

  async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const started = Date.now();
    const executionId = ctx.executionId;

    if (!executionId) {
      return {
        ok: false,
        output: '',
        error: 'NO_EXECUTION_CONTEXT',
        durationMs: Date.now() - started,
      };
    }

    if (!ctx.compactor) {
      return {
        ok: false,
        output: '',
        error: 'COMPACTION_SERVICE_UNAVAILABLE',
        durationMs: Date.now() - started,
      };
    }

    try {
      const result = await ctx.compactor.compact({
        executionId,
        trigger: 'AGENT',
        reason: typeof input.reason === 'string' ? input.reason : 'Agent requested compaction',
        force: Boolean(input.force),
      });

      if (result.status === 'compacted') {
        const m = result.metrics;
        const outputData = {
          status: 'compacted',
          beforeTokens: m?.beforeTokens ?? 0,
          afterTokens: m?.afterTokens ?? 0,
          tokensSaved: m?.tokensSaved ?? 0,
          snapshotId: result.snapshotId,
          preservedTailMessages: m?.messagesAfter ?? 0,
        };
        return {
          ok: true,
          output: JSON.stringify(outputData, null, 2),
          structuredOutput: outputData,
          durationMs: Date.now() - started,
        };
      } else if (result.status === 'skipped') {
        const outputData = {
          status: 'skipped',
          reason: result.metrics?.reason ?? 'Context utilization is low or insufficient tokens to reclaim',
        };
        return {
          ok: true,
          output: JSON.stringify(outputData, null, 2),
          structuredOutput: outputData,
          durationMs: Date.now() - started,
        };
      } else {
        return {
          ok: false,
          output: '',
          error: result.errorCode ?? result.error ?? 'CONTEXT_COMPACTION_FAILED',
          durationMs: Date.now() - started,
        };
      }
    } catch (err) {
      return {
        ok: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      };
    }
  },
};
