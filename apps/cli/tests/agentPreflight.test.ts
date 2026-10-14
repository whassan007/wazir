import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpAgentAdapter } from '@wazir/agents';
import { checkAgents, knownAgentFailure, recordAgentTask, renderPreflight } from '../src/agentPreflight.js';
import { runTaskCommand } from '../src/commands.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../packages/agents/tests/fixtures/fakeAcpAgent.mjs');

function engineWith(agents: Record<string, string>) {
  const adapters = Object.fromEntries(Object.entries(agents).map(([name, mode]) => [name,
    new AcpAgentAdapter({ name, description: '', command: process.execPath, args: [FAKE], env: { FAKE_ACP_MODE: mode }, cancelGraceMs: 300 })]));
  return {
    agents: {
      list: () => [...Object.keys(adapters).map((n) => ({ descriptor: { name: n }, source: 'external' })), { descriptor: { name: 'wazir-coding' }, source: 'native' }],
      get: (n: string) => adapters[n],
    },
  };
}

describe('wa agents check', () => {
  let home: string;
  let file: string;
  beforeEach(() => { home = mkdtempSync(path.join(os.tmpdir(), 'wazir-pfc-')); file = path.join(home, 'agent-preflight.json'); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); vi.unstubAllEnvs(); });

  it('probes only external agents, caches results privately, and reuses them until --fresh', async () => {
    const engine = engineWith({ good: 'normal', bad: 'session-error' });
    const first = await checkAgents(engine, [], { file });
    expect(first.map((r) => [r.agent, r.status]).sort()).toEqual([['bad', 'FAILED'], ['good', 'READY']]);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }

    const cached = await checkAgents(engine, ['good'], { file });
    expect(cached[0].checkedAt).toBe(first.find((r) => r.agent === 'good')!.checkedAt);

    const fresh = await checkAgents(engine, ['good'], { file, fresh: true });
    expect(fresh[0].checkedAt).not.toBe(cached[0].checkedAt);
  });

  it('reports unknown names without probing', async () => {
    const r = await checkAgents(engineWith({}), ['nope'], { file });
    expect(r[0]).toMatchObject({ agent: 'nope', status: 'UNKNOWN' });
  });

  it('renders fix hints under failing agents', () => {
    const text = renderPreflight([{ agent: 'qwen-code', status: 'FAILED', detail: 'Internal error: Connection error.', hint: 'check ~/.qwen/settings.json', durationMs: 1, checkedAt: new Date().toISOString() }]);
    expect(text).toContain('qwen-code');
    expect(text).toContain('fix: check ~/.qwen/settings.json');
  });

  it('knownAgentFailure ignores READY and stale results', () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    writeFileSync(file, JSON.stringify({ version: 1, results: {
      ok: { agent: 'ok', status: 'READY', detail: '', durationMs: 1, checkedAt: now },
      bad: { agent: 'bad', status: 'FAILED', detail: 'x', durationMs: 1, checkedAt: now },
      stale: { agent: 'stale', status: 'FAILED', detail: 'x', durationMs: 1, checkedAt: old },
    } }));
    expect(knownAgentFailure('ok', file)).toBeUndefined();
    expect(knownAgentFailure('bad', file)?.status).toBe('FAILED');
    expect(knownAgentFailure('stale', file)).toBeUndefined();
  });

  it('wa run --agent refuses a known-failed agent before doing any work, unless --force', async () => {
    vi.stubEnv('WAZIR_HOME', home);
    writeFileSync(file, JSON.stringify({ version: 1, results: {
      codex: { agent: 'codex', status: 'FAILED', detail: 'model requires a newer Codex', hint: 'wait for codex-acp', durationMs: 1, checkedAt: new Date().toISOString() },
    } }));
    // An engine that throws on any use proves the refusal happens before execution starts.
    const untouchable = new Proxy({}, { get: () => { throw new Error('engine must not be used'); } }) as any;
    const refused = await runTaskCommand(untouchable, 'fix it', { agent: 'codex' });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("Agent 'codex' is FAILED");
    expect(refused.output).toContain('fix: wait for codex-acp');
    expect(refused.output).toContain('--force');

    const json = JSON.parse((await runTaskCommand(untouchable, 'fix it', { agent: 'codex', json: true })).output);
    expect(json).toMatchObject({ success: false });

    await expect(runTaskCommand(untouchable, 'fix it', { agent: 'codex', force: true })).rejects.toThrow('engine must not be used');
  });

  it('a probe answer is not enough: a later real-task failure in the agent shows DEGRADED, and history survives re-probes', async () => {
    const engine = engineWith({ codex: 'normal' });
    const [first] = await checkAgents(engine, ['codex'], { file });
    expect(first.status).toBe('READY');
    expect(renderPreflight([first])).toMatch(/no verified real task yet/);

    recordAgentTask('codex', { at: new Date(Date.now() + 1).toISOString(), executionId: 'exec-1', outcome: 'agent_error', detail: 'model endpoint 400' }, file);
    const [degraded] = await checkAgents(engine, ['codex'], { file });
    expect(degraded.status).toBe('DEGRADED');
    expect(renderPreflight([degraded])).toMatch(/last task: agent_error .*exec-1.*model endpoint 400/);
    expect(knownAgentFailure('codex', file)).toBeUndefined(); // degraded warns; it does not refuse

    recordAgentTask('codex', { at: new Date(Date.now() + 2).toISOString(), executionId: 'exec-2', outcome: 'verified' }, file);
    const [fresh] = await checkAgents(engine, ['codex'], { file, fresh: true });
    expect(fresh.status).toBe('READY');
    expect(fresh.lastVerifiedTask).toMatchObject({ executionId: 'exec-2' });
  });
});
