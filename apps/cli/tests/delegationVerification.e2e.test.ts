import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AccountRegistry, AgentRegistry, ComputerRegistry, ContextCompiler, DEFAULT_POLICY, ExecutionEngine, ModelRegistry,
  PolicyEngine, ResourceLedger, RuntimeRegistry, Scheduler, TokenBudgetManager,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { ExternalAgentAdapter } from '@wazir/agents';
import type { Worker } from '@wazir/workers';
import { executeTask } from '../src/run.js';
import type { RookEngine } from '../src/engine.js';

/**
 * A delegated agent's exit code is not evidence. These runs go through the real executeTask
 * path with a scripted "vendor CLI" that edits the project and exits 0; Wazir must observe
 * the edits itself, run the project's checks, and refuse attempts to weaken them.
 */
const PKG = { name: 'p', version: '1.0.0', scripts: { test: 'node add.test.js' } };
const TEST_JS = `const assert = require('node:assert');\nconst { add } = require('./src/add.js');\nassert.strictEqual(add(2, 3), 5);\nassert.strictEqual(add(-1, 1), 0);\n`;
const BROKEN = 'exports.add = (a, b) => a - b;\n';
const FIXED = 'exports.add = (a, b) => a + b;\n';

let root: string | undefined;
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); root = undefined; });

async function project(): Promise<string> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-deleg-'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(PKG, null, 2));
  await fs.writeFile(path.join(root, 'add.test.js'), TEST_JS);
  await fs.writeFile(path.join(root, 'src/add.js'), BROKEN);
  return root;
}

/** The "agent" is a shell script run in the project root; `body` is what it does. */
async function engineWithAgent(projectRoot: string, body: string) {
  const command = path.join(projectRoot, '..', `${path.basename(projectRoot)}-agent.sh`);
  await fs.writeFile(command, `#!/usr/bin/env bash\nset -e\n${body}\necho "All done, tests pass."\n`, { mode: 0o755 });
  const agents = new AgentRegistry();
  agents.register(new ExternalAgentAdapter({ name: 'scripted', version: '1', description: '', command, taskTypes: ['coding', 'bugfix', 'general'] as never, capabilities: ['coding'] }), 'external');
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const executions = new ExecutionEngine();
  const ledger = new ResourceLedger(':memory:');
  const accounts = new AccountRegistry([]);
  accounts.addImplicit({ localRuntimes: [], hostedRuntimes: [], agents: ['scripted'], hostedAuthorized: false });
  const budget = new TokenBudgetManager(ledger, accounts, { ...DEFAULT_POLICY });
  const engine = {
    config: { modelContext: {}, modelCapabilities: {}, networkAllowed: false, allowCommands: [], denyCommands: [], allowedMcpServers: [] },
    projectRoot, configDir: path.join(projectRoot, '.wazir'),
    computers, runtimes, models, agents, executions,
    tools: new ToolRegistry(defaultTools),
    policy: new PolicyEngine({ projectRoot, networkAllowed: false }),
    scheduler: new Scheduler({ computers, runtimes, models, agents }),
    compiler: new ContextCompiler(),
    adapters: new Map(), discovered: [],
    worker: { id: 'worker-local', computerId: 'local', adapterForModel: () => undefined } as unknown as Worker,
    resources: { budget, policy: budget.policy, resolveAgentAccount: (a: string) => accounts.candidates({ agent: a })[0]?.id },
  } as unknown as RookEngine;
  return { engine, ledger, cleanup: () => fs.rm(command, { force: true }) };
}

async function run(body: string, task = 'fix the add function in src/add.js') {
  const dir = await project();
  const { engine, ledger, cleanup } = await engineWithAgent(dir, body);
  try {
    const outcome = await executeTask(engine, task, { quiet: true, agent: 'scripted' });
    const record = engine.executions.require(outcome.executionId);
    const preflight = JSON.parse(await fs.readFile(path.join(dir, '.wazir', 'agent-preflight.json'), 'utf8')).results.scripted;
    return { outcome, record, ledger, preflight };
  } finally {
    await cleanup();
  }
}

describe.skipIf(process.platform === 'win32')('delegated work is verified by Wazir, not by the agent', () => {
  it('an agent that exits 0 with a wrong fix fails: Wazir runs the tests itself', async () => {
    const { outcome, record } = await run(`echo "exports.add = (a, b) => a * b;" > src/add.js`);
    expect(outcome.success).toBe(false);
    expect(record.execution.status).toBe('failed');
    expect(record.filesChanged).toEqual(['src/add.js']);
    expect(record.checks).toEqual([expect.objectContaining({ name: 'test', ok: false, command: 'npm run test' })]);
  }, 60_000);

  it('real task outcomes are recorded for preflight: rejected work, verified work, and agent failures differ', async () => {
    const wrong = await run(`echo "exports.add = (a, b) => a * b;" > src/add.js`);
    expect(wrong.preflight.lastTask).toMatchObject({ outcome: 'rejected', executionId: wrong.outcome.executionId });
    expect(wrong.preflight.lastVerifiedTask).toBeUndefined();
    const right = await run(`printf '${FIXED}' > src/add.js`);
    expect(right.preflight.lastTask).toMatchObject({ outcome: 'verified' });
    expect(right.preflight.lastVerifiedTask).toMatchObject({ executionId: right.outcome.executionId });
    const crashed = await run(`echo "model endpoint unreachable" >&2; exit 3`);
    expect(crashed.outcome.success).toBe(false);
    expect(crashed.preflight.lastTask).toMatchObject({ outcome: 'agent_error', detail: expect.stringMatching(/exited with code 3/) });
  }, 60_000);

  it('a correct fix passes on the evidence of a test run at the new revision', async () => {
    const { outcome, record, ledger } = await run(`printf '${FIXED}' > src/add.js`);
    expect(record.checks).toEqual([expect.objectContaining({ name: 'test', ok: true })]);
    expect(outcome.success).toBe(true);
    expect(record.execution.status).toBe('completed');
    expect(record.checks[0].workspaceRevision).toBe(record.workspaceState?.revision);
    // The subscription request was settled once, as an estimate, and holds no lease.
    expect(ledger.usageRows()).toEqual([expect.objectContaining({ source: 'estimated', agent: 'scripted' })]);
    expect(ledger.activeReservations()).toHaveLength(0);
  }, 60_000);

  it('deleting assertions to make the tests pass is refused', async () => {
    const { outcome, record } = await run(`printf "const assert = require('node:assert');\\n" > add.test.js; echo "exports.add = (a, b) => a * b;" > src/add.js`);
    expect(outcome.success).toBe(false);
    expect(record.errors.join('\n')).toMatch(/VERIFICATION_PROTECTED: delegated agent assertions_removed in add\.test\.js/);
  }, 60_000);

  it('rewriting the test script so the check cannot fail is refused', async () => {
    const { outcome, record } = await run(`echo "exports.add = (a, b) => a * b;" > src/add.js; node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.scripts.test='true';fs.writeFileSync('package.json',JSON.stringify(p,null,2));"`);
    expect(outcome.success).toBe(false);
    expect(record.errors.join('\n')).toMatch(/changed the 'test' script/);
    expect(record.checks.filter((c) => c.name === 'test')).toHaveLength(0);
  }, 60_000);
});
