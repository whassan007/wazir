import { describe, expect, it } from 'vitest';
import {
  ContextCompactionService,
  optimizeContextPartsForBudget,
} from '../src/services/contextCompactionService.js';
import { WEB_TRUST_INSTRUCTION } from '../src/services/contextCompiler.js';
import type { ContextPart, ContextSnapshot } from '../src/types/context.js';

describe('Context Optimization & Bounded Snapshot Retention (Agent 08)', () => {
  it('removes exact duplicate non-pinned history/tool parts and measures tokensSaved', () => {
    const parts: ContextPart[] = [
      {
        kind: 'system',
        label: 'System Prompt',
        content: 'You are Wazir, a local-first AI coding assistant.',
        priority: 'critical',
        category: 'PINNED',
      },
      {
        kind: 'tools',
        label: 'bash',
        content: 'Error: ECONNREFUSED 127.0.0.1:5432',
        priority: 'optional',
      },
      {
        kind: 'tools',
        label: 'bash',
        content: 'Error:   ECONNREFUSED   127.0.0.1:5432 ',
        priority: 'optional',
      },
      {
        kind: 'conversation',
        label: 'Turn 1',
        content: 'Read file packages/core/src/index.ts and inspected exports.',
        priority: 'optional',
      },
      {
        kind: 'conversation',
        label: 'Turn 2 (duplicate)',
        content: 'Read file packages/core/src/index.ts and inspected exports.',
        priority: 'optional',
      },
    ];

    const res = optimizeContextPartsForBudget(parts);
    expect(res.duplicatesRemoved).toBe(2);
    expect(res.parts).toHaveLength(3);
    expect(res.tokensAfter).toBeLessThan(res.tokensBefore);
    expect(res.tokensSaved).toBe(res.tokensBefore - res.tokensAfter);
  });

  it('strips repeated WEB_TRUST_INSTRUCTION headers across retrieved parts while preserving the primary instruction', () => {
    const parts: ContextPart[] = [
      {
        kind: 'system',
        label: 'Trust Policy',
        content: `${WEB_TRUST_INSTRUCTION}\nSystem rules active.`,
        priority: 'critical',
        category: 'PINNED',
      },
      {
        kind: 'retrieved',
        label: 'Doc 1',
        content: `${WEB_TRUST_INSTRUCTION}\nFirst retrieved snippet body.`,
        priority: 'optional',
      },
      {
        kind: 'retrieved',
        label: 'Doc 2',
        content: `${WEB_TRUST_INSTRUCTION}\nSecond retrieved snippet body.`,
        priority: 'optional',
      },
    ];

    const res = optimizeContextPartsForBudget(parts, { stripRepeatedHeaders: true });
    expect(res.parts[0]!.content).toContain(WEB_TRUST_INSTRUCTION);
    expect(res.parts[1]!.content).not.toContain(WEB_TRUST_INSTRUCTION);
    expect(res.parts[1]!.content).toContain('First retrieved snippet body.');
    expect(res.parts[2]!.content).not.toContain(WEB_TRUST_INSTRUCTION);
    expect(res.parts[2]!.content).toContain('Second retrieved snippet body.');
    expect(res.tokensSaved).toBeGreaterThan(20);
  });

  it('strictly preserves must, system, task, and PINNED parts under tight token budgets while head+tail truncating low-priority parts', () => {
    const pinnedSystem = 'SYSTEM_MUST_SURVIVE_INTACT_12345';
    const pinnedTask = 'TASK_OBJECTIVE_MUST_SURVIVE_INTACT_67890';
    const pinnedMust = 'MUST_PRIORITY_VERIFICATION_STATE_INTACT';
    const oversizedHistory = `HEAD_MARKER_START ${'verbose log output '.repeat(120)} TAIL_MARKER_END`;

    const parts: ContextPart[] = [
      {
        kind: 'system',
        label: 'System',
        content: pinnedSystem,
        priority: 'critical',
        category: 'PINNED',
      },
      {
        kind: 'task',
        label: 'Task',
        content: pinnedTask,
        priority: 'critical',
        category: 'PINNED',
      },
      {
        kind: 'memory',
        label: 'Verification',
        content: pinnedMust,
        priority: 'must' as any,
        category: 'PINNED',
      },
      {
        kind: 'conversation',
        label: 'Verbose History',
        content: oversizedHistory,
        priority: 'optional',
        category: 'COMPRESSIBLE',
      },
    ];

    const res = optimizeContextPartsForBudget(parts, { maxTotalTokens: 120 });

    expect(res.truncatedParts).toBeGreaterThanOrEqual(1);
    expect(res.tokensAfter).toBeLessThanOrEqual(120);

    const joined = res.parts.map((p) => p.content).join('\n');
    expect(joined).toContain(pinnedSystem);
    expect(joined).toContain(pinnedTask);
    expect(joined).toContain(pinnedMust);

    const historyPart = res.parts.find((p) => p.label === 'Verbose History');
    expect(historyPart).toBeDefined();
    expect(historyPart!.content).toContain('HEAD_MARKER_START');
    expect(historyPart!.content).toContain('...[context truncated for budget]...');
    expect(historyPart!.content).toContain('TAIL_MARKER_END');
  });

  it('bounds snapshotsByExecution to maxSnapshotsPerExecution while preserving generation 1 and the most recent snapshots', () => {
    const service = new ContextCompactionService({
      maxSnapshotsPerExecution: 5,
    });

    const baseParts: ContextPart[] = [
      {
        kind: 'system',
        label: 'System',
        content: 'System prompt',
        priority: 'critical',
        category: 'PINNED',
      },
    ];

    service.createInitialSnapshot({
      executionId: 'exec-bounded',
      modelId: 'qwen3-coder:30b',
      effectiveContextWindow: 8192,
      parts: baseParts,
    });

    for (let gen = 2; gen <= 12; gen++) {
      const snap: ContextSnapshot = {
        id: `snap-gen-${gen}`,
        executionId: 'exec-bounded',
        generation: gen,
        modelId: 'qwen3-coder:30b',
        effectiveContextWindow: 8192,
        estimatedTokens: 100 + gen,
        createdAt: new Date(),
        pinned: baseParts,
        active: [],
        compressible: [],
        tail: [],
        artifactReferences: [],
      };
      service.registerSnapshot(snap);
    }

    const retained = service.getSnapshots('exec-bounded');
    expect(retained).toHaveLength(5);
    // Generation 1 is always preserved alongside the 4 most recent generations (9, 10, 11, 12)
    expect(retained.map((s) => s.generation)).toEqual([1, 9, 10, 11, 12]);
    expect(service.getLatestSnapshot('exec-bounded')?.generation).toBe(12);
  });
});
