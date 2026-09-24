import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SolutionSearchService } from '../src/services/solutionSearchService.js';
import { HierarchicalMctsService } from '../src/services/hierarchicalMctsService.js';
import type {
  SolutionSearchRequest,
  CandidateRunner,
  ExecutionRecord,
  ExecutionCheckpoint,
  CandidateDescriptor,
  CandidateEvaluation,
} from '../src/types/index.js';

describe('Acceptance Gates: G66, G67, G68 — Hierarchical MCTS & Tree Resilience', () => {
  let mockCheckpointService: any;
  let mockWorktreeManager: any;
  let mockExecutionEngine: any;
  let mockEvaluationService: any;
  let baselineCheckpoint: ExecutionCheckpoint;
  let checkpointsStore: Map<string, ExecutionCheckpoint>;

  beforeEach(() => {
    checkpointsStore = new Map();

    baselineCheckpoint = {
      id: 'chk-baseline-c0',
      parentCheckpointId: undefined,
      executionId: 'exec-parent',
      timestamp: new Date(),
      workspaceRevision: 10,
      snapshotHash: 'hash-c0',
      description: 'Baseline Refactoring State C0',
      branch: 'main',
      workspaceRoot: '/tmp/workspace-root',
      worktreeState: { branch: 'main', isGit: true, filesSnapshot: { 'src/payment.ts': 'legacy_code' } },
      contextSnapshot: { itemUris: ['src/payment.ts'] },
      planState: { status: 'running' },
      verificationState: { revision: 10, evidenceIds: ['ev-c0'], checksPass: true },
      createdAt: new Date(),
    };
    checkpointsStore.set(baselineCheckpoint.id, baselineCheckpoint);

    mockCheckpointService = {
      checkpoint: vi.fn().mockImplementation((execId: string, opts?: any) => {
        const id = `chk-${execId}-${Date.now()}`;
        const chk: ExecutionCheckpoint = {
          id,
          executionId: execId,
          workspaceRevision: 11,
          workspaceRoot: `/tmp/worktrees/${execId}`,
          worktreeState: { branch: `branch-${execId}`, isGit: true, filesSnapshot: {} },
          contextSnapshot: { itemUris: [] },
          planState: { status: 'running' },
          verificationState: { revision: 11, evidenceIds: [], checksPass: true },
          createdAt: new Date(),
          description: opts?.description,
        };
        checkpointsStore.set(id, chk);
        return Promise.resolve(chk);
      }),
      getCheckpoint: vi.fn().mockImplementation((id: string) => checkpointsStore.get(id)),
      fork: vi.fn().mockImplementation((chkId: string, forkedExecId: string) => {
        const forkedChkId = `chk-fork-${forkedExecId}`;
        const chk: ExecutionCheckpoint = {
          id: forkedChkId,
          executionId: forkedExecId,
          workspaceRevision: 10,
          workspaceRoot: `/tmp/worktrees/${forkedExecId}`,
          worktreeState: { branch: `branch-${forkedExecId}`, isGit: true, filesSnapshot: {} },
          contextSnapshot: { itemUris: [] },
          planState: { status: 'running' },
          verificationState: { revision: 10, evidenceIds: [], checksPass: true },
          createdAt: new Date(),
        };
        checkpointsStore.set(forkedChkId, chk);
        return Promise.resolve({
          forkedExecutionId: forkedExecId,
          forkedWorktreePath: `/tmp/worktrees/${forkedExecId}`,
          branch: `branch-${forkedExecId}`,
          checkpointId: forkedChkId,
        });
      }),
      mergeFork: vi.fn().mockResolvedValue({
        success: true,
        mergedRevision: 12,
      }),
    };

    mockWorktreeManager = {
      createWorktree: vi.fn().mockResolvedValue({
        worktreeDir: '/tmp/worktree-dir',
        branch: 'branch-cand',
      }),
      removeWorktree: vi.fn().mockResolvedValue(true),
    };

    mockExecutionEngine = {
      get: vi.fn().mockResolvedValue({
        execution: { id: 'exec-parent', taskId: 'task-refactor', status: 'completed' },
        task: { id: 'task-refactor', title: 'Multi-Module Payment Refactoring' },
        workspaceState: { revision: 10 },
      }),
    };

    mockEvaluationService = {
      evaluate: vi.fn().mockImplementation((record: ExecutionRecord) => {
        const hasBuildFailure = record.checks?.some((c) => c.name === 'build' && !c.ok);
        const hasTestFailure = record.checks?.some((c) => c.name === 'test' && !c.ok);
        const hasProtectedFailure = record.checks?.some((c) => (c as any).protected && !c.ok);
        const qualifies = !hasBuildFailure && !hasTestFailure && !hasProtectedFailure && record.status !== 'failed';

        return {
          passed: qualifies,
          qualifies,
          score: qualifies ? 0.95 : 0.2,
          disqualificationReasons: qualifies ? [] : ['Verification checks failed'],
          metrics: {
            testsPassed: !hasTestFailure,
            buildPassed: !hasBuildFailure,
            lintPassed: true,
            taskSuccess: qualifies,
            physicalVerificationSuccess: qualifies,
            totalModelCalls: 1,
          },
        };
      }),
    };
  });

  /**
   * GATE G66: HIERARCHICAL_SEARCH
   *
   * Multi-module refactoring task with at least two architectural approaches
   * and multiple implementation variants.
   * Require:
   * - depth >= 3
   * - multiple branches
   * - checkpoint inheritance
   * - pruning
   * - verification
   * - final promotion
   */
  it('G66 Acceptance: executes hierarchical MCTS refactoring across multiple levels with pruning and promotion', async () => {
    const service = new SolutionSearchService({
      checkpointService: mockCheckpointService,
      worktreeManager: mockWorktreeManager,
      executionEngine: mockExecutionEngine,
      evaluationService: mockEvaluationService,
      defaultProjectRoot: '/tmp/workspace-root',
    });

    const emittedEvents: string[] = [];
    service.onEvent((e) => emittedEvents.push(e.type));

    // Runner simulates rollout based on candidate strategy:
    // Approach A (Event-Driven): succeeds cleanly at all depths
    // Approach B (Monolith): fails build or tests at depth 2/3 -> gets pruned
    const runner: CandidateRunner = async (context) => {
      const isApproachB = context.descriptor.implementationApproach?.includes('monolith') ||
                          context.candidateId.includes('option_B');

      if (isApproachB) {
        return {
          execution: { id: `exec-${context.candidateId}`, taskId: 'task-refactor', status: 'failed' } as any,
          task: { id: 'task-refactor' } as any,
          policyDecisions: [],
          toolCalls: [],
          filesChanged: ['src/monolith.ts'],
          checks: [
            { name: 'build', command: 'tsc', ok: false, output: 'Cyclic dependency in monolithic module', durationMs: 40 },
          ],
          errors: ['UNRECOVERABLE_BUILD: tight coupling prevents compilation'],
          events: [],
          usage: { input: 1500, output: 300, total: 1800 },
          durationMs: 80,
        };
      }

      // Approach A: Modular Event-Driven Refactoring succeeds
      return {
        execution: { id: `exec-${context.candidateId}`, taskId: 'task-refactor', status: 'completed' } as any,
        task: { id: 'task-refactor' } as any,
        policyDecisions: [],
        toolCalls: [],
        filesChanged: ['src/events.ts', 'src/provider.ts', 'src/processor.ts'],
        checks: [
          { name: 'build', command: 'tsc', ok: true, output: 'Compiled successfully', durationMs: 50 },
          { name: 'test', command: 'npm test', ok: true, output: '24 tests passed', durationMs: 120 },
        ],
        errors: [],
        events: [],
        usage: { input: 2000, output: 600, total: 2600 },
        durationMs: 170,
      };
    };

    const request: SolutionSearchRequest = {
      executionId: 'exec-parent',
      objective: 'Refactor payment processing into modular decoupled architecture',
      strategy: 'hierarchical_mcts',
      candidates: 8,
      autoPromote: true,
      hierarchical: {
        enabled: true,
        maxDepth: 3,
        maxNodes: 8,
        branchingFactor: 2,
        explorationConstant: 1.414,
        phases: ['architecture', 'design', 'implementation'],
        progressiveVerification: true,
        transpositionDetection: true,
        pruneThreshold: 0.1,
      },
    };

    const result = await service.search(request, runner);

    // 1. Verify Hierarchical Search Structure
    expect(result.hierarchicalTree).toBeDefined();
    expect(result.hierarchicalTelemetry).toBeDefined();

    const telemetry = result.hierarchicalTelemetry!;
    console.log('TELEMETRY NODES:', telemetry.totalNodes, telemetry.nodesPerLevel);
    console.log('ALL NODES:', Array.from(result.hierarchicalTree!.nodes.values()).map(n => ({ id: n.id, depth: n.depth, level: n.level, strategy: n.strategy, pruned: n.pruned })));
    expect(telemetry.treeDepth).toBeGreaterThanOrEqual(3);
    expect(telemetry.totalNodes).toBeGreaterThanOrEqual(5);

    // 2. Multiple branches explored
    expect(telemetry.nodesPerLevel.architecture).toBeGreaterThanOrEqual(1);
    expect(telemetry.nodesPerLevel.design).toBeGreaterThanOrEqual(1);
    expect(telemetry.nodesPerLevel.implementation).toBeGreaterThanOrEqual(1);

    // 3. Checkpoint inheritance verified: child branches originate from parent checkpoints
    expect(mockCheckpointService.fork).toHaveBeenCalled();
    const evaluatedNodes = Array.from(result.hierarchicalTree!.nodes.values());
    const deepNode = evaluatedNodes.find((n) => n.depth >= 2);
    expect(deepNode).toBeDefined();
    expect(deepNode?.checkpointId).toBeDefined();

    // 4. Pruning verified: unpromising Approach B is pruned
    const prunedNode = evaluatedNodes.find((n) => n.pruned);
    expect(prunedNode).toBeDefined();
    expect(prunedNode?.pruneReason).toBeDefined();
    expect(telemetry.prunedNodesCount).toBeGreaterThanOrEqual(1);
    expect(emittedEvents).toContain('mcts.node_pruned');

    // 5. Progressive verification verified
    expect(result.qualifyingCandidates.length).toBeGreaterThan(0);
    const qualifying = result.qualifyingCandidates[0];
    expect(qualifying.evaluation?.correctness).toBe(true);

    // 6. Final Promotion verified: best candidate is promoted
    expect(result.selectedCandidate).toBeDefined();
    expect(result.promotionResult).toBeDefined();
    expect(result.promotionResult?.success).toBe(true);
    expect(result.promotionResult?.promoted).toBe(true);
    expect(result.promotionResult?.promotedRevision).toBe(12);
  });

  /**
   * GATE G67: TREE_RECOVERY
   *
   * Kill a worker executing one branch mid-search.
   * Assert:
   * - Tree remains valid
   * - Completed node evidence retained
   * - Branch safely recoverable/requeueable
   * - Other branches continue
   */
  it('G67 Acceptance: recovers safely from worker failure during branch rollout without corrupting tree state', async () => {
    const mctsService = new HierarchicalMctsService({
      checkpointService: mockCheckpointService,
      worktreeManager: mockWorktreeManager,
      executionEngine: mockExecutionEngine,
      evaluationService: mockEvaluationService,
    });

    const tree = mctsService.initTree({
      rootExecutionId: 'exec-parent',
      rootCheckpointId: baselineCheckpoint.id,
      objective: 'Distributed Tree Recovery Test',
      config: { maxDepth: 3, branchingFactor: 2 },
    });

    // 1. Expand root into 2 branches
    const rootNode = tree.nodes.get(tree.rootId)!;
    const [childA, childB] = await mctsService.expand({
      tree,
      parentNode: rootNode,
      strategyProposals: [
        { strategy: 'branch_A_safe_worker' },
        { strategy: 'branch_B_failing_worker' },
      ],
    });

    // 2. Simulate childA successfully
    const successRunner: CandidateRunner = async (ctx) => ({
      execution: { id: `exec-${ctx.candidateId}`, taskId: 'task-1', status: 'completed' } as any,
      task: { id: 'task-1' } as any,
      policyDecisions: [],
      toolCalls: [],
      filesChanged: ['src/branchA.ts'],
      checks: [{ name: 'test', command: 'npm test', ok: true, durationMs: 40 }],
      errors: [],
      events: [],
      usage: { input: 1000, output: 200, total: 1200 },
      durationMs: 50,
    });

    await mctsService.simulate({ tree, node: childA, runner: successRunner });
    mctsService.backpropagate({ tree, leafNode: childA, rewardEvidence: childA.rewardEvidence! });

    expect(childA.rewardEvidence).toBeDefined();
    expect(childA.visits).toBe(1);

    // 3. Worker executing branch B crashes/fails
    const failureResult = mctsService.handleWorkerFailure({
      tree,
      nodeId: childB.id,
      workerId: 'worker-node-crash-01',
      error: new Error('WORKER_DISCONNECTED: Connection reset by peer during rollout'),
    });

    // Assert: Tree remains structurally sound and valid
    expect(failureResult.recovered).toBe(true);
    expect(tree.nodes.size).toBe(3); // root, childA, childB
    expect(tree.nodes.get(childA.id)?.rewardEvidence).toBeDefined(); // childA evidence intact!

    // Assert: Failed branch is safely requeued
    expect(failureResult.requeuedNode.id).toBe(childB.id);
    expect(failureResult.requeuedNode.visits).toBe(0);
    expect((failureResult.requeuedNode.metadata as any)?.workerFailure.workerId).toBe('worker-node-crash-01');

    // 4. Other branches continue execution and survive to completion
    await mctsService.simulate({ tree, node: childB, runner: successRunner });
    mctsService.backpropagate({ tree, leafNode: childB, rewardEvidence: childB.rewardEvidence! });

    expect(childB.rewardEvidence).toBeDefined();
    expect(childB.visits).toBe(1);

    const telemetry = mctsService.getTelemetry(tree);
    expect(telemetry.workerFailuresRecovered).toBe(1);
    expect(telemetry.totalNodes).toBe(3);
  });

  /**
   * GATE G68: TRANSPOSITION
   *
   * Cause two branches to converge on equivalent workspace state.
   * Assert duplicate state is detected and redundant evaluation avoided.
   */
  it('G68 Acceptance: detects equivalent workspace convergence and avoids redundant simulation', async () => {
    const mctsService = new HierarchicalMctsService({
      checkpointService: mockCheckpointService,
      worktreeManager: mockWorktreeManager,
      executionEngine: mockExecutionEngine,
      evaluationService: mockEvaluationService,
    });

    const tree = mctsService.initTree({
      rootExecutionId: 'exec-parent',
      rootCheckpointId: baselineCheckpoint.id,
      objective: 'Transposition Convergence Test',
      config: { maxDepth: 3, transpositionDetection: true },
    });

    const rootNode = tree.nodes.get(tree.rootId)!;
    const convergedHash = 'sha256-identical-state-converged';

    // Two different paths: Path 1 (via strategy A) and Path 2 (via strategy B)
    const [path1Node, path2Node] = await mctsService.expand({
      tree,
      parentNode: rootNode,
      strategyProposals: [
        { strategy: 'refactor_via_service_layer', customHash: convergedHash },
        { strategy: 'refactor_via_domain_facade', customHash: convergedHash },
      ],
    });

    let runExecutionCount = 0;
    const runner: CandidateRunner = async (ctx) => {
      runExecutionCount++;
      return {
        execution: { id: `exec-${ctx.candidateId}`, taskId: 'task-1', status: 'completed' } as any,
        task: { id: 'task-1' } as any,
        policyDecisions: [],
        toolCalls: [],
        filesChanged: ['src/common.ts'],
        checks: [{ name: 'test', command: 'npm test', ok: true, durationMs: 50 }],
        errors: [],
        events: [],
        usage: { input: 1200, output: 300, total: 1500 },
        durationMs: 60,
      };
    };

    // 1. Simulate Path 1: Executes fully and populates transposition table
    await mctsService.simulate({ tree, node: path1Node, runner });
    expect(runExecutionCount).toBe(1);
    expect(path1Node.isTransposition).toBeFalsy();

    // 2. Simulate Path 2: Converges on the exact same stateHash
    await mctsService.simulate({ tree, node: path2Node, runner });

    // Assert: Redundant evaluation avoided! (runner was not called a second time)
    expect(runExecutionCount).toBe(1);
    expect(path2Node.isTransposition).toBe(true);
    expect(path2Node.transpositionTargetId).toBe(path1Node.id);
    expect(path2Node.rewardEvidence?.scalarReward).toBe(path1Node.rewardEvidence?.scalarReward);

    const telemetry = mctsService.getTelemetry(tree);
    expect(telemetry.transpositionsDetected).toBe(1);
  });

  /**
   * COMPARISON: FLAT ADAPTIVE SEARCH VS HIERARCHICAL MCTS
   *
   * Run equivalent hard tasks with flat adaptive search vs hierarchical MCTS.
   * Measure:
   * - task success
   * - verified solution rate
   * - tokens
   * - model calls
   * - wall time
   * - compute
   * - branches
   * - repair cycles
   */
  it('Comparative Evaluation: Flat Adaptive Search vs Hierarchical MCTS', async () => {
    const service = new SolutionSearchService({
      checkpointService: mockCheckpointService,
      worktreeManager: mockWorktreeManager,
      executionEngine: mockExecutionEngine,
      evaluationService: mockEvaluationService,
      defaultProjectRoot: '/tmp/workspace-root',
    });

    const mockRunner: CandidateRunner = async (ctx) => {
      const isUnviable = ctx.candidateId.includes('unviable') || ctx.descriptor.name.includes('bad');
      return {
        execution: { id: `exec-${ctx.candidateId}`, taskId: 'task-compare', status: isUnviable ? 'failed' : 'completed' } as any,
        task: { id: 'task-compare' } as any,
        policyDecisions: [],
        toolCalls: [],
        filesChanged: ['src/algo.ts'],
        checks: [
          { name: 'build', command: 'tsc', ok: !isUnviable, durationMs: 40 },
          { name: 'test', command: 'npm test', ok: !isUnviable, durationMs: 60 },
        ],
        errors: isUnviable ? ['TEST_FAILURE'] : [],
        events: [],
        usage: { input: 1500, output: 400, total: 1900 },
        durationMs: 100,
      };
    };

    // 1. Run with Flat Adaptive Search
    const flatRequest: SolutionSearchRequest = {
      executionId: 'exec-parent',
      objective: 'Comparative multi-module refactoring benchmark',
      strategy: 'same_model_diverse',
      candidates: 4,
      adaptive: {
        enabled: true,
        initialCandidates: 2,
        maxCandidates: 4,
      },
    };

    const flatResult = await service.search(flatRequest, mockRunner);

    // 2. Run with Hierarchical MCTS Search
    const mctsRequest: SolutionSearchRequest = {
      executionId: 'exec-parent',
      objective: 'Comparative multi-module refactoring benchmark',
      strategy: 'hierarchical_mcts',
      candidates: 6,
      hierarchical: {
        enabled: true,
        maxDepth: 3,
        maxNodes: 6,
        branchingFactor: 2,
      },
    };

    const mctsResult = await service.search(mctsRequest, mockRunner);

    // Collect comparative measurements
    const comparison = {
      flat: {
        taskSuccess: flatResult.status === 'completed',
        verifiedSolutionRate: flatResult.qualifyingCandidates.length / Math.max(1, flatResult.totalCandidates),
        totalTokens: flatResult.totalTokens,
        modelCalls: flatResult.totalModelCalls,
        wallTimeMs: flatResult.wallTimeMs,
        branchesExplored: flatResult.totalCandidates,
        repairCycles: flatResult.candidates.reduce((s, c) => s + (c.evaluation?.execution.repairCycles ?? 0), 0),
      },
      mcts: {
        taskSuccess: mctsResult.status === 'completed',
        verifiedSolutionRate: mctsResult.qualifyingCandidates.length / Math.max(1, mctsResult.totalCandidates),
        totalTokens: mctsResult.totalTokens,
        modelCalls: mctsResult.totalModelCalls,
        wallTimeMs: mctsResult.wallTimeMs,
        branchesExplored: mctsResult.hierarchicalTelemetry?.totalNodes ?? mctsResult.totalCandidates,
        repairCycles: mctsResult.candidates.reduce((s, c) => s + (c.evaluation?.execution.repairCycles ?? 0), 0),
        treeDepth: mctsResult.hierarchicalTelemetry?.treeDepth ?? 0,
      },
    };

    console.log('\n============================================================');
    console.log('FLAT ADAPTIVE SEARCH VS HIERARCHICAL MCTS COMPARATIVE REPORT');
    console.log('============================================================');
    console.log('Flat Adaptive Search:', JSON.stringify(comparison.flat, null, 2));
    console.log('Hierarchical MCTS Search:', JSON.stringify(comparison.mcts, null, 2));
    console.log('============================================================\n');

    expect(comparison.flat.taskSuccess).toBe(true);
    expect(comparison.mcts.taskSuccess).toBe(true);
    expect(comparison.mcts.treeDepth).toBeGreaterThanOrEqual(2);
    expect(comparison.mcts.branchesExplored).toBeGreaterThanOrEqual(4);
  });
});
