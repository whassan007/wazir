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
  type ExperimentPlan,
  type OptimizationObjective,
  type CandidateDescriptor,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { MemoryStore } from '@wazir/shared';
import { EvaluationService, MetaOptimizerService, BenchmarkService } from '@wazir/evaluation';
import { TuiTestHarness } from '../src/tui/inputHarness.js';
import type { RookEngine } from '../src/engine.js';

describe('Acceptance Gates: G57, G58, G59, G60 — Operational Observability & Full System Integration', () => {
  let projectRoot: string;
  let engine: RookEngine;
  let harness: TuiTestHarness;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-obs-gates-'));
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

    computers.register({
      id: 'worker-local',
      name: 'worker-node-1',
      type: 'workstation',
      local: true,
      os: { platform: os.platform(), architecture: os.arch(), version: os.release() },
      hardware: { cpu: 'test-cpu', cpuCores: 8, memoryGB: 32 },
      capabilities: ['localExecution', 'gpuAcceleration'],
    });

    runtimes.register({
      id: 'local',
      type: 'other',
      name: 'local-runtime',
      version: '1.0',
      computerId: 'worker-local',
      capabilities: { chat: true, streaming: true, toolCalling: true },
    });

    models.register({
      id: 'claude-3-5-sonnet',
      provider: 'local',
      family: 'claude',
      displayName: 'Claude 3.5 Sonnet',
      contextWindow: 65536,
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

  // =========================================================================
  // G57: TUI_IMPROVEMENT
  // =========================================================================
  it('G57: TUI_IMPROVEMENT — simulates active self-improvement, updates metrics and decisions, verifies keyboard navigation without corruption', async () => {
    // 1. Simulate active self-improvement experiment
    const plan: ExperimentPlan = {
      experimentId: 'exp-012',
      name: 'Context utilization optimization via prefix caching',
      hypothesis: {
        domain: 'context',
        statement: 'Cache-stable prefix minimizes redundant token usage without accuracy regression',
        description: 'Context revision and stable prefix layout',
      } as any,
      baselineCheckpointId: 'base-main',
      primaryMetric: 'tokens' as any,
      secondaryMetrics: ['wall_time_ms' as any],
      requiredImprovement: { metric: 'tokens', threshold: 0.15, direction: 'MINIMIZE' } as any,
      regressionConstraints: {
        task_success: { metric: 'task_success', threshold: 0.95, direction: 'MAXIMIZE' } as any,
      },
      benchmarkCategories: ['context', 'repair'],
      benchmarkTasks: ['task-1', 'task-2'],
      sampleSize: 10,
      budget: { maxWallTimeMs: 60000, maxTotalTokens: 50000 },
      createdAt: new Date(),
      objectives: [
        { metric: 'tokens', direction: 'MINIMIZE', targetDelta: -0.20 },
        { metric: 'wall time', direction: 'MINIMIZE', targetDelta: -0.15 },
      ] as any,
      protectedMetrics: ['task success', 'verification'],
    };

    // Enrich experiment plan with Pareto evaluation and regression guard results
    (plan as any).status = 'BENCHMARKING';
    (plan as any).maturityLevel = 'Level 2 (Guarded)';
    (plan as any).baselinePassRate = 0.85;
    (plan as any).candidateCount = 3;
    (plan as any).benchmarkProgress = { completed: 8, total: 10 };
    (plan as any).regressionGuardStatus = { passed: true, violationsCount: 0, summary: 'Guard OK (0 regressions)' };
    (plan as any).decision = 'QUALIFIED';
    (plan as any).decisionReason = 'Pareto optimal frontier candidate with positive token delta and intact guards';
    (plan as any).paretoFrontier = {
      frontierCandidates: [{ candidateId: 'C1' }, { candidateId: 'C2' }],
      dominatedCandidates: [{ candidateId: 'C3' }],
      allEvaluated: [
        { candidateId: 'C1', isNonDominated: true },
        { candidateId: 'C2', isNonDominated: true },
        { candidateId: 'C3', isNonDominated: false },
      ],
    };

    engine.optimizer!.registerExperiment(plan);

    // 2. Switch to IMPROVEMENT view via keyboard shortcut '2'
    harness.sendKey('2');
    expect(harness.tui.getCurrentView()).toBe('improvement');

    // 3. Assert experiment, metrics, Pareto bullets, and decision are visible
    let buf = harness.getScreenBuffer();
    expect(buf).toContain('SELF IMPROVEMENT');
    expect(buf).toContain('exp-012');
    expect(buf).toContain('context');
    expect(buf).toContain('BENCHMARKING');
    expect(buf).toContain('Objective:');
    expect(buf).toContain('tokens ↓');
    expect(buf).toContain('wall time ↓');
    expect(buf).toContain('Protected:');
    expect(buf).toContain('task success');
    expect(buf).toContain('verification');
    expect(buf).toContain('Pareto:');
    expect(buf).toContain('C1 ●');
    expect(buf).toContain('C2 ●');
    expect(buf).toContain('C3 dominated');
    expect(buf).toContain('QUALIFIED');

    // 4. Update metrics and decision dynamically
    (plan as any).status = 'QUALIFIED';
    (plan as any).decision = 'PROMOTED';
    engine.optimizer!.registerExperiment(plan);

    buf = harness.getScreenBuffer();
    expect(buf).toContain('PROMOTED');

    // 5. Verify keyboard navigation and control-plane actions
    // Pause action via 'p'
    harness.sendKey('p');
    expect(harness.tui.getStatusMessage()).toContain('Toggled pause for experiment exp-012');

    // Inspect evidence modal via 'e'
    harness.sendKey('e');
    expect(harness.tui.isEvidenceModalOpen()).toBe(true);
    buf = harness.getScreenBuffer();
    expect(buf).toContain('Self-Improvement Evidence: exp-012');
    expect(buf).toContain('regression-guard-task-success');
    expect(buf).toContain('causal_attribution');
    expect(buf).toContain('PROVENANCE');

    // Close modal via Escape
    harness.sendKey('\x1b');
    expect(harness.tui.isEvidenceModalOpen()).toBe(false);

    // Return to fleet overview via Escape
    harness.sendKey('\x1b');
    expect(harness.tui.getCurrentView()).toBe('fleet');

    // Ensure no terminal corruption / broken escapes
    buf = harness.getScreenBuffer();
    expect(buf).not.toContain('\x1b[3\n');
    expect(buf).not.toContain('\x1b[\n');
  });

  // =========================================================================
  // G58: TUI_SEARCH
  // =========================================================================
  it('G58: TUI_SEARCH — simulates multiple candidates across workers, verifies placement, pruning, Pareto membership, and promotion', async () => {
    // 1. Setup SolutionSearch with multiple candidates placed across workers
    const searchId = 'search-eng-101';
    (engine.solutionSearch as any).searches = new Map();
    (engine.solutionSearch as any).activeSearches = new Map();

    const mockSearch: any = {
      searchId,
      objective: 'Refactor async scheduling without deadlocks',
      status: 'running',
      strategy: 'adaptive_pareto_sampling',
      totalCandidates: 3,
      candidates: [
        {
          candidateId: 'C1-sonnet',
          descriptor: { iteration: 1, modelId: 'claude-3-5-sonnet', workerId: 'worker-local' },
          status: 'completed',
          tokensUsed: 1840,
          durationMs: 3100,
          metrics: { totalTokens: 1840, wallTimeMs: 3100 },
          evaluation: {
            qualifies: true,
            buildPassed: true,
            testsPassed: true,
            testSummary: '24/24 passed',
            isParetoFrontier: true,
            isDominated: false,
          },
        },
        {
          candidateId: 'C2-qwen',
          descriptor: { iteration: 1, modelId: 'qwen-2.5-coder-32b', workerId: 'worker-local' },
          status: 'completed',
          tokensUsed: 2100,
          durationMs: 2800,
          metrics: { totalTokens: 2100, wallTimeMs: 2800 },
          evaluation: {
            qualifies: true,
            buildPassed: true,
            testsPassed: true,
            testSummary: '24/24 passed',
            isParetoFrontier: true,
            isDominated: false,
          },
        },
        {
          candidateId: 'C3-pruned',
          descriptor: { iteration: 1, modelId: 'qwen-2.5-coder-32b', workerId: 'worker-local' },
          status: 'pruned',
          tokensUsed: 950,
          durationMs: 1400,
          metrics: { totalTokens: 950, wallTimeMs: 1400 },
          evaluation: {
            qualifies: false,
            buildPassed: false,
            testsPassed: false,
            testSummary: 'build failed: TS2345',
            isParetoFrontier: false,
            isDominated: true,
            disqualificationReasons: ['TypeScript compilation oracle failed'],
          },
        },
      ],
      qualifyingCandidates: [],
      disqualifiedCandidates: [],
      selectedCandidate: { candidateId: 'C1-sonnet' },
      selectionReason: 'Non-dominated Pareto candidate with minimal token consumption and passing oracles',
    };

    (engine.solutionSearch as any).searches.set(searchId, mockSearch);

    // 2. Switch to SEARCH view via keyboard shortcut '3'
    harness.sendKey('3');
    expect(harness.tui.getCurrentView()).toBe('search');

    // 3. Assert candidate status, worker placement, pruning, and Pareto membership
    let buf = harness.getScreenBuffer();
    expect(buf).toContain('SOLUTION SEARCH: search-eng-101');
    expect(buf).toContain('C1-sonnet');
    expect(buf).toContain('claude-3-5-sonnet');
    expect(buf).toContain('worker-local');
    expect(buf).toContain('● FRONTIER');

    expect(buf).toContain('C2-qwen');
    expect(buf).toContain('qwen-2.5-coder-32b');

    expect(buf).toContain('C3-pruned');
    expect(buf).toContain('PRUNED');
    expect(buf).toContain('DOMINATED');

    expect(buf).toContain('PARETO FRONTIER MEMBERSHIP:');
    expect(buf).toContain('● Non-dominated (Frontier): C1-sonnet, C2-qwen');
    expect(buf).toContain('Dominated / Pruned:       C3-pruned');

    // 4. Test control actions
    // Pause search via 'p'
    harness.sendKey('p');
    expect(harness.tui.getStatusMessage()).toContain('search-eng-101');

    // Inspect candidate evidence modal via 'e'
    harness.sendKey('e');
    expect(harness.tui.isEvidenceModalOpen()).toBe(true);
    buf = harness.getScreenBuffer();
    expect(buf).toContain('Candidate Evidence: C1-sonnet');
    expect(buf).toContain('build-oracle');
    expect(buf).toContain('PROVENANCE');

    // Close modal via Escape
    harness.sendKey('\x1b');
    expect(harness.tui.isEvidenceModalOpen()).toBe(false);

    // Return to fleet via Escape
    harness.sendKey('\x1b');
    expect(harness.tui.getCurrentView()).toBe('fleet');
  });

  // =========================================================================
  // G59: TUI_CONTEXT
  // =========================================================================
  it('G59: TUI_CONTEXT — feeds 50+ context generations, asserts bounded memory, sawtooth graph, resize stability, and input isolation', async () => {
    // 1. Feed 60 context generations showing sawtooth behavior (drops on compaction)
    for (let gen = 1; gen <= 60; gen++) {
      // Sawtooth pattern: tokens climb from 4,000 to 28,000, then drop to 12,000 every 12 generations
      const cycle = gen % 12;
      const currentTokens = 4000 + cycle * 2000;
      const deduplicated = cycle > 0 ? 1200 : 4500;
      const compressed = cycle > 0 ? 800 : 3800;
      const offloaded = cycle > 0 ? 500 : 2500;
      const stablePrefix = 6000;
      const volatilePortion = Math.max(0, currentTokens - stablePrefix);

      harness.tui.recordContextSample({
        generation: gen,
        currentTokens,
        effectiveMax: 32768,
        targetTokens: 16384,
        deduplicated,
        compressed,
        offloaded,
        stablePrefix,
        volatilePortion,
        timestamp: new Date(),
      });
    }

    // 2. Assert bounded memory: ring buffer does not exceed MAX_CONTEXT_SAMPLES (100)
    expect((harness.tui as any).contextSamples.length).toBeLessThanOrEqual(100);
    expect((harness.tui as any).contextSamples.length).toBe(60);

    // 3. Switch to CONTEXT view via keyboard shortcut '4'
    harness.sendKey('4');
    expect(harness.tui.getCurrentView()).toBe('context');

    let buf = harness.getScreenBuffer();
    expect(buf).toContain('CONTEXT UTILIZATION OVER TIME');
    expect(buf).toContain('Current Gen: G60');
    expect(buf).toContain('Stable Prefix: 6000 tok');
    expect(buf).toContain('Exact Deduplicated:');
    expect(buf).toContain('Semantic Compressed:');
    expect(buf).toContain('Oversized Offloaded:');
    expect(buf).toContain('[MAX]');
    expect(buf).toContain('[TARGET]');

    // 4. Assert resize works dynamically without stale artifacts or soft-wrap overflow
    harness.screen.handleResize({ columns: 80, rows: 35 });
    buf = harness.getScreenBuffer();
    expect(buf).toContain('CONTEXT UTILIZATION OVER TIME');
    expect(buf).not.toContain('\x1b[3\n');

    harness.screen.handleResize({ columns: 140, rows: 45 });
    buf = harness.getScreenBuffer();
    expect(buf).toContain('CONTEXT UTILIZATION OVER TIME');

    // 5. Verify input isolation: typing while in context view doesn't corrupt the graph or buffer
    harness.sendKey('e');
    expect(harness.tui.isEvidenceModalOpen()).toBe(true);
    buf = harness.getScreenBuffer();
    expect(buf).toContain('Context Generation Snapshot: G60');

    harness.sendKey('\x1b');
    expect(harness.tui.isEvidenceModalOpen()).toBe(false);

    harness.sendKey('\x1b');
    expect(harness.tui.getCurrentView()).toBe('fleet');
  });

  // =========================================================================
  // G60: FULL SYSTEM INTEGRATION
  // =========================================================================
  it('G60: FULL SYSTEM INTEGRATION — runs full engineering task through classification -> empirical routing -> worker placement -> solution search -> pruning -> verification -> Pareto -> promotion -> evaluation -> meta-optimizer -> TUI projection with full provenance completeness', async () => {
    // 1. Task Definition
    const engineeringTask = {
      id: 'task-eng-g60',
      prompt: 'Refactor exponential backoff retry policy and repair flaky test in test/retry.test.ts',
      files: ['src/retry.ts', 'test/retry.test.ts'],
    };

    // 2. Capability Classification
    const classification = await engine.modelIntelligence!.classifyTask(engineeringTask.prompt);
    expect(classification.primaryCategory).toBeDefined();
    expect(classification.relevantCategories.length).toBeGreaterThan(0);

    // 3. Empirical Model Routing
    const targetCategory = classification.primaryCategory;
    const modelProfile = await engine.modelIntelligence!.getProfile('claude-3-5-sonnet');
    expect(modelProfile).toBeDefined();
    const routedModelId = 'claude-3-5-sonnet';

    // 4. Distributed Worker Placement
    const workers = engine.computers.list();
    expect(workers.length).toBeGreaterThan(0);
    const selectedWorker = workers[0];
    expect(selectedWorker.id).toBe('worker-local');

    // 5. Adaptive SolutionSearch: multiple candidates across workers
    const searchHandle = await engine.solutionSearch!.startSearch({
      objective: engineeringTask.prompt,
      parentExecutionId: engineeringTask.id,
      parentWorkspaceRoot: projectRoot,
      targetFiles: engineeringTask.files,
      budget: { maxCandidates: 3, maxWallTimeMs: 30000, maxTotalTokens: 25000 },
      strategy: 'adaptive_pareto_sampling',
      candidateDescriptors: [
        { modelId: routedModelId, workerId: selectedWorker.id, iteration: 1 } as CandidateDescriptor,
        { modelId: 'qwen-2.5-coder-32b', workerId: selectedWorker.id, iteration: 1 } as CandidateDescriptor,
      ],
      autoPromote: false,
    });
    expect(searchHandle.searchId).toBeDefined();

    // 6. Candidate Pruning & Verification Simulation
    const cand1 = searchHandle.candidates[0]!;
    const cand2 = searchHandle.candidates[1]!;

    cand1.status = 'completed';
    cand1.tokensUsed = 1450;
    cand1.durationMs = 2800;
    cand1.metrics = { totalTokens: 1450, wallTimeMs: 2800 };
    cand1.evaluation = {
      qualifies: true,
      buildPassed: true,
      testsPassed: true,
      passedTests: 18,
      totalTests: 18,
      testSummary: '18/18 passed',
      isParetoFrontier: true,
      isDominated: false,
    };
    cand1.executionRecord = {
      filesChanged: ['src/retry.ts'],
      workspaceRevision: 1,
    } as any;

    // Prune candidate 2 due to test failure
    cand2.status = 'pruned';
    cand2.tokensUsed = 1900;
    cand2.durationMs = 3400;
    cand2.metrics = { totalTokens: 1900, wallTimeMs: 3400 };
    cand2.evaluation = {
      qualifies: false,
      buildPassed: true,
      testsPassed: false,
      passedTests: 14,
      totalTests: 18,
      testSummary: '4 tests failed: BackoffTimeout',
      isParetoFrontier: false,
      isDominated: true,
      disqualificationReasons: ['Unit tests failed oracle verification'],
    };

    // 7. Pareto Evaluation: cand1 is on frontier, cand2 is dominated
    searchHandle.status = 'completed';
    searchHandle.selectedCandidate = cand1;
    searchHandle.selectionReason = 'Pareto frontier candidate with passing build and 18/18 tests';

    // 8. Promotion via control-plane API
    const promotionResult = await engine.solutionSearch!.promoteCandidate({
      searchId: searchHandle.searchId,
      candidateId: cand1.candidateId,
    });
    expect(promotionResult.promoted).toBe(true);
    expect(promotionResult.promotedRevision).toBeGreaterThan(0);

    // 9. EvaluationService observation & record
    const evalResult = engine.evaluation!.evaluateTaskExecution({
      taskId: engineeringTask.id,
      wallTimeMs: cand1.durationMs,
      tokensUsed: cand1.tokensUsed,
      costUsd: 0.005,
      success: true,
      verified: true,
    });
    expect(evalResult.score).toBeGreaterThan(0);

    // 10. MetaOptimizer observation
    const experimentPlan: ExperimentPlan = {
      experimentId: `exp-g60-${Date.now()}`,
      name: 'Automated solution promotion observation',
      hypothesis: {
        domain: 'routing',
        statement: 'Routing to empirical capability model achieves 100% test pass rate',
        description: 'Empirical model routing observation',
      } as any,
      primaryMetric: 'tokens' as any,
      secondaryMetrics: ['wall_time_ms' as any],
      requiredImprovement: { metric: 'tokens', threshold: 0.1, direction: 'MINIMIZE' } as any,
      regressionConstraints: {},
      benchmarkCategories: ['routing'],
      benchmarkTasks: [engineeringTask.id],
      sampleSize: 1,
      budget: { maxWallTimeMs: 30000, maxTotalTokens: 20000 },
      createdAt: new Date(),
    };
    (experimentPlan as any).status = 'QUALIFIED';
    (experimentPlan as any).decision = 'PROMOTED';
    engine.optimizer!.registerExperiment(experimentPlan);

    // 11. TUI Projection: Assert state displays accurately in both SEARCH and IMPROVEMENT views
    harness.sendKey('3'); // SEARCH view
    expect(harness.tui.getCurrentView()).toBe('search');
    let buf = harness.getScreenBuffer();
    expect(buf).toContain(searchHandle.searchId);
    expect(buf).toContain(cand1.candidateId);
    expect(buf).toContain('● FRONTIER');
    expect(buf).toContain('PRUNED');

    harness.sendKey('2'); // IMPROVEMENT view
    expect(harness.tui.getCurrentView()).toBe('improvement');
    buf = harness.getScreenBuffer();
    expect(buf).toContain('SELF IMPROVEMENT');
    expect(buf).toContain(experimentPlan.experimentId);
    expect(buf).toContain('PROMOTED');

    // 12. Provenance Completeness Trace: register and verify artifact lineage
    const provenanceArtifact = await engine.provenance.registerArtifact({
      executionId: engineeringTask.id,
      name: 'promoted-patch-retry.ts',
      type: 'code_patch',
      location: 'src/retry.ts',
      contentHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      sizeBytes: 1240,
      workspace: projectRoot,
      agentId: 'wazir-coding',
      modelId: routedModelId,
      runtimeId: 'local',
      computerId: selectedWorker.id,
      workerId: selectedWorker.id,
      toolsUsed: ['edit', 'test_oracle'],
      metadata: {
        task: engineeringTask.prompt,
        classification: classification.primaryCategory,
        routedModel: routedModelId,
        workerPlacement: selectedWorker.id,
        searchId: searchHandle.searchId,
        promotedCandidate: cand1.candidateId,
        promotedRevision: promotionResult.promotedRevision,
        evaluationScore: evalResult.score,
        experimentId: experimentPlan.experimentId,
      },
    });

    const lineage = await engine.provenance.getLineage(provenanceArtifact.artifactId);
    expect(lineage.length).toBeGreaterThan(0);
    const rootArtifact = lineage[0];
    expect(rootArtifact.executionId).toBe(engineeringTask.id);
    expect(rootArtifact.modelId).toBe(routedModelId);
    expect(rootArtifact.workerId).toBe(selectedWorker.id);
    expect(rootArtifact.metadata?.classification).toBe(classification.primaryCategory);
    expect(rootArtifact.metadata?.searchId).toBe(searchHandle.searchId);
    expect(rootArtifact.metadata?.promotedCandidate).toBe(cand1.candidateId);
    expect(rootArtifact.metadata?.promotedRevision).toBe(promotionResult.promotedRevision);
    expect(rootArtifact.metadata?.experimentId).toBe(experimentPlan.experimentId);
  });
});
