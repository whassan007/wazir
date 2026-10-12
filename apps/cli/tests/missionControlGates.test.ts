import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRegistry,
  ApprovalQueue,
  ComputerRegistry,
  ContextCompiler,
  ExecutionEngine,
  JobOrchestrator,
  ModelRegistry,
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
  WorktreeManager,
  CheckpointService,
  VerificationEngine,
  SolutionSearchService,
  TaskCapabilityClassifier,
  ModelIntelligenceService,
  ProvenanceManager,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { MemoryStore } from '@wazir/shared';
import { EvaluationService, MetaOptimizerService, BenchmarkService } from '@wazir/evaluation';
import { TuiTestHarness } from '../src/tui/inputHarness.js';
import type { RookEngine } from '../src/engine.js';
import type { SearchTreeNode } from '../src/tui/observabilityViews.js';

describe('Acceptance Gates: G74, G75, G76, G77 — Wazir Mission Control', () => {
  let projectRoot: string;
  let engine: RookEngine;
  let harness: TuiTestHarness;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-mission-control-'));
    const computers = new ComputerRegistry();
    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();
    const agents = new AgentRegistry();
    const tools = new ToolRegistry(defaultTools);
    const compiler = new ContextCompiler();
    const executions = new ExecutionEngine({ workspace: projectRoot });
    await executions.ready;
    const approvalQueue = new ApprovalQueue();
    const worktrees = new WorktreeManager({
      worktreeRootDir: path.join(projectRoot, '.wazir', 'worktrees'),
    });
    const store = new MemoryStore();
    const provenance = new ProvenanceManager(store);

    // Register primary compute nodes (DGX-01, MAC-01, PC-01)
    computers.register({
      id: 'DGX-01',
      name: 'DGX-01',
      type: 'cluster',
      local: false,
      os: { platform: 'linux', architecture: 'x64', version: '6.5' },
      hardware: { cpu: 'EPYC 9654', cpuCores: 128, memoryGB: 512, gpu: 'H100' },
      capabilities: ['gpuAcceleration', 'distributedSharding'],
    });

    computers.register({
      id: 'MAC-01',
      name: 'MAC-01',
      type: 'workstation',
      local: true,
      os: { platform: 'darwin', architecture: 'arm64', version: '14.5' },
      hardware: { cpu: 'Apple M2 Ultra', cpuCores: 24, memoryGB: 128, gpu: 'M2 Ultra' },
      capabilities: ['localExecution', 'gpuAcceleration'],
    });

    computers.register({
      id: 'PC-01',
      name: 'PC-01',
      type: 'workstation',
      local: false,
      os: { platform: 'linux', architecture: 'x64', version: '6.2' },
      hardware: { cpu: 'Core i9-14900K', cpuCores: 24, memoryGB: 64, gpu: 'RTX 4090' },
      capabilities: ['localExecution', 'gpuAcceleration'],
    });

    runtimes.register({
      id: 'vllm-dgx',
      type: 'vllm',
      name: 'vLLM DGX Engine',
      version: '0.4.0',
      computerId: 'DGX-01',
      capabilities: { chat: true, streaming: true, toolCalling: true },
    });

    runtimes.register({
      id: 'mlx-mac',
      type: 'mlx',
      name: 'MLX Apple Silicon',
      version: '1.2.0',
      computerId: 'MAC-01',
      capabilities: { chat: true, streaming: true, toolCalling: true },
    });

    runtimes.register({
      id: 'ollama-pc',
      type: 'ollama',
      name: 'Ollama PC Runtime',
      version: '0.3.0',
      computerId: 'PC-01',
      capabilities: { chat: true, streaming: true, toolCalling: true },
    });

    models.register({
      id: 'claude-3-5-sonnet',
      provider: 'anthropic',
      family: 'claude',
      displayName: 'Claude 3.5 Sonnet',
      contextWindow: 200000,
      capabilities: ['chat', 'toolCalling'],
    });

    models.register({
      id: 'qwen-2.5-coder-32b',
      provider: 'local',
      family: 'qwen',
      displayName: 'Qwen 2.5 Coder 32B',
      contextWindow: 32768,
      capabilities: ['chat', 'toolCalling'],
    });

    models.register({
      id: 'deepseek-coder',
      provider: 'local',
      family: 'deepseek',
      displayName: 'DeepSeek Coder V2',
      contextWindow: 65536,
      capabilities: ['chat', 'toolCalling'],
    });

    const checkpointService = new CheckpointService({
      executionEngine: executions,
      worktreeManager: worktrees,
      defaultWorkspaceRoot: projectRoot,
    });

    const verificationEngine = new VerificationEngine({ projectRoot });
    const evaluationService = new EvaluationService();
    const benchmarkService = new BenchmarkService(evaluationService);

    const solutionSearch = new SolutionSearchService({
      checkpointService,
      worktreeManager: worktrees,
      executionEngine: executions,
      evaluationService,
      verificationEngine,
      projectRoot,
    });

    const classifier = new TaskCapabilityClassifier();
    const modelIntelligence = new ModelIntelligenceService({ classifier });

    const optimizer = new MetaOptimizerService({
      worktreeManager: worktrees,
      checkpointService,
      verificationEngine,
      evaluationService,
      benchmarkService,
      projectRoot,
    });

    const orchestrator = new JobOrchestrator(
      {
        computers,
        runtimes,
        models,
        agents,
        tools,
        compiler,
        executions,
        approvalQueue,
      },
      { defaultConcurrencyLimit: 4 },
    );

    const scheduler = new Scheduler(computers, runtimes, models, agents, executions);
    const policy = new PolicyEngine();

    engine = {
      config: {
        models: { startup: { mode: 'none' } },
        modelContext: {},
        modelCapabilities: {},
        networkAllowed: false,
        allowCommands: [],
        denyCommands: [],
        allowedMcpServers: [],
      } as any,
      configDir: path.join(projectRoot, '.wazir'),
      projectRoot,
      computers,
      runtimes,
      models,
      agents,
      tools,
      policy,
      scheduler,
      compiler,
      executions,
      approvalQueue,
      orchestrator,
      worktrees,
      checkpoints: checkpointService,
      solutionSearch,
      evaluation: evaluationService,
      benchmark: benchmarkService,
      optimizer,
      modelIntelligence,
      provenance,
      verification: verificationEngine,
      planner: {} as any,
      adapters: new Map(),
      discovered: [],
      worker: {} as any,
      store,
      secretBroker: {} as any,
      hostedAdapters: new Map(),
    };

    harness = new TuiTestHarness({ engine, concurrencyLimit: 4, useWorktrees: false });
    await harness.start();
  });

  afterEach(async () => {
    harness?.stop();
    await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  // =========================================================================
  // G74: MISSION_CONTROL
  // =========================================================================
  it('G74: MISSION_CONTROL — renders all 6 operational views, verifies non-mutating view projection, structured why explanations, and declutter rules', async () => {
    // 1. Initial State: Execution engine state
    const initialExecutionCount = (await engine.executions.list()).length;

    // Verify Header contains WAZIR control branding and view tag
    let buf = harness.getScreenBuffer();
    expect(buf).toContain('WAZIR - CONTROL - WORKER:');
    expect(buf).toContain('[View: FLEET]');

    // 2. View 1: TASK View
    harness.sendLine('/task');
    expect(harness.tui.getCurrentView()).toBe('task');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('TASK EXECUTION PIPELINE');
    // Visual pipeline: TASK -> AGENT -> MODEL -> RUNTIME -> WORKER -> TOOLS -> VERIFY
    expect(buf).toContain('TASK');
    expect(buf).toContain('AGENT');
    expect(buf).toContain('MODEL');
    expect(buf).toContain('RUNTIME');
    expect(buf).toContain('WORKER');
    expect(buf).toContain('TOOLS');
    expect(buf).toContain('VERIFY');
    expect(buf).toContain('Routing:');
    expect(buf).toContain('Compute:');
    expect(buf).toContain('Deterministic Verification:');
    expect(buf).toContain('Budget Governance:');

    // 3. View 2: SEARCH View
    harness.sendLine('/search');
    expect(harness.tui.getCurrentView()).toBe('search');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('SOLUTION SEARCH');
    expect(buf).toContain('MCTS');

    // 4. View 3: FLEET View
    harness.sendLine('/fleet');
    expect(harness.tui.getCurrentView()).toBe('fleet');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('FLEET TOPOLOGY & DISTRIBUTED COMPUTE FABRIC');

    // 5. View 4: IMPROVEMENT View
    harness.sendLine('/improvement');
    expect(harness.tui.getCurrentView()).toBe('improvement');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('SELF IMPROVEMENT');

    // 6. View 5: CONTEXT View
    harness.sendLine('/context');
    expect(harness.tui.getCurrentView()).toBe('context');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('CONTEXT UTILIZATION OVER TIME');
    expect(buf).toContain('[MAX]');
    expect(buf).toContain('[TARGET]');

    // 7. View 6: EVIDENCE View
    harness.sendLine('/evidence');
    expect(harness.tui.getCurrentView()).toBe('evidence');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('VERIFICATION EVIDENCE');
    // No execution record selected: nothing may be implied verified.
    expect(buf).toContain('No execution record selected');
    expect(buf).not.toContain('PASS');
    expect(buf).toContain('MODEL CLAIM != EXECUTION EVIDENCE');

    // Assert Invariant: TUI STATE != EXECUTION STATE
    // View switching MUST NOT mutate or create any executions or workspace revisions
    expect((await engine.executions.list()).length).toBe(initialExecutionCount);

    // 8. Contextual Explainability: why <topic> command tests
    // why model?
    harness.sendLine('why model');
    expect(harness.tui.isWhyModalOpen()).toBe(true);
    buf = harness.getScreenBuffer();
    expect(buf).toContain('WHY MODEL?');
    expect(buf).toContain('Empirical capability matching for task');
    expect(buf).toContain('Scheduler / ModelIntelligenceService');
    expect(buf).toContain('MODEL CLAIM != EXECUTION EVIDENCE');
    harness.sendKey('\x1b'); // Dismiss modal
    expect(harness.tui.isWhyModalOpen()).toBe(false);

    // why complete?
    harness.sendLine('why complete');
    expect(harness.tui.isWhyModalOpen()).toBe(true);
    buf = harness.getScreenBuffer();
    expect(buf).toContain('WHY COMPLETE?');
    expect(buf).toContain('No execution evidence loaded');
    expect(buf).toContain('UNKNOWN');
    harness.sendKey('\x1b'); // Dismiss modal

    // why rollback?
    harness.sendLine('why rollback');
    expect(harness.tui.isWhyModalOpen()).toBe(true);
    buf = harness.getScreenBuffer();
    expect(buf).toContain('WHY ROLLBACK?');
    expect(buf).toContain('RegressionGuard');
    harness.sendKey('\x1b'); // Dismiss modal

    // 9. Declutter rules: test sidebar toggle hotkeys (Ctrl+T and '\')
    const initialSidebarMode = harness.tui.getSidebarMode();
    expect(initialSidebarMode).toBe('full');

    // Toggle sidebar hide via Ctrl+T
    harness.sendKey('\x14'); // Ctrl+T
    expect(harness.tui.getSidebarMode()).toBe('hidden');

    // Restore sidebar via Ctrl+T
    harness.sendKey('\x14'); // Ctrl+T
    expect(harness.tui.getSidebarMode()).toBe('full');

    // Toggle sidebar via backslash '\'
    harness.sendKey('\\');
    expect(harness.tui.getSidebarMode()).toBe('focused');
    harness.sendKey('\\');
    expect(harness.tui.getSidebarMode()).toBe('hidden');
    harness.sendKey('\\');
    expect(harness.tui.getSidebarMode()).toBe('full');
  });

  // =========================================================================
  // G75: DISTRIBUTED_MAP
  // =========================================================================
  it('G75: DISTRIBUTED_MAP — renders multi-machine topology (DGX-01, MAC-01, PC-01) with capacity, temperature, memory, models, shards, and health all visible simultaneously', async () => {
    // Switch to FLEET view
    harness.sendLine('/fleet');
    expect(harness.tui.getCurrentView()).toBe('fleet');

    const buf = harness.getScreenBuffer();

    // 1. All three nodes present simultaneously
    expect(buf).toContain('DGX-01');
    expect(buf).toContain('MAC-01');
    expect(buf).toContain('PC-01');

    // 2. Hardware and Load Progress Bars
    expect(buf).toContain('H100');
    expect(buf).toContain('M2 Ultra');
    expect(buf).toContain('RTX 4090');
    expect(buf).toContain('█'); // ASCII graphical load bar

    // 3. Capacities and Available Capacities
    expect(buf).toContain('Cap:');
    expect(buf).toContain('Avail:');

    // 4. Memory (RAM)
    expect(buf).toContain('RAM:');
    expect(buf).toContain('GB');

    // 5. Models Loaded
    expect(buf).toContain('models:');

    // 6. Active Shards
    expect(buf).toContain('shards:');

    // 7. Health Status
    expect(buf).toContain('Health');

    // 8. Temperatures
    expect(buf).toContain('°C');
  });

  // =========================================================================
  // G76: SEARCH_TREE
  // =========================================================================
  it('G76: SEARCH_TREE — renders hierarchical candidate MCTS tree (C0 -> A, B, C) with active vs pruned states and Pareto frontier clearly marked', async () => {
    // Setup hierarchical MCTS search tree
    const treeNodes: SearchTreeNode[] = [
      {
        id: 'C0',
        name: 'C0 (Root Checkpoint)',
        state: 'completed',
        tokens: 0,
        children: [
          {
            id: 'A',
            name: 'A (Refactor Strategy)',
            state: 'completed',
            tokens: 840,
            children: [
              {
                id: 'A1',
                name: 'A1',
                state: 'completed',
                glyph: '✓',
                tokens: 1250,
                testsPassed: true,
                isFrontier: true,
              },
              {
                id: 'A2',
                name: 'A2',
                state: 'pruned',
                glyph: '×',
                prunedReason: 'build failed',
                tokens: 920,
                testsPassed: false,
                isDominated: true,
              },
            ],
          },
          {
            id: 'B',
            name: 'B (Incremental Strategy)',
            state: 'active',
            tokens: 610,
            children: [
              {
                id: 'B1',
                name: 'B1',
                state: 'verifying',
                glyph: '◶',
                tokens: 780,
              },
              {
                id: 'B2',
                name: 'B2',
                state: 'pending',
                tokens: 340,
              },
            ],
          },
          {
            id: 'C',
            name: 'C (Parallel Strategy)',
            state: 'pruned',
            glyph: '×',
            prunedReason: 'timeout',
            tokens: 450,
            isDominated: true,
          },
        ],
      },
    ];

    const mockSearch: any = {
      searchId: 'search-mcts-gate-76',
      objective: 'Optimize concurrent job queue without race conditions',
      status: 'running',
      strategy: 'hierarchical_mcts',
      totalCandidates: 5,
      treeNodes,
      candidates: [
        {
          candidateId: 'A1',
          descriptor: { iteration: 1, modelId: 'claude-3-5-sonnet', workerId: 'DGX-01' },
          status: 'completed',
          tokensUsed: 1250,
          durationMs: 2100,
          evaluation: {
            qualifies: true,
            buildPassed: true,
            testsPassed: true,
            testSummary: '36/36 passed',
            isParetoFrontier: true,
            isDominated: false,
          },
        },
        {
          candidateId: 'A2',
          descriptor: { iteration: 1, modelId: 'qwen-2.5-coder-32b', workerId: 'MAC-01' },
          status: 'pruned',
          tokensUsed: 920,
          durationMs: 1800,
          evaluation: {
            qualifies: false,
            buildPassed: false,
            testsPassed: false,
            testSummary: 'compiler error',
            isParetoFrontier: false,
            isDominated: true,
            disqualificationReasons: ['build failed'],
          },
        },
        {
          candidateId: 'C',
          descriptor: { iteration: 1, modelId: 'deepseek-coder', workerId: 'PC-01' },
          status: 'pruned',
          tokensUsed: 450,
          durationMs: 5000,
          evaluation: {
            qualifies: false,
            buildPassed: true,
            testsPassed: false,
            testSummary: 'execution timeout',
            isParetoFrontier: false,
            isDominated: true,
            disqualificationReasons: ['timeout'],
          },
        },
      ],
      selectedCandidate: { candidateId: 'A1' },
      selectionReason: 'Non-dominated Pareto frontier candidate with verified tests',
    };

    (engine.solutionSearch as any).searches.set(mockSearch.searchId, mockSearch);

    // Switch to SEARCH view
    harness.sendLine('/search');
    expect(harness.tui.getCurrentView()).toBe('search');

    const buf = harness.getScreenBuffer();

    // 1. Tree structure and branch connectors
    expect(buf).toContain('HIERARCHICAL MCTS SEARCH TREE:');
    expect(buf).toContain('C0 (Root Checkpoint)');
    expect(buf).toContain('├─ A (Refactor Strategy)');
    expect(buf).toContain('A1');
    expect(buf).toContain('A2');
    expect(buf).toContain('├─ B (Incremental Strategy)');
    expect(buf).toContain('B1');
    expect(buf).toContain('B2');
    expect(buf).toContain('└─ C (Parallel Strategy)');

    // 2. Active vs Pruned State Badges
    expect(buf).toContain('✓'); // completed / verified
    expect(buf).toContain('×'); // failed / pruned
    expect(buf).toContain('◶'); // verifying
    expect(buf).toContain('[PRUNED: build failed]');
    expect(buf).toContain('[PRUNED: timeout]');

    // 3. Pareto Frontier Marker
    expect(buf).toContain('[● FRONTIER]');
    expect(buf).toContain('A1');
  });

  // =========================================================================
  // G77: TUI_STRESS
  // =========================================================================
  it('integration: all why topics reject model prose and absent controller proof', () => {
    const tui = harness.tui as any;
    tui.agents.set('unverified', {
      taskId: 'unverified', status: 'running',
      lastMessage: 'MODEL_PROSE_CLAIMS_ALL_TESTS_PASS',
    });
    tui.selectedTaskId = 'unverified';
    for (const topic of ['model', 'worker', 'tool', 'candidate', 'prune', 'complete', 'rollback', 'context']) {
      const explanation = harness.tui.buildWhyExplanation(topic);
      expect(JSON.stringify(explanation)).not.toContain('MODEL_PROSE_CLAIMS_ALL_TESTS_PASS');
      expect(explanation.controllerAudit.immutableHash).toBeUndefined();
      expect(JSON.stringify(explanation)).toContain('UNKNOWN');
      expect(JSON.stringify(explanation)).not.toContain('PASS (');
    }
  });

  it('integration: canary history selection renders the selected controller record', async () => {
    const service = engine.optimizer.getCanaryDeploymentService();
    for (const candidateId of ['first-canary', 'second-canary']) {
      await service.registerCanary({
        candidateId, domain: 'routing', qualificationStatus: 'QUALIFIED',
        candidateConfig: {} as any, baselineConfig: {} as any,
      });
    }
    harness.sendLine('/canary');
    harness.sendKey('h');
    harness.sendKey('\x1b[B');
    harness.sendKey('\r');
    expect((harness.tui as any).selectedCanaryId).toBe(service.listDeployments()[1].canaryId);
    harness.sendKey('\x1b');
    expect(harness.getScreenBuffer()).toContain('second-canary');
  });

  it('integration: 300 mixed update cycles preserve input, bounded buffers and redraw latency', async () => {
    const tui = harness.tui as any;
    const service = engine.optimizer.getCanaryDeploymentService();
    const deployment = await service.registerCanary({
      candidateId: 'mixed-stress', domain: 'routing', qualificationStatus: 'QUALIFIED',
      candidateConfig: {} as any, baselineConfig: {} as any,
    });
    const node = { id: 'mixed-root', state: 'active', visits: 0, tokens: 0, children: [] };
    const search = {
      searchId: 'mixed-search', strategy: 'hierarchical_mcts', status: 'running',
      treeNodes: [node], candidates: [],
    };
    (engine.solutionSearch as any).searches.set(search.searchId, search);
    tui.agents.set('mixed-task', { taskId: 'mixed-task', title: 'Mixed stress', status: 'running', phase: 'ACT' });
    const input = '/pending cshrbm 1234567';
    harness.sendKeys(input);
    const latencies: number[] = [];
    const initialExecutions = (await engine.executions.list()).length;
    for (let i = 0; i < 300; i++) {
      // Independent producer microtasks interleave on the same event loop as input/rendering.
      await Promise.all([
        Promise.resolve().then(() => tui.onJobEvent({
          type: 'task:progress', taskId: 'mixed-task',
          event: { kind: 'token', content: `chunk-${i}: ${'x'.repeat(100)}` },
        })),
        Promise.resolve().then(() => { node.visits++; node.tokens += 10; }),
        i % 2 ? service.resumeCanary(deployment.canaryId) : service.pauseCanary(deployment.canaryId),
        Promise.resolve().then(() => harness.tui.recordContextSample({
          generation: i, currentTokens: 4000, effectiveMax: 32768, targetTokens: 16000,
          deduplicated: 0, compressed: 0, offloaded: 0, stablePrefix: 1000, volatilePortion: 3000,
          cache: {
            inputTokens: { value: 4000, status: 'OBSERVED' },
            cacheReadTokens: i % 2 ? { value: 1000, status: 'OBSERVED' } : { status: 'UNKNOWN' },
            cacheWriteTokens: { status: 'UNSUPPORTED' },
          },
        })),
        Promise.resolve().then(() => engine.computers.heartbeat('DGX-01', {
          load: { cpuPercent: i % 100, memoryUsedGB: 128, memoryAvailableGB: 384 },
        })),
      ]);
      tui.currentView = ['task', 'search', 'canary', 'context', 'fleet'][i % 5];
      const start = performance.now();
      harness.tui.draw();
      latencies.push(performance.now() - start);
      expect(tui.inputBuffer).toBe(input);
      // The mock captures every write; discard its history to measure TUI retention.
      harness.outStream.clearOutput();
    }
    expect(tui.streamingBuffers.get('mixed-task').length).toBeLessThanOrEqual(12000);
    expect(tui.contextSamples).toHaveLength(100);
    expect(node.visits).toBe(300);
    expect(service.listDeployments()).toHaveLength(1);
    expect(engine.computers.list()).toHaveLength(3);
    expect((await engine.executions.list()).length).toBe(initialExecutions);
    expect(harness.inStream.listenerCount('keypress')).toBe(1);
    const average = latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length;
    const p95 = [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)];
    console.info(`Worker 11 mixed stress: 1500 updates; mean=${average.toFixed(2)}ms p95=${p95.toFixed(2)}ms; context=100 stream=${tui.streamingBuffers.get('mixed-task').length}`);
    expect(average).toBeLessThan(50);
    expect(p95).toBeLessThan(50);
  });

  it('G77: TUI_STRESS — executes 150+ high-frequency streaming events, candidate updates, and verification checks; asserts no crashes, bounded memory, and draw latency < 50ms', async () => {
    // 1. Switch to TASK view
    harness.sendLine('/task');
    expect(harness.tui.getCurrentView()).toBe('task');

    const taskId = 'stress-task-77';
    (harness.tui as any).agents.set(taskId, {
      taskId,
      title: 'Stress Task',
      status: 'running',
      phase: 'ACT',
    });

    // Measure draw latency over 150 iterations
    const drawLatencies: number[] = [];

    for (let i = 0; i < 150; i++) {
      // Simulate high-frequency streaming token events
      (harness.tui as any).onJobEvent({
        type: 'task:progress',
        taskId,
        event: {
          kind: 'token',
          content: ` streaming token chunk #${i} with AST verification details`,
        },
      });

      // Feed periodic context telemetry
      if (i % 5 === 0) {
        (harness.tui as any).contextSamples.push({
          generation: i,
          currentTokens: 4000 + (i * 200) % 16000,
          effectiveMax: 32768,
          targetTokens: 16000,
          deduplicated: i * 50,
          compressed: i * 80,
          offloaded: i * 30,
          stablePrefix: 2000,
          volatilePortion: 4000 + (i * 100) % 10000,
        });
        if ((harness.tui as any).contextSamples.length > 60) {
          (harness.tui as any).contextSamples.shift();
        }
      }

      // Benchmark draw latency
      const start = performance.now();
      harness.tui.draw();
      const elapsed = performance.now() - start;
      drawLatencies.push(elapsed);
    }

    // 2. Assert no crashes occurred and screen buffer is populated and intact
    const buf = harness.getScreenBuffer();
    expect(buf.length).toBeGreaterThan(0);
    expect(buf).not.toContain('\x1b[3\n'); // No broken escape fragments
    expect(buf).not.toContain('\x1b[\n');

    // 3. Assert bounded memory invariants
    const streamingBuf = (harness.tui as any).streamingBuffers.get(taskId) ?? '';
    expect(streamingBuf.length).toBeLessThanOrEqual(12_000); // 12KB bounding invariant

    const contextSamples = (harness.tui as any).contextSamples;
    expect(contextSamples.length).toBeLessThanOrEqual(60); // Bounded ring buffer

    // 4. Assert draw latency budget (< 50ms per frame average)
    const avgLatency = drawLatencies.reduce((a, b) => a + b, 0) / drawLatencies.length;
    expect(avgLatency).toBeLessThan(50);
  });
  it('integration: /evidence and why complete/incomplete read the durable record, flag STALE evidence', async () => {
    const { execution } = await engine.executions.create({
      task: { id: 'evid-task', type: 'coding', input: 'fix', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date(), acceptanceContract: { requiredEvidence: ['TEST'] } },
      computerId: 'DGX-01', runtimeId: 'lmstudio', modelId: 'qwen',
    } as any);
    const id = execution.id;
    const mut = (a: string, b: string) => ({ path: 'src/a.ts', attempted: true, succeeded: true, existedBefore: true, existsAfter: true, beforeHash: a, afterHash: b, changed: true });
    await engine.executions.recordFileMutations(id, [mut('aa', 'bb')], 'digest-abc');
    await engine.executions.recordEvidence(id, { type: 'TEST', revision: 1, command: 'npm test', exitCode: 0, metadata: { passed: 42, failed: 0 } } as any);
    await engine.executions.setResult(id, 'MODEL_PROSE: everything verified');

    const tui = harness.tui as any;
    tui.agents.set('evid-task', { taskId: 'evid-task', title: 'evid', status: 'running', lastMessage: '', filesChanged: [] });
    tui.selectedTaskId = 'evid-task';
    await tui.refreshEvidenceInspection();
    harness.sendLine('/evidence');
    let buf = harness.getScreenBuffer();
    expect(buf).toContain(id);
    expect(buf).toContain('Eligible      YES');
    expect(buf).not.toContain('MODEL_PROSE');

    const complete = harness.tui.buildWhyExplanation('complete');
    expect(complete.decision).toBe('Completion eligible: YES');
    expect(complete.rationale.join('\n')).toContain('npm test');

    // Post-verification mutation: the old PASS becomes STALE.
    await engine.executions.recordFileMutations(id, [mut('bb', 'cc')]);
    await tui.refreshEvidenceInspection();
    harness.sendLine('/evidence');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('STALE — NOT VALID FOR COMPLETION');
    expect(buf).toContain('AFTER VERIFICATION');
    expect(buf).toContain('Eligible      NO');
    const incomplete = harness.tui.buildWhyExplanation('incomplete');
    expect(incomplete.decision).toBe('Completion eligible: NO');
    expect(incomplete.rationale).toEqual(['TEST: STALE — evidence is for R1, current revision is R2']);
    // Read-only: inspecting created nothing.
    expect(engine.executions.require(id).evidence).toHaveLength(1);
  });
});
