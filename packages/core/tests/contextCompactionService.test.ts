import { describe, it, expect, beforeEach } from 'vitest';
import {
  ContextCompactionService,
  STRUCTURED_SUMMARY_SCHEMA,
} from '../src/services/contextCompactionService.js';
import type { ContextPart, StructuredCompactionSummary } from '../src/types/context.js';

describe('ContextCompactionService (Stage 5)', () => {
  let service: ContextCompactionService;

  beforeEach(() => {
    service = new ContextCompactionService({
      config: {
        autoThreshold: 0.75,
        targetUtilization: 0.45,
        preserveRecentTailRatio: 0.5,
        minimumTokensToReclaim: 100, // lower for unit testing
      },
      defaultReserves: {
        outputTokens: 1000,
        toolSchemaTokens: 500,
        safetyTokens: 500,
      },
    });
  });

  const makeParts = (): ContextPart[] => [
    { kind: 'system', label: 'System', content: 'You are Wazir.', priority: 'critical', category: 'PINNED' },
    { kind: 'task', label: 'Objective', content: 'Refactor auth module', priority: 'critical', category: 'PINNED' },
    { kind: 'conversation', label: 'Turn 1', content: 'Explored repository directory layout', priority: 'optional', category: 'COMPRESSIBLE' },
    { kind: 'conversation', label: 'Turn 2', content: 'Searched for UserSession symbol across files', priority: 'optional', category: 'COMPRESSIBLE' },
    { kind: 'conversation', label: 'Turn 3', content: 'Found obsolete auth token implementation in legacy.ts', priority: 'optional', category: 'COMPRESSIBLE' },
    { kind: 'conversation', label: 'Turn 4', content: 'Ran initial tests: 3 failures in auth suite', priority: 'optional', category: 'COMPRESSIBLE' },
    { kind: 'conversation', label: 'Turn 5', content: 'Applied fix to authHandler.ts', priority: 'important', category: 'COMPRESSIBLE' },
    { kind: 'conversation', label: 'Turn 6', content: 'Latest test run: 1 failure remaining', priority: 'important', category: 'ACTIVE' },
  ];

  it('creates initial ContextSnapshot with generation 1 and partitions categories', () => {
    const parts = makeParts();
    const snapshot = service.createInitialSnapshot({
      executionId: 'exec-1',
      modelId: 'test-model',
      effectiveContextWindow: 10000,
      parts,
    });

    expect(snapshot.generation).toBe(1);
    expect(snapshot.executionId).toBe('exec-1');
    expect(snapshot.pinned.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.pinned.every(p => p.category === 'PINNED')).toBe(true);
    expect(snapshot.active.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.compressible.length).toBeGreaterThanOrEqual(1);
  });

  it('evaluates shouldAutoCompact based on usable input budget utilization', () => {
    const parts = makeParts();
    // Effective: 10,000. Reserves: 2,000. Usable: 8,000. 75% threshold = 6,000 tokens.
    const snapshot = service.createInitialSnapshot({
      executionId: 'exec-auto',
      modelId: 'test-model',
      effectiveContextWindow: 10000,
      parts,
    });

    // Currently small token count
    const below = service.shouldAutoCompact('exec-auto');
    expect(below.shouldCompact).toBe(false);
    expect(below.utilization).toBeLessThan(0.75);

    // Simulate high token count in snapshot
    snapshot.estimatedTokens = 6500;
    const above = service.shouldAutoCompact('exec-auto');
    expect(above.shouldCompact).toBe(true);
    expect(above.utilization).toBeGreaterThanOrEqual(0.75);
  });

  it('compacts eligible history while strictly preserving PINNED context and recent tail', async () => {
    // Create large compressible content to ensure tokens saved > minimumTokensToReclaim
    const longContent = 'Detail information line '.repeat(100);
    const parts: ContextPart[] = [
      { kind: 'system', label: 'System', content: 'CRITICAL_SYSTEM_INSTRUCTION', priority: 'critical', category: 'PINNED' },
      { kind: 'task', label: 'Objective', content: 'CRITICAL_TASK_REQUIREMENT', priority: 'critical', category: 'PINNED' },
      { kind: 'conversation', label: 'Old Turn 1', content: longContent, priority: 'optional', category: 'COMPRESSIBLE' },
      { kind: 'conversation', label: 'Old Turn 2', content: longContent, priority: 'optional', category: 'COMPRESSIBLE' },
      { kind: 'conversation', label: 'Old Turn 3', content: longContent, priority: 'optional', category: 'COMPRESSIBLE' },
      { kind: 'conversation', label: 'Recent Tail', content: 'RECENT_TAIL_MESSAGE', priority: 'important', category: 'COMPRESSIBLE' },
    ];

    const initial = service.createInitialSnapshot({
      executionId: 'exec-preserve',
      modelId: 'test-model',
      effectiveContextWindow: 20000,
      parts,
    });

    const result = await service.compact({
      executionId: 'exec-preserve',
      trigger: 'USER',
      reason: 'Manual compaction test',
      force: true,
    });

    expect(result.status).toBe('compacted');
    expect(result.snapshotId).toBeDefined();

    const latest = service.getLatestSnapshot('exec-preserve');
    expect(latest).toBeDefined();
    expect(latest!.generation).toBe(2);

    // PINNED context must be completely preserved
    const pinnedContent = latest!.pinned.map(p => p.content);
    expect(pinnedContent).toContain('CRITICAL_SYSTEM_INSTRUCTION');
    expect(pinnedContent).toContain('CRITICAL_TASK_REQUIREMENT');

    // Recent tail must be preserved
    const tailContent = latest!.tail.map(p => p.content);
    expect(tailContent).toContain('RECENT_TAIL_MESSAGE');

    // Compressed summary part must be present
    expect(latest!.compressed).toBeDefined();
    expect(latest!.compressed![0].content).toContain('Context Compaction Summary');
  });

  it('leaves previous context untouched and returns CONTEXT_SUMMARY_INVALID on schema violation', async () => {
    const invalidService = new ContextCompactionService({
      summarizer: async () => {
        // Return an object missing mandatory fields like 'objective', 'workspaceRevision', etc.
        return {
          objective: '',
          // missing requirements, decisions, files, etc.
        } as unknown as StructuredCompactionSummary;
      },
    });

    const parts = makeParts();
    const initial = invalidService.createInitialSnapshot({
      executionId: 'exec-invalid',
      modelId: 'test-model',
      effectiveContextWindow: 10000,
      parts,
    });

    const result = await invalidService.compact({
      executionId: 'exec-invalid',
      trigger: 'AGENT',
      force: true,
    });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('CONTEXT_SUMMARY_INVALID');

    // Previous valid snapshot is completely preserved
    const current = invalidService.getLatestSnapshot('exec-invalid');
    expect(current).toBe(initial);
    expect(current!.generation).toBe(1);
  });

  it('leaves previous context untouched and returns CONTEXT_COMPACTION_FAILED on summarizer crash', async () => {
    const crashingService = new ContextCompactionService({
      summarizer: async () => {
        throw new Error('LLM provider rate limit exceeded');
      },
    });

    const parts = makeParts();
    const initial = crashingService.createInitialSnapshot({
      executionId: 'exec-crash',
      modelId: 'test-model',
      effectiveContextWindow: 10000,
      parts,
    });

    const result = await crashingService.compact({
      executionId: 'exec-crash',
      trigger: 'AUTO',
      force: true,
    });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('CONTEXT_COMPACTION_FAILED');
    expect(result.error).toContain('LLM provider rate limit exceeded');

    // Previous snapshot intact
    expect(crashingService.getLatestSnapshot('exec-crash')).toBe(initial);
  });

  it('prevents concurrent conflicting compactions on the same execution', async () => {
    let resolver: () => void;
    const blockPromise = new Promise<void>(resolve => {
      resolver = resolve;
    });

    const slowService = new ContextCompactionService({
      summarizer: async () => {
        await blockPromise;
        return {
          objective: 'Test',
          requirements: [],
          decisions: [],
          files: { read: [], modified: [], created: [] },
          currentState: 'done',
          workspaceRevision: 1,
          verification: { build: 'ok', tests: 'ok', revision: 1 },
          errors: [],
          importantSymbols: [],
          toolArtifacts: [],
          remainingWork: [],
          constraints: [],
          provenance: { compactedRange: '1-5', createdAt: new Date().toISOString() },
        };
      },
    });

    const parts = makeParts();
    slowService.createInitialSnapshot({
      executionId: 'exec-conflict',
      modelId: 'test-model',
      effectiveContextWindow: 10000,
      parts,
    });

    // Start compaction 1 (will pause inside summarizer)
    const promise1 = slowService.compact({
      executionId: 'exec-conflict',
      trigger: 'USER',
      force: true,
    });

    // Start compaction 2 immediately
    const result2 = await slowService.compact({
      executionId: 'exec-conflict',
      trigger: 'AGENT',
      force: true,
    });

    expect(result2.status).toBe('failed');
    expect(result2.errorCode).toBe('CONTEXT_GENERATION_CONFLICT');

    // Unblock compaction 1
    resolver!();
    const result1 = await promise1;
    expect(result1.status).toBe('compacted');
  });

  it('skips compaction when token savings are below minimumTokensToReclaim without force', async () => {
    const parts = makeParts();
    service.createInitialSnapshot({
      executionId: 'exec-small',
      modelId: 'test-model',
      effectiveContextWindow: 10000,
      parts,
    });

    const result = await service.compact({
      executionId: 'exec-small',
      trigger: 'AGENT',
      force: false,
    });

    expect(result.status).toBe('skipped');
  });
});
