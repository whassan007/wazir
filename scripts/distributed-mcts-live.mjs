#!/usr/bin/env node
/* Real-model distributed session. The coordinator is in-process; each branch is a
 * separate child process with its own WAZIR_HOME and physical workspace. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFixture } from './live-session-harness/fixtures.mjs';
import { DistributedMctsCoordinator } from '../packages/core/dist/src/services/distributedSearchCoordinator.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
const model = value('model') ?? 'gemma-4-26b-a4b-it-qat';
const objective = value('objective') ?? 'Inspect this repository for a real functional defect. Explore a materially different approach, implement the strongest repair, add a meaningful regression test, and verify the final revision.';
const timeoutMs = Number(value('timeout-ms') ?? 300_000);
const workerNames = (value('workers') ?? 'DGX-01,MAC-01,PC-01').split(',').map(s => s.trim()).filter(Boolean);
const runRoot = await fs.mkdtemp(path.join('/tmp', 'wazir-distributed-live-'));
const sourceRoot = path.join(runRoot, 'source');
await fs.mkdir(sourceRoot);
await createFixture(sourceRoot, 'average');
const sourceSnapshot = {};
async function capture(dir, relative = '') {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'out', '.wazir'].includes(entry.name)) continue;
    const rel = path.join(relative, entry.name).split(path.sep).join('/');
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) await capture(abs, rel); else sourceSnapshot[rel] = await fs.readFile(abs, 'utf8');
  }
}
await capture(sourceRoot);
const checkpoint = { id: 'live-c0', executionId: 'live-parent', createdAt: new Date(), workspaceRevision: 0, workspaceRoot: sourceRoot, worktreeState: { isGit: false, filesSnapshot: sourceSnapshot }, verificationState: { revision: 0, evidenceIds: [], checksPass: false } };

function tree() {
  const root = { id: 'C0', depth: 0, level: 'architecture', checkpointId: checkpoint.id, strategy: 'baseline', mutations: [], workspaceRevision: 0, stateHash: 'C0', visits: 1, value: 0, meanValue: 0, children: [], terminal: false, createdAt: new Date() };
  return { rootId: root.id, nodes: new Map([[root.id, root]]), transpositionTable: new Map([['C0', 'C0']]), bestNodeId: root.id, maxDepthReached: 0, totalNodesCreated: 1, paretoFrontierNodeIds: [] };
}
let serial = 0;
const mcts = {
  select: t => [...t.nodes.values()].filter(n => !n.terminal).sort((a, b) => b.depth - a.depth)[0] ?? t.nodes.get(t.rootId),
  expand: async ({ tree: t, parentNode }) => { const id = `${parentNode.id}-${++serial}`; const child = { id, parentId: parentNode.id, depth: parentNode.depth + 1, level: parentNode.depth === 0 ? 'design' : 'implementation', checkpointId: checkpoint.id, strategy: `independent branch ${id}`, mutations: [], workspaceRevision: 0, stateHash: id, visits: 0, value: 0, meanValue: 0, children: [], terminal: true, createdAt: new Date() }; parentNode.children.push(id); t.nodes.set(id, child); t.maxDepthReached = Math.max(t.maxDepthReached, child.depth); return [child]; },
  backpropagate: ({ leafNode, rewardEvidence }) => { leafNode.rewardEvidence = rewardEvidence; leafNode.visits++; leafNode.value += rewardEvidence.scalarReward; leafNode.meanValue = leafNode.value / leafNode.visits; },
};

function runWorker(request, workerId) {
  return new Promise(async resolve => {
    const workspace = path.join(runRoot, workerId);
    const home = path.join(runRoot, `${workerId}-home`);
    await fs.mkdir(workspace); await fs.mkdir(home);
    for (const [relative, content] of Object.entries(sourceSnapshot)) { const target = path.join(workspace, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content); }
    const child = spawn(process.execPath, [path.join(repo, 'bin/wa.js'), 'task', 'run', `${objective}\nBranch strategy: ${request.strategy}`, '--type', 'coding', '--model', model, '--max-turns', '40', '--json'], { cwd: workspace, env: { ...process.env, WAZIR_HOME: home, WAZIR_SECRETS_BACKEND: 'encrypted-file' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => { output += chunk.toString(); }); child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.on('close', async code => {
      clearTimeout(timer); let store = {}; try { store = JSON.parse(await fs.readFile(path.join(home, 'wazir.json'), 'utf8')); } catch {}
      const record = Object.values(store).find(v => v?.execution?.workspaceRoot === workspace) ?? {};
      const checks = record.checks ?? []; resolve({ searchId: request.searchId, nodeId: request.nodeId, sourceTreeRevision: request.treeRevision, attemptId: request.attemptId, leaseId: request.leaseId, workerId, workspaceDigest: JSON.stringify(Object.keys(record.filesChanged ?? {}).sort()), status: code === 0 ? 'COMPLETED' : 'FAILED', buildEvidence: checks.filter(c => c.name === 'build'), testEvidence: checks.filter(c => c.name === 'test'), verificationEvidence: record.evidence ?? [], usage: { ...(record.usage ?? {}), modelCalls: record.events?.filter(e => e.type === 'generation.started').length ?? 0, wallTimeMs: 0 }, artifacts: [{ path: workspace, kind: 'worker-workspace' }], error: code === 0 ? undefined : output.slice(-4000) });
    });
  });
}

const events = []; const coordinator = new DistributedMctsCoordinator({ mcts, checkpointService: { getCheckpoint: id => id === checkpoint.id ? checkpoint : undefined }, workers: () => workerNames.map((id, i) => ({ id, capacity: workerNames.length - i })), dispatch: (request, workerId) => runWorker(request, workerId), onEvent: event => events.push(event) });
await coordinator.initialize({ searchId: 'live-distributed-mcts', tree: tree(), objective });
const results = await coordinator.dispatch('live-distributed-mcts', workerNames.length);
const accepted = []; for (const result of results) if (result.status === 'fulfilled') accepted.push(await coordinator.acceptResult(result.value));
const state = coordinator.get('live-distributed-mcts');
const report = { searchId: state.searchId, model, objective, runRoot, workers: workerNames, treeRevision: state.treeRevision, depth: state.tree.maxDepthReached, leases: [...state.leases.values()], accepted, eventTypes: events.map(e => e.type), budget: state.budget, note: 'Real model processes and isolated physical workspaces; reward computed by controller from durable checks.' };
await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
