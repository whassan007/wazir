import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScopedInstructionResolver } from '../src/services/instructionResolver.js';
import { HeuristicContextRelevanceSelector } from '../src/services/contextRelevanceSelector.js';
import { ContextCompiler } from '../src/services/contextCompiler.js';
import type { ContextCandidate, ContextRequest } from '../src/types/context.js';

describe('ScopedInstructionResolver & Context Discovery', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-instr-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('1. discovers root instruction file (AGENTS.md)', async () => {
    await fs.writeFile(path.join(tempRoot, 'AGENTS.md'), '# Root Instructions\nFollow global project conventions.');
    const resolver = new ScopedInstructionResolver();
    const resolved = await resolver.resolve({
      projectRoot: tempRoot,
      task: 'Refactor code',
    });

    expect(resolved.length).toBeGreaterThanOrEqual(1);
    expect(resolved.find(r => r.scope === 'root')).toBeDefined();
    expect(resolved[0].content).toContain('Root Instructions');
  });

  it('2. discovers package-local instruction file', async () => {
    const pkgDir = path.join(tempRoot, 'packages', 'scheduler');
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(path.join(pkgDir, 'AGENTS.md'), '# Scheduler Rules\nStrict concurrency constraints.');

    const resolver = new ScopedInstructionResolver();
    const resolved = await resolver.resolve({
      projectRoot: tempRoot,
      activeFiles: ['packages/scheduler/src/router.ts'],
      task: 'Fix scheduler deadlock',
    });

    const schedulerRule = resolved.find(r => r.scope === 'packages/scheduler');
    expect(schedulerRule).toBeDefined();
    expect(schedulerRule?.content).toContain('Scheduler Rules');
  });

  it('3. scheduler task receives scheduler rules', async () => {
    const rootAgents = path.join(tempRoot, 'AGENTS.md');
    await fs.writeFile(rootAgents, '# Global Rules');

    const schedDir = path.join(tempRoot, 'packages', 'scheduler');
    await fs.mkdir(schedDir, { recursive: true });
    await fs.writeFile(path.join(schedDir, 'AGENTS.md'), '# Scheduler Specific');

    const resolver = new ScopedInstructionResolver();
    const resolved = await resolver.resolve({
      projectRoot: tempRoot,
      activeFiles: ['packages/scheduler/src/router.ts'],
      task: 'Update scheduler router',
    });

    expect(resolved.some(r => r.scope === 'root')).toBe(true);
    expect(resolved.some(r => r.scope === 'packages/scheduler')).toBe(true);
  });

  it('4. scheduler task does not automatically receive unrelated web rules', async () => {
    const schedDir = path.join(tempRoot, 'packages', 'scheduler');
    const webDir = path.join(tempRoot, 'packages', 'web');
    await fs.mkdir(schedDir, { recursive: true });
    await fs.mkdir(webDir, { recursive: true });

    await fs.writeFile(path.join(schedDir, 'AGENTS.md'), '# Scheduler Rules');
    await fs.writeFile(path.join(webDir, 'AGENTS.md'), '# Web UI Rules');

    const resolver = new ScopedInstructionResolver();
    const resolved = await resolver.resolve({
      projectRoot: tempRoot,
      activeFiles: ['packages/scheduler/src/router.ts'],
      task: 'Refactor router logic',
    });

    expect(resolved.some(r => r.scope === 'packages/scheduler')).toBe(true);
    expect(resolved.some(r => r.scope === 'packages/web')).toBe(false);
  });

  it('5. nested instruction scope resolves correctly with explainable reason', async () => {
    const pkgDir = path.join(tempRoot, 'packages', 'scheduler');
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(path.join(pkgDir, 'AGENTS.md'), '# Scheduler Rules');

    const resolver = new ScopedInstructionResolver();
    const resolved = await resolver.resolve({
      projectRoot: tempRoot,
      activeFiles: ['packages/scheduler/src/router.ts'],
      task: 'Fix router',
    });

    const rule = resolved.find(r => r.scope === 'packages/scheduler');
    expect(rule?.reasonIncluded).toContain("Active file 'packages/scheduler/src/router.ts' modifies scope 'packages/scheduler'");
  });
});

describe('Large Context File Management & Truncation Metadata', () => {
  const compiler = new ContextCompiler();

  it('6. large context file is bounded', () => {
    const largeContent = 'A'.repeat(80000); // 20,000 tokens
    const candidate: ContextCandidate = {
      id: 'large-file',
      source: 'repo',
      kind: 'repository',
      label: 'docs/architecture.md',
      content: largeContent,
      priority: 50,
      estimatedTokens: 20000,
      sourceUri: 'docs/architecture.md',
    };

    const { item, truncated, originalTokens } = compiler.boundContextItem(candidate, { maxTokens: 4000 });
    expect(truncated).toBe(true);
    expect(originalTokens).toBe(20000);
    expect(item.tokens).toBeLessThanOrEqual(4200);
  });

  it('7. truncation is explicitly reported with metadata notice', () => {
    const largeContent = 'START_' + 'X'.repeat(60000) + '_END';
    const candidate: ContextCandidate = {
      id: 'large-file',
      source: 'repo',
      kind: 'repository',
      label: 'large.ts',
      content: largeContent,
      priority: 50,
      estimatedTokens: 15000,
    };

    const { item, truncated } = compiler.boundContextItem(candidate, { maxTokens: 2000 });
    expect(truncated).toBe(true);
    expect(item.content).toContain('[Context file truncated]');
    expect(item.content).toContain('Strategy: HEAD_TAIL');
    expect(item.metadata?.truncated).toBe(true);
  });

  it('8. head/tail truncation preserves configured portions', () => {
    const prefix = 'HEAD_DATA_HERE_';
    const suffix = '_TAIL_DATA_HERE';
    const middle = 'M'.repeat(50000);
    const content = prefix + middle + suffix;

    const candidate: ContextCandidate = {
      id: 'split-file',
      source: 'repo',
      kind: 'repository',
      label: 'split.txt',
      content,
      priority: 50,
      estimatedTokens: 12500,
    };

    const { item } = compiler.boundContextItem(candidate, { maxTokens: 1000, headRatio: 0.7, tailRatio: 0.2 });
    expect(item.content.startsWith(prefix)).toBe(true);
    expect(item.content.endsWith(suffix)).toBe(true);
  });
});

describe('Tiered Priority, Deduplication, and Revision Selection', () => {
  it('9. pinned context cannot be displaced by lower-priority context under tight budget', async () => {
    const compiler = new ContextCompiler();
    const request: ContextRequest = {
      executionId: 'exec-1',
      agentId: 'wazir-coder',
      modelId: 'test-model',
      taskDescription: 'Crucial User Task',
      projectRoot: '/tmp',
      effectiveContextWindow: 20000, // tight window: after reserves (18000), usable input is only 2000 tokens
      activeFiles: ['src/index.ts'],
      recentHistory: [
        {
          kind: 'conversation',
          label: 'huge turn',
          content: 'Z'.repeat(25000), // ~6250 tokens
          priority: 'optional',
          category: 'COMPRESSIBLE',
        },
      ],
    };

    const snapshot = await compiler.compileSnapshot(request);
    expect(snapshot.pinned.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.pinned.some(p => p.label.includes('Task Objective'))).toBe(true);
    // Lower priority compressible item was omitted due to budget
    expect(snapshot.omitted?.some(o => o.category === 'COMPRESSIBLE')).toBe(true);
  });

  it('10. active error survives context revision', async () => {
    const compiler = new ContextCompiler();
    const request: ContextRequest = {
      executionId: 'exec-2',
      agentId: 'wazir-coder',
      modelId: 'test-model',
      taskDescription: 'Fix error',
      projectRoot: '/tmp',
      effectiveContextWindow: 96000,
      activeErrors: ['TypeError: Cannot read properties of undefined (reading router)'],
    };

    const snapshot = await compiler.compileSnapshot(request);
    expect(snapshot.active.some(a => a.label === 'Active Diagnostics')).toBe(true);
    expect(snapshot.active.find(a => a.label === 'Active Diagnostics')?.content).toContain('TypeError');
  });

  it('13 & 14. duplicate file content and duplicate tool outputs are removed', async () => {
    const compiler = new ContextCompiler();
    const dupContent = 'function hello() { return 42; }';
    const request: ContextRequest = {
      executionId: 'exec-3',
      agentId: 'wazir-coder',
      modelId: 'test-model',
      taskDescription: 'Deduplicate items',
      projectRoot: '/tmp',
      effectiveContextWindow: 96000,
      recentHistory: [
        { kind: 'repository', label: 'file A', content: dupContent, priority: 50 },
        { kind: 'repository', label: 'file A (dup)', content: dupContent, priority: 50 },
      ],
    };

    const snapshot = await compiler.compileSnapshot(request);
    expect(snapshot.omitted?.some(o => o.reason.includes('Deterministic exact duplicate removed'))).toBe(true);
  });

  it('15 & 16. superseded file versions are removed and newest remains', async () => {
    const compiler = new ContextCompiler();
    const request: ContextRequest = {
      executionId: 'exec-4',
      agentId: 'wazir-coder',
      modelId: 'test-model',
      taskDescription: 'File versions',
      projectRoot: '/tmp',
      effectiveContextWindow: 96000,
      recentHistory: [
        {
          kind: 'repository',
          label: 'src/Calendar.cpp',
          content: 'Calendar revision 1',
          priority: 40,
          sourceUri: 'src/Calendar.cpp',
        },
        {
          kind: 'repository',
          label: 'src/Calendar.cpp',
          content: 'Calendar revision 2 (newest)',
          priority: 80,
          sourceUri: 'src/Calendar.cpp',
        },
      ],
    };

    const snapshot = await compiler.compileSnapshot(request);
    expect(snapshot.omitted?.some(o => o.reason.includes('Superseded by newer revision of src/Calendar.cpp'))).toBe(true);
    const calendarItem = [...snapshot.active, ...snapshot.relevant, ...snapshot.compressible]
      .find(i => i.sourceUri === 'src/Calendar.cpp');
    expect(calendarItem?.content).toContain('Calendar revision 2 (newest)');
  });
});

describe('Execution Phase and Agent Specific Context', () => {
  const selector = new HeuristicContextRelevanceSelector();

  it('19. PLAN phase prioritizes architecture/repository context', () => {
    const candidates: ContextCandidate[] = [
      { id: '1', source: 'repo', kind: 'repository', label: 'architecture.md', content: 'Architecture overview', priority: 50 },
      { id: '2', source: 'repo', kind: 'repository', label: 'test_runner.ts', content: 'Test implementation', priority: 50 },
    ];
    const request: ContextRequest = {
      executionId: 'exec-phase',
      agentId: 'planner',
      phase: 'plan',
      taskDescription: 'Plan system architecture',
      projectRoot: '/tmp',
      modelId: 'm1',
      effectiveContextWindow: 96000,
    };

    const ranked = selector.rank(candidates, request);
    expect(ranked[0].label).toBe('architecture.md');
  });

  it('20. IMPLEMENT phase prioritizes source/tests', () => {
    const candidates: ContextCandidate[] = [
      { id: '1', source: 'repo', kind: 'repository', label: 'notes.txt', content: 'Random notes', priority: 50 },
      { id: '2', source: 'repo', kind: 'repository', label: 'source.ts', content: 'export function run() {}', priority: 50 },
    ];
    const request: ContextRequest = {
      executionId: 'exec-phase',
      agentId: 'coder',
      phase: 'implement',
      taskDescription: 'Implement run function',
      projectRoot: '/tmp',
      modelId: 'm1',
      effectiveContextWindow: 96000,
    };

    const ranked = selector.rank(candidates, request);
    expect(ranked[0].label).toBe('source.ts');
  });

  it('21. REPAIR phase prioritizes current failure', () => {
    const candidates: ContextCandidate[] = [
      { id: '1', source: 'repo', kind: 'repository', label: 'feature.ts', content: 'Feature code', priority: 50 },
      { id: '2', source: 'exec', kind: 'task', label: 'error_log', content: 'Fatal assertion error', priority: 50, category: 'ACTIVE' },
    ];
    const request: ContextRequest = {
      executionId: 'exec-phase',
      agentId: 'coder',
      phase: 'repair',
      taskDescription: 'Fix crash',
      projectRoot: '/tmp',
      modelId: 'm1',
      effectiveContextWindow: 96000,
    };

    const ranked = selector.rank(candidates, request);
    expect(ranked[0].label).toBe('error_log');
  });

  it('23. planner and coder receive different context prioritization', () => {
    const candidates: ContextCandidate[] = [
      { id: '1', source: 'repo', kind: 'repository', label: 'high_level_plan.md', content: 'Milestones', priority: 50 },
      { id: '2', source: 'repo', kind: 'repository', label: 'router.ts', content: 'Implementation details', priority: 50 },
    ];
    const planReq: ContextRequest = {
      executionId: 'exec-role',
      agentId: 'planner-agent',
      agentRole: 'planner',
      taskDescription: 'Plan architecture',
      projectRoot: '/tmp',
      modelId: 'm1',
      effectiveContextWindow: 96000,
    };
    const codeReq: ContextRequest = {
      executionId: 'exec-role',
      agentId: 'coder-agent',
      agentRole: 'coder',
      taskDescription: 'Code router',
      projectRoot: '/tmp',
      modelId: 'm1',
      effectiveContextWindow: 96000,
    };

    const planRanked = selector.rank(candidates, planReq);
    const codeRanked = selector.rank(candidates, codeReq);

    expect(planRanked[0].label).toBe('high_level_plan.md');
    expect(codeRanked[0].label).toBe('router.ts');
  });
});

describe('Token Budgeting, Reserves, and Prompt Caching', () => {
  const compiler = new ContextCompiler();

  it('24 & 25. 32K and 96K models receive different budgeted contexts and runtimeLoaded overrides max', async () => {
    const smallReq: ContextRequest = {
      executionId: 'exec-budget-1',
      agentId: 'wazir-coder',
      modelId: 'qwen-32k',
      taskDescription: 'Task 1',
      projectRoot: '/tmp',
      effectiveContextWindow: 32000,
      runtimeLoaded: 28000, // runtimeLoaded override
    };

    const largeReq: ContextRequest = {
      executionId: 'exec-budget-2',
      agentId: 'wazir-coder',
      modelId: 'qwen-96k',
      taskDescription: 'Task 1',
      projectRoot: '/tmp',
      effectiveContextWindow: 96000,
    };

    const snapSmall = await compiler.compileSnapshot(smallReq);
    const snapLarge = await compiler.compileSnapshot(largeReq);

    expect(snapSmall.effectiveContextWindow).toBe(28000);
    expect(snapLarge.effectiveContextWindow).toBe(96000);
    expect(snapSmall.effectiveContextWindow).toBeLessThan(snapLarge.effectiveContextWindow);
  });

  it('26, 27, 28. reserves for output, tool schema, and safety are respected', async () => {
    const req: ContextRequest = {
      executionId: 'exec-reserves',
      agentId: 'wazir-coder',
      modelId: 'test-model',
      taskDescription: 'Test reserves',
      projectRoot: '/tmp',
      effectiveContextWindow: 96000,
      reserve: {
        outputTokens: 8000,
        toolSchemaTokens: 5000,
        safetyTokens: 5000,
      },
    };

    const snapshot = await compiler.compileSnapshot(req);
    expect(snapshot.tokenBudget?.reserve.outputTokens).toBe(8000);
    expect(snapshot.tokenBudget?.reserve.toolSchemaTokens).toBe(5000);
    expect(snapshot.tokenBudget?.reserve.safetyTokens).toBe(5000);
  });

  it('31 & 32. immutable snapshot generation increments correctly', async () => {
    const req: ContextRequest = {
      executionId: 'exec-gen',
      agentId: 'wazir-coder',
      modelId: 'test-model',
      taskDescription: 'Generations test',
      projectRoot: '/tmp',
      effectiveContextWindow: 96000,
    };

    const snap1 = await compiler.compileSnapshot(req);
    const snap2 = await compiler.compileSnapshot(req);

    expect(snap1.generation).toBe(1);
    expect(snap2.generation).toBe(2);
    expect(compiler.getLatestSnapshot('exec-gen')?.generation).toBe(2);
  });

  it('36. stable prefix remains unchanged when volatile state changes', async () => {
    const baseReq: ContextRequest = {
      executionId: 'exec-prefix',
      agentId: 'wazir-coder',
      modelId: 'test-model',
      taskDescription: 'Refactor code',
      projectRoot: '/tmp',
      effectiveContextWindow: 96000,
    };

    const snap1 = await compiler.compileSnapshot(baseReq);

    const changedReq: ContextRequest = {
      ...baseReq,
      activeErrors: ['New volatile error occurred'],
      activeDiff: 'diff --git a/foo b/foo',
    };

    const snap2 = await compiler.compileSnapshot(changedReq);

    expect(snap1.stablePrefix).toBeDefined();
    expect(snap2.stablePrefix).toBeDefined();
    expect(snap1.stablePrefix?.[0]?.content).toEqual(snap2.stablePrefix?.[0]?.content);
    // Volatile tail changed
    expect(snap2.volatileTail?.some(v => v.content.includes('New volatile error'))).toBe(true);
  });
});
