import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { ExecutionEngine, persistExecutionRecord } from '@wazir/core';
import { MemoryStore, type KeyValueStore } from '@wazir/shared';
import { createApiState, createApp } from '../../apps/api/src/server.js';

interface MockElement {
  id: string;
  textContent: string;
  innerHTML: string;
  className: string;
  value: string;
  disabled: boolean;
  title: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
  selectedOptions: Array<{ textContent: string }>;
  classList: {
    classes: Set<string>;
    add: (...tokens: string[]) => void;
    remove: (...tokens: string[]) => void;
    toggle: (token: string, force?: boolean) => void;
    contains: (token: string) => boolean;
  };
  addEventListener: (type: string, fn: (...args: unknown[]) => void) => void;
  setAttribute: (name: string, val: string) => void;
  querySelectorAll: () => MockElement[];
}

function makeElement(id: string): MockElement {
  const classes = new Set<string>();
  return {
    id,
    textContent: id.startsWith('badge-') || id.startsWith('kpi-') ? '—' : '',
    innerHTML: '',
    className: '',
    value: '',
    disabled: false,
    title: '',
    style: { display: 'none' },
    dataset: {},
    selectedOptions: [],
    classList: {
      classes,
      add: (...t) => t.forEach((c) => classes.add(c)),
      remove: (...t) => t.forEach((c) => classes.delete(c)),
      toggle: (t, force) => {
        if (force === true) classes.add(t);
        else if (force === false) classes.delete(t);
        else if (classes.has(t)) classes.delete(t);
        else classes.add(t);
      },
      contains: (t) => classes.has(t),
    },
    addEventListener: () => undefined,
    setAttribute: () => undefined,
    querySelectorAll: () => [],
  };
}

/**
 * Loads the real script from `apps/web/public/index.html` into an isolated VM
 * context backed by a lightweight DOM and a caller-supplied `fetch` implementation
 * pointed at the live `apps/web/server.js` proxy.
 */
function mountDashboardHtml(customFetch: typeof fetch) {
  const htmlPath = path.resolve(__dirname, '../../apps/web/public/index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Failed to extract <script> from apps/web/public/index.html');

  const elements = new Map<string, MockElement>();
  const getEl = (id: string): MockElement => {
    let el = elements.get(id);
    if (!el) {
      el = makeElement(id);
      elements.set(id, el);
    }
    return el;
  };

  const storage = new Map<string, string>([['wazir_refresh_interval', '0']]);
  const windowObj: Record<string, unknown> = {};
  const documentObj = {
    hidden: false,
    getElementById: (id: string) => getEl(id),
    querySelectorAll: () => [] as MockElement[],
    addEventListener: () => undefined,
  };

  const context = vm.createContext({
    window: windowObj,
    document: documentObj,
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, String(v)),
    },
    fetch: customFetch,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Promise,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    encodeURIComponent,
    decodeURIComponent,
    parseInt,
    console,
  });

  vm.runInContext(match[1], context, { filename: 'apps/web/public/index.html' });

  const surface = windowObj.__WAZIR_SURFACE__ as {
    refresh: () => Promise<void>;
    showExecutionDrawer: (execId: string) => Promise<void>;
    switchTab: (tabId: string) => void;
    setAutonomyPosture: (mode: string) => Promise<void>;
    selectTargetHost: (hostId: string) => Promise<void>;
  };

  return { html, getEl, surface };
}

describe('Web dashboard end-to-end (Section 4 & Findings A, C, D, E, I.3)', { timeout: 30_000 }, () => {
  const servers: Server[] = [];
  const children: ChildProcess[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      child.kill();
      await once(child, 'exit').catch(() => undefined);
    }
    for (const server of servers.splice(0)) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  async function startApiAndProxy(options: {
    store?: KeyValueStore;
    apiToken?: string;
    proxyToken?: string;
  } = {}) {
    const store = options.store ?? new MemoryStore();
    const apiToken = options.apiToken ?? 'op-token-end-to-end-0123456789abcdef';
    const proxyToken = options.proxyToken ?? apiToken;
    const state = await createApiState({
      store,
      auth: {
        operatorToken: apiToken,
        allowUnauthenticated: false,
        store,
      },
    });
    const app = createApp(state);
    const apiServer = app.listen(0, '127.0.0.1');
    await once(apiServer, 'listening');
    servers.push(apiServer);
    const apiPort = (apiServer.address() as AddressInfo).port;

    const home = await mkdtemp(path.join(os.tmpdir(), 'wazir-web-e2e-'));
    tempDirs.push(home);

    const webChild = spawn(process.execPath, ['apps/web/server.js'], {
      env: {
        ...process.env,
        PORT: '0',
        WAZIR_WEB_HOST: '127.0.0.1',
        WAZIR_HOME: home,
        WAZIR_API: `http://127.0.0.1:${apiPort}`,
        WAZIR_API_TOKEN: proxyToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(webChild);

    const webPort = await new Promise<number>((resolve, reject) => {
      let stdout = '';
      const timer = setTimeout(() => reject(new Error('wazir-web startup timeout')), 5000);
      webChild.stdout!.on('data', (chunk) => {
        stdout += chunk;
        const m = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      webChild.on('error', reject);
    });

    const webBaseUrl = `http://127.0.0.1:${webPort}`;
    const proxyFetch: typeof fetch = (input, init) => {
      const url = typeof input === 'string' && input.startsWith('/') ? `${webBaseUrl}${input}` : input;
      return fetch(url, init);
    };

    return { state, store, apiServer, webBaseUrl, proxyFetch };
  }

  it('has zero inline onclick attributes in apps/web/public/index.html', () => {
    const htmlPath = path.resolve(__dirname, '../../apps/web/public/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(html).not.toMatch(/\bonclick\s*=/i);
  });

  it('distinguishes 401 auth failure from 502 offline and never shows 0 for unknown counts', async () => {
    // Start with a mismatched proxy token -> 401 from API
    const { proxyFetch, getEl, surface } = await (async () => {
      const env = await startApiAndProxy({
        apiToken: 'real-operator-secret-0123456789abcdef',
        proxyToken: 'wrong-operator-secret-0123456789abcdef',
      });
      const dom = mountDashboardHtml(env.proxyFetch);
      return { ...env, ...dom };
    })();

    await surface.refresh();
    expect(getEl('global-status-pill').textContent).toBe('authentication required');
    expect(getEl('badge-activity').textContent).toBe('—');
    expect(getEl('badge-infrastructure').textContent).toBe('—');
    expect(getEl('badge-catalog').textContent).toBe('—');

    // Now test against an unreachable endpoint -> offline, badges still '—'
    const offlineDom = mountDashboardHtml(async () => {
      const err = new Error('502 Bad Gateway') as Error & { status?: number };
      err.status = 502;
      throw err;
    });
    await offlineDom.surface.refresh();
    expect(offlineDom.getEl('global-status-pill').textContent).toBe('offline');
    expect(offlineDom.getEl('badge-activity').textContent).toBe('—');
    void proxyFetch;
  });

  it('loads live CLI executions and renders execution details, events, and child subagents via the web proxy', async () => {
    const store = new MemoryStore();
    const { proxyFetch } = await startApiAndProxy({ store });

    // Create a parent + child execution via the CLI's ExecutionEngine on the shared store
    const cliEngine = new ExecutionEngine({
      persist: (record) => persistExecutionRecord(store, `execution/${record.execution.id}`, record),
      load: async () => (await store.list('execution/')).map((e) => e.value as never),
    });
    await cliEngine.ready;

    const parent = await cliEngine.create({
      task: {
        id: 'task-e2e-parent',
        type: 'coding',
        input: 'Implement unified execution view',
        requirements: { capabilities: [] },
        priority: 'normal',
        status: 'completed',
        createdAt: new Date(),
      },
      agentId: 'architect',
      modelId: 'qwen2.5-coder:32b',
      runtimeId: 'ollama',
      computerId: 'local',
    });
    await cliEngine.setResult(parent.execution.id, 'Unified store active');
    await cliEngine.setStatus(parent.execution.id, 'completed');

    const child = await cliEngine.create({
      task: {
        id: 'task-e2e-child',
        type: 'coding',
        input: 'Run child verification',
        requirements: { capabilities: [] },
        priority: 'normal',
        status: 'completed',
        createdAt: new Date(),
      },
      parentExecutionId: parent.execution.id,
      agentId: 'verifier',
      modelId: 'qwen2.5-coder:7b',
      runtimeId: 'ollama',
      computerId: 'local',
    });
    await cliEngine.setStatus(child.execution.id, 'completed');

    const { getEl, surface } = mountDashboardHtml(proxyFetch);
    await surface.refresh();

    expect(getEl('global-status-pill').textContent).toBe('online');
    expect(getEl('executions').innerHTML).toContain(parent.execution.id);
    expect(getEl('executions').innerHTML).toContain(child.execution.id);

    // Open the execution details drawer for the parent execution
    await surface.showExecutionDrawer(parent.execution.id);
    const drawerHtml = getEl('drawer-body').innerHTML;
    expect(drawerHtml).toContain('Unified store active');
    expect(drawerHtml).toContain('Nested Subagent Executions (1)');
    expect(drawerHtml).toContain(child.execution.id);
    expect(drawerHtml).toContain('Execution Trajectory Timeline');
    // Verify delegated button attribute is used (no inline onclick)
    expect(drawerHtml).toContain(`class="exec-open-btn" data-exec-id="${child.execution.id}"`);
    expect(drawerHtml).not.toMatch(/\bonclick\s*=/i);

    // Verify explicit unavailable warning when /events or /children fails
    const failingSubresourceDom = mountDashboardHtml((input, init) => {
      const urlStr = String(input);
      if (urlStr.endsWith('/events') || urlStr.endsWith('/children')) {
        return Promise.reject(new Error('503 subresource outage'));
      }
      return proxyFetch(input, init);
    });
    await failingSubresourceDom.surface.showExecutionDrawer(parent.execution.id);
    const degradedDrawerHtml = failingSubresourceDom.getEl('drawer-body').innerHTML;
    expect(degradedDrawerHtml).toContain('Subagent execution details unavailable');
    expect(degradedDrawerHtml).toContain('Execution event timeline unavailable');
  });
});
