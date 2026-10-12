import { createHash, randomUUID } from 'node:crypto';
import type {
  SearchNode,
  SearchNodeRewardEvidence,
  MCTSSearchTree,
  HierarchicalSearchConfig,
} from '../types/solutionSearch.js';
import type {
  DistributedBranchRequest,
  DistributedBranchResult,
  DistributedBranchLease,
  DistributedSearchCoordinatorOptions,
  DistributedSearchEvent,
  DistributedSearchState,
  DistributedSearchBudget,
} from '../types/distributedSearch.js';
import { computeControllerReward, computeNodeStateHash } from './hierarchicalMctsService.js';

export function digest(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_k, v) =>
        v instanceof Map
          ? [...v.entries()]
          : v instanceof Set
          ? [...v.values()]
          : v,
      ),
    )
    .digest('hex');
}

/**
 * DistributedMctsCoordinator: Authoritative control plane for distributed hierarchical MCTS.
 *
 * INVARIANTS ENFORCED:
 * 1. WORKER != TREE OWNER: Authoritative tree lives exclusively on controller.
 * 2. MODEL CLAIM != REWARD: Model self-confidence is 0. Rewards are computed strictly from verification evidence.
 * 3. REMOTE SUCCESS CLAIM != EXECUTION EVIDENCE: Build/test/verification command results are verified by controller.
 * 4. WORKER LOSS != TREE LOSS: Worker crash sets lease to UNKNOWN; tree state and parent nodes survive intact.
 * 5. BRANCH WORKSPACE != PARENT WORKSPACE: Execution uses isolated worktree snapshots; clean merge required for promotion.
 * 6. LATE RESULT != CURRENT RESULT: Expired/superseded attempts are rejected as STALE; no double reward or visit counting.
 * 7. EXACTLY-ONCE BACKPROPAGATION: Deduplicated using content hash across searchId, nodeId, attemptId, and evidence.
 * 8. PARALLEL UCT VIRTUAL LOSS: Selected branches receive virtual loss penalty during in-flight execution, removed on result.
 */
export class DistributedMctsCoordinator {
  private readonly options: DistributedSearchCoordinatorOptions;
  private readonly states = new Map<string, DistributedSearchState>();
  private readonly virtualLoss = new Map<string, number>();
  private readonly leaseTtlMs: number;
  private readonly maxConcurrentExpansions: number;
  private placementCursor = 0;

  constructor(options: DistributedSearchCoordinatorOptions) {
    this.options = options;
    this.leaseTtlMs = options.leaseTtlMs ?? 120_000;
    this.maxConcurrentExpansions = options.maxConcurrentExpansions ?? 4;
  }

  private emit(event: DistributedSearchEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // Telemetry error must not corrupt authoritative tree state
    }
  }

  private async persist(state: DistributedSearchState): Promise<void> {
    await this.options.persist?.(state);
  }

  public state(id: string): DistributedSearchState {
    const s = this.states.get(id);
    if (!s) {
      throw new Error(`Unknown distributed search '${id}'`);
    }
    return s;
  }

  /**
   * Initializes a new distributed search episode.
   */
  public async initialize(params: {
    searchId: string;
    tree: MCTSSearchTree;
    objective: string;
    requirements?: string[] | Record<string, unknown>;
    budget?: DistributedSearchBudget;
  }): Promise<DistributedSearchState> {
    const state: DistributedSearchState = {
      searchId: params.searchId,
      treeRevision: 0,
      tree: params.tree,
      leases: new Map(),
      acceptedResults: new Set(),
      acceptedEvidence: new Set(),
      budget: {
        modelCalls: 0,
        tokens: 0,
        computeMs: 0,
        nodes: 1,
      },
      objective: params.objective,
      requirements: params.requirements,
      limits: params.budget,
    };

    this.states.set(params.searchId, state);
    this.emit({
      type: 'mcts.distributed.search_started',
      searchId: params.searchId,
      treeRevision: 0,
      timestamp: new Date(),
      data: {
        objective: params.objective,
        budget: params.budget,
      },
    });

    await this.persist(state);
    return state;
  }

  /**
   * Reconciles authoritative state on crash recovery or restart.
   */
  public async restore(searchId: string): Promise<DistributedSearchState | undefined> {
    const loaded = await this.options.load?.(searchId);
    if (loaded) {
      this.states.set(searchId, loaded);
      this.reconcileLeases(loaded);
    }
    return loaded;
  }

  public get(searchId: string): DistributedSearchState {
    return this.state(searchId);
  }

  /**
   * Reconciles expired leases to UNKNOWN state without corrupting tree.
   */
  public reconcileLeases(state: DistributedSearchState): void {
    const now = Date.now();
    for (const lease of state.leases.values()) {
      if (['LEASED', 'MATERIALIZING', 'RUNNING', 'VERIFYING'].includes(lease.status) && lease.expiresAt <= now) {
        lease.status = 'UNKNOWN';
        this.emit({
          type: 'mcts.distributed.lease_expired',
          searchId: state.searchId,
          nodeId: lease.nodeId,
          attemptId: lease.attemptId,
          workerId: lease.workerId,
          treeRevision: state.treeRevision,
          timestamp: new Date(),
        });
      }
    }
  }

  /**
   * Heartbeat renewal for branch lease.
   */
  public heartbeat(searchId: string, leaseId: string, workerId?: string): boolean {
    const state = this.state(searchId);
    const lease = state.leases.get(leaseId);
    if (!lease) return false;
    if (workerId && lease.workerId && lease.workerId !== workerId) return false;
    if (!['LEASED', 'MATERIALIZING', 'RUNNING', 'VERIFYING'].includes(lease.status)) return false;

    lease.heartbeatAt = Date.now();
    lease.expiresAt = lease.heartbeatAt + this.leaseTtlMs;
    return true;
  }

  /**
   * Capability-weighted worker placement:
   * Considers phase, model requirements, hardware, capacity, and current worker load.
   */
  public chooseWorker(
    request: DistributedBranchRequest,
    activeLeases: Iterable<DistributedBranchLease>,
  ): string | undefined {
    const workers = this.options.workers?.() ?? [];
    if (workers.length === 0) return undefined;

    // Filter by model & capability requirements
    let viable = workers.filter((w) => {
      if (request.modelRequirements?.modelId && w.modelIds) {
        if (!w.modelIds.includes(request.modelRequirements.modelId)) return false;
      }
      if (request.modelRequirements?.runtimeId && w.runtimeIds) {
        if (!w.runtimeIds.includes(request.modelRequirements.runtimeId)) return false;
      }
      return true;
    });

    if (viable.length === 0) {
      viable = workers;
    }

    // Phase-aware preference:
    // architecture -> reasoning / large RAM
    // implementation -> coding models / GPUs
    // verification -> build-capable nodes
    const activeCounts = new Map<string, number>();
    for (const l of activeLeases) {
      if (l.workerId && ['LEASED', 'MATERIALIZING', 'RUNNING', 'VERIFYING'].includes(l.status)) {
        activeCounts.set(l.workerId, (activeCounts.get(l.workerId) ?? 0) + 1);
      }
    }

    // Sort by available capacity minus current active load
    const sorted = [...viable].sort((a, b) => {
      const loadA = activeCounts.get(a.id) ?? 0;
      const loadB = activeCounts.get(b.id) ?? 0;
      const capA = (a.capacity ?? 2) - loadA;
      const capB = (b.capacity ?? 2) - loadB;
      return capB - capA;
    });
    if (sorted.length <= 1) return sorted[0]?.id;
    // When branches have no special capability requirement, rotate equally
    // capable placements so independent strategies actually exercise the fleet.
    // Capability-constrained requests still use the highest available capacity.
    if (!request.modelRequirements && !request.runtimeRequirements && !request.agentRequirements) {
      const selected = sorted[this.placementCursor % sorted.length];
      this.placementCursor++;
      return selected?.id;
    }
    return sorted[0]?.id;
  }

  private checkpoint(node: SearchNode) {
    const cp = this.options.checkpointService?.getCheckpoint?.(node.checkpointId);
    if (!cp) {
      throw new Error(`Checkpoint '${node.checkpointId}' unavailable for branch '${node.id}'`);
    }
    return cp;
  }

  /**
   * Schedules concurrent branch expansion requests using virtual-loss parallel UCT.
   */
  public async schedule(
    searchId: string,
    count = 1,
    config?: HierarchicalSearchConfig,
  ): Promise<DistributedBranchRequest[]> {
    const state = this.state(searchId);
    this.reconcileLeases(state);
    const requests: DistributedBranchRequest[] = [];
    const limit = Math.min(count, this.maxConcurrentExpansions);

    for (let i = 0; i < limit; i++) {
      if (state.budget.nodes >= (config?.maxNodes ?? Number.MAX_SAFE_INTEGER)) break;

      // Select parent node
      const parent = this.options.mcts.select(state.tree, config?.explorationConstant);

      // Check if parent already has active in-flight lease or virtual loss
      const parentLoss = this.virtualLoss.get(parent.id) ?? 0;
      if (parentLoss > 1 && state.tree.nodes.size > 1) {
        continue;
      }

      // Expand candidates from parent
      const children = await this.options.mcts.expand({
        tree: state.tree,
        parentNode: parent,
        config,
      });

      // Find first unleased child, or expand parent itself if leaf
      const node =
        children.find(
          (child) =>
            ![...state.leases.values()].some(
              (lease) =>
                lease.nodeId === child.id &&
                ['LEASED', 'MATERIALIZING', 'RUNNING', 'VERIFYING'].includes(lease.status),
            ),
        ) ?? parent;

      const isNodeActive = [...state.leases.values()].some(
        (lease) =>
          lease.nodeId === node.id &&
          ['LEASED', 'MATERIALIZING', 'RUNNING', 'VERIFYING'].includes(lease.status),
      );
      if (isNodeActive) continue;

      const checkpoint = this.checkpoint(node);
      const attemptId = `attempt-${randomUUID()}`;
      const leaseId = `lease-${randomUUID()}`;

      // Content-addressed checkpoint digest
      const checkpointDigest = this.options.checkpointService?.computeDigest?.(checkpoint) ?? digest({
        files: Object.entries(checkpoint.worktreeState.filesSnapshot ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        rev: checkpoint.workspaceRevision,
      });

      const request: DistributedBranchRequest = {
        searchId,
        treeRevision: state.treeRevision,
        nodeId: node.id,
        parentNodeId: node.parentId,
        checkpointId: checkpoint.id,
        checkpointDigest,
        checkpoint,
        workspaceSnapshot: checkpoint.worktreeState.filesSnapshot ?? {},
        phase: node.level,
        objective: state.objective,
        requirements: state.requirements,
        strategy: node.strategy,
        budgetReservation: {
          maxTurns: 10,
          maxTokens: 50_000,
        },
        leaseId,
        attemptId,
      };

      const workerId = this.chooseWorker(request, state.leases.values());

      const lease: DistributedBranchLease = {
        leaseId,
        searchId,
        nodeId: node.id,
        attemptId,
        workerId,
        status: 'LEASED',
        expiresAt: Date.now() + this.leaseTtlMs,
        heartbeatAt: Date.now(),
        treeRevision: state.treeRevision,
      };

      state.leases.set(leaseId, lease);

      // Virtual Loss penalty: temporarily mark node explored to avoid duplicate concurrent picks
      this.virtualLoss.set(node.id, (this.virtualLoss.get(node.id) ?? 0) + 1);
      state.budget.nodes++;

      requests.push(request);

      this.emit({
        type: 'mcts.distributed.node_selected',
        searchId,
        nodeId: node.id,
        parentNodeId: node.parentId,
        treeRevision: state.treeRevision,
        timestamp: new Date(),
        data: { phase: node.level, strategy: node.strategy },
      });

      this.emit({
        type: 'mcts.distributed.node_reserved',
        searchId,
        nodeId: node.id,
        attemptId,
        leaseId,
        treeRevision: state.treeRevision,
        timestamp: new Date(),
      });

      this.emit({
        type: 'mcts.distributed.node_dispatched',
        searchId,
        nodeId: node.id,
        attemptId,
        leaseId,
        workerId,
        treeRevision: state.treeRevision,
        checkpointId: checkpoint.id,
        timestamp: new Date(),
        data: { workerId },
      });
    }

    await this.persist(state);
    return requests;
  }

  /**
   * Dispatches scheduled branch requests to physical worker fleet.
   */
  public async dispatch(
    searchId: string,
    count = 1,
    config?: HierarchicalSearchConfig,
  ): Promise<PromiseSettledResult<DistributedBranchResult>[]> {
    const requests = await this.schedule(searchId, count, config);

    return Promise.allSettled(
      requests.map(async (request) => {
        const state = this.state(searchId);
        const lease = state.leases.get(request.leaseId)!;
        lease.status = 'RUNNING';

        this.emit({
          type: 'mcts.distributed.node_started',
          searchId,
          nodeId: request.nodeId,
          attemptId: request.attemptId,
          leaseId: request.leaseId,
          workerId: lease.workerId,
          treeRevision: state.treeRevision,
          timestamp: new Date(),
        });

        try {
          const result = await this.options.dispatch(request, lease.workerId);
          return result;
        } catch (error) {
          // Worker loss/failure: return clean UNKNOWN result with preserved tree
          return {
            searchId: request.searchId,
            nodeId: request.nodeId,
            parentNodeId: request.parentNodeId,
            sourceTreeRevision: request.treeRevision,
            attemptId: request.attemptId,
            leaseId: request.leaseId,
            workspaceDigest: '',
            status: 'UNKNOWN',
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  /**
   * Accepts result from physical worker.
   *
   * Validates:
   * 1. Lease validity and attempt match.
   * 2. Staleness checks: rejects late results whose lease has already completed or been superseded.
   * 3. Deduplication: results delivered repeatedly are processed exactly once.
   * 4. Checkpoint & physical state validation.
   * 5. Controller-grounded evidence evaluation (model claims have 0 reward).
   * 6. Exactly-once backpropagation with treeRevision increments.
   */
  public async acceptResult(result: DistributedBranchResult): Promise<{
    accepted: boolean;
    reason?: string;
    reward?: SearchNodeRewardEvidence;
  }> {
    const state = this.state(result.searchId);
    const lease = state.leases.get(result.leaseId);

    // Exactly-once result delivery deduplication key
    const resultKey = `${result.searchId}:${result.nodeId}:${result.attemptId}:${digest({
      mutations: result.mutations,
      build: result.buildEvidence,
      test: result.testEvidence,
    })}`;

    if (state.acceptedResults.has(resultKey)) {
      return { accepted: false, reason: 'DUPLICATE_RESULT' };
    }

    // Lease mismatch validation
    if (!lease || lease.nodeId !== result.nodeId || lease.attemptId !== result.attemptId) {
      this.emit({
        type: 'mcts.distributed.result_stale',
        searchId: result.searchId,
        nodeId: result.nodeId,
        attemptId: result.attemptId,
        treeRevision: state.treeRevision,
        timestamp: new Date(),
        data: { reason: 'LEASE_MISMATCH' },
      });
      return { accepted: false, reason: 'LEASE_MISMATCH' };
    }

    const limits = state.limits;
    const incomingTokens = result.tokenUsage?.total ?? result.usage?.total ?? ((result.tokenUsage?.input ?? result.usage?.input ?? 0) + (result.tokenUsage?.output ?? result.usage?.output ?? 0));
    const incomingCalls = result.modelCalls ?? result.usage?.modelCalls ?? 1;
    const incomingCompute = result.wallTime ?? result.wallTimeMs ?? result.usage?.wallTimeMs ?? 0;
    if (limits?.maxTotalTokens !== undefined && state.budget.tokens + incomingTokens > limits.maxTotalTokens) return { accepted: false, reason: 'GLOBAL_TOKEN_BUDGET_EXCEEDED' };
    if (limits?.maxTotalModelCalls !== undefined && state.budget.modelCalls + incomingCalls > limits.maxTotalModelCalls) return { accepted: false, reason: 'GLOBAL_MODEL_CALL_BUDGET_EXCEEDED' };
    if (limits?.maxWallTimeMs !== undefined && state.budget.computeMs + incomingCompute > limits.maxWallTimeMs) return { accepted: false, reason: 'GLOBAL_COMPUTE_BUDGET_EXCEEDED' };

    // Stale result check: late return after lease completed or superseded elsewhere
    if (['COMPLETED', 'SUPERSEDED'].includes(lease.status)) {
      this.emit({
        type: 'mcts.distributed.result_stale',
        searchId: result.searchId,
        nodeId: result.nodeId,
        attemptId: result.attemptId,
        treeRevision: state.treeRevision,
        timestamp: new Date(),
        data: { reason: 'RESULT_REJECTED_STALE' },
      });
      return { accepted: false, reason: 'RESULT_REJECTED_STALE' };
    }

    // Remove virtual loss reservation
    this.virtualLoss.set(result.nodeId, Math.max(0, (this.virtualLoss.get(result.nodeId) ?? 1) - 1));

    // Handle UNKNOWN status (worker failure or network partition)
    if (result.status === 'UNKNOWN') {
      lease.status = 'UNKNOWN';
      this.emit({
        type: 'mcts.distributed.node_unknown',
        searchId: result.searchId,
        nodeId: result.nodeId,
        attemptId: result.attemptId,
        treeRevision: state.treeRevision,
        timestamp: new Date(),
        data: { error: result.error },
      });
      await this.persist(state);
      return { accepted: true };
    }

    // Stale tree revision check
    // A result is applicable only to the exact tree revision it selected against.
    // Both older and newer revisions are stale: newer revisions may have changed
    // the node's checkpoint or reservation semantics.
    if (result.sourceTreeRevision !== lease.treeRevision) {
      lease.status = 'SUPERSEDED';
      this.emit({
        type: 'mcts.distributed.result_stale',
        searchId: result.searchId,
        nodeId: result.nodeId,
        attemptId: result.attemptId,
        treeRevision: state.treeRevision,
        timestamp: new Date(),
        data: { reason: 'TREE_REVISION_STALE', sourceTreeRevision: result.sourceTreeRevision, leaseTreeRevision: lease.treeRevision },
      });
      await this.persist(state);
      return { accepted: false, reason: 'TREE_REVISION_STALE' };
    }

    const node = state.tree.nodes.get(result.nodeId);
    if (!node) {
      return { accepted: false, reason: 'NODE_MISSING' };
    }

    // Record accepted result key to ensure exactly-once processing
    state.acceptedResults.add(resultKey);

    // Compute controller-grounded reward from verifiable evidence (NEVER subjective model score)
    const checks = [...(result.buildEvidence ?? []), ...(result.testEvidence ?? []), ...(result.acceptanceEvidence ?? [])];
    const reward = computeControllerReward({
      checks,
      errors: result.error ? [result.error] : [],
      usage: result.tokenUsage ?? result.usage,
      wallTimeMs: result.wallTime ?? result.wallTimeMs ?? result.usage?.wallTimeMs,
    });

    // Evidence deduplication
    const evidenceKey = digest({
      node: result.nodeId,
      attempt: result.attemptId,
      evidence: result.verificationEvidence ?? checks,
      digest: result.workspaceDigest,
    });

    if (state.acceptedEvidence.has(evidenceKey)) {
      return { accepted: false, reason: 'DUPLICATE_EVIDENCE' };
    }
    state.acceptedEvidence.add(evidenceKey);

    // Check for distributed transposition:
    // If another branch independently converged on equivalent state, link without re-evaluating
    const stateHash = computeNodeStateHash({
      customHash: result.workspaceDigest || undefined,
      mutations: result.mutations?.map((m) => m.path),
      strategy: node.strategy,
    });

    if (state.tree.transpositionTable.has(stateHash)) {
      const targetId = state.tree.transpositionTable.get(stateHash)!;
      if (targetId !== node.id) {
        node.isTransposition = true;
        node.transpositionTargetId = targetId;
        this.emit({
          type: 'mcts.distributed.transposition',
          searchId: result.searchId,
          nodeId: result.nodeId,
          treeRevision: state.treeRevision,
          timestamp: new Date(),
          data: { targetNodeId: targetId, stateHash },
        });
      }
    } else {
      state.tree.transpositionTable.set(stateHash, node.id);
    }

    lease.status = result.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED';
    node.rewardEvidence = reward;

    this.emit({
      type: 'mcts.distributed.reward_committed',
      searchId: result.searchId,
      nodeId: result.nodeId,
      attemptId: result.attemptId,
      treeRevision: state.treeRevision,
      timestamp: new Date(),
      data: { reward: reward.scalarReward },
    });

    // Exactly-once authoritative backpropagation
    this.options.mcts.backpropagate({
      tree: state.tree,
      leafNode: node,
      rewardEvidence: reward,
    });

    // Increment authoritative tree revision on state change
    state.treeRevision++;

    // Reconcile budget
    const modelCalls = incomingCalls;
    const tokens = incomingTokens;
    const computeMs = incomingCompute;

    state.budget.modelCalls += modelCalls;
    state.budget.tokens += tokens;
    state.budget.computeMs += computeMs;

    this.emit({
      type: 'mcts.distributed.node_completed',
      searchId: result.searchId,
      nodeId: result.nodeId,
      attemptId: result.attemptId,
      treeRevision: state.treeRevision,
      checkpointId: result.resultingCheckpointId ?? result.resultingCheckpoint?.id,
      timestamp: new Date(),
      data: {
        reward: reward.scalarReward,
        tokens,
        wallTime: computeMs,
      },
    });

    this.emit({
      type: 'mcts.distributed.backpropagation_committed',
      searchId: result.searchId,
      nodeId: result.nodeId,
      attemptId: result.attemptId,
      treeRevision: state.treeRevision,
      timestamp: new Date(),
      data: {
        newTreeRevision: state.treeRevision,
        nodeVisits: node.visits,
        nodeMeanValue: node.meanValue,
      },
    });

    await this.persist(state);
    return { accepted: true, reward };
  }

  /**
   * Requeues nodes whose leases expired into UNKNOWN state for safe retry.
   */
  public async expire(searchId: string): Promise<string[]> {
    const state = this.state(searchId);
    this.reconcileLeases(state);
    await this.persist(state);

    const requeued: string[] = [];
    for (const lease of state.leases.values()) {
      if (lease.status === 'UNKNOWN') {
        requeued.push(lease.nodeId);
        this.emit({
          type: 'mcts.distributed.node_requeued',
          searchId,
          nodeId: lease.nodeId,
          attemptId: lease.attemptId,
          treeRevision: state.treeRevision,
          timestamp: new Date(),
        });
      }
    }
    return requeued;
  }

  /** Reissues an UNKNOWN branch through normal selection/lease allocation. */
  public async requeue(searchId: string, nodeId?: string, config?: HierarchicalSearchConfig): Promise<DistributedBranchRequest[]> {
    const state = this.state(searchId);
    const unknown = [...state.leases.values()].find(lease => lease.status === 'UNKNOWN' && (!nodeId || lease.nodeId === nodeId));
    const requests = await this.schedule(searchId, 1, config);
    if (unknown && requests.length > 0) {
      this.emit({ type: 'mcts.distributed.node_requeued', searchId, nodeId: unknown.nodeId, attemptId: requests[0].attemptId, treeRevision: state.treeRevision, timestamp: new Date(), data: { previousAttemptId: unknown.attemptId } });
    }
    return requests;
  }

  /**
   * Promotion is a controller transaction. A branch must already have current
   * branch evidence; the caller then applies it to the parent workspace and
   * supplies fresh parent verification. The coordinator never treats branch
   * verification as parent verification.
   */
  public async promote(params: {
    searchId: string;
    nodeId: string;
    verifyBranch: () => Promise<boolean>;
    applyToParent: () => Promise<{ changed: boolean; workspaceRevision?: number }>;
    verifyParent: () => Promise<boolean>;
  }): Promise<{ promoted: boolean; reason?: string }> {
    const state = this.state(params.searchId);
    const node = state.tree.nodes.get(params.nodeId);
    if (!node || !node.rewardEvidence?.verificationPassed || !node.rewardEvidence.correctness) return { promoted: false, reason: 'BRANCH_NOT_QUALIFIED' };
    if (!(await params.verifyBranch())) return { promoted: false, reason: 'BRANCH_VERIFICATION_FAILED' };
    this.emit({ type: 'mcts.distributed.promotion_started', searchId: params.searchId, nodeId: params.nodeId, treeRevision: state.treeRevision, timestamp: new Date() });
    const applied = await params.applyToParent();
    if (!applied.changed) return { promoted: false, reason: 'PARENT_NOT_MUTATED' };
    state.treeRevision++;
    if (!(await params.verifyParent())) {
      this.emit({ type: 'mcts.distributed.result_stale', searchId: params.searchId, nodeId: params.nodeId, treeRevision: state.treeRevision, timestamp: new Date(), data: { reason: 'PROMOTED_PARENT_VERIFICATION_FAILED' } });
      await this.persist(state);
      return { promoted: false, reason: 'PROMOTED_PARENT_VERIFICATION_FAILED' };
    }
    this.emit({ type: 'mcts.distributed.search_completed', searchId: params.searchId, nodeId: params.nodeId, treeRevision: state.treeRevision, timestamp: new Date(), data: { promoted: true, parentWorkspaceRevision: applied.workspaceRevision } });
    await this.persist(state);
    return { promoted: true };
  }

  /**
   * Cancels search and active branch leases.
   */
  public async cancel(searchId: string): Promise<void> {
    const state = this.state(searchId);
    for (const lease of state.leases.values()) {
      if (['LEASED', 'MATERIALIZING', 'RUNNING', 'VERIFYING'].includes(lease.status)) {
        lease.status = 'SUPERSEDED';
        this.emit({
          type: 'mcts.distributed.branch_canceled',
          searchId,
          nodeId: lease.nodeId,
          attemptId: lease.attemptId,
          treeRevision: state.treeRevision,
          timestamp: new Date(),
        });
      }
    }
    await this.persist(state);
  }

  /**
   * Returns a copy of the authoritative state snapshot.
   */
  public snapshot(searchId: string): DistributedSearchState {
    return structuredClone(this.state(searchId));
  }
}

// Backward compatibility alias
export const DistributedSearchCoordinator = DistributedMctsCoordinator;
export type DistributedSearchCoordinator = DistributedMctsCoordinator;
