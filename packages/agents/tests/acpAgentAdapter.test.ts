import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpAgentAdapter, decideAcpPermission, parseAcpPermissionMode } from '../src/acp/acpAgentAdapter.js';
import { classifyOption } from '@wazir/core';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fakeAcpAgent.mjs');
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function runAgent(adapter: AcpAgentAdapter, request: Record<string, unknown>) {
  const turns: any[] = [];
  for await (const t of adapter.run({ modelId: 'external', taskType: 'coding', taskDescription: 'write out.txt', ...request } as any, {} as any)) turns.push(t);
  return turns;
}

describe('AcpAgentAdapter over a real ACP stdio connection', () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); dir = undefined; });
  const fake = (mode: string, extra: Partial<ConstructorParameters<typeof AcpAgentAdapter>[0]> = {}) =>
    new AcpAgentAdapter({ name: 'fake', description: 'fake', command: process.execPath, args: [FAKE], ...extra, env: { FAKE_ACP_MODE: mode, ...(extra.env ?? {}) } });

  it('runs a task: streams plan and tools, grants edits, denies execute, returns the answer without thoughts', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-acp-'));
    const turns = await runAgent(fake('normal'), { projectRoot: dir });

    expect(await fs.readFile(path.join(dir, 'out.txt'), 'utf8')).toContain('written by fake agent');
    expect(turns.some((t) => t.kind === 'message' && t.content.startsWith('Plan:'))).toBe(true);
    expect(turns.some((t) => t.kind === 'tool_call' && t.tool === 'edit')).toBe(true);
    expect(turns.some((t) => t.kind === 'tool_result' && t.toolResult.ok)).toBe(true);
    expect(turns.some((t) => t.kind === 'message' && /permission granted .*edit: Write out.txt/.test(t.content))).toBe(true);
    expect(turns.some((t) => t.kind === 'message' && /permission denied .*execute: rm -rf/.test(t.content))).toBe(true);
    const done = turns.at(-1);
    expect(done).toMatchObject({ kind: 'done', terminationReason: 'COMPLETED' });
    expect(done.content).toBe('Done: wrote out.txt (exec cancelled)');
    expect(JSON.stringify(turns)).not.toContain('SECRET_THOUGHT');
  });

  it('read-only mode denies the edit', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-acp-'));
    await runAgent(fake('normal', { permissionMode: 'read' }), { projectRoot: dir });
    await expect(fs.access(path.join(dir, 'out.txt'))).rejects.toThrow();
  });

  it('propagates cancellation through session/cancel', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-acp-'));
    let cancelled = false;
    setTimeout(() => { cancelled = true; }, 300);
    const turns = await runAgent(fake('cancel'), { projectRoot: dir, isCancelled: () => cancelled });
    expect(turns.at(-1)).toMatchObject({ kind: 'error', terminationReason: 'CANCELLED' });
  });

  it.skipIf(process.platform === 'win32')('kills an agent that ignores cancel, including its children', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-acp-'));
    const pidFile = path.join(dir, 'pids');
    let cancelled = false;
    const started = Date.now();
    const run = runAgent(fake('hang', { env: { FAKE_ACP_PIDS: pidFile }, cancelGraceMs: 300 }), { projectRoot: dir, isCancelled: () => cancelled });
    let pids: number[] = [];
    for (let i = 0; i < 100 && pids.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      pids = (await fs.readFile(pidFile, 'utf8').catch(() => '')).trim().split(/\s+/).filter(Boolean).map(Number);
    }
    expect(pids).toHaveLength(2);
    cancelled = true;
    const turns = await run;
    expect(turns.at(-1)).toMatchObject({ kind: 'error', terminationReason: 'CANCELLED' });
    expect(Date.now() - started).toBeLessThan(10_000);
    await new Promise((r) => setTimeout(r, 200));
    for (const pid of pids) expect(isAlive(pid)).toBe(false);
  }, 20_000);

  it('enforces the wall-clock bound', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-acp-'));
    const turns = await runAgent(fake('cancel', { maxWallClockMs: 300 }), { projectRoot: dir });
    expect(turns.at(-1)).toMatchObject({ kind: 'error', terminationReason: 'MAX_WALL_CLOCK' });
  });

  it('surfaces the agent\'s own session/new failure and stderr, not a guessed-auth error', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-acp-'));
    const turns = await runAgent(fake('session-error'), { projectRoot: dir });
    const last = turns.at(-1);
    expect(last).toMatchObject({ kind: 'error', errorKind: 'infrastructure' });
    expect(last.error).toContain('ORIGINAL_SESSION_FAILURE');
    expect(last.error).toContain('refusing to open a session');
    expect(last.error).not.toContain('Method not implemented');
  });

  it('reports a missing executable as an infrastructure error', async () => {
    const turns = await runAgent(new AcpAgentAdapter({ name: 'nope', description: '', command: '/nonexistent/acp-agent' }), { projectRoot: os.tmpdir() });
    expect(turns.at(-1)).toMatchObject({ kind: 'error', errorKind: 'infrastructure' });
  });
});

describe('ACP permission policy', () => {
  const opts = [
    { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
    { optionId: 'always', name: 'Always', kind: 'allow_always' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  ].map(classifyOption);

  it.each([
    ['read', 'read', 'yes'], ['read', 'edit', undefined], ['edit', 'edit', 'yes'],
    ['edit', 'execute', undefined], ['edit', 'fetch', undefined], ['edit', undefined, undefined],
    ['full', 'execute', 'yes'], ['full', 'mystery-kind', 'yes'],
  ] as const)('mode %s, kind %s -> %s', (mode, kind, expected) => {
    expect(decideAcpPermission(mode, kind, opts).optionId).toBe(expected);
  });

  it('never selects an "always" grant', () => {
    const alwaysOnly = [{ optionId: 'always', name: 'Always', kind: 'allow_always' }].map(classifyOption);
    expect(decideAcpPermission('full', 'execute', alwaysOnly)).toEqual({ cancelled: true });
  });

  it('defaults to edit mode for unknown values', () => {
    expect(parseAcpPermissionMode(undefined)).toBe('edit');
    expect(parseAcpPermissionMode('yolo')).toBe('edit');
    expect(parseAcpPermissionMode('full')).toBe('full');
  });
});
