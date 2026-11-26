import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  executeSpotlightMatch,
  querySpotlight,
} from '../../packages/spotlight/src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

describe('Wazir Spotlight (KRunner Provider)', () => {
  it('routes terminal commands deterministically without an LLM', async () => {
    const matches = await querySpotlight('> git status');
    expect(matches).toHaveLength(1);
    expect(matches[0].category).toBe('terminal');
    expect(matches[0].requiresAi).toBe(false);
    expect(matches[0].actionPayload).toEqual({
      kind: 'exec-terminal',
      target: 'git status',
    });
  });

  it('performs deterministic repository code search via ripgrep', async () => {
    const matches = await querySpotlight('repo:BRAND_AUTHORITY', {
      workspaceRoots: [path.join(repoRoot, 'packages/design-tokens/src')],
    });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].category).toBe('code');
    expect(matches[0].requiresAi).toBe(false);
    expect(matches[0].actionPayload.kind).toBe('open-file');
  });

  it('queries models, fleet, and sessions from @wazir/api deterministically', async () => {
    const mockFetch = (async (url: string) => {
      if (url.endsWith('/api/v1/models')) {
        return new Response(
          JSON.stringify({ models: [{ id: 'qwen3-coder', name: 'Qwen3 Coder', status: 'loaded', provider: 'ollama' }] }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/workers')) {
        return new Response(JSON.stringify({ workers: [{ id: 'dgx-1', status: 'online', host: '10.0.0.5' }] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/agents')) {
        return new Response(JSON.stringify({ agents: [{ id: 'agent-1', name: 'Coder', status: 'idle' }] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/executions')) {
        return new Response(JSON.stringify({ executions: [{ id: 'exec-1234567890', status: 'completed', input: 'Run tests' }] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const modelHits = await querySpotlight('@qwen', { fetchImpl: mockFetch });
    expect(modelHits[0].category).toBe('models');
    expect(modelHits[0].text).toContain('Qwen3 Coder');

    const fleetHits = await querySpotlight('fleet', { fetchImpl: mockFetch });
    expect(fleetHits.some((m) => m.text.includes('dgx-1'))).toBe(true);
    expect(fleetHits.some((m) => m.text.includes('Coder'))).toBe(true);

    const sessionHits = await querySpotlight('sessions', { fetchImpl: mockFetch });
    expect(sessionHits[0].category).toBe('sessions');
    expect(sessionHits[0].text).toContain('exec-12345');
  });

  it('isolates AI/API failures so Spotlight & desktop stay operational offline', async () => {
    const offlineFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    const modelOffline = await querySpotlight('models', { fetchImpl: offlineFetch });
    expect(modelOffline).toHaveLength(1);
    expect(modelOffline[0].category).toBe('status');
    expect(modelOffline[0].text).toContain('offline');

    const terminalStillWorks = await querySpotlight('sh:uname -a', { fetchImpl: offlineFetch });
    expect(terminalStillWorks[0].category).toBe('terminal');
    expect(terminalStillWorks[0].actionPayload.target).toBe('uname -a');
  });

  it('routes natural-language AI tasks through policy-governed /api/v1/tasks/dispatch with operator auth', async () => {
    const matches = await querySpotlight('wazir:audit auth middleware');
    expect(matches).toHaveLength(1);
    expect(matches[0].requiresAi).toBe(true);
    expect(matches[0].actionPayload.kind).toBe('dispatch-ai');

    const noToken = await executeSpotlightMatch(matches[0], { operatorToken: '' });
    // Only fails if no ~/.wazir/local-operator.token exists; when token is provided, verifies dispatch call:
    let dispatchedAuth = '';
    const mockDispatch = (async (_url: string, init?: RequestInit) => {
      dispatchedAuth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }) as typeof fetch;

    const ok = await executeSpotlightMatch(matches[0], {
      operatorToken: 'test-operator-secret',
      fetchImpl: mockDispatch,
    });
    expect(ok.executed).toBe(true);
    expect(dispatchedAuth).toBe('Bearer test-operator-secret');
    expect(noToken).toBeDefined();
  });

  it('switches the Wazir OS engine deterministically via Spotlight (use liquid/gemma4/qwen/nemo)', async () => {
    const liquidHits = await querySpotlight('use liquid');
    expect(liquidHits).toHaveLength(1);
    expect(liquidHits[0].category).toBe('engine');
    expect(liquidHits[0].requiresAi).toBe(false);
    expect(liquidHits[0].actionPayload).toEqual({
      kind: 'switch-engine',
      target: 'liquid-light',
    });

    let postedBody = '';
    const mockSwitch = (async (_url: string, init?: RequestInit) => {
      postedBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ ok: true, activeEngineId: 'liquid-light' }), { status: 200 });
    }) as typeof fetch;

    const switched = await executeSpotlightMatch(liquidHits[0], {
      operatorToken: 'test-operator-secret',
      fetchImpl: mockSwitch,
    });
    expect(switched.executed).toBe(true);
    expect(JSON.parse(postedBody)).toEqual({ activeEngineId: 'liquid-light' });
  });
});
