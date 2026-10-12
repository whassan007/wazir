import { describe, expect, it, vi } from 'vitest';
import { DistributedSearchCoordinator } from '../src/services/distributedSearchCoordinator.js';
import type { MCTSSearchTree, SearchNode } from '../src/types/index.js';

const makeTree = (): MCTSSearchTree => {
  const root: SearchNode = { id: 'root', depth: 0, level: 'architecture', checkpointId: 'cp', strategy: 'root', mutations: [], workspaceRevision: 0, stateHash: 'root', visits: 1, value: 0, meanValue: 0, children: [], terminal: false, createdAt: new Date() };
  return { rootId: 'root', nodes: new Map([['root', root]]), transpositionTable: new Map([['root', 'root']]), bestNodeId: 'root', maxDepthReached: 0, totalNodesCreated: 1, paretoFrontierNodeIds: [] };
};
const makeCheckpoint = () => ({ id: 'cp', executionId: 'e', createdAt: new Date(), workspaceRevision: 0, workspaceRoot: '/tmp', worktreeState: { isGit: false, filesSnapshot: { 'src/a.ts': 'a' } }, verificationState: { revision: 0, evidenceIds: [], checksPass: false }, metadata: {} });
function setup() {
  let sequence = 0;
  const mcts = { select: (t: MCTSSearchTree) => t.nodes.get(t.rootId)!, expand: async ({ tree, parentNode }: any) => { const id = `n${++sequence}`; const node = { id, parentId: parentNode.id, depth: 1, level: 'implementation', checkpointId: 'cp', strategy: id, mutations: [], workspaceRevision: 0, stateHash: id, visits: 0, value: 0, meanValue: 0, children: [], terminal: true, createdAt: new Date() } as SearchNode; parentNode.children.push(id); tree.nodes.set(id, node); return [node]; }, backpropagate: ({ leafNode, rewardEvidence }: any) => { leafNode.rewardEvidence = rewardEvidence; leafNode.visits++; } };
  const dispatch = vi.fn(async (request: any) => ({ searchId: request.searchId, nodeId: request.nodeId, sourceTreeRevision: request.treeRevision, attemptId: request.attemptId, leaseId: request.leaseId, workspaceDigest: 'x', status: 'COMPLETED' as const, buildEvidence: [{ name: 'build' as const, command: 'build', ok: true, output: '', durationMs: 1 }], testEvidence: [{ name: 'test' as const, command: 'test', ok: true, output: '', durationMs: 1 }] }));
  return { coordinator: new DistributedSearchCoordinator({ mcts, dispatch, checkpointService: { getCheckpoint: () => makeCheckpoint() }, workers: () => [{ id: 'dgx', capacity: 10 }, { id: 'mac', capacity: 2 }], leaseTtlMs: 10 }), dispatch };
}

describe('DistributedSearchCoordinator', () => {
  it('dispatches independent branches concurrently and commits controller rewards', async () => {
    const { coordinator, dispatch } = setup(); await coordinator.initialize({ searchId: 's', tree: makeTree(), objective: 'repair' });
    const results = await coordinator.dispatch('s', 2); await Promise.all(results.map(async result => { if (result.status === 'fulfilled') await coordinator.acceptResult(result.value); }));
    expect(dispatch).toHaveBeenCalledTimes(2); expect(coordinator.get('s').treeRevision).toBe(2); expect([...coordinator.get('s').leases.values()].every(lease => lease.status === 'COMPLETED')).toBe(true);
  });
  it('rejects duplicate and stale results without duplicate backpropagation', async () => {
    const { coordinator } = setup(); await coordinator.initialize({ searchId: 's', tree: makeTree(), objective: 'repair' }); const request = (await coordinator.schedule('s'))[0];
    const result = { searchId: 's', nodeId: request.nodeId, sourceTreeRevision: request.treeRevision, attemptId: request.attemptId, leaseId: request.leaseId, workspaceDigest: 'x', status: 'COMPLETED' as const, buildEvidence: [{ name: 'build' as const, command: 'build', ok: true, output: '', durationMs: 1 }] };
    expect((await coordinator.acceptResult(result)).accepted).toBe(true); expect((await coordinator.acceptResult(result)).accepted).toBe(false);
    const next = (await coordinator.schedule('s'))[0]; await coordinator.acceptResult({ ...result, nodeId: next.nodeId, attemptId: next.attemptId, leaseId: next.leaseId, sourceTreeRevision: 99 }); expect(coordinator.get('s').treeRevision).toBe(1);
  });
  it('expires leases as unknown while preserving authoritative tree state', async () => {
    const { coordinator } = setup(); await coordinator.initialize({ searchId: 's', tree: makeTree(), objective: 'repair' }); const request = (await coordinator.schedule('s'))[0]; coordinator.get('s').leases.get(request.leaseId)!.expiresAt = 0;
    expect(await coordinator.expire('s')).toContain(request.nodeId); expect(coordinator.get('s').tree.nodes.has('root')).toBe(true); expect(coordinator.heartbeat('s', request.leaseId)).toBe(false);
  });
});
