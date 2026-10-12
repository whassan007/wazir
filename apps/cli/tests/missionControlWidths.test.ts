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

describe('Mission Control terminal width sweep', () => {
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

  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  const views: Array<[string, string]> = [
    ['task', '/task'],
    ['search', '/search'],
    ['fleet', '/fleet'],
    ['improvement', '/improvement'], ['models', '/model-intelligence'],
    ['context', '/context'],
    ['evidence', '/evidence'],
    ['canary', '/canary'],
    ['help', '?'],
  ];

  for (const cols of [70, 100, 140, 200]) {
    it(`renders every Mission Control view without overflow at ${cols} columns`, () => {
      harness.outStream.columns = cols;
      harness.outStream.rows = 40;
      harness.outStream.emit('resize');
      for (const [view, cmd] of views) {
        if (cmd === '?') harness.sendKey('?');
        else harness.sendLine(cmd);
        const lines = harness.getLines();
        expect(harness.tui.getCurrentView()).toBe(view);
        expect(Math.max(...lines.map((l) => stripAnsi(l).length))).toBe(cols);
        if (process.env.DUMP_WIDTHS) require('node:fs').appendFileSync(process.env.DUMP_WIDTHS, `\n=== ${view} @${cols}\n` + lines.map(stripAnsi).join('\n'));
        const over = lines
          .map((l, i) => ({ i, w: stripAnsi(l).length, l: stripAnsi(l) }))
          .filter((x) => x.w > cols);
        expect(over, `${view} @${cols}: ${JSON.stringify(over.slice(0, 3))}`).toEqual([]);
        // No raw/partial escape fragments leaked into visible text
        for (const l of lines) expect(stripAnsi(l)).not.toMatch(/\x1b|\[\d+m/);
        if (cmd === '?') harness.sendKey('?');
      }
    });
  }
});
