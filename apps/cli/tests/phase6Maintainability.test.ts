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
import { FleetTui, isScreenFragment } from '../src/tui/fleetTui.js';
import * as cliCommands from '../src/commands.js';
import type { RookEngine } from '../src/engine.js';

describe('Phase 6: Maintainability Modularization & TUI Truthfulness (ISS-020)', () => {
  let projectRoot: string;
  let engine: RookEngine;
  let harness: TuiTestHarness;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-phase6-tui-'));
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
    const policy = new PolicyEngine();
    const classifier = new TaskCapabilityClassifier();
    const modelIntelligence = new ModelIntelligenceService();
    const scheduler = new Scheduler({
      computers,
      runtimes,
      models,
      agents,
      tools,
      policy,
      classifier,
      modelIntelligence,
    });
    const checkpointService = new CheckpointService({ workspace: projectRoot, store });
    const verification = new VerificationEngine({ workspace: projectRoot });
    const solutionSearch = new SolutionSearchService({
      checkpoints: checkpointService,
      verification,
      executions,
    });
    const evaluation = new EvaluationService(store);
    const benchmark = new BenchmarkService(evaluation, store);
    const optimizer = new MetaOptimizerService(evaluation, benchmark, store);
    const orchestrator = new JobOrchestrator({
      scheduler,
      executions,
      worktrees,
      store,
    });

    engine = {
      projectRoot,
      config: { projectRoot, models: { startup: { mode: 'none' } } } as any,
      store,
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
      worktrees,
      orchestrator,
      provenance,
      checkpoints: checkpointService,
      verification,
      solutionSearch,
      evaluation,
      benchmark,
      optimizer,
      classifier,
      modelIntelligence,
      discovered: [],
    } as unknown as RookEngine;

    harness = new TuiTestHarness({ engine, cols: 120, rows: 40 });
    await harness.start();
  });

  afterEach(async () => {
    harness?.stop();
    await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('returns empty search tree nodes and does not fabricate C0/claude-3-5-sonnet/DGX-01 candidates when no search exists', () => {
    expect(engine.solutionSearch?.listSearches() ?? []).toHaveLength(0);
    expect(harness.tui.getSearchTreeNodes()).toEqual([]);

    harness.sendLine('/search');
    expect(harness.tui.getCurrentView()).toBe('search');
    const buf = harness.getScreenBuffer();
    expect(buf).toContain('SOLUTION SEARCH');
    expect(buf).toContain('No active MCTS search tree or candidates recorded.');
    expect(buf).not.toContain('C0 (Root Checkpoint)');
    expect(buf).not.toContain('claude-3-5-sonnet');
    expect(buf).not.toContain('qwen-2.5-coder-32b');
  });

  it('renders truthful empty context state with [MAX] and [TARGET] legend instead of fabricated token samples', () => {
    harness.sendLine('/context');
    expect(harness.tui.getCurrentView()).toBe('context');
    const buf = harness.getScreenBuffer();
    expect(buf).toContain('CONTEXT UTILIZATION OVER TIME');
    expect(buf).toContain('No context telemetry samples recorded.');
    expect(buf).toContain('[MAX]');
    expect(buf).toContain('[TARGET]');
    expect(buf).not.toContain('4200');
    expect(buf).not.toContain('8900');
    expect(buf).not.toContain('14500');
  });

  it('preserves public exports from fleetTui.ts and commands.ts after modularization', () => {
    expect(typeof FleetTui).toBe('function');
    expect(typeof isScreenFragment).toBe('function');
    expect(isScreenFragment('[View: FLEET]')).toBe(true);

    // Verify commands.ts barrel re-exports across all 6 domain command modules
    expect(typeof cliCommands.table).toBe('function');
    expect(typeof cliCommands.listAgents).toBe('function');
    expect(typeof cliCommands.listModels).toBe('function');
    expect(typeof cliCommands.addContext).toBe('function');
    expect(typeof cliCommands.listArtifacts).toBe('function');
    expect(typeof cliCommands.verifyRunCommand).toBe('function');
    expect(typeof cliCommands.listProvidersCommand).toBe('function');
    expect(typeof cliCommands.improveStatusCommand).toBe('function');
    expect(typeof cliCommands.canaryStatusCommand).toBe('function');
    expect(typeof cliCommands.listExecutions).toBe('function');
  });
});
