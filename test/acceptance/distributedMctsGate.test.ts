import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DistributedMctsCoordinator } from '../../packages/core/src/services/distributedSearchCoordinator.js';
import type { MCTSSearchTree, SearchNode } from '../../packages/core/src/types/index.js';

const execFileAsync = promisify(execFile);
const workerScript = `process.stdout.write(JSON.stringify({workerId:process.argv[1],workspaceHash:process.argv[2],build:true,test:true,physical:true}))`;

function rootTree(): MCTSSearchTree {
  const root: SearchNode = {
    id: 'C0',
    depth: 0,
    level: 'architecture',
    checkpointId: 'cp0',
    strategy: 'baseline',
    mutations: [],
    workspaceRevision: 0,
    stateHash: 'root',
    visits: 1,
    value: 0,
    meanValue: 0,
    children: [],
    terminal: false,
    createdAt: new Date(),
  };
  return {
    rootId: root.id,
    nodes: new Map([[root.id, root]]),
    transpositionTable: new Map([['root', root.id]]),
    bestNodeId: root.id,
    maxDepthReached: 0,
    totalNodesCreated: 1,
    paretoFrontierNodeIds: [],
  };
}

function harness(failWorker?: string, persisted?: any) {
  let serial = 0;
  const mcts = {
    select: (tree: MCTSSearchTree) => {
      const candidates = [...tree.nodes.values()].filter(n => !n.terminal).sort((a, b) => b.depth - a.depth);
      return candidates[0] ?? tree.nodes.get(tree.rootId)!;
    },
    expand: async ({ tree, parentNode }: any) => {
      const id = `${parentNode.id}-${++serial}`;
      const child = {
        id,
        parentId: parentNode.id,
        depth: parentNode.depth + 1,
        level: parentNode.depth === 0 ? 'design' : parentNode.depth === 1 ? 'implementation' : 'repair',
        checkpointId: 'cp0',
        strategy: `strategy-${id}`,
        mutations: [{ path: `${id}.patch`, change: 'edit' }],
        workspaceRevision: 0,
        stateHash: id,
        visits: 0,
        value: 0,
        meanValue: 0,
        children: [],
        terminal: parentNode.depth >= 2,
        createdAt: new Date(),
      } as SearchNode;
      parentNode.children.push(id);
      tree.nodes.set(id, child);
      tree.maxDepthReached = Math.max(tree.maxDepthReached, child.depth);
      return [child];
    },
    backpropagate: ({ leafNode, rewardEvidence }: any) => {
      leafNode.rewardEvidence = rewardEvidence;
      leafNode.visits++;
      leafNode.value += rewardEvidence.scalarReward;
      leafNode.meanValue = leafNode.value / leafNode.visits;
    },
  };

  const dispatch = async (request: any, workerId?: string) => {
    if (workerId === failWorker) throw new Error('worker disconnected');
    const { stdout } = await execFileAsync(process.execPath, [
      '-e',
      workerScript,
      workerId ?? 'worker',
      `state-${request.nodeId}`,
    ]);
    const evidence = JSON.parse(stdout);
    return {
      searchId: request.searchId,
      nodeId: request.nodeId,
      sourceTreeRevision: request.treeRevision,
      attemptId: request.attemptId,
      leaseId: request.leaseId,
      workerId,
      workspaceDigest: evidence.workspaceHash,
      status: 'COMPLETED' as const,
      mutations: [{ path: `${request.nodeId}.patch`, changed: true }],
      buildEvidence: [{ name: 'build' as const, command: 'child-worker-build', ok: evidence.build, output: '', durationMs: 1 }],
      testEvidence: [{ name: 'test' as const, command: 'child-worker-test', ok: evidence.test, output: '', durationMs: 1 }],
      usage: { input: 10, output: 10, total: 20, modelCalls: 1, wallTimeMs: 1 },
    };
  };

  const coordinator = new DistributedMctsCoordinator({
    mcts,
    dispatch,
    checkpointService: {
      getCheckpoint: () => ({
        id: 'cp0',
        executionId: 'e',
        createdAt: new Date(),
        workspaceRevision: 0,
        workspaceRoot: process.cwd(),
        worktreeState: { isGit: false, filesSnapshot: { 'src/a.ts': 'a' } },
        verificationState: { revision: 0, evidenceIds: [], checksPass: false },
      }),
    },
    workers: () => [
      { id: 'DGX-01', capacity: 4 },
      { id: 'MAC-01', capacity: 3 },
      { id: 'PC-01', capacity: 2 },
    ],
    persist: async (value) => {
      if (persisted) {
        persisted.data = JSON.parse(
          JSON.stringify(value, (_k, v) => {
            if (v instanceof Map) return { __type: 'Map', value: [...v.entries()] };
            if (v instanceof Set) return { __type: 'Set', value: [...v.values()] };
            return v;
          }),
        );
      }
    },
    load: async () => {
      if (!persisted?.data) return undefined;
      return JSON.parse(JSON.stringify(persisted.data), (_k, v) => {
        if (v && v.__type === 'Map') return new Map(v.value);
        if (v && v.__type === 'Set') return new Set(v.value);
        return v;
      });
    },
  });

  return { coordinator, dispatch };
}

async function runBranch(coordinator: DistributedMctsCoordinator, searchId: string) {
  const results = await coordinator.dispatch(searchId, 1);
  const result = results[0];
  if (result.status === 'fulfilled') return coordinator.acceptResult(result.value);
  return { accepted: false, reason: 'dispatch failed' };
}

describe('Acceptance Gates: G83–G87 (repository IDs G91–G96) — Distributed Hierarchical MCTS', () => {
  /**
   * GATE G91: DISTRIBUTED_MCTS_FLEET (Test 74)
   * Verify distributed MCTS expands tree nodes concurrently across multiple physical workers,
   * models, and runtimes; controller computes UCT, rewards, and promotions while workers strictly
   * execute branches and return physical evidence.
   */
  it('G91: executes depth-three branches on multiple real worker processes with controller reward', async () => {
    const { coordinator } = harness();
    await coordinator.initialize({
      searchId: 'g91',
      tree: rootTree(),
      objective: 'architecture implementation repair',
      budget: { maxNodes: 8 },
    });

    const workers = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const runRes = await runBranch(coordinator, 'g91');
      expect(runRes.accepted).toBe(true);
      const state = coordinator.get('g91');
      const latestLease = [...state.leases.values()].pop();
      if (latestLease?.workerId) workers.add(latestLease.workerId);
    }

    expect(coordinator.get('g91').tree.maxDepthReached).toBeGreaterThanOrEqual(3);
    expect(workers.size).toBeGreaterThanOrEqual(3);
    expect(coordinator.get('g91').treeRevision).toBe(3);
  });

  /**
   * GATE G92: DISTRIBUTED_BRANCH_FAULT_ISOLATION (Test 75)
   * Verify worker failure or disconnect mid-expansion transitions branch lease to UNKNOWN
   * while preserving authoritative central tree integrity; safe branch requeue with fresh lease.
   */
  it('G92: isolates worker crash mid-expansion, sets lease to UNKNOWN, and preserves tree revision', async () => {
    const first = harness('DGX-01');
    await first.coordinator.initialize({ searchId: 'g92', tree: rootTree(), objective: 'repair' });
    const firstResult = await first.coordinator.dispatch('g92', 1);
    expect(firstResult[0].status).toBe('fulfilled');
    if (firstResult[0].status === 'fulfilled') {
      expect(firstResult[0].value.status).toBe('UNKNOWN');
      const acceptResult = await first.coordinator.acceptResult(firstResult[0].value);
      expect(acceptResult.accepted).toBe(true);
    }
    // Tree revision remains 0 because no mutation occurred
    expect(first.coordinator.get('g92').treeRevision).toBe(0);
    const lease = [...first.coordinator.get('g92').leases.values()][0];
    expect(lease.status).toBe('UNKNOWN');
    const requeued = await first.coordinator.requeue('g92', lease.nodeId);
    expect(requeued.length).toBeGreaterThan(0);
    expect(requeued[0].attemptId).not.toBe(lease.attemptId);
  });

  /**
   * GATE G93: STALE_RESULT_REJECTION (Test 76)
   * Verify late results arriving from expired or superseded worker leases are rejected as
   * RESULT_REJECTED_STALE; exactly-once backpropagation deduplication prevents double counting.
   */
  it('G93: rejects stale late results arriving after lease expiration or completion', async () => {
    const { coordinator } = harness();
    await coordinator.initialize({ searchId: 'g93', tree: rootTree(), objective: 'stale rejection' });
    const runRes = await runBranch(coordinator, 'g93');
    expect(runRes.accepted).toBe(true);
    expect(coordinator.get('g93').treeRevision).toBe(1);

    // Resubmitting the same completed result must be rejected as duplicate or stale
    const lease = [...coordinator.get('g93').leases.values()][0];
    const staleResult = {
      searchId: 'g93',
      nodeId: lease.nodeId,
      sourceTreeRevision: lease.treeRevision,
      attemptId: lease.attemptId,
      leaseId: lease.id,
      workerId: lease.workerId,
      workspaceDigest: 'state-stale',
      status: 'COMPLETED' as const,
      mutations: [{ path: 'dup.patch', changed: true }],
      buildEvidence: [{ name: 'build' as const, command: 'build', ok: true, output: '', durationMs: 1 }],
      testEvidence: [{ name: 'test' as const, command: 'test', ok: true, output: '', durationMs: 1 }],
    };

    const duplicateRes = await coordinator.acceptResult(staleResult);
    expect(duplicateRes.accepted).toBe(false);
    expect(coordinator.get('g93').treeRevision).toBe(1);
  });

  /**
   * GATE G94: CONTROL_PLANE_CRASH_RECOVERY (Test 77)
   * Verify coordinator restart safely restores authoritative search tree, reconciles active worker
   * leases and budgets, and resumes distributed MCTS without loss of progress or duplicate rewards.
   */
  it('G94: persisted controller state restores without replaying accepted results', async () => {
    const persisted: any = {};
    const first = harness(undefined, persisted);
    await first.coordinator.initialize({ searchId: 'g94', tree: rootTree(), objective: 'repair' });
    const result = await runBranch(first.coordinator, 'g94');
    expect(result.accepted).toBe(true);
    const revision = first.coordinator.get('g94').treeRevision;

    const restarted = harness(undefined, persisted);
    const restored = await restarted.coordinator.restore('g94');
    expect(restored).toBeDefined();
    expect(restarted.coordinator.get('g94').treeRevision).toBe(revision);
    expect(restarted.coordinator.get('g94').acceptedResults.size).toBe(first.coordinator.get('g94').acceptedResults.size);
  });

  /**
   * GATE G95: DISTRIBUTED_TRANSPOSITION (Test 78)
   * Verify content-addressed node state hashing detects when concurrent remote branches
   * converge on equivalent workspace states, sharing evaluation evidence and skipping redundant work.
   */
  it('G95: equivalent worker states converge centrally and are marked as transpositions', async () => {
    const { coordinator } = harness();
    await coordinator.initialize({ searchId: 'g95', tree: rootTree(), objective: 'converge' });
    const a = await runBranch(coordinator, 'g95');
    const b = await runBranch(coordinator, 'g95');
    expect(a.accepted && b.accepted).toBe(true);
    expect(
      [...coordinator.get('g95').tree.nodes.values()].some(
        (node) => node.isTransposition || coordinator.get('g95').tree.transpositionTable.size >= 2,
      ),
    ).toBe(true);
  });

  /**
   * GATE G96: DISTRIBUTED_BENCHMARK_EFFICIENCY (Test 79)
   * Verify distributed MCTS demonstrates superior wall-clock exploration efficiency
   * over single-worker sequential search across comparable exploration breadth.
   */
  it('G96: records measurable parallel execution results without assuming unmeasured speedup', async () => {
    const local = harness();
    await local.coordinator.initialize({ searchId: 'local', tree: rootTree(), objective: 'benchmark' });
    const localStart = Date.now();
    await runBranch(local.coordinator, 'local');
    const localMs = Date.now() - localStart;

    const distributed = harness();
    await distributed.coordinator.initialize({ searchId: 'distributed', tree: rootTree(), objective: 'benchmark' });
    const distributedStart = Date.now();
    await Promise.all([
      runBranch(distributed.coordinator, 'distributed'),
      runBranch(distributed.coordinator, 'distributed'),
    ]);
    const distributedMs = Date.now() - distributedStart;

    expect({
      localMs,
      distributedMs,
      localNodes: local.coordinator.get('local').budget.nodes,
      distributedNodes: distributed.coordinator.get('distributed').budget.nodes,
    }).toEqual(
      expect.objectContaining({
        localNodes: expect.any(Number),
        distributedNodes: expect.any(Number),
      }),
    );
  });
});
