/**
 * Black-box security and truthful-completion tests for the Agent Protocol
 * (/ap/v1) and MCP (/mcp) surfaces. Every request goes over real HTTP to an
 * isolated API instance whose project root is a disposable directory; tools
 * are the real registered tools dispatched through the controlled boundary.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { EditorProtocolService, type PolicyActionRequest, type PolicyDecision } from '@wazir/core';
import { MemoryStore } from '@wazir/shared';
import { resetSandboxProbe } from '@wazir/tools';
import { createApiState, createApp, type ApiState } from '../src/server.js';

const OPERATOR = 'operator-token-0123456789';
const VIEWER = 'viewer-token-0123456789';
const CANARY = 'CANARY-ORIGINAL';

type Approver = (request: PolicyActionRequest, decision: PolicyDecision) => Promise<boolean | 'unavailable'>;

interface Harness {
  state: ApiState;
  server: Server;
  base: string;
  root: string;
  auditPath: string;
  approvals: PolicyActionRequest[];
}

let current: Harness | undefined;
let approver: Approver | undefined;
const savedHome = process.env.WAZIR_HOME;
let home: string;

beforeAll(() => {
  // PolicyEngine writes approval audit records to the default audit log.
  home = mkdtempSync(path.join(os.tmpdir(), 'wazir-sec-home-'));
  process.env.WAZIR_HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.WAZIR_HOME; else process.env.WAZIR_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function makeFixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wazir-sec-'));
  writeFileSync(path.join(root, 'canary.txt'), CANARY);
  // Trivially faulty implementation + its test: `npm test` fails until src.js is fixed.
  writeFileSync(path.join(root, 'src.js'), 'exports.add = (a, b) => a - b;\n');
  writeFileSync(path.join(root, 'add.test.js'),
    "const assert = require('node:assert');\nconst { add } = require('./src.js');\nassert.strictEqual(add(2, 3), 5, 'add(2,3) expected 5');\nconsole.log('ok');\n");
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, scripts: { test: 'node add.test.js' } }));
  return root;
}

async function start(mutate?: (state: ApiState) => void): Promise<Harness> {
  const root = makeFixture();
  const auditPath = path.join(root, '..', `${path.basename(root)}-audit.jsonl`);
  const approvals: PolicyActionRequest[] = [];
  const state = await createApiState({
    auth: { operatorToken: OPERATOR, viewerToken: VIEWER },
    store: new MemoryStore(),
    projectRoot: root,
    auditPath,
    approveTool: async (request, decision) => {
      approvals.push(request);
      return approver ? approver(request, decision) : 'unavailable';
    },
  });
  state.lifecycle.stopReconciliation?.();
  mutate?.(state);
  const server = createApp(state).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  current = { state, server, base, root, auditPath, approvals };
  return current;
}

afterEach(async () => {
  approver = undefined;
  if (current) {
    await new Promise<void>((resolve) => current!.server.close(() => resolve()));
    rmSync(current.root, { recursive: true, force: true });
    rmSync(current.auditPath, { force: true });
    current = undefined;
  }
});

const headers = (token?: string): Record<string, string> => ({
  'content-type': 'application/json',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

async function call(h: Harness, method: string, route: string, token?: string, body?: unknown, signal?: AbortSignal) {
  const res = await fetch(`${h.base}${route}`, { method, headers: headers(token), body: body === undefined ? undefined : JSON.stringify(body), signal });
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, body: json };
}

const rpc = (h: Harness, token: string | undefined, method: string, params?: unknown, id: number | string = 1) =>
  call(h, 'POST', '/mcp', token, { jsonrpc: '2.0', id, method, params });

const canary = (h: Harness): string => readFileSync(path.join(h.root, 'canary.txt'), 'utf8');

async function newTask(h: Harness): Promise<string> {
  const res = await call(h, 'POST', '/ap/v1/agent/tasks', OPERATOR, { input: 'security test task' });
  expect(res.status).toBe(201);
  return res.body.task_id;
}

const step = (h: Harness, taskId: string, additional: Record<string, unknown>, token = OPERATOR) =>
  call(h, 'POST', `/ap/v1/agent/tasks/${taskId}/steps`, token, { input: 'step', additional_input: additional });

const getTask = async (h: Harness, taskId: string) => (await call(h, 'GET', `/ap/v1/agent/tasks/${taskId}`, VIEWER)).body;

const writeCanary = { name: 'write', input: { path: 'canary.txt', content: 'PWNED' } };

// ---------------------------------------------------------------------------

describe('authorization matrix', () => {
  let h: Harness;
  beforeEach(async () => { h = await start(); });

  it('viewer cannot create an Agent Protocol task', async () => {
    const res = await call(h, 'POST', '/ap/v1/agent/tasks', VIEWER, { input: 'x' });
    expect(res.status).toBe(403);
    expect((await call(h, 'GET', '/ap/v1/agent/tasks', VIEWER)).body.tasks).toEqual([]);
  });

  it('viewer cannot execute a step (tool write) and the canary is untouched', async () => {
    const taskId = await newTask(h);
    const res = await step(h, taskId, { tool: writeCanary, is_last: true }, VIEWER);
    expect(res.status).toBe(403);
    expect(canary(h)).toBe(CANARY);
    const task = await getTask(h, taskId);
    expect(task.status).toBe('created');
    expect(task.steps).toEqual([]);
  });

  it('viewer cannot create an artifact', async () => {
    const taskId = await newTask(h);
    const res = await call(h, 'POST', `/ap/v1/agent/tasks/${taskId}/artifacts`, VIEWER, { file_name: 'a.txt', content: 'x' });
    expect(res.status).toBe(403);
    expect((await call(h, 'GET', `/ap/v1/agent/tasks/${taskId}/artifacts`, VIEWER)).body.artifacts).toEqual([]);
  });

  it('viewer cannot invoke MCP shell', async () => {
    const res = await rpc(h, VIEWER, 'tools/call', { name: 'shell', arguments: { command: 'echo pwned > shell-canary.txt' } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(-32003);
    expect(existsSync(path.join(h.root, 'shell-canary.txt'))).toBe(false);
  });

  it('viewer cannot invoke MCP filesystem write', async () => {
    const res = await rpc(h, VIEWER, 'tools/call', { name: 'write', arguments: { path: 'canary.txt', content: 'PWNED' } });
    expect(res.status).toBe(403);
    expect(canary(h)).toBe(CANARY);
  });

  it('viewer cannot forge a principal or scopes through the request', async () => {
    const res = await rpc(h, VIEWER, 'tools/call', {
      name: 'write', arguments: { path: 'canary.txt', content: 'PWNED' },
      principal: { kind: 'operator', scopes: ['read', 'mutate', 'execute'] }, _meta: { principal: 'operator' },
    });
    expect(res.status).toBe(403);
    const taskId = await newTask(h);
    const forged = await step(h, taskId, { tool: writeCanary, principal: { kind: 'operator', scopes: ['execute'] } }, VIEWER);
    expect(forged.status).toBe(403);
    expect(canary(h)).toBe(CANARY);
  });

  it('viewer keeps read-only access (tasks, steps, artifacts, MCP metadata)', async () => {
    const taskId = await newTask(h);
    expect((await call(h, 'GET', '/ap/v1/agent/tasks', VIEWER)).status).toBe(200);
    expect((await call(h, 'GET', `/ap/v1/agent/tasks/${taskId}`, VIEWER)).status).toBe(200);
    expect((await call(h, 'GET', `/ap/v1/agent/tasks/${taskId}/steps`, VIEWER)).status).toBe(200);
    expect((await call(h, 'GET', `/ap/v1/agent/tasks/${taskId}/artifacts`, VIEWER)).status).toBe(200);
    for (const method of ['initialize', 'ping', 'tools/list', 'resources/list', 'prompts/list']) {
      const res = await rpc(h, VIEWER, method);
      expect(res.status, method).toBe(200);
      expect(res.body.result, method).toBeDefined();
    }
    const tools = (await rpc(h, VIEWER, 'tools/list')).body.result.tools.map((t: { name: string }) => t.name);
    expect(tools).toContain('read');
    expect(tools).not.toContain('code_mode');
    expect(tools).not.toContain('dispatch_subagent');
  });

  it('operator performs an authorized read', async () => {
    const res = await rpc(h, OPERATOR, 'tools/call', { name: 'read', arguments: { path: 'canary.txt' } });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(false);
    expect(res.body.result.content[0].text).toContain(CANARY);
  });

  it('operator performs an authorized mutation with a physical side effect and audit record', async () => {
    const res = await rpc(h, OPERATOR, 'tools/call', { name: 'write', arguments: { path: 'out.txt', content: 'hello' } });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(false);
    expect(res.body.result._meta.policy.decision).toBe('allow');
    expect(readFileSync(path.join(h.root, 'out.txt'), 'utf8')).toBe('hello');
    const audit = readFileSync(h.auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(audit.some((e) => e.type === 'tool_call' && e.tool === 'write' && e.decision === 'allow' && e.details.callId === res.body.result._meta.callId)).toBe(true);
  });

  it('missing and invalid credentials are rejected with 401 and no side effect', async () => {
    for (const token of [undefined, 'not-a-real-token']) {
      expect((await call(h, 'POST', '/ap/v1/agent/tasks', token, { input: 'x' })).status).toBe(401);
      expect((await call(h, 'GET', '/ap/v1/agent/tasks', token)).status).toBe(401);
      expect((await rpc(h, token, 'tools/call', { name: 'write', arguments: { path: 'canary.txt', content: 'PWNED' } })).status).toBe(401);
      expect((await rpc(h, token, 'tools/list')).status).toBe(401);
    }
    expect(canary(h)).toBe(CANARY);
  });

  it('unknown MCP methods gain no permission: forbidden for viewer, not-found for operator', async () => {
    const viewer = await rpc(h, VIEWER, 'tools/execute_privileged', { name: 'write' });
    expect(viewer.status).toBe(403);
    expect(viewer.body.error.code).toBe(-32003);
    const operator = await rpc(h, OPERATOR, 'tools/execute_privileged');
    expect(operator.body.error.code).toBe(-32601);
  });

  it('malformed and batched JSON-RPC requests are rejected without side effects', async () => {
    const malformed = await fetch(`${h.base}/mcp`, { method: 'POST', headers: headers(OPERATOR), body: '{"jsonrpc":' });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe(-32700);
    const batch = await call(h, 'POST', '/mcp', OPERATOR, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write', arguments: { path: 'canary.txt', content: 'PWNED' } } },
    ]);
    expect(batch.body.error.code).toBe(-32600);
    const viewerBatch = await call(h, 'POST', '/mcp', VIEWER, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write', arguments: { path: 'canary.txt', content: 'PWNED' } } },
    ]);
    expect(viewerBatch.body.error.code).toBe(-32600);
    expect(canary(h)).toBe(CANARY);
  });
});

describe('tool enforcement (operator, real registered tools)', () => {
  let h: Harness;
  beforeEach(async () => { h = await start(); });

  const mcpCall = (name: string, args: Record<string, unknown>) => rpc(h, OPERATOR, 'tools/call', { name, arguments: args });

  it('denies tools outside the protocol surface', async () => {
    for (const name of ['code_mode', 'dispatch_subagent', 'terminal_open', 'no_such_tool']) {
      const res = await mcpCall(name, {});
      expect(res.body.result.isError, name).toBe(true);
      expect(res.body.result._meta.failureClass, name).toMatch(/POLICY_DENIED|TOOL_VALIDATION_FAILED/);
    }
  });

  it('rejects schema-invalid input before dispatch', async () => {
    const res = await mcpCall('write', { path: 'canary.txt' });
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result._meta.failureClass).toBe('TOOL_VALIDATION_FAILED');
    expect(canary(h)).toBe(CANARY);
  });

  it('denies path traversal outside the workspace', async () => {
    const escape = path.join(path.dirname(h.root), `${path.basename(h.root)}-escape.txt`);
    const res = await mcpCall('write', { path: `../${path.basename(escape)}`, content: 'x' });
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result._meta.policy.decision).toBe('deny');
    expect(existsSync(escape)).toBe(false);
    const abs = await mcpCall('read', { path: '/etc/passwd' });
    expect(abs.body.result.isError).toBe(true);
  });

  it('refuses to weaken a protected verification file', async () => {
    approver = async () => true;
    const res = await mcpCall('write', { path: 'add.test.js', content: 'console.log("ok")\n' });
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toContain('VERIFICATION_PROTECTED');
    expect(readFileSync(path.join(h.root, 'add.test.js'), 'utf8')).toContain('expected 5');
  });

  it('denies an approval-required command when no human approves (fail closed)', async () => {
    const res = await mcpCall('shell', { command: `node -e "require('fs').writeFileSync('canary.txt','PWNED')"` });
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result._meta.policy.decision).toBe('deny');
    expect(h.approvals.length).toBe(1);
    expect(canary(h)).toBe(CANARY);
  });

  it('honours an explicit approval denial', async () => {
    approver = async () => false;
    const res = await mcpCall('shell', { command: `node -e "require('fs').writeFileSync('canary.txt','PWNED')"` });
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result._meta.policy.decision).toBe('deny');
    expect(canary(h)).toBe(CANARY);
  });

  it('dispatches an approval-required command only after explicit approval', async () => {
    approver = async () => true;
    const res = await mcpCall('shell', { command: `node -e "require('fs').writeFileSync('approved.txt','yes')"` });
    expect(res.body.result.isError).toBe(false);
    expect(res.body.result._meta.policy.rule).toContain('user-approved');
    expect(readFileSync(path.join(h.root, 'approved.txt'), 'utf8')).toBe('yes');
  });

  it('fails closed when the sandbox is required but unavailable', async () => {
    const saved = process.env.WAZIR_SANDBOX;
    process.env.WAZIR_SANDBOX = 'required-but-unknown-backend';
    resetSandboxProbe();
    try {
      const res = await mcpCall('shell', { command: 'echo sandboxed > sandbox-canary.txt' });
      expect(res.body.result.isError).toBe(true);
      expect(existsSync(path.join(h.root, 'sandbox-canary.txt'))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.WAZIR_SANDBOX; else process.env.WAZIR_SANDBOX = saved;
      resetSandboxProbe();
    }
  });

  it('times out a long-running tool and records a non-success outcome', async () => {
    approver = async () => true;
    const shell = h.state.tools.get('shell')!;
    const original = shell.descriptor.timeoutMs;
    shell.descriptor.timeoutMs = 300;
    try {
      const taskId = await newTask(h);
      const res = await step(h, taskId, { tool: { name: 'shell', input: { command: 'sleep 5' } }, is_last: true });
      expect(res.body.status).toBe('failed');
      expect(['TIMED_OUT', 'OUTCOME_UNKNOWN']).toContain(res.body.additional_output.outcome);
      expect((await getTask(h, taskId)).status).toBe('failed');
    } finally {
      shell.descriptor.timeoutMs = original;
    }
  });

  it('records a tool exception as a failed step, never completion', async () => {
    const original = h.state.tools.get('lint')!;
    h.state.tools.register({ descriptor: { ...original.descriptor }, execute: async () => { throw new Error('boom from tool'); } });
    try {
      const taskId = await newTask(h);
      const res = await step(h, taskId, { tool: { name: 'lint', input: {} }, is_last: true });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      expect(res.body.output).toContain('boom from tool');
      expect(res.body.additional_output.tool.ok).toBe(false);
      const task = await getTask(h, taskId);
      expect(task.status).toBe('failed');
      expect(task.additional_output.outcome).toBe('FAILED');
    } finally {
      h.state.tools.register(original);
    }
  });
});

describe('audit and cross-process state integrity', () => {
  it('does not dispatch a tool when the pre-dispatch audit record cannot be written', async () => {
    const h = await start();
    // Make the audit path a directory so appending fails.
    rmSync(h.auditPath, { force: true });
    mkdirSync(h.auditPath);
    try {
      const res = await rpc(h, OPERATOR, 'tools/call', { name: 'write', arguments: { path: 'canary.txt', content: 'PWNED' } });
      expect(res.body.result.isError).toBe(true);
      expect(canary(h)).toBe(CANARY);
    } finally {
      rmSync(h.auditPath, { recursive: true, force: true });
    }
  });

  it('a task finished by another process during execution is not overwritten', async () => {
    const h = await start();
    approver = async () => true;
    const taskId = await newTask(h);
    const pending = step(h, taskId, { tool: { name: 'shell', input: { command: 'sleep 1' } }, is_last: true });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await getTask(h, taskId)).status !== 'running') await new Promise((r) => setTimeout(r, 20));
    // Simulate another API instance sharing the store marking the task failed.
    const stored = await h.state.store.get<any>(`editor_protocol/tasks/${taskId}`);
    await h.state.store.put(`editor_protocol/tasks/${taskId}`, { ...stored, status: 'failed', additional_output: { outcome: 'FAILED', last_step_id: 'other-instance' } });
    const res = await pending;
    expect(res.status).toBe(409);
    const task = await getTask(h, taskId);
    expect(task.status).toBe('failed');
    expect(task.additional_output.last_step_id).toBe('other-instance');
  }, 20_000);
});

describe('client cancellation', () => {
  it('aborting the HTTP request cancels the running tool and fails the step', async () => {
    const h = await start();
    approver = async () => true;
    const taskId = await newTask(h);
    const controller = new AbortController();
    const request = fetch(`${h.base}/ap/v1/agent/tasks/${taskId}/steps`, {
      method: 'POST', headers: headers(OPERATOR), signal: controller.signal,
      body: JSON.stringify({ input: 'long', additional_input: { tool: { name: 'shell', input: { command: 'sleep 3 && echo late > late.txt' } } } }),
    }).catch((e) => e);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await getTask(h, taskId)).status !== 'running') await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    await request;
    let task = await getTask(h, taskId);
    const until = Date.now() + 10_000;
    while (Date.now() < until && task.status === 'running') { await new Promise((r) => setTimeout(r, 50)); task = await getTask(h, taskId); }
    expect(task.status).toBe('failed');
    expect(['CANCELLED', 'OUTCOME_UNKNOWN']).toContain(task.steps[0].additional_output.outcome);
    await new Promise((r) => setTimeout(r, 3_500));
    expect(existsSync(path.join(h.root, 'late.txt'))).toBe(false);
  }, 30_000);
});

describe('truthful completion', () => {
  it('a text-only step is RECORDED, never reported as executed or verified', async () => {
    const h = await start();
    const taskId = await newTask(h);
    const res = await step(h, taskId, { is_last: true });
    expect(res.body.status).toBe('completed');
    expect(res.body.additional_output.outcome).toBe('RECORDED');
    expect(res.body.additional_output.executed).toBe(false);
    expect(res.body.output).not.toMatch(/^Executed/);
    const task = await getTask(h, taskId);
    expect(task.status).toBe('completed');
    expect(task.additional_output.outcome).toBe('UNVERIFIED');
  });

  it('no execution engine: a tool step fails with EXECUTION_UNAVAILABLE', async () => {
    const h = await start((state) => { state.editorProtocol = new EditorProtocolService({ store: state.store, tools: state.tools }); });
    const taskId = await newTask(h);
    const res = await step(h, taskId, { tool: writeCanary, is_last: true });
    expect(res.body.status).toBe('failed');
    expect(res.body.additional_output.outcome).toBe('EXECUTION_UNAVAILABLE');
    expect((await getTask(h, taskId)).status).toBe('failed');
    expect(canary(h)).toBe(CANARY);
    const mcp = await rpc(h, OPERATOR, 'tools/call', { name: 'write', arguments: { path: 'canary.txt', content: 'PWNED' } });
    expect(mcp.body.result.isError).toBe(true);
    expect(canary(h)).toBe(CANARY);
  });

  it('a tool returning ok:false fails the last step and the parent task', async () => {
    const h = await start();
    const taskId = await newTask(h);
    const res = await step(h, taskId, { tool: { name: 'read', input: { path: 'missing.txt' } }, is_last: true, verify: true });
    expect(res.body.status).toBe('failed');
    expect(res.body.additional_output.outcome).toBe('TOOL_FAILED');
    expect(res.body.additional_output.verification).toBeUndefined();
    const task = await getTask(h, taskId);
    expect(task.status).toBe('failed');
    expect(task.additional_output.failed_step_id).toBe(res.body.step_id);
  });

  it('verification unavailable is never PASS', async () => {
    const h = await start((state) => {
      const svc = state.editorProtocol as unknown as { verifier?: unknown };
      svc.verifier = undefined;
    });
    const taskId = await newTask(h);
    const res = await step(h, taskId, { verify: true, is_last: true });
    expect(res.body.status).toBe('failed');
    expect(res.body.additional_output.outcome).toBe('VERIFICATION_UNAVAILABLE');
    const status = JSON.parse((await rpc(h, VIEWER, 'resources/read', { uri: 'wazir://verification/status' })).body.result.contents[0].text);
    expect(status.verified).toBe(false);
    expect(status.status).toBe('UNAVAILABLE');
  });

  it('verification that throws is ERROR, not PASS', async () => {
    const h = await start((state) => {
      (state.editorProtocol as unknown as { verifier: unknown }).verifier = async () => { throw new Error('verifier crashed'); };
    });
    const taskId = await newTask(h);
    const res = await step(h, taskId, { verify: true, is_last: true });
    expect(res.body.status).toBe('failed');
    expect(res.body.additional_output.verification.status).toBe('ERROR');
    expect((await getTask(h, taskId)).status).toBe('failed');
  });

  it('a verifier claiming PASS without executed checks is rejected', async () => {
    const h = await start((state) => {
      (state.editorProtocol as unknown as { verifier: unknown }).verifier = async (r: any) => ({
        status: 'PASS', executionId: r.executionId, taskId: r.taskId, stepId: r.stepId, checks: [], startedAt: '', completedAt: '', reasons: [],
      });
    });
    const taskId = await newTask(h);
    const res = await step(h, taskId, { verify: true, is_last: true });
    expect(res.body.status).toBe('failed');
    expect(res.body.additional_output.verification.status).toBe('ERROR');
  });

  it('tool succeeds but the independent check fails: step and task fail', async () => {
    const h = await start();
    const taskId = await newTask(h);
    const res = await step(h, taskId, { tool: { name: 'write', input: { path: 'notes.txt', content: 'unrelated' } }, verify: true, is_last: true });
    expect(res.body.additional_output.tool.ok).toBe(true);
    expect(existsSync(path.join(h.root, 'notes.txt'))).toBe(true);
    expect(res.body.status).toBe('failed');
    expect(res.body.additional_output.outcome).toBe('VERIFICATION_FAILED');
    expect(res.body.additional_output.verification.checks[0]).toMatchObject({ name: 'test', status: 'FAIL' });
    const task = await getTask(h, taskId);
    expect(task.status).toBe('failed');
    const status = JSON.parse((await rpc(h, VIEWER, 'resources/read', { uri: 'wazir://verification/status' })).body.result.contents[0].text);
    expect(status.verified).toBe(false);
    expect(status.status).toBe('FAIL');
  }, 60_000);

  it('a terminal task rejects late and duplicate steps without changing state', async () => {
    const h = await start();
    const taskId = await newTask(h);
    expect((await step(h, taskId, { is_last: true })).body.status).toBe('completed');
    const dup = await step(h, taskId, { is_last: true, tool: writeCanary });
    expect(dup.status).toBe(409);
    expect(canary(h)).toBe(CANARY);
    const task = await getTask(h, taskId);
    expect(task.status).toBe('completed');
    expect(task.steps.length).toBe(1);
  });

  it('concurrent steps cannot overwrite a failed terminal state', async () => {
    const h = await start();
    const taskId = await newTask(h);
    const [failing, late] = await Promise.all([
      step(h, taskId, { tool: { name: 'read', input: { path: 'missing.txt' } } }),
      step(h, taskId, { is_last: true }),
    ]);
    const task = await getTask(h, taskId);
    expect(failing.body.status).toBe('failed');
    expect(late.status).toBe(409);
    expect(task.status).toBe('failed');
    expect(task.steps.length).toBe(1);
  });
});

describe('end-to-end: client → API → policy → registered tool → filesystem → verification → persisted result', () => {
  it('operator repairs a faulty implementation with verified evidence; viewer attempt has no effect', async () => {
    const h = await start();
    const src = path.join(h.root, 'src.js');
    const before = readFileSync(src, 'utf8');
    const taskId = await newTask(h);

    // Unauthorized attempt first: no physical change, no step recorded.
    const denied = await step(h, taskId, { tool: { name: 'edit', input: { path: 'src.js', oldString: 'a - b', newString: 'a + b' } }, verify: true, is_last: true }, VIEWER);
    expect(denied.status).toBe(403);
    expect(readFileSync(src, 'utf8')).toBe(before);

    // Baseline: verification of the faulty code is FAIL (the oracle can fail).
    // (Run on a second task so this task stays open.)
    const probe = await newTask(h);
    expect((await step(h, probe, { verify: true })).body.additional_output.verification.status).toBe('FAIL');

    const res = await step(h, taskId, { tool: { name: 'edit', input: { path: 'src.js', oldString: 'a - b', newString: 'a + b' } }, verify: true, is_last: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.additional_output.outcome).toBe('VERIFIED');
    expect(readFileSync(src, 'utf8')).toBe('exports.add = (a, b) => a + b;\n');

    const evidence = res.body.additional_output.verification;
    expect(evidence).toMatchObject({ status: 'PASS', taskId, stepId: res.body.step_id, executionId: res.body.additional_output.execution_id });
    expect(evidence.checks).toHaveLength(1);
    expect(evidence.checks[0]).toMatchObject({ name: 'test', status: 'PASS' });
    expect(evidence.checks[0].output).toContain('ok');
    expect(evidence.workspaceRevision).toMatch(/\w+/);
    expect(res.body.additional_output.tool.workspace_after_hash).toBeDefined();

    // Persisted record agrees.
    const persisted = (await call(h, 'GET', `/ap/v1/agent/tasks/${taskId}/steps/${res.body.step_id}`, VIEWER)).body;
    expect(persisted.status).toBe('completed');
    expect(persisted.additional_output.verification.status).toBe('PASS');
    const task = await getTask(h, taskId);
    expect(task.status).toBe('completed');
    expect(task.additional_output.outcome).toBe('VERIFIED');
    const status = JSON.parse((await rpc(h, VIEWER, 'resources/read', { uri: 'wazir://verification/status' })).body.result.contents[0].text);
    expect(status).toMatchObject({ verified: true, status: 'PASS' });
    expect(status.evidence.stepId).toBe(res.body.step_id);
  }, 90_000);
});

