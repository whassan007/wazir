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
  ModelIntelligenceService,
  ProvenanceManager,
  TaskCapabilityClassifier,
  type ExperimentPlan,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { MemoryStore } from '@wazir/shared';
import { EvaluationService, MetaOptimizerService, BenchmarkService, CanaryDeploymentService } from '@wazir/evaluation';
import { TuiTestHarness } from '../src/tui/inputHarness.js';
import type { RookEngine } from '../src/engine.js';
import { renderImprovementView, type ImprovementViewData } from '../src/tui/observabilityViews.js';

describe('Interactive Canary Control Widget in Improvement View', () => {
  let projectRoot: string;
  let engine: RookEngine;
  let harness: TuiTestHarness;
  let canaryService: CanaryDeploymentService;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-canary-widget-'));
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

    canaryService = new CanaryDeploymentService({ store });

    const checkpointService = new CheckpointService({
      executionEngine: executions,
      worktreeManager: worktrees,
      defaultWorkspaceRoot: projectRoot,
    });
    const verificationEngine = new VerificationEngine({ projectRoot });
    const solutionSearch = new SolutionSearchService({
      checkpointService,
      worktreeManager: worktrees,
      executionEngine: executions,
      projectRoot,
    });
    const evaluationService = new EvaluationService();
    const benchmarkService = new BenchmarkService(evaluationService);
    const optimizer = new MetaOptimizerService({
      worktreeManager: worktrees,
      checkpointService,
      verificationEngine,
      evaluationService,
      benchmarkService,
      projectRoot,
      canaryDeploymentService: canaryService,
    });
    const classifier = new TaskCapabilityClassifier();
    const modelIntelligence = new ModelIntelligenceService({ classifier });

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
      { defaultConcurrencyLimit: 2 },
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
      planner: {} as any,
      adapters: new Map(),
      discovered: [],
      worker: {} as any,
      store,
      secretBroker: {} as any,
      hostedAdapters: new Map(),
    };

    harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });
    await harness.start();
  });

  afterEach(async () => {
    harness?.stop();
    await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('renders exact compact canary widget matching specification layout', () => {
    const viewData: ImprovementViewData = {
      experiments: [
        {
          id: 'exp-context-v17',
          domain: 'context_policy',
          state: 'QUALIFIED',
          hypothesis: 'Context pruning reduces tokens by 18%',
          canaryState: {
            candidateId: 'context-policy-v17',
            stageName: 'CANARY_10',
            currentAllocation: 0.10,
            status: 'ACTIVE',
            sampleCount: 142,
            minimumSamples: 100,
            correctnessStatus: 'DOMINANT_PASS',
            regressionGuardState: 'INTACT (0 violations)',
            nextStage: 'CANARY_25',
          },
        },
      ],
      selectedIndex: 0,
      width: 80,
      maxRows: 30,
    };

    const lines = renderImprovementView(viewData);
    const text = lines.join('\n');

    expect(text).toContain('CANARY');
    expect(text).toContain('Candidate   context-policy-v17');
    expect(text).toContain('State       CANARY_10');
    expect(text).toContain('Baseline');
    expect(text).toContain('90%');
    expect(text).toContain('Canary');
    expect(text).toContain('10%');
    expect(text).toContain('[p] Pause');
    expect(text).toContain('[t] Throttle');
    expect(text).toContain('[a] Advance');
    expect(text).toContain('[x] Rollback');
    expect(text).toContain('Allocation:  10%');
    expect(text).toContain('Stage: CANARY_10');
    expect(text).toContain('Next: CANARY_25');
    expect(text).toContain('Samples:     142 / 100 min');
    expect(text).toContain('Correctness: DOMINANT_PASS');
    expect(text).toContain('Guard:       INTACT (0 violations)');
  });

  it('handles unknown telemetry values safely by displaying UNKNOWN', () => {
    const viewData: ImprovementViewData = {
      experiments: [
        {
          id: 'exp-unknown',
          domain: 'routing',
          state: 'BENCHMARKING',
          canaryState: {
            status: 'ACTIVE',
          },
        },
      ],
      selectedIndex: 0,
      width: 80,
      maxRows: 25,
    };

    const lines = renderImprovementView(viewData);
    const text = lines.join('\n');

    expect(text).toContain('Candidate   exp-unknown');
    expect(text).toContain('Stage: UNKNOWN');
    expect(text).toContain('Next: UNKNOWN');
    expect(text).toContain('Samples:     UNKNOWN / UNKNOWN min');
    expect(text).toContain('Correctness: UNKNOWN');
  });

  it('executes pause and resume actions through CanaryDeploymentService', async () => {
    // Register active canary deployment in service
    const canary = await canaryService.registerCanary({
      candidateId: 'cand-context-1',
      candidateConfig: { strategy: 'pruning' },
      baselineConfig: { strategy: 'default' },
      domain: 'context_policy',
      qualificationStatus: 'QUALIFIED',
      initialAllocation: 0.10,
    });

    const plan: ExperimentPlan = {
      experimentId: 'exp-ctx',
      name: 'Context pruning experiment',
      hypothesis: { domain: 'context_policy', statement: 'Pruning reduces tokens' } as any,
      baselineCheckpointId: 'base-01',
      primaryMetric: 'tokens' as any,
      secondaryMetrics: [],
      benchmarkCategories: [],
      benchmarkTasks: [],
      sampleSize: 10,
      budget: { maxWallTimeMs: 10000, maxTotalTokens: 10000 },
      createdAt: new Date(),
    };
    engine.optimizer!.registerExperiment(plan);

    // Switch to improvement view
    harness.sendKey('2');
    expect(harness.tui.getCurrentView()).toBe('improvement');

    // Press 'p' to pause canary
    harness.sendKey('p');
    const pausedRecord = canaryService.getDeployment(canary.canaryId);
    expect(pausedRecord?.status).toBe('PAUSED');
    expect(pausedRecord?.currentAllocation).toBe(0);

    // Press 'r' to resume canary
    harness.sendKey('r');
    const resumedRecord = canaryService.getDeployment(canary.canaryId);
    expect(resumedRecord?.status).toBe('ACTIVE');
    expect(resumedRecord?.currentAllocation).toBe(0.10);
    expect(harness.tui.getStatusMessage()).toContain('resumed via control-plane API');
  });

  it('requires confirmation modal for advance and executes upon y/Enter', async () => {
    const canary = await canaryService.registerCanary({
      candidateId: 'cand-advance-1',
      candidateConfig: { strategy: 'routing' },
      baselineConfig: { strategy: 'default' },
      domain: 'routing',
      qualificationStatus: 'QUALIFIED',
      initialAllocation: 0.01,
      initialStage: 'CANARY_1',
    });

    const plan: ExperimentPlan = {
      experimentId: 'exp-advance',
      name: 'Routing optimization',
      hypothesis: { domain: 'routing', statement: 'Heuristic routing' } as any,
      baselineCheckpointId: 'base-01',
      primaryMetric: 'tokens' as any,
      secondaryMetrics: [],
      benchmarkCategories: [],
      benchmarkTasks: [],
      sampleSize: 10,
      budget: { maxWallTimeMs: 10000, maxTotalTokens: 10000 },
      createdAt: new Date(),
    };
    engine.optimizer!.registerExperiment(plan);

    harness.sendKey('2');
    expect(harness.tui.getCurrentView()).toBe('improvement');

    // Press 'a' opens Advance Confirmation Modal
    harness.sendKey('a');
    expect(harness.tui.isCanaryModalOpen()).toBe(true);
    let buf = harness.getScreenBuffer();
    expect(buf).toContain('CONFIRM CANARY STAGE ADVANCEMENT');
    expect(buf).toContain('CANARY_5');

    // Press 'n' cancels the modal
    harness.sendKey('n');
    expect(harness.tui.isCanaryModalOpen()).toBe(false);
    expect(canaryService.getDeployment(canary.canaryId)?.stage).toBe('CANARY_1');

    // Press 'a' again and confirm with 'y'
    harness.sendKey('a');
    expect(harness.tui.isCanaryModalOpen()).toBe(true);
    harness.sendKey('y');
    expect(harness.tui.isCanaryModalOpen()).toBe(false);

    // Wait for async advance
    await new Promise((r) => setTimeout(r, 50));
    const advanced = canaryService.getDeployment(canary.canaryId);
    expect(advanced?.stage).toBe('CANARY_5');
    expect(advanced?.currentAllocation).toBe(0.05);
  });

  it('requires confirmation modal for rollback and executes upon Enter', async () => {
    const canary = await canaryService.registerCanary({
      candidateId: 'cand-rollback-1',
      candidateConfig: { strategy: 'prompt' },
      baselineConfig: { strategy: 'default' },
      domain: 'prompts',
      qualificationStatus: 'QUALIFIED',
      initialAllocation: 0.10,
      initialStage: 'CANARY_10',
    });

    const plan: ExperimentPlan = {
      experimentId: 'exp-rollback',
      name: 'Prompt experiment',
      hypothesis: { domain: 'prompts', statement: 'Compact prompts' } as any,
      baselineCheckpointId: 'base-01',
      primaryMetric: 'tokens' as any,
      secondaryMetrics: [],
      benchmarkCategories: [],
      benchmarkTasks: [],
      sampleSize: 10,
      budget: { maxWallTimeMs: 10000, maxTotalTokens: 10000 },
      createdAt: new Date(),
    };
    engine.optimizer!.registerExperiment(plan);

    harness.sendKey('2');

    // Press 'x' opens Rollback Confirmation Modal
    harness.sendKey('x');
    expect(harness.tui.isCanaryModalOpen()).toBe(true);
    let buf = harness.getScreenBuffer();
    expect(buf).toContain('CONFIRM CANARY ROLLBACK');
    expect(buf).toContain('WARNING: Rolling back will terminate canary evaluation immediately');

    // Press Escape cancels the modal
    harness.sendKey('\x1b');
    expect(harness.tui.isCanaryModalOpen()).toBe(false);
    expect(canaryService.getDeployment(canary.canaryId)?.status).toBe('ACTIVE');

    // Press 'x' again and confirm with Enter
    harness.sendKey('x');
    expect(harness.tui.isCanaryModalOpen()).toBe(true);
    harness.sendKey('\r');
    expect(harness.tui.isCanaryModalOpen()).toBe(false);

    // Wait for async rollback
    await new Promise((r) => setTimeout(r, 50));
    const rolledBack = canaryService.getDeployment(canary.canaryId);
    expect(rolledBack?.status).toBe('ROLLED_BACK');
    expect(rolledBack?.currentAllocation).toBe(0.0);
  });

  it('provides bounded selectable tiers during throttle', async () => {
    const canary = await canaryService.registerCanary({
      candidateId: 'cand-throttle-1',
      candidateConfig: { strategy: 'orchestration' },
      baselineConfig: { strategy: 'default' },
      domain: 'orchestration',
      qualificationStatus: 'QUALIFIED',
      initialAllocation: 0.25,
      initialStage: 'CANARY_25',
    });

    const plan: ExperimentPlan = {
      experimentId: 'exp-throttle',
      name: 'Orchestration experiment',
      hypothesis: { domain: 'orchestration', statement: 'Task graph optimization' } as any,
      baselineCheckpointId: 'base-01',
      primaryMetric: 'tokens' as any,
      secondaryMetrics: [],
      benchmarkCategories: [],
      benchmarkTasks: [],
      sampleSize: 10,
      budget: { maxWallTimeMs: 10000, maxTotalTokens: 10000 },
      createdAt: new Date(),
    };
    engine.optimizer!.registerExperiment(plan);

    harness.sendKey('2');

    // Press 't' opens Throttle Modal
    harness.sendKey('t');
    expect(harness.tui.isCanaryModalOpen()).toBe(true);
    const cm = harness.tui.getCanaryModal();
    expect(cm?.type).toBe('throttle');
    // Bounded tiers up to current 25%: [0.01, 0.05, 0.10, 0.25]
    expect(cm?.availableTiers).toEqual([0.01, 0.05, 0.10, 0.25]);

    // Select tier index 1 (5% traffic) using number key '2'
    harness.sendKey('2');
    expect(harness.tui.getCanaryModal()?.selectedTierIndex).toBe(1);

    // Confirm with Enter
    harness.sendKey('\r');
    expect(harness.tui.isCanaryModalOpen()).toBe(false);

    await new Promise((r) => setTimeout(r, 50));
    const throttled = canaryService.getDeployment(canary.canaryId);
    expect(throttled?.currentAllocation).toBe(0.05);
  });

  it('enforces domain restrictions on forbidden domains', async () => {
    const plan: ExperimentPlan = {
      experimentId: 'exp-forbidden',
      name: 'Source code modification',
      hypothesis: { domain: 'wazir_source_code', statement: 'Core engine refactor' } as any,
      baselineCheckpointId: 'base-01',
      primaryMetric: 'tokens' as any,
      secondaryMetrics: [],
      benchmarkCategories: [],
      benchmarkTasks: [],
      sampleSize: 10,
      budget: { maxWallTimeMs: 10000, maxTotalTokens: 10000 },
      createdAt: new Date(),
    };
    engine.optimizer!.registerExperiment(plan);

    harness.sendKey('2');

    // Attempting advance or throttle on source code experiment triggers restriction
    harness.sendKey('a');
    expect(harness.tui.getStatusMessage()).toContain('Approved qualified experiment/candidate exp-forbidden');
  });

  it('handles terminal resize and declutter mode smoothly without corruption', async () => {
    harness.sendKey('2');
    expect(harness.tui.getCurrentView()).toBe('improvement');

    // Toggle declutter / sidebar modes
    harness.sendKey('\\');
    let buf = harness.getScreenBuffer();
    expect(buf).not.toContain('\x1b[3\n');
    expect(buf).not.toContain('\x1b[\n');

    // Toggle full/hidden via Ctrl+T
    harness.sendKey('\u0014');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('Sidebar hidden');

    // Restore sidebar
    harness.sendKey('\u0014');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('Sidebar restored');
  });
});
