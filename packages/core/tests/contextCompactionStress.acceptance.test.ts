import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ContextCompactionService,
  ContextCompiler,
  ObservationCompactor,
  OffloadStore,
  computeUsableBudget,
  computeUtilization,
  deduplicateContextParts,
  estimateTokens,
  tokensForPart,
  type ContextPart,
  type ToolResult,
} from '../src/index.js';

describe('Context Compaction Pipeline Acceptance & Stress Test (Stage 8)', () => {
  let tmpWorkspace: string;
  let offloadStore: OffloadStore;
  let compactor: ObservationCompactor;
  let compactionService: ContextCompactionService;

  beforeEach(async () => {
    tmpWorkspace = await mkdtemp(path.join(tmpdir(), 'wazir-stress-test-'));
    offloadStore = new OffloadStore({ workspace: tmpWorkspace, enabled: true });
    compactor = new ObservationCompactor({
      toolResultMaxTokens: 2000,
      toolResultPreviewTokens: 500,
    });
    compactionService = new ContextCompactionService({
      config: {
        autoThreshold: 0.75,
        targetUtilization: 0.45,
        preserveRecentTailRatio: 0.5,
        minimumTokensToReclaim: 1000,
      },
      defaultReserves: {
        outputTokens: 8000,
        toolSchemaTokens: 5000,
        safetyTokens: 5000,
      },
    });
  });

  afterEach(async () => {
    await rm(tmpWorkspace, { recursive: true, force: true });
  });

  it('runs complete multi-turn simulation proving context reduction while preserving authoritative facts', async () => {
    const effectiveContextTokens = 96000;
    const usableBudget = computeUsableBudget({
      effectiveContextTokens,
      reserveOutputTokens: 8000,
      reserveToolSchemaTokens: 5000,
      reserveSafetyTokens: 5000,
    }); // 78,000 tokens

    // 1. Initial Pinned Context (Never compacted)
    const pinnedSystem: ContextPart = {
      kind: 'system',
      label: 'System Prompt',
      content: 'You are Wazir autonomous coding agent. Strictly adhere to security invariants.',
      priority: 'critical',
      category: 'PINNED',
    };
    const pinnedTask: ContextPart = {
      kind: 'task',
      label: 'Task Objective',
      content: 'Refactor AST parsing engine and repair compiler typecheck failure in parser.ts',
      priority: 'critical',
      category: 'PINNED',
    };

    // 2. Execution History: Simulated raw operations
    const rawExecutionHistory: Array<{ tool: string; input: Record<string, unknown>; result: ToolResult }> = [];

    // Operation A: Repeated file reads (identical files read multiple times across turns)
    const readContent = 'export interface AstNode { id: string; type: string; children: AstNode[]; }\n'.repeat(50);
    for (let i = 0; i < 4; i++) {
      rawExecutionHistory.push({
        tool: 'read',
        input: { path: 'packages/core/src/parser.ts' },
        result: { ok: true, output: readContent },
      });
    }

    // Operation B: Massive 15,000+ token shell output (approx 65,000 characters)
    const hugeShellLines: string[] = [];
    for (let i = 0; i < 1500; i++) {
      hugeShellLines.push(`[info] [build-step-${i}] Compiling unit AST chunk ${i}: generated symbol table entry with metadata index ${i * 4}`);
    }
    hugeShellLines.push('src/parser.ts(88,12): error TS2322: Type "AstNode" is not assignable to type "ParseResult".');
    hugeShellLines.push('src/parser.ts(104,5): error TS2304: Cannot find name "parseStatement".');
    hugeShellLines.push('Command exited with code 1');
    const hugeShellOutput = hugeShellLines.join('\n');
    const hugeTokens = estimateTokens(hugeShellOutput);
    expect(hugeTokens).toBeGreaterThan(15000);

    rawExecutionHistory.push({
      tool: 'shell',
      input: { command: 'npm run build' },
      result: { ok: false, error: 'Build failed', output: hugeShellOutput },
    });

    // Operation C: Multiple repository searches
    for (let i = 0; i < 5; i++) {
      rawExecutionHistory.push({
        tool: 'search',
        input: { query: 'parseStatement' },
        result: {
          ok: true,
          output: `src/parser.ts:104: export function parseStatement(): AstNode { return { id: "${i}", type: "stmt", children: [] }; }`,
        },
      });
    }

    // Operation D: Repair edit and successful verification
    rawExecutionHistory.push({
      tool: 'edit',
      input: { path: 'src/parser.ts', operation: 'fix-types' },
      result: { ok: true, output: '1 change applied successfully' },
    });
    rawExecutionHistory.push({
      tool: 'build',
      input: { command: 'tsc --build' },
      result: { ok: true, output: 'Build succeeded with 0 errors' },
    });

    // --- PROVE WITHOUT OPTIMIZATION ---
    // If we fed raw execution output directly into model context:
    const unoptimizedParts: ContextPart[] = [
      pinnedSystem,
      pinnedTask,
      ...rawExecutionHistory.map((op, idx) => ({
        kind: 'conversation' as const,
        label: `Turn ${idx + 1}: ${op.tool}`,
        content: op.result.output,
        priority: 'optional' as const,
        category: 'COMPRESSIBLE' as const,
      })),
    ];

    const unoptimizedTokens = unoptimizedParts.reduce((s, p) => s + tokensForPart(p), 0);
    const unoptimizedUtilization = computeUtilization(unoptimizedTokens, usableBudget);

    // Unoptimized context consumed massive tokens largely from the 15,000+ token shell output
    expect(unoptimizedTokens).toBeGreaterThan(18000);

    // --- PROVE WITH OPTIMIZATION ---

    // 1. Layer 1: Oversized tool result offloading
    const layer1Parts: ContextPart[] = [pinnedSystem, pinnedTask];
    let offloadedCount = 0;

    for (let i = 0; i < rawExecutionHistory.length; i++) {
      const op = rawExecutionHistory[i];
      const compactedObs = await compactor.compactWithOffload(
        op.tool,
        op.input,
        op.result,
        offloadStore,
        'exec-stress-1',
        `call-${i + 1}`,
      );

      if (compactedObs.offloadArtifact) {
        offloadedCount++;
        // Verify artifact retrieval byte-for-byte
        const retrieved = await offloadStore.retrieve(compactedObs.offloadArtifact);
        expect(retrieved).toBe(op.result.ok ? op.result.output : [op.result.error, op.result.output].filter(Boolean).join('\n'));

        // Verify SHA256 integrity
        const verified = await offloadStore.verify(compactedObs.offloadArtifact);
        expect(verified).toBe(true);

        // Verify model replacement is bounded and contains structured failure info
        expect(compactedObs.text).toContain('[Tool output compacted]');
        expect(compactedObs.text).toContain('TS2322');
        expect(compactedObs.text).toContain('TS2304');
        expect(compactedObs.visibleTokens).toBeLessThan(1000);
      }

      layer1Parts.push({
        kind: 'conversation',
        label: op.tool === 'read' ? 'File: packages/core/src/parser.ts' : `Turn ${i + 1}: ${op.tool}`,
        content: compactedObs.text,
        priority: i >= rawExecutionHistory.length - 2 ? 'important' : 'optional',
        category: i >= rawExecutionHistory.length - 2 ? 'ACTIVE' : 'COMPRESSIBLE',
      });
    }

    expect(offloadedCount).toBeGreaterThanOrEqual(1);

    // 2. Deterministic Deduplication
    const { deduplicated, removedCount } = deduplicateContextParts(layer1Parts);
    // Identical file reads were deduplicated without requiring any LLM call
    expect(removedCount).toBeGreaterThan(0);

    // 3. Layer 2: Semantic Compression with immutable snapshot
    const initialSnapshot = compactionService.createInitialSnapshot({
      executionId: 'exec-stress-1',
      modelId: 'qwen2.5-coder',
      effectiveContextWindow: effectiveContextTokens,
      parts: deduplicated,
    });

    const compactionResult = await compactionService.compact({
      executionId: 'exec-stress-1',
      trigger: 'AUTO',
      reason: 'Crossed utilization threshold in stress test',
      force: true,
    });

    expect(compactionResult.status).toBe('compacted');
    expect(compactionResult.snapshotId).toBeDefined();

    const finalSnapshot = compactionService.getLatestSnapshot('exec-stress-1');
    expect(finalSnapshot).toBeDefined();
    expect(finalSnapshot!.generation).toBe(2);

    // Prove Pinned context survived
    expect(finalSnapshot!.pinned.map(p => p.content)).toContain(pinnedSystem.content);
    expect(finalSnapshot!.pinned.map(p => p.content)).toContain(pinnedTask.content);

    // Prove structured summary is present and validated
    expect(finalSnapshot!.compressed).toBeDefined();
    expect(finalSnapshot!.compressed![0].content).toContain('Context Compaction Summary');

    // Prove tokens reduced significantly
    const finalTokens = finalSnapshot!.estimatedTokens;
    expect(finalTokens).toBeLessThan(unoptimizedTokens);
    const reductionRatio = (unoptimizedTokens - finalTokens) / unoptimizedTokens;
    expect(reductionRatio).toBeGreaterThan(0.70); // Greater than 70% token savings!

    // Invariant check: The original raw execution history remains completely intact!
    expect(rawExecutionHistory[4].result.output).toBe(hugeShellOutput);
    expect(rawExecutionHistory[4].result.output.length).toBe(hugeShellOutput.length);
  });
});
