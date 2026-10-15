// Explicit live test: uses official installed CLI sessions and may consume provider quota.
// Build first. No credentials or raw vendor output are recorded.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (!process.argv.includes('--live')) {
  console.error('Run with --live to authorize bounded real agent calls.');
  process.exit(2);
}
const workspace = await mkdtemp(path.join(os.tmpdir(), 'wazir-discovery-live-'));
process.env.WAZIR_IN_MEMORY = '1';
process.env.WAZIR_ACP_PERMISSIONS = 'read';
process.env.WAZIR_HOME = path.join(workspace, 'wazir-state');
const { createEngine } = require('../apps/cli/dist/engine.js');
const { checkAgents } = require('../apps/cli/dist/agentPreflight.js');
const report = { platform: process.platform, arch: process.arch, at: new Date().toISOString(), workspace, probes: [], tasks: [] };
try {
  const engine = await createEngine({ projectRoot: workspace, readOnlyLifecycle: true, quiet: true });
  const names = ['codex', 'claude-code', 'antigravity'];
  report.probes = await checkAgents(engine, names, { fresh: true, timeoutMs: 45000 });
  for (const name of names) {
    const adapter = engine.agents.get(name);
    if (!adapter || report.probes.find(p => p.agent === name)?.status !== 'READY') {
      report.tasks.push({ agent: name, result: 'BLOCKED', reason: 'Preflight did not pass.' }); continue;
    }
    const accountId = engine.resources.resolveAgentAccount(name);
    const requestId = `live-validation:${name}`;
    const decision = engine.resources.budget.admit({ requestId, accountId, modelId: `agent:${name}`, agent: name, workload: 'routine', requests: 1, estimatedInputTokens: 4096, estimatedOutputTokens: 32 });
    if (decision.outcome !== 'admitted') { report.tasks.push({ agent: name, result: 'BLOCKED', reason: 'Resource admission denied.' }); continue; }
    const started = Date.now();
    let matched = false;
    let completed = false;
    const stopLease = engine.resources.budget.holdLease(requestId);
    try {
      for await (const turn of adapter.run({ modelId: 'external', taskType: 'chat', taskDescription: 'Compute 17 multiplied by 19. Respond with only the resulting integer. Do not use tools.', projectRoot: workspace, maxWallClockMs: 45000, isCancelled: () => Date.now() - started >= 45000 }, {})) {
        if ((turn.kind === 'message' || turn.kind === 'done') && /(^|\n)\s*323\s*($|\n)/.test(turn.content ?? '')) matched = true;
        completed = turn.kind === 'done';
      }
      const success = matched && completed;
      if (success) engine.resources.budget.reconcile(requestId, { inputTokens: 4096, outputTokens: 32, source: 'estimated' }, { agent: name });
      else engine.resources.budget.fail(requestId, { ambiguous: true });
      report.tasks.push({ agent: name, result: success ? 'PASS' : 'FAIL', durationMs: Date.now() - started, expectedAnswer: '323', answerMatched: matched });
    } catch {
      engine.resources.budget.fail(requestId, { ambiguous: true });
      report.tasks.push({ agent: name, result: 'FAIL', reason: 'Execution error; raw output withheld.' });
    } finally { stopLease(); }
  }
} finally {
  await rm(workspace, { recursive: true, force: true });
}
const destination = path.join(os.tmpdir(), 'wazir-agent-discovery-live.json');
await writeFile(destination, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
process.exit(report.tasks.length === 3 && report.tasks.every(t => t.result === 'PASS') ? 0 : 1);
