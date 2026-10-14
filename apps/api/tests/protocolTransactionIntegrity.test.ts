/**
 * Audit-failure visibility at the controlled tool boundary and verification
 * provenance rules, on isolated fixtures. Audit storage failures are injected by
 * replacing `appendAuditEvent`; everything else (tools, policy, workspace) is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const auditFault = vi.hoisted(() => ({ failTypes: new Set<string>() }));
vi.mock('@wazir/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wazir/shared')>();
  return {
    ...actual,
    appendAuditEvent: async (event: { type: string }, options?: unknown) => {
      if (auditFault.failTypes.has(event.type)) throw new Error(`EIO: injected audit failure (${event.type})`);
      return (actual.appendAuditEvent as (e: unknown, o?: unknown) => Promise<unknown>)(event, options);
    },
  };
});

const { MemoryStore } = await import('@wazir/shared');
const { EditorProtocolService } = await import('@wazir/core');
const { ToolRegistry, defaultTools } = await import('@wazir/tools');
const { createControlledExecution } = await import('../src/toolExecution.js');
type StepVerificationReport = import('@wazir/core').StepVerificationReport;
type KeyValueStore = import('@wazir/shared').KeyValueStore;

const OPERATOR = { kind: 'operator' as const, id: 'operator', scopes: ['read', 'mutate', 'execute'] as const };
const VIEWER = { kind: 'viewer' as const, id: 'viewer', scopes: ['read'] as const };

let root: string;
const savedHome = process.env.WAZIR_HOME;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'wazir-txn-'));
  process.env.WAZIR_HOME = path.join(root, '.home');
  writeFileSync(path.join(root, 'canary.txt'), 'ORIGINAL');
  auditFault.failTypes.clear();
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.WAZIR_HOME; else process.env.WAZIR_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

function controlled() {
  return createControlledExecution({
    tools: new ToolRegistry(defaultTools), projectRoot: root, auditPath: path.join(root, '.home', 'audit.jsonl'), approve: async () => true,
  });
}

function service(store: KeyValueStore = new MemoryStore(), withVerifier = true) {
  const c = controlled();
  const tools = new ToolRegistry(defaultTools);
  return new EditorProtocolService({ store, tools, executeTool: c.executeTool, verify: withVerifier ? c.verify : undefined, toolSurface: c.toolSurface, projectRoot: root });
}

const write = { name: 'write', input: { path: 'canary.txt', content: 'CHANGED' } };

describe('audit failure visibility', () => {
  it('pre-dispatch audit failure: tool not dispatched, reported as AUDIT_UNAVAILABLE (fail closed)', async () => {
    auditFault.failTypes.add('policy_decision');
    const result = await controlled().executeTool({ ...write, principal: OPERATOR, executionId: 'e1', source: 'mcp' });
    expect(result.ok).toBe(false);
    expect(result.dispatched).toBe(false);
    expect(result.failureClass).toBe('AUDIT_UNAVAILABLE');
    expect(readFileSync(path.join(root, 'canary.txt'), 'utf8')).toBe('ORIGINAL');
  });

  it('post-dispatch audit failure is surfaced without denying that the tool ran', async () => {
    auditFault.failTypes.add('tool_call');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await controlled().executeTool({ ...write, principal: OPERATOR, executionId: 'e2', source: 'mcp' });
      expect(result.ok).toBe(true);
      expect(result.dispatched).toBe(true);
      expect(result.audit).toMatchObject({ recorded: false });
      expect(result.audit?.error).toContain('injected audit failure');
      expect(stderr.mock.calls.some(([m]) => String(m).includes('AUDIT WRITE FAILED'))).toBe(true);
    } finally {
      stderr.mockRestore();
    }
    expect(readFileSync(path.join(root, 'canary.txt'), 'utf8')).toBe('CHANGED');
  });

  it('the step records TOOL_SUCCEEDED with audit_recorded=false, and MCP reports it in _meta; nothing is re-run', async () => {
    auditFault.failTypes.add('tool_call');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const svc = service();
      const task = await svc.createTask({ input: 't' }, { principal: OPERATOR });
      const step = await svc.executeStep(task.task_id, { additional_input: { tool: write } }, { principal: OPERATOR });
      expect(step.additional_output).toMatchObject({ outcome: 'TOOL_SUCCEEDED', executed: true, audit_recorded: false });
      writeFileSync(path.join(root, 'canary.txt'), 'ORIGINAL');
      const rpc = await svc.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write', arguments: write.input } }, { principal: OPERATOR });
      const meta = (rpc!.result as { isError: boolean; _meta: Record<string, unknown> });
      expect(meta.isError).toBe(false);
      expect(meta._meta).toMatchObject({ dispatched: true, auditRecorded: false });
      expect(readFileSync(path.join(root, 'canary.txt'), 'utf8')).toBe('CHANGED');
    } finally {
      stderr.mockRestore();
    }
  });

  it('a denied call stays denied when its audit record cannot be written', async () => {
    auditFault.failTypes.add('tool_call');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await controlled().executeTool({ ...write, principal: VIEWER as never, executionId: 'e3', source: 'mcp' });
      expect(result).toMatchObject({ ok: false, dispatched: false, failureClass: 'POLICY_DENIED', audit: { recorded: false } });
    } finally {
      stderr.mockRestore();
    }
    expect(existsSync(path.join(root, 'canary.txt')) && readFileSync(path.join(root, 'canary.txt'), 'utf8')).toBe('ORIGINAL');
  });
});

describe('verification provenance', () => {
  const pass = (over: Partial<StepVerificationReport> = {}): StepVerificationReport => ({
    status: 'PASS', executionId: 'x', taskId: 't', stepId: 's', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    reasons: [], checks: [{ name: 'test', status: 'PASS', durationMs: 1, startedAt: '', completedAt: '', output: 'SECRET-OUTPUT' }], ...over,
  });

  it('an old PASS with no verification engine configured is not verified', async () => {
    const store = new MemoryStore();
    await store.put('editor_protocol/verification/latest', pass({ workspaceEpoch: 0 }));
    const status = await service(store, false).verificationStatus({ principal: OPERATOR });
    expect(status).toMatchObject({ verified: false, status: 'UNAVAILABLE' });
  });

  it('a legacy PASS not bound to a workspace revision is STALE, never verified', async () => {
    const store = new MemoryStore();
    await store.put('editor_protocol/verification/latest', pass());
    expect(await service(store).verificationStatus({ principal: OPERATOR })).toMatchObject({ verified: false, status: 'STALE' });
  });

  it('viewers get statuses without check output', async () => {
    const store = new MemoryStore();
    await store.put('editor_protocol/verification/latest', pass({ workspaceEpoch: 0 }));
    const svc = service(store);
    const viewer = await svc.verificationStatus({ principal: VIEWER });
    expect(viewer.verified).toBe(true);
    expect(JSON.stringify(viewer)).not.toContain('SECRET-OUTPUT');
    expect(JSON.stringify(await svc.verificationStatus({ principal: OPERATOR }))).toContain('SECRET-OUTPUT');
  });

  it('a verifier PASS that skipped a requested check is rejected', async () => {
    const svc = new EditorProtocolService({
      store: new MemoryStore(),
      verify: async (req) => pass({ executionId: req.executionId, taskId: req.taskId, stepId: req.stepId }),
    });
    const task = await svc.createTask({ input: 't' }, { principal: OPERATOR });
    const step = await svc.executeStep(task.task_id, { additional_input: { verify: ['test', 'lint'], is_last: true } }, { principal: OPERATOR });
    expect(step.additional_output!.outcome).toBe('VERIFICATION_FAILED');
    expect(JSON.stringify(step.additional_output!.verification)).toContain('requested check(s) not executed: lint');
    expect((await svc.getTask(task.task_id))!.status).toBe('failed');
  });

  it('a workspace mutation during verification rejects the PASS', async () => {
    const store = new MemoryStore();
    const svc = new EditorProtocolService({
      store,
      verify: async (req) => {
        await store.put('editor_protocol/workspace/epoch', { seq: 99, at: '', executionId: 'other', tool: 'write' });
        return pass({ executionId: req.executionId, taskId: req.taskId, stepId: req.stepId });
      },
    });
    const task = await svc.createTask({ input: 't' }, { principal: OPERATOR });
    const step = await svc.executeStep(task.task_id, { additional_input: { verify: true, is_last: true } }, { principal: OPERATOR });
    expect(step.additional_output!.outcome).toBe('VERIFICATION_FAILED');
    expect(JSON.stringify(step.additional_output!.verification)).toContain('mutated while verification ran');
  });
});

describe('unsupported storage', () => {
  it('a store without atomic update refuses task mutations instead of risking lost writes', async () => {
    const inner = new MemoryStore();
    const store: KeyValueStore = { put: (k, v) => inner.put(k, v), get: (k) => inner.get(k), list: (p) => inner.list(p), delete: (k) => inner.delete(k), clear: () => inner.clear() };
    const svc = new EditorProtocolService({ store });
    const task = await svc.createTask({ input: 't' }, { principal: OPERATOR });
    await expect(svc.executeStep(task.task_id, {}, { principal: OPERATOR })).rejects.toMatchObject({ code: 'UNSUPPORTED_STORE' });
    await expect(svc.createArtifact(task.task_id, { file_name: 'a' }, { principal: OPERATOR })).rejects.toMatchObject({ code: 'UNSUPPORTED_STORE' });
  });
});
