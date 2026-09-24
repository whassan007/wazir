import { describe, it, expect } from 'vitest';
import type {
  ContextCategory,
  TokenCount,
  TokenCountKind,
  ContextReserve,
  OffloadedArtifact,
  ContextSnapshot,
  CompactionMetrics,
  CompactionRequest,
  CompactionResult,
  ContextItem,
  ToolResultCompactor,
  AgentContextCompressor,
  ContextConfig,
} from '../src/types/context.js';
import { ContextBudgetError } from '../src/types/context.js';

describe('Stage 1 Context Types', () => {
  it('constructs a valid ContextReserve and computes reserves', () => {
    const reserve: ContextReserve = {
      outputTokens: 8000,
      toolSchemaTokens: 5000,
      safetyTokens: 5000,
    };
    expect(reserve.outputTokens + reserve.toolSchemaTokens + reserve.safetyTokens).toBe(18000);
  });

  it('instantiates valid TokenCount with kind EXACT or ESTIMATED', () => {
    const exact: TokenCount = { value: 1234, kind: 'EXACT' };
    const estimated: TokenCount = { value: 500, kind: 'ESTIMATED' };
    expect(exact.kind).toBe('EXACT');
    expect(estimated.kind).toBe('ESTIMATED');
  });

  it('instantiates an OffloadedArtifact with complete metadata', () => {
    const artifact: OffloadedArtifact = {
      artifactId: 'art-001',
      executionId: 'exec-123',
      toolCallId: 'call-456',
      toolName: 'shell',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      originalTokens: 12000,
      originalBytes: 48000,
      offloadPath: '.wazir/offload/exec-123/tool_result_call-456.txt',
      createdAt: new Date(),
      contentType: 'tool_result',
    };
    expect(artifact.contentType).toBe('tool_result');
    expect(artifact.originalTokens).toBe(12000);
  });

  it('instantiates an immutable ContextSnapshot with all categories', () => {
    const pinnedItem: ContextItem = {
      kind: 'system',
      label: 'System Prompt',
      content: 'You are Wazir.',
      priority: 'critical',
      category: 'PINNED',
    };
    const activeItem: ContextItem = {
      kind: 'task',
      label: 'Current Error',
      content: 'TypeError at line 42',
      priority: 'important',
      category: 'ACTIVE',
    };
    const compressibleItem: ContextItem = {
      kind: 'conversation',
      label: 'Old turn',
      content: 'ls command output',
      priority: 'optional',
      category: 'COMPRESSIBLE',
    };
    const tailItem: ContextItem = {
      kind: 'conversation',
      label: 'Recent turn',
      content: 'npm test output',
      priority: 'important',
      category: 'ACTIVE',
    };

    const snapshot: ContextSnapshot = {
      id: 'snap-1',
      executionId: 'exec-123',
      generation: 1,
      modelId: 'qwen2.5-coder:32b',
      effectiveContextWindow: 96000,
      estimatedTokens: 25000,
      createdAt: new Date(),
      pinned: [pinnedItem],
      active: [activeItem],
      compressible: [compressibleItem],
      tail: [tailItem],
      artifactReferences: [],
    };

    expect(snapshot.generation).toBe(1);
    expect(snapshot.pinned[0].category).toBe('PINNED');
    expect(snapshot.active[0].category).toBe('ACTIVE');
    expect(snapshot.compressible[0].category).toBe('COMPRESSIBLE');
  });

  it('handles ContextBudgetError correctly', () => {
    const err = new ContextBudgetError(10000, 8000, ['insufficient token window']);
    expect(err.name).toBe('ContextBudgetError');
    expect(err.requiredTokens).toBe(10000);
    expect(err.availableTokens).toBe(8000);
    expect(err.message).toContain('Context budget exceeded');
  });
});
