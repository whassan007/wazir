// Goal Studio shell (contract §9). Vanilla ES module, no build step.
//
// Defines window.WazirGoalStudio.register(name, { mount(el, ctx), unmount?() })
// and gives every module ctx = { api, apiJson, events, state, notify }.
// Optional modules (graph, control, prompts, fleet) are loaded with dynamic
// import; a missing or failing module only affects its own panel.
//
// The pure helpers below are exported for unit tests; DOM wiring runs only in
// a browser.

export const API_BASE = '/api/v1/goal-studio/';

export const GOAL_STUDIO_EVENT_TYPES = Object.freeze([
  'run.created', 'run.status', 'run.idle', 'target.transition', 'target.phase',
  'attempt.started', 'attempt.finished', 'route.decided', 'execution.event',
  'verification.evidence', 'gate.decided', 'recovery.decided', 'approval.requested',
  'approval.resolved', 'governance.denied', 'graph.revision', 'prompt.version', 'error',
]);

/** Tabs and the module each mounts. */
export const TABS = Object.freeze([
  { id: 'graph', label: 'Dashboard / Graph', module: 'graph' },
  { id: 'execution', label: 'Execution', module: 'control' },
  { id: 'prompts', label: 'Prompts', module: 'prompts' },
  { id: 'fleet', label: 'Fleet', module: 'fleet' },
]);

/** Resolves a Goal Studio API path. `graphs` and `/graphs` → /api/v1/goal-studio/graphs; `/api/...` is kept. */
export function apiUrl(path) {
  const p = String(path ?? '');
  if (/^https?:\/\//i.test(p)) throw new Error('Goal Studio api() only accepts same-origin paths');
  if (p.startsWith('/api/')) return p;
  return API_BASE + p.replace(/^\/+/, '');
}

/**
 * Builds fetch init for ctx.api: adds the dashboard's selected-host header
 * (same mechanism as apps/web/public/index.html — the web proxy attaches the
 * operator token for trusted loopback same-origin callers) and JSON-encodes
 * plain-object bodies.
 */
export function buildInit(init = {}, hostId) {
  const headers = new Headers(init.headers || {});
  if (hostId && hostId !== 'local' && !headers.has('X-Wazir-Target-Host')) headers.set('X-Wazir-Target-Host', hostId);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  let body = init.body;
  const isPlain = body !== undefined && body !== null && typeof body === 'object'
    && (Array.isArray(body) || Object.getPrototypeOf(body) === Object.prototype || Object.getPrototypeOf(body) === null);
  if (isPlain) {
    body = JSON.stringify(body);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  }
  return { credentials: 'same-origin', ...init, headers, body };
}

export class GoalStudioApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'GoalStudioApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Parses a Response into JSON or throws GoalStudioApiError using the contract error envelope. */
export async function readJson(res) {
  let body;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  if (!res.ok) {
    const err = body && (body.error || body);
    const message = (err && typeof err === 'object' ? err.message : typeof err === 'string' ? err : undefined)
      || `${res.status} ${res.statusText || 'request failed'}`;
    throw new GoalStudioApiError(res.status, err && typeof err === 'object' ? err.code : undefined, message, err && err.details);
  }
  return body;
}

export function eventsUrl(runId, afterSeq) {
  const base = `${API_BASE}runs/${encodeURIComponent(runId)}/events`;
  return afterSeq > 0 ? `${base}?after=${afterSeq}` : base;
}

export function backoffDelay(attempt, base = 500, max = 15000) {
  return Math.min(max, base * 2 ** Math.max(0, attempt));
}

/**
 * Resilient SSE subscription. Deduplicates by `seq`, remembers the last seq,
 * lets the browser's native reconnect (which sends Last-Event-ID) run first,
 * and when the stream is closed or keeps failing reconnects with `?after=<seq>`
 * using exponential backoff. Returns close().
 */
export function createEventStream(runId, onEvent, options = {}) {
  const ES = options.EventSource || globalThis.EventSource;
  const setT = options.setTimeout || globalThis.setTimeout.bind(globalThis);
  const clearT = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
  const onStatus = options.onStatus || (() => {});
  const maxNativeRetries = options.maxNativeRetries ?? 2;
  let lastSeq = Number(options.after) > 0 ? Number(options.after) : 0;
  let es;
  let closed = false;
  let attempt = 0;
  let nativeErrors = 0;
  let timer;

  if (!ES) {
    onStatus('unsupported');
    return () => {};
  }

  const handle = (msg) => {
    let ev;
    try { ev = JSON.parse(msg.data); } catch { return; }
    if (!ev || typeof ev !== 'object') return;
    const seq = Number(ev.seq ?? msg.lastEventId);
    if (Number.isFinite(seq) && seq > 0) {
      if (seq <= lastSeq) return; // replayed duplicate
      lastSeq = seq;
    }
    nativeErrors = 0;
    attempt = 0;
    try { onEvent(ev); } catch (err) { console.error('[goal-studio] event handler failed', err); }
  };

  const connect = () => {
    if (closed) return;
    onStatus('connecting');
    es = new ES(eventsUrl(runId, lastSeq));
    es.onopen = () => { nativeErrors = 0; attempt = 0; onStatus('open'); };
    es.onmessage = handle;
    for (const type of GOAL_STUDIO_EVENT_TYPES) es.addEventListener(type, handle);
    es.onerror = () => {
      if (closed) return;
      const CLOSED = ES.CLOSED ?? 2;
      nativeErrors += 1;
      if (es.readyState !== CLOSED && nativeErrors <= maxNativeRetries) {
        onStatus('reconnecting');
        return; // browser retries itself, sending Last-Event-ID
      }
      es.close();
      onStatus('reconnecting');
      const delay = backoffDelay(attempt++);
      timer = setT(() => { nativeErrors = 0; connect(); }, delay);
    };
  };
  connect();

  const close = () => {
    closed = true;
    if (timer) clearT(timer);
    if (es) es.close();
    onStatus('closed');
  };
  close.lastSeq = () => lastSeq;
  return close;
}

/** Shared observable state. Known keys: graphId, revision, runId. */
export function createState(initial = {}, persist) {
  let s = { graphId: null, revision: null, runId: null, ...initial };
  const subs = new Set();
  const state = {
    get: () => ({ ...s }),
    set(patch) {
      const prev = s;
      const next = { ...s, ...patch };
      const changed = Object.keys(patch).filter((k) => prev[k] !== next[k]);
      if (!changed.length) return;
      s = next;
      try { persist && persist(s); } catch { /* storage unavailable */ }
      for (const fn of [...subs]) {
        try { fn({ ...s }, { ...prev }, changed); } catch (err) { console.error('[goal-studio] state listener failed', err); }
      }
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
  for (const k of ['graphId', 'revision', 'runId']) {
    Object.defineProperty(state, k, { enumerable: true, get: () => s[k], set: (v) => state.set({ [k]: v }) });
  }
  return state;
}

/** Module registry independent of the DOM (tested directly). */
export function createRegistry({ onRegister } = {}) {
  const modules = new Map();
  return {
    modules,
    register(name, mod) {
      if (typeof name !== 'string' || !name) throw new TypeError('register(name, module): name required');
      if (!mod || typeof mod.mount !== 'function') throw new TypeError(`register(${name}): module.mount(el, ctx) required`);
      const prev = modules.get(name);
      modules.set(name, mod);
      if (onRegister) onRegister(name, mod, prev);
    },
    get: (name) => modules.get(name),
    has: (name) => modules.has(name),
  };
}

// ---------------------------------------------------------------------------
// Browser wiring
// ---------------------------------------------------------------------------

function safeStorage() {
  try { return window.localStorage; } catch { return undefined; }
}

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) n.append(c);
  return n;
}

function bootBrowser() {
  const storage = safeStorage();
  const hostId = () => (storage && storage.getItem('wazir_target_host')) || 'local';

  // Theme: shares the dashboard's `wazir_theme` key.
  const themeBtn = document.getElementById('gs-theme-toggle');
  const applyTheme = (theme) => {
    const t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    if (themeBtn) themeBtn.textContent = t === 'light' ? '☀ Light' : '☾ Dark';
  };
  applyTheme((storage && storage.getItem('wazir_theme'))
    || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  themeBtn?.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { storage?.setItem('wazir_theme', next); } catch { /* ignore */ }
    applyTheme(next);
  });
  const hostLabel = document.getElementById('gs-host');
  if (hostLabel) hostLabel.textContent = `host: ${hostId()}`;

  // Shared state, persisted per browser and reflected in the URL query.
  const params = new URLSearchParams(location.search);
  let saved = {};
  try { saved = JSON.parse(storage?.getItem('wazir_goal_studio_state') || '{}') || {}; } catch { saved = {}; }
  const initial = {
    graphId: params.get('graph') || saved.graphId || null,
    revision: params.get('rev') ? Number(params.get('rev')) : (saved.revision ?? null),
    runId: params.get('run') || saved.runId || null,
  };
  const state = createState(initial, (s) => {
    storage?.setItem('wazir_goal_studio_state', JSON.stringify({ graphId: s.graphId, revision: s.revision, runId: s.runId }));
    const q = new URLSearchParams(location.search);
    for (const [k, key] of [['graph', 'graphId'], ['rev', 'revision'], ['run', 'runId']]) {
      if (s[key] === null || s[key] === undefined || s[key] === '') q.delete(k); else q.set(k, String(s[key]));
    }
    const qs = q.toString();
    history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
  });

  const toasts = document.getElementById('gs-toasts');
  const notify = (message, kind = 'info') => {
    if (!toasts) return;
    const t = el('div', { class: `gs-toast gs-toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, String(message));
    toasts.append(t);
    setTimeout(() => t.remove(), kind === 'error' ? 8000 : 4000);
  };

  const api = (path, init) => fetch(apiUrl(path), buildInit(init, hostId()));
  const apiJson = async (path, init) => readJson(await api(path, init));

  const nav = document.getElementById('gs-tabs');
  const main = document.getElementById('gs-panels');
  const panels = new Map();
  const mounted = new Map(); // module name -> { ctx, closers }
  const loadFailures = new Map();

  const makeCtx = (name) => {
    const closers = new Set();
    const ctx = {
      api,
      apiJson,
      state,
      notify,
      events(runId, onEvent, opts = {}) {
        const close = createEventStream(runId, onEvent, opts);
        closers.add(close);
        return () => { closers.delete(close); close(); };
      },
      module: name,
    };
    return { ctx, closers };
  };

  const renderPlaceholder = (tab) => {
    const panel = panels.get(tab.id);
    if (!panel || mounted.has(tab.module)) return;
    panel.replaceChildren();
    const failure = loadFailures.get(tab.module);
    panel.append(el('div', { class: 'gs-empty' },
      el('h2', {}, tab.label),
      el('p', {}, failure
        ? `Module "${tab.module}" is not installed or failed to load (${tab.module}.js). The rest of Goal Studio keeps working.`
        : `Loading module "${tab.module}"…`)));
  };

  const mountModule = (tab) => {
    const mod = registry.get(tab.module);
    const panel = panels.get(tab.id);
    if (!mod || !panel || mounted.has(tab.module)) return;
    panel.replaceChildren();
    const host = el('div', { class: 'gs-module', 'data-module': tab.module });
    panel.append(host);
    const entry = makeCtx(tab.module);
    mounted.set(tab.module, entry);
    try {
      const r = mod.mount(host, entry.ctx);
      if (r && typeof r.catch === 'function') r.catch((err) => showMountError(tab, err));
    } catch (err) {
      showMountError(tab, err);
    }
  };

  const showMountError = (tab, err) => {
    console.error(`[goal-studio] module ${tab.module} failed to mount`, err);
    const panel = panels.get(tab.id);
    panel?.prepend(el('div', { class: 'gs-banner gs-banner-err', role: 'alert' }, `Module "${tab.module}" failed: ${err && err.message ? err.message : err}`));
  };

  const unmountModule = (name) => {
    const entry = mounted.get(name);
    if (!entry) return;
    for (const c of entry.closers) { try { c(); } catch { /* ignore */ } }
    try { registry.get(name)?.unmount?.(); } catch (err) { console.error(`[goal-studio] ${name}.unmount failed`, err); }
    mounted.delete(name);
  };

  let active = null;
  const activate = (tabId) => {
    const tab = TABS.find((t) => t.id === tabId) || TABS[0];
    active = tab.id;
    for (const t of TABS) {
      const btn = nav.querySelector(`[data-tab="${t.id}"]`);
      btn?.setAttribute('aria-selected', String(t.id === tab.id));
      btn?.setAttribute('tabindex', t.id === tab.id ? '0' : '-1');
      panels.get(t.id).hidden = t.id !== tab.id;
    }
    if (registry.has(tab.module)) mountModule(tab); else renderPlaceholder(tab);
    panels.get(tab.id).dispatchEvent(new CustomEvent('goal-studio:show', { bubbles: false }));
    if (location.hash !== `#${tab.id}`) history.replaceState(null, '', `${location.pathname}${location.search}#${tab.id}`);
  };

  const registry = createRegistry({
    onRegister(name, _mod, prev) {
      if (prev) unmountModule(name);
      const tab = TABS.find((t) => t.module === name);
      if (tab && tab.id === active) mountModule(tab);
    },
  });

  for (const tab of TABS) {
    const btn = el('button', {
      type: 'button', role: 'tab', class: 'gs-tab', 'data-tab': tab.id,
      id: `gs-tab-${tab.id}`, 'aria-controls': `gs-panel-${tab.id}`,
      onclick: () => activate(tab.id),
    }, tab.label);
    nav.append(btn);
    const panel = el('section', { class: 'gs-panel', role: 'tabpanel', id: `gs-panel-${tab.id}`, 'aria-labelledby': `gs-tab-${tab.id}`, hidden: true });
    main.append(panel);
    panels.set(tab.id, panel);
  }
  nav.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.findIndex((t) => t.id === active);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    activate(next.id);
    nav.querySelector(`[data-tab="${next.id}"]`)?.focus();
  });

  window.WazirGoalStudio = Object.freeze({
    register: registry.register,
    state,
    notify,
    activate,
    contractVersion: 1,
  });
  window.addEventListener('pagehide', () => { for (const name of [...mounted.keys()]) unmountModule(name); });

  activate((location.hash || '').replace('#', '') || TABS[0].id);

  // Load optional modules after register() exists. Failures are isolated.
  const names = (document.body.dataset.modules || 'graph,control,prompts,fleet')
    .split(',').map((s) => s.trim()).filter((s) => /^[a-z][a-z0-9-]*$/.test(s));
  for (const name of names) {
    import(`./${name}.js`).catch((err) => {
      loadFailures.set(name, err);
      console.warn(`[goal-studio] optional module ${name}.js not loaded:`, err && err.message);
      const tab = TABS.find((t) => t.module === name);
      if (tab && !registry.has(name)) renderPlaceholder(tab);
    });
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.WazirGoalStudio) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootBrowser, { once: true });
  else bootBrowser();
}
