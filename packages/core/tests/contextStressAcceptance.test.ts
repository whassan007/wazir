import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContextCompiler } from '../src/services/contextCompiler.js';
import type { ContextPart, ContextRequest } from '../src/types/context.js';

describe('Stress Acceptance Test: Bounded Context under Compaction & Revision', () => {
  let tempRoot: string;
  let compiler: ContextCompiler;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-stress-context-'));
    compiler = new ContextCompiler();

    // 1. Large root project instructions
    await fs.writeFile(
      path.join(tempRoot, 'AGENTS.md'),
      '# Global Agent Instructions\n\n' + 'Global architecture rules.\n'.repeat(500), // ~2500 tokens
    );

    // 2. Package-local instructions for scheduler
    const schedDir = path.join(tempRoot, 'packages', 'scheduler');
    await fs.mkdir(schedDir, { recursive: true });
    await fs.writeFile(
      path.join(schedDir, 'AGENTS.md'),
      '# Scheduler Package Rules\n\n' + 'Strict queue concurrency rules.\n'.repeat(300), // ~1500 tokens
    );

    // 3. Unrelated package instructions (web)
    const webDir = path.join(tempRoot, 'packages', 'web');
    await fs.mkdir(webDir, { recursive: true });
    await fs.writeFile(
      path.join(webDir, 'AGENTS.md'),
      '# Web Package Rules\n\n' + 'React UI rendering and CSS rules.\n'.repeat(400),
    );
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('proves that long-running coding scenario produces bounded ContextSnapshot with all invariants', async () => {
    const activeFiles = ['packages/scheduler/src/router.ts'];
    const activeErrors = ['AssertionError: deadlock detected in scheduler worker pool'];

    // Simulated 50-turn execution history with:
    // - repeated file reads
    // - multiple versions of the same file
    // - large tool results
    // - repeated repository searches
    // - compiler failure and repair attempts
    const noisyHistory: ContextPart[] = [];

    // Repeated file reads of Calendar.cpp with 3 revisions
    noisyHistory.push({
      kind: 'repository',
      label: 'packages/scheduler/src/router.ts (v1)',
      content: 'router revision 1\n' + 'int count = 0;\n'.repeat(100),
      priority: 30,
      sourceUri: 'packages/scheduler/src/router.ts',
    });
    noisyHistory.push({
      kind: 'repository',
      label: 'packages/scheduler/src/router.ts (v2)',
      content: 'router revision 2\n' + 'int count = 1;\n'.repeat(100),
      priority: 50,
      sourceUri: 'packages/scheduler/src/router.ts',
    });
    noisyHistory.push({
      kind: 'repository',
      label: 'packages/scheduler/src/router.ts (v3 - current)',
      content: 'router revision 3\n' + 'int count = 2;\n'.repeat(100),
      priority: 90,
      sourceUri: 'packages/scheduler/src/router.ts',
    });

    // Enormous tool results / searches repeated
    const largeToolOutput = 'search result match file.ts: line 10\n'.repeat(1000); // 37,000 chars (~9250 tokens)
    noisyHistory.push({
      kind: 'retrieved',
      label: 'grep search output (1)',
      content: largeToolOutput,
      priority: 20,
    });
    noisyHistory.push({
      kind: 'retrieved',
      label: 'grep search output (2 - exact duplicate)',
      content: largeToolOutput,
      priority: 20,
    });

    // Compiler errors and repair cycles
    for (let i = 1; i <= 20; i++) {
      noisyHistory.push({
        kind: 'conversation',
        label: `turn ${i} - inspect and test`,
        content: `Executed npm test on scheduler module: attempt ${i}`,
        priority: 40,
        category: 'COMPRESSIBLE',
      });
    }

    // Recent tail (latest turns)
    noisyHistory.push({
      kind: 'conversation',
      label: 'recent turn: applied mutex lock',
      content: 'Applied mutex lock to router dispatch method',
      priority: 80,
      category: 'ACTIVE',
    });

    // Naive transcript includes all instructions (root, scheduler, web), repeated file reads, duplicates, etc.
    const allInstructions = [
      '# Global Agent Instructions\n\n' + 'Global architecture rules.\n'.repeat(500),
      '# Scheduler Package Rules\n\n' + 'Strict queue concurrency rules.\n'.repeat(300),
      '# Web Package Rules\n\n' + 'React UI rendering and CSS rules.\n'.repeat(400),
    ];
    const naiveTotalTokens = noisyHistory.reduce(
      (sum, p) => sum + Math.ceil(p.content.length / 4),
      0,
    ) + allInstructions.reduce((sum, inst) => sum + Math.ceil(inst.length / 4), 0);

    const startTime = Date.now();

    const request: ContextRequest = {
      executionId: 'exec-stress-test',
      agentId: 'wazir-coding-agent',
      agentRole: 'coder',
      phase: 'repair',
      taskDescription: 'Fix concurrency deadlock in scheduler worker pool',
      projectRoot: tempRoot,
      activeFiles,
      activeErrors,
      recentHistory: noisyHistory,
      effectiveContextWindow: 96000,
    };

    const snapshot = await compiler.compileSnapshot(request);
    const compileDurationMs = Date.now() - startTime;

    // INVARIANT 1: Unrelated package instructions excluded
    const includedItems = [
      ...snapshot.pinned,
      ...snapshot.active,
      ...(snapshot.relevant ?? []),
      ...(snapshot.compressed ?? []),
      ...snapshot.tail,
    ];

    expect(includedItems.some((i) => i.label.includes('Web Package Rules') || i.content.includes('Web Package Rules'))).toBe(false);

    // INVARIANT 2: Scoped package instructions included
    expect(includedItems.some((i) => i.label.includes('packages/scheduler') || i.content.includes('Scheduler Package Rules'))).toBe(true);

    // INVARIANT 3: Exact duplicates removed
    expect(
      snapshot.omitted?.some((o) => o.reason.includes('Deterministic exact duplicate removed')),
    ).toBe(true);

    // INVARIANT 4: Superseded file versions removed; newest preserved
    expect(
      snapshot.omitted?.some((o) =>
        o.reason.includes('Superseded by newer revision of packages/scheduler/src/router.ts'),
      ),
    ).toBe(true);
    const activeRouter = [
      ...snapshot.active,
      ...(snapshot.relevant ?? []),
      ...(snapshot.compressed ?? []),
    ].find((i) => i.sourceUri === 'packages/scheduler/src/router.ts');
    expect(activeRouter?.content).toContain('router revision 3');

    // INVARIANT 5: Active error survives
    expect(snapshot.active.some((a) => a.content.includes('deadlock detected'))).toBe(true);

    // INVARIANT 6: Active model context remains strictly bounded
    expect(snapshot.estimatedTokens).toBeLessThan(naiveTotalTokens);
    expect(snapshot.estimatedTokens).toBeLessThan(snapshot.effectiveContextWindow * 0.7);

    // Verify token savings and duration
    const tokensSaved = naiveTotalTokens - snapshot.estimatedTokens;
    expect(tokensSaved).toBeGreaterThan(5000);
    expect(compileDurationMs).toBeLessThan(1000); // fast compilation
  });
});
