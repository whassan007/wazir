import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpAgentAdapter } from '../src/acp/acpAgentAdapter.js';
import { ExternalAgentAdapter } from '../src/externalAgent.js';
import { classifyAgentFailure, isPreflightFresh, preflightAgent } from '../src/preflight.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fakeAcpAgent.mjs');
const fake = (mode: string, name = 'fake') =>
  new AcpAgentAdapter({ name, description: '', command: process.execPath, args: [FAKE], env: { FAKE_ACP_MODE: mode }, cancelGraceMs: 300 });

describe('preflightAgent', () => {
  it('requires an actual probe answer from discovered vendors, excluding stderr', async () => {
    const spec = (code: string) => new ExternalAgentAdapter({ name: 'codex', version: 'test', description: '', command: process.execPath, args: ['-e', code], taskTypes: [], capabilities: [] });
    expect((await preflightAgent(spec('process.stderr.write("OK")'))).status).toBe('FAILED');
    expect((await preflightAgent(spec('process.stdout.write("OK")'))).status).toBe('READY');
    expect((await preflightAgent(spec('process.exit(0)'))).status).toBe('FAILED');
  });

  it('blocks nested Claude profiles and rejects invalid time bounds', async () => {
    expect((await preflightAgent(fake('normal', 'claude-code@work'), { env: { CLAUDECODE: '1' } })).status).toBe('BLOCKED');
    await expect(preflightAgent(fake('normal'), { timeoutMs: NaN })).rejects.toThrow('positive finite');
  });
  it('reports READY when the agent answers the probe', async () => {
    const r = await preflightAgent(fake('normal'));
    expect(r).toMatchObject({ agent: 'fake', status: 'READY', stage: 'answer' });
    expect(r.detail).toMatch(/^answered in \d+\.\ds$/);
  });

  it('reports a session failure at the start stage with the agent\'s own reason', async () => {
    const r = await preflightAgent(fake('session-error'));
    expect(r).toMatchObject({ status: 'FAILED', stage: 'start' });
    expect(r.detail).toContain('ORIGINAL_SESSION_FAILURE');
  });

  it('bounds a probe that never answers', async () => {
    const started = Date.now();
    const r = await preflightAgent(fake('cancel'), { timeoutMs: 1_000 });
    expect(r).toMatchObject({ status: 'FAILED', stage: 'answer' });
    expect(r.detail).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it('reports a missing executable with an install hint', async () => {
    const r = await preflightAgent(new AcpAgentAdapter({ name: 'ghost', description: '', command: '/nonexistent/ghost-acp' }));
    expect(r).toMatchObject({ status: 'FAILED', stage: 'start' });
    expect(r.hint).toContain('install the ghost CLI');
  });

  it('BLOCKS claude-code inside a Claude Code session without launching anything', async () => {
    // A launch attempt would fail with ENOENT (FAILED); BLOCKED proves nothing was started.
    const adapter = new AcpAgentAdapter({ name: 'claude-code', description: '', command: '/nonexistent/claude-acp' });
    const r = await preflightAgent(adapter, { env: { CLAUDECODE: '1' } });
    expect(r).toMatchObject({ status: 'BLOCKED', stage: 'environment', hint: 'run wa from a normal terminal' });
    expect(r.durationMs).toBeLessThan(1_000);
  });

  it.skipIf(process.platform === 'win32')('checks headless external agents too', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-pf-'));
    const ok = path.join(dir, 'ok.sh');
    const broken = path.join(dir, 'broken.sh');
    await fs.writeFile(ok, '#!/usr/bin/env bash\necho OK\n', { mode: 0o755 });
    await fs.writeFile(broken, '#!/usr/bin/env bash\necho "Error: 401 Unauthorized" >&2\nexit 1\n', { mode: 0o755 });
    try {
      const spec = (command: string) => new ExternalAgentAdapter({ name: 'ext', version: '1', description: '', command, taskTypes: [], capabilities: [] });
      expect(await preflightAgent(spec(ok))).toMatchObject({ status: 'READY' });
      const r = await preflightAgent(spec(broken));
      expect(r.status).toBe('FAILED');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('classifyAgentFailure (messages captured from live runs)', () => {
  it.each([
    ['claude-code', 'Error: Claude Code cannot be launched inside another Claude Code session.', 'BLOCKED', /normal terminal/],
    ['codex', "Internal error: {\"status\":400,\"error\":{\"message\":\"The 'gpt-6-astra' model requires a newer version of Codex.", 'FAILED', /codex-acp/],
    ['codex', "The 'gpt-5' model is not supported when using Codex with a ChatGPT account", 'FAILED', /codex-acp/],
    ['gemini', 'This client is no longer supported for Gemini Code Assist for individuals.', 'FAILED', /antigravity/],
    ['qwen-code', 'Internal error: Connection error.', 'FAILED', /~\/\.qwen\/settings\.json/],
    ['codex', 'HTTP 401 Unauthorized', 'FAILED', /sign in/],
    ['qwen-code', "ACP agent 'qwen-code' did not initialize within 30000ms", 'FAILED', /did not respond in time/],
    ['opencode', 'The number of tokens to keep from the initial prompt is greater than the context length (n_keep: 20097>= n_ctx: 8192)', 'FAILED', /context window/],
  ] as const)('%s: %s', (agent, text, status, hint) => {
    const r = classifyAgentFailure(agent, text);
    expect(r.status).toBe(status);
    expect(r.hint).toMatch(hint);
  });

  it('keeps unmatched failures without inventing a hint', () => {
    expect(classifyAgentFailure('x', 'something novel went wrong')).toEqual({ status: 'FAILED' });
  });
});

describe('isPreflightFresh', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  it.each([
    ['2026-10-12T11:55:00Z', true],
    ['2026-10-12T11:49:59Z', false],
    ['2026-10-12T12:05:00Z', false],
    ['not a date', false],
  ])('%s -> %s', (checkedAt, fresh) => {
    expect(isPreflightFresh({ checkedAt }, now)).toBe(fresh);
  });
  it('treats a missing result as stale', () => expect(isPreflightFresh(undefined, now)).toBe(false));
});
