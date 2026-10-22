import { expect, it } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fixture, policy } from './harness.js';
import { buildTestEngine } from './legacyEngine.js';
import { AccountRegistry, WorktreeManager } from '../../packages/core/src/index.js';
import { runCompetitiveTask } from '../../apps/cli/src/competitive.js';
import { sandboxStatus } from '../../packages/tools/src/sandbox.js';

it.runIf(sandboxStatus().mode !== 'none')('CLI race entry runs two isolated native CodingAgents through scheduled fake runtimes and production verification', async () => {
  const f = await fixture();
  try {
    const engine = await buildTestEngine(f.root);
    engine.store = f.store; engine.worktrees = new WorktreeManager();
    engine.resources = { resolveAccount: () => undefined, accounts: new AccountRegistry() } as any;
    const model = engine.models.get('fake-model')!;
    engine.models.register({ ...model, id: 'fake-model-b', name: 'fake-model-b' });
    const instance = engine.models.instancesOf('fake-model')[0];
    engine.models.upsertInstance({ ...instance, id: 'fake-model-b::local::fake', modelId: 'fake-model-b', runtimeModelId: 'fake-model-b' });
    engine.adapters.get('fake')!.listModels = async () => [{ id: 'fake-model', name: 'fake-model' }, { id: 'fake-model-b', name: 'fake-model-b' }];
    const calls = new Map<string, number>();
    engine.adapters.get('fake')!.generate = async function* (request) {
      const n = calls.get(request.modelId) ?? 0; calls.set(request.modelId, n + 1);
      const replies = [
        JSON.stringify({ action: 'plan', content: 'fix add with the supplied source tools' }),
        JSON.stringify({ action: 'tool', tool: 'write', input: { path: 'src/add.cjs', content: 'exports.add=(a,b)=>a+b;\n' } }),
        JSON.stringify({ action: 'done', summary: 'implemented add' }),
      ];
      const reply = replies[Math.min(n, replies.length - 1)];
      yield { type: 'token', content: reply }; yield { type: 'completed', content: reply };
    };
    const policyFile = path.join(f.root, '.wazir', 'trusted.json');
    await fs.writeFile(policyFile, JSON.stringify({ ...policy, maxTurns: 8, maxTokens: 8192 }));
    const result = await runCompetitiveTask(engine, 'Fix addition in src/add.cjs', { race: '2', agent: 'wazir-coding', racePolicy: policyFile });
    expect(result.attempts.map(a => ({ state: a.state, failure: a.failure, checks: a.checks }))).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'VERIFIED' }), expect.objectContaining({ state: 'VERIFIED' })]));
    expect(result.state, JSON.stringify(result.events)).toBe('AWAITING_MERGE'); expect(calls.size).toBe(2);
    const executions = await engine.executions.list();
    expect(executions).toHaveLength(2);
    expect(executions.every(r => r.execution.status === 'completed' && r.execution.workspaceRoot !== f.root)).toBe(true);
    expect(executions.every(r => r.events.some(e => (e.eventType ?? e.type) === 'race.verification.completed'))).toBe(true);
  } finally { await f.dispose(); }
});
