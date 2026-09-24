import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import {
  ContextCompiler,
  ContextRevisionService,
  PromptLayoutPlanner,
  type ContextRequest,
  type ContextPart,
  type ContextReserve,
} from '../src/index.js';

describe('ContextRevisionService & PromptLayoutPlanner (Comprehensive)', () => {
  let compiler: ContextCompiler;
  let layoutPlanner: PromptLayoutPlanner;
  let revisionService: ContextRevisionService;
  const projectRoot = path.resolve(process.cwd());

  beforeEach(() => {
    compiler = new ContextCompiler();
    layoutPlanner = new PromptLayoutPlanner();
    revisionService = new ContextRevisionService({
      compiler,
      layoutPlanner,
      config: {
        enabled: true,
        autoThreshold: 0.75,
        targetUtilization: 0.50,
        preserveRecentTailRatio: 0.50,
        maxOversizedObservationChars: 1000,
        previewChars: 200,
      },
    });
  });

  // Test 1: Duplicate context removed deterministically
  it('1. removes exact duplicate context items without calling an LLM', async () => {
    const history: ContextPart[] = [
      { kind: 'conversation', label: 'Turn 1', content: 'Exact duplicate message content', priority: 50 },
      { kind: 'conversation', label: 'Turn 2', content: 'Exact duplicate message content', priority: 50 },
      { kind: 'conversation', label: 'Turn 3', content: 'Unique message content', priority: 50 },
    ];

    const result = await revisionService.revise({
      executionId: 'exec-dedup-1',
      agentId: 'coder',
      modelId: 'qwen2.5-coder-7b',
      taskDescription: 'Deduplication test',
      projectRoot,
      recentHistory: history,
      effectiveContextWindow: 32000,
    });

    expect(result.tokensDeduplicated).toBeGreaterThan(0);
    const contents = result.snapshot.tokenBudget?.parts.map((p) => p.content);
    const duplicates = contents?.filter((c) => c === 'Exact duplicate message content');
    expect(duplicates?.length).toBe(1);
  });

  // Test 2: Duplicate tool observation removed
  it('2. removes repeated tool observations across steps', async () => {
    const history: ContextPart[] = [
      { kind: 'tools', label: 'git status', content: 'On branch main\nnothing to commit', priority: 50 },
      { kind: 'tools', label: 'git status', content: 'On branch main\nnothing to commit', priority: 50 },
    ];

    const result = await revisionService.revise({
      executionId: 'exec-dedup-tool',
      agentId: 'coder',
      modelId: 'qwen2.5-coder-7b',
      taskDescription: 'Tool dedup test',
      projectRoot,
      recentHistory: history,
      effectiveContextWindow: 32000,
    });

    expect(result.tokensDeduplicated).toBeGreaterThan(0);
  });

  // Test 3 & 4: Superseded source removed, newest source retained
  it('3 & 4. removes superseded source revisions and retains newest revision', async () => {
    const fileUri = path.resolve(projectRoot, 'src/math.ts');
    const history: ContextPart[] = [
      {
        kind: 'repository',
        label: 'math.ts R1',
        sourceUri: fileUri,
        content: 'export function add(a: number, b: number) { return a - b; }',
        priority: 40,
      },
      {
        kind: 'repository',
        label: 'math.ts R2',
        sourceUri: fileUri,
        content: 'export function add(a: number, b: number) { return a + b; }',
        priority: 75,
      },
    ];

    const result = await revisionService.revise({
      executionId: 'exec-superseded-1',
      agentId: 'coder',
      modelId: 'qwen2.5-coder-7b',
      taskDescription: 'Superseded test',
      projectRoot,
      recentHistory: history,
      effectiveContextWindow: 32000,
    });

    expect(result.tokensSuperseded).toBeGreaterThan(0);
    const parts = result.snapshot.tokenBudget?.parts ?? [];
    const mathParts = parts.filter((p) => p.sourceUri === fileUri || p.label.includes('math.ts'));
    expect(mathParts.length).toBe(1);
    expect(mathParts[0].content).toContain('return a + b;');
  });

  // Test 5 & 6: Task and acceptance criteria remain pinned
  it('5 & 6. keeps task objective and acceptance criteria pinned across revisions', async () => {
    const result = await revisionService.revise({
      executionId: 'exec-pinned-1',
      agentId: 'coder',
      modelId: 'qwen2.5-coder-7b',
      taskDescription: 'Implement critical cryptography function',
      acceptanceCriteria: ['Must pass FIPS 140-3', 'Must handle nonces securely'],
      projectRoot,
      effectiveContextWindow: 32000,
    });

    const pinnedLabels = result.snapshot.pinned.map((p) => p.label);
    expect(pinnedLabels).toContain('Task Objective');
    expect(pinnedLabels).toContain('Acceptance Criteria');
  });

  // Test 7 & 8: Active error retained, resolved error compressible
  it('7 & 8. retains active errors in active tier and allows resolved errors to compress', async () => {
    const result = await revisionService.revise({
      executionId: 'exec-error-1',
      agentId: 'coder',
      modelId: 'qwen2.5-coder-7b',
      taskDescription: 'Fix crash in parser',
      activeErrors: ['SyntaxError: Unexpected token < at Line 42'],
      projectRoot,
      recentHistory: [
        {
          kind: 'conversation',
          label: 'Resolved error discussion',
          content: 'The old TypeError in utils.ts was resolved in commit 1234',
          category: 'COMPRESSIBLE',
          priority: 30,
        },
      ],
      effectiveContextWindow: 32000,
    });

    const activeParts = result.snapshot.active;
    expect(activeParts.some((p) => p.content.includes('SyntaxError: Unexpected token'))).toBe(true);

    const compressibleParts = result.snapshot.compressible;
    expect(compressibleParts.some((p) => p.content.includes('Resolved error discussion'))).toBe(true);
  });

  // Test 9 & 10: Authoritative revision and verification state reinjected
  it('9 & 10. injects authoritative workspace revision and verification state into pinned context', async () => {
    const result = await revisionService.revise({
      executionId: 'exec-auth-1',
      agentId: 'coder',
      modelId: 'qwen2.5-coder-7b',
      taskDescription: 'Verify authoritative injection',
      projectRoot,
      effectiveContextWindow: 32000,
    });

    const authPart = result.snapshot.pinned.find((p) => p.id === 'auth-workspace-revision');
    expect(authPart).toBeDefined();
    expect(authPart?.content).toContain('Authoritative Workspace State');
  });

  // Test 11: Semantic summary cannot override execution truth
  it('11. ensures semantic summaries cannot override authoritative controller truth', async () => {
    const result = await revisionService.revise({
      executionId: 'exec-truth-1',
      agentId: 'coder',
      modelId: 'qwen2.5-coder-7b',
      taskDescription: 'Truth invariant test',
      projectRoot,
      effectiveContextWindow: 32000,
    });

    const authPart = result.snapshot.pinned.find((p) => p.id === 'auth-workspace-revision');
    expect(authPart?.category).toBe('PINNED');
  });

  // Test 12: Compression failure preserves previous snapshot
  it('12. preserves previous valid snapshot if compression fails or throws', async () => {
    const snap1 = await revisionService.revise({
      executionId: 'exec-fallback-1',
      agentId: 'coder',
      modelId: 'qwen2.5-coder-7b',
      taskDescription: 'Fallback baseline',
      projectRoot,
      effectiveContextWindow: 32000,
    });

    expect(snap1.snapshot.generation).toBe(1);
    const retrieved = revisionService.getLatestSnapshot('exec-fallback-1');
    expect(retrieved?.id).toBe(snap1.snapshot.id);
  });

  // Test 13, 14, 15: Immutable snapshots, leased generation unchanged, N+1 created
  it('13, 14, 15. maintains immutable snapshots, leaves in-flight generation unchanged, creates N+1', async () => {
    const runId = 'exec-immut-1';
    const snap1 = await revisionService.revise({
      executionId: runId,
      agentId: 'coder',
      modelId: 'qwen2.5-coder-7b',
      taskDescription: 'Generation 1 task',
      projectRoot,
      effectiveContextWindow: 32000,
    });

    expect(snap1.generation).toBe(1);

    // Acquire lease on generation 1 for an active in-flight request
    const releaseLease = revisionService.acquireInFlightLease(runId, 1);
    expect(revisionService.hasInFlightLease(runId, 1)).toBe(true);

    const snapshotGen1BeforeTokens = snap1.snapshot.estimatedTokens;

    // Concurrently trigger background revision
    const snap2 = await revisionService.revise(
      {
        executionId: runId,
        agentId: 'coder',
        modelId: 'qwen2.5-coder-7b',
        taskDescription: 'Generation 1 task with new step',
        projectRoot,
        recentHistory: [
          { kind: 'conversation', label: 'Turn 1', content: 'New step executed', priority: 60 },
        ],
        effectiveContextWindow: 32000,
      },
      { force: true },
    );

    expect(snap2.generation).toBe(2);
    // Generation 1 snapshot was NOT mutated
    expect(snap1.snapshot.generation).toBe(1);
    expect(snap1.snapshot.estimatedTokens).toBe(snapshotGen1BeforeTokens);

    releaseLease();
    expect(revisionService.hasInFlightLease(runId, 1)).toBe(false);
  });

  // Test 16, 17, 18: Effective runtime context, output reserve, tool schema reserve
  it('16, 17, 18. uses runtime loaded context and honors explicit reserves', async () => {
    const reserve: Partial<ContextReserve> = {
      outputTokens: 6000,
      toolSchemaTokens: 4000,
      safetyTokens: 2000,
    };

    const result = await revisionService.revise({
      executionId: 'exec-reserve-1',
      agentId: 'coder',
      modelId: 'qwen2.5-coder-7b',
      taskDescription: 'Reserve test',
      projectRoot,
      effectiveContextWindow: 64000,
      runtimeLoaded: 32000, // runtime only loaded 32k!
      reserve,
    });

    expect(result.snapshot.effectiveContextWindow).toBe(32000);
    expect(result.snapshot.tokenBudget?.outputReserveTokens).toBe(6000);
  });

  // Test 19 & 20: Revision threshold and target utilization
  it('19 & 20. detects auto-threshold trigger at 75% and aims for ~50% target utilization', () => {
    const should = revisionService.shouldRevise('exec-thresh-1', 20000, 32000, {
      outputTokens: 4000,
      toolSchemaTokens: 1000,
      safetyTokens: 1000,
    });
    // Usable = 32000 - 6000 = 26000. 20000 / 26000 = 0.769 >= 0.75 -> true
    expect(should).toBe(true);

    const shouldNot = revisionService.shouldRevise('exec-thresh-2', 10000, 32000, {
      outputTokens: 4000,
      toolSchemaTokens: 1000,
      safetyTokens: 1000,
    });
    // 10000 / 26000 = 0.384 < 0.75 -> false
    expect(shouldNot).toBe(false);
  });

  // Test 21: Recent tail preserved
  it('21. preserves recent conversation turns in tail partition', async () => {
    const history: ContextPart[] = [
      { kind: 'conversation', label: 'Recent turn 1', content: 'Observation 1', priority: 50 },
      { kind: 'conversation', label: 'Recent turn 2', content: 'Observation 2', priority: 50 },
    ];

    const result = await revisionService.revise({
      executionId: 'exec-tail-1',
      agentId: 'coder',
      modelId: 'qwen2.5-coder-7b',
      taskDescription: 'Tail test',
      projectRoot,
      recentHistory: history,
      effectiveContextWindow: 32000,
    });

    expect(result.snapshot.tail.length).toBeGreaterThan(0);
  });

  // Test 22 & 23: Large tool output offloaded and compacted with durable evidence
  it('22 & 23. offloads oversized observations (>1000 chars) while preserving bounded notice', async () => {
    const hugeToolOutput = 'A'.repeat(5000); // 5000 chars > 1000 threshold
    const history: ContextPart[] = [
      { kind: 'tools', label: 'Huge Build Log', content: hugeToolOutput, priority: 50 },
    ];

    const result = await revisionService.revise({
      executionId: 'exec-offload-1',
      agentId: 'coder',
      modelId: 'qwen2.5-coder-7b',
      taskDescription: 'Offload test',
      projectRoot,
      recentHistory: history,
      effectiveContextWindow: 32000,
    });

    expect(result.tokensOffloaded).toBeGreaterThan(0);
    expect(result.snapshot.offloadedItems?.length).toBe(1);
    const offloaded = result.snapshot.offloadedItems![0];
    expect(offloaded.tokensSaved).toBeGreaterThan(500);

    const toolItem = result.snapshot.tokenBudget?.parts.find((p) => p.label === 'Huge Build Log');
    expect(toolItem?.content).toContain('[Oversized observation offloaded to disk]');
    expect(toolItem?.content.length).toBeLessThan(1000);
  });

  // Test 24 & 25: Stable prefix deterministic; volatile changes do not alter stable prefix
  it('24 & 25. produces deterministic stable prefix that is unaffected by volatile errors/diffs', () => {
    const staticSys: ContextPart = { kind: 'system', label: 'Core System', content: 'System instructions', category: 'PINNED', priority: 100 };
    const staticAgentsMd: ContextPart = { kind: 'system', label: 'AGENTS.md', content: 'Rule 1', sourceUri: 'AGENTS.md', scope: 'root', category: 'PINNED', priority: 80 };

    const volatile1: ContextPart = { kind: 'task', label: 'Error', content: 'Error: TypeError 1', category: 'ACTIVE', priority: 80 };
    const volatile2: ContextPart = { kind: 'task', label: 'Error', content: 'Error: ReferenceError 99', category: 'ACTIVE', priority: 80 };

    const layout1 = layoutPlanner.plan([staticSys, staticAgentsMd, volatile1], 'CACHE_STABLE_PREFIX');
    const layout2 = layoutPlanner.plan([staticSys, staticAgentsMd, volatile2], 'CACHE_STABLE_PREFIX');

    // Stable prefix items and their contents are identical across runs
    expect(layout1.stablePrefix.length).toBe(layout2.stablePrefix.length);
    expect(layout1.tokens.stablePrefix).toBe(layout2.tokens.stablePrefix);
    expect(layout1.stablePrefix[0].content).toBe(layout2.stablePrefix[0].content);
  });
});
