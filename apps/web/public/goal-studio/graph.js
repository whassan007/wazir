// Goal Studio: strategic dashboard + interactive goal graph (workstream 06).
//
// Registers module "graph" with the shell (contract §9). Reads graphs and
// revisions from workstream 02's routes and live target statuses from the
// selected run's ledger (workstream 07). Edits are collected in a draft and
// saved as a NEW revision via POST graphs/:graphId/revisions with
// parentRevision; a run's pinned revision is never modified.
import * as M from './graph-model.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function h(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  setAttrs(n, attrs);
  append(n, children);
  return n;
}
function s(tag, attrs = {}, ...children) {
  const n = document.createElementNS(SVG_NS, tag);
  setAttrs(n, attrs);
  append(n, children);
  return n;
}
function setAttrs(n, attrs) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.setAttribute('class', v);
    else if (k === 'text') n.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'value' && 'value' in n) n.value = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
}
function append(n, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    n.append(c instanceof Node ? c : String(c));
  }
}
const shortDigest = (d) => (d ? String(d).replace(/^sha256:/, '').slice(0, 12) : '—');
const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
};

function wrapText(text, max, lines) {
  const words = String(text).split(/\s+/);
  const out = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= max) cur += ' ' + w;
    else { out.push(cur); cur = w; }
    if (out.length === lines) break;
  }
  if (out.length < lines && cur) out.push(cur);
  if (out.length === lines && out.join(' ').length < String(text).length) {
    out[lines - 1] = out[lines - 1].slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  }
  return out.map((l) => (l.length > max ? l.slice(0, max - 1) + '…' : l));
}

export function mountGraphStudio(root, ctx) {
  const st = {
    graphs: [],
    graphsError: null,
    graphId: null,
    revisions: [],
    record: null,
    latestRevision: null,
    compareRev: null,
    compareRecord: null,
    serverCriticalPath: null,
    runId: null,
    runs: [],
    runsError: null,
    run: null,
    runError: null,
    connection: '',
    selected: null,
    focusChain: true,
    draft: null,
    view: { x: 0, y: 0, k: 1 },
    fitted: false,
    layout: null,
    importOpen: false,
    importIssues: null,
    importYamlText: '',
    createOpen: false,
    createName: 'New Goal',
    createObjective: 'Autonomous goal execution',
    createProject: 'default',
    searchQuery: '',
    filterStatus: '',
    filterStage: '',
    evidenceRecords: {},
    loading: false,
  };
  let closeEvents = null;
  let refetchTimer = null;
  let disposed = false;
  const unsubs = [];

  // ---------- skeleton ----------
  const graphSel = h('select', { 'aria-label': 'Goal graph', onchange: (e) => selectGraph(e.target.value || null) });
  const revSel = h('select', { 'aria-label': 'Graph revision', onchange: (e) => selectRevision(Number(e.target.value)) });
  const cmpSel = h('select', { 'aria-label': 'Compare with revision', onchange: (e) => selectCompare(e.target.value ? Number(e.target.value) : null) });
  const runSel = h('select', { 'aria-label': 'Run overlay', onchange: (e) => selectRun(e.target.value || null) });
  const runInput = h('input', { type: 'text', placeholder: 'run id…', size: 14, 'aria-label': 'Run id' });
  const searchInput = h('input', {
    type: 'search', placeholder: 'search targets…', size: 16, 'aria-label': 'Search targets',
    oninput: (e) => { st.searchQuery = e.target.value; renderGraph(); },
  });
  const statusFilterSel = h('select', {
    'aria-label': 'Filter by status',
    onchange: (e) => { st.filterStatus = e.target.value; renderGraph(); },
  });
  const stageFilterSel = h('select', {
    'aria-label': 'Filter by stage',
    onchange: (e) => { st.filterStage = e.target.value; renderGraph(); },
  });
  const connChip = h('span', { class: 'gs-chip gs-muted', title: 'Live event stream' }, 'no run');
  // Toolbar actions: data-action="seed-nobel" (POST graphs/seed-nobel) and data-action="create-goal" (POST graphs/create)
  const toolbar = h('div', { class: 'gs-toolbar' },
    h('label', { class: 'gs-field' }, 'Graph', graphSel),
    h('label', { class: 'gs-field' }, 'Revision', revSel),
    h('label', { class: 'gs-field' }, 'Compare with', cmpSel),
    h('label', { class: 'gs-field' }, 'Run overlay', h('div', { class: 'gs-row' }, runSel, runInput,
      h('button', { class: 'gs-btn gs-btn-sm', type: 'button', onclick: () => runInput.value.trim() && selectRun(runInput.value.trim()) }, 'Load'))),
    h('label', { class: 'gs-field' }, 'Search', searchInput),
    h('label', { class: 'gs-field' }, 'Status', statusFilterSel),
    h('label', { class: 'gs-field' }, 'Stage', stageFilterSel),
    connChip,
    h('span', { class: 'gs-spacer' }),
    h('button', { class: 'gs-btn', type: 'button', 'data-action': 'seed-nobel', onclick: () => seedNobel() }, 'Load Nobel Example'),
    h('button', { class: 'gs-btn gs-btn-primary', type: 'button', 'data-action': 'create-goal', onclick: () => createGoal() }, '+ New Goal'),
    h('button', { class: 'gs-btn', type: 'button', onclick: () => refreshAll() }, '↻ Refresh'),
    h('button', { class: 'gs-btn', type: 'button', onclick: () => { st.importOpen = !st.importOpen; if (st.importOpen) st.createOpen = false; renderImport(); renderCreate(); } }, '⇪ Import YAML'),
  );
  const createBox = h('div', { class: 'gs-card gs-create', hidden: true });
  const importBox = h('div', { class: 'gs-card gs-import', hidden: true });
  const banners = h('div', { class: 'gs-banners', style: 'display:flex;flex-direction:column;gap:6px' });
  const dash = h('div', { class: 'gs-dash' });
  const draftBar = h('div', { hidden: true });
  const diffBox = h('div', { class: 'gs-card gs-diff', hidden: true });

  const svg = s('svg', { class: 'gs-canvas', tabindex: '0', role: 'img', 'aria-label': 'Goal target dependency graph' });
  const defs = s('defs', {},
    ['', '-critical', '-related'].map((v) => s('marker', { id: `gs-arrow${v}`, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' },
      s('path', { d: 'M0,0 L10,5 L0,10 z', class: `gs-arrowhead${v ? ' gs-arrowhead' + v : ''}` }))));
  const viewport = s('g', { class: 'gs-viewport' });
  svg.append(defs, viewport);
  const zoomBtn = (label, title, fn) => h('button', { class: 'gs-btn gs-btn-sm', type: 'button', title, 'aria-label': title, onclick: fn }, label);
  const controls = h('div', { class: 'gs-canvas-controls' },
    zoomBtn('+', 'Zoom in', () => zoomCenter(1.25)),
    zoomBtn('−', 'Zoom out', () => zoomCenter(0.8)),
    zoomBtn('⤢', 'Fit graph', () => fit()),
    zoomBtn('1:1', 'Reset zoom', () => { st.view = { x: 20, y: 20, k: 1 }; applyView(); }),
  );
  const legend = h('div', { class: 'gs-legend', 'aria-label': 'Status legend' },
    M.TARGET_STATUSES.map((status) => h('span', {}, h('i', { class: `gs-dot gs-st-${M.statusMeta(status).cls}` }), M.statusMeta(status).label)),
    h('span', {}, h('i', { class: 'gs-dot', style: 'background:var(--critical)' }), 'critical path'));
  const canvasWrap = h('div', { class: 'gs-canvas-wrap' }, svg, controls, legend);
  const inspector = h('aside', { class: 'gs-card gs-inspector', 'aria-label': 'Target inspector' });
  const workspace = h('div', { class: 'gs-workspace' }, canvasWrap, inspector);
  root.append(toolbar, createBox, importBox, banners, dash, draftBar, diffBox, workspace);

  // ---------- data helpers ----------
  const api = (path, init) => ctx.apiJson ? ctx.apiJson(path, init) : ctx.api(path, init).then(async (r) => {
    const body = await r.json().catch(() => undefined);
    if (!r.ok) { const e = new Error(body?.error?.message || `${r.status}`); e.status = r.status; e.code = body?.error?.code; throw e; }
    return body;
  });
  const g = (id) => `graphs/${encodeURIComponent(id)}`;
  const errText = (err) => {
    if (!err) return '';
    if (err.status === 503) return `${err.message || 'service not configured'} (503 — the Goal Studio service is not wired on this API yet)`;
    if (err.status === 404 && !err.code) return 'endpoint not found (404 — API without Goal Studio routes?)';
    return err.message || String(err);
  };

  function currentDefinition() {
    if (st.draft) return st.draft.definition;
    return st.record ? M.normalizeDefinition(st.record.definition) : null;
  }
  function currentTargets() {
    return currentDefinition()?.targets || [];
  }

  // ---------- loading ----------
  async function loadGraphs() {
    try {
      const body = await api('graphs');
      const list = M.unwrap(body, 'graphs', 'items');
      st.graphs = Array.isArray(list) ? list : [];
      st.graphsError = null;
    } catch (err) {
      st.graphs = [];
      st.graphsError = err;
    }
    renderToolbar();
    renderBanners();
  }

  async function selectGraph(graphId, preferredRevision) {
    if (!(await confirmDiscard())) { renderToolbar(); return; }
    st.graphId = graphId;
    st.record = null; st.revisions = []; st.compareRev = null; st.compareRecord = null; st.selected = null;
    st.serverCriticalPath = null; st.fitted = false; st.draft = null;
    if (ctx.state.graphId !== graphId) ctx.state.set({ graphId, revision: null });
    if (!graphId) { renderAll(); return; }
    await loadRevisions();
    const wanted = preferredRevision ?? ctx.state.revision;
    const rev = st.revisions.some((r) => Number(r.revision) === Number(wanted)) ? Number(wanted) : st.latestRevision;
    if (rev) await loadRevision(rev);
    loadRuns();
    renderAll();
  }

  async function loadRevisions() {
    try {
      const body = await api(`${g(st.graphId)}/revisions`);
      const list = M.unwrap(body, 'revisions', 'items');
      st.revisions = (Array.isArray(list) ? list : []).slice().sort((a, b) => Number(b.revision) - Number(a.revision));
    } catch (err) {
      st.revisions = [];
      ctx.notify?.(`Could not list revisions: ${errText(err)}`, 'error');
    }
    const meta = st.graphs.find((x) => x.graphId === st.graphId);
    st.latestRevision = st.revisions.length ? Number(st.revisions[0].revision) : (meta ? Number(meta.latestRevision) : null);
  }

  async function fetchRevision(rev) {
    const body = await api(`${g(st.graphId)}/revisions/${encodeURIComponent(rev)}`);
    const rec = body && body.definition ? body : M.unwrap(body, 'record', 'graph');
    if (!rec || !rec.definition) throw new Error(`revision ${rev} has no definition`);
    return rec;
  }

  async function loadRevision(rev) {
    try {
      st.record = await fetchRevision(rev);
    } catch (err) {
      st.record = null;
      ctx.notify?.(`Could not load revision ${rev}: ${errText(err)}`, 'error');
      renderAll();
      return;
    }
    st.fitted = false;
    if (Number(ctx.state.revision) !== Number(st.record.revision)) ctx.state.set({ revision: Number(st.record.revision) });
    st.serverCriticalPath = null;
    api(`${g(st.graphId)}/critical-path?revision=${encodeURIComponent(rev)}`)
      .then((body) => {
        if (!st.record || Number(st.record.revision) !== Number(rev)) return;
        st.serverCriticalPath = M.parseCriticalPath(body, M.normalizeDefinition(st.record.definition).targets) || null;
        renderDashboard(); renderGraph();
      })
      .catch(() => { /* fall back to the locally computed path */ });
    if (st.compareRev) await selectCompare(st.compareRev, true);
    renderAll();
  }

  async function selectRevision(rev) {
    if (!rev || (st.record && Number(st.record.revision) === rev)) return;
    if (!(await confirmDiscard())) { renderToolbar(); return; }
    st.draft = null;
    await loadRevision(rev);
  }

  async function selectCompare(rev, silent) {
    st.compareRev = rev;
    st.compareRecord = null;
    if (rev) {
      try { st.compareRecord = await fetchRevision(rev); } catch (err) { ctx.notify?.(`Could not load revision ${rev}: ${errText(err)}`, 'error'); }
    }
    if (!silent) { renderDiff(); renderGraph(); renderToolbar(); }
  }

  async function loadRuns() {
    if (!st.graphId) return;
    try {
      const body = await api(`runs?graphId=${encodeURIComponent(st.graphId)}`);
      const list = M.unwrap(body, 'runs', 'items');
      st.runs = (Array.isArray(list) ? list : []).filter((r) => !r.graphId || r.graphId === st.graphId);
      st.runsError = null;
    } catch (err) {
      st.runs = [];
      st.runsError = err;
    }
    renderToolbar();
  }

  async function fetchRun(runId) {
    const body = await api(`runs/${encodeURIComponent(runId)}`);
    const run = body && body.runId ? body : M.unwrap(body, 'run', 'ledger');
    if (!run || !run.runId) throw new Error('run ledger missing');
    return run;
  }

  async function selectRun(runId) {
    if (closeEvents) { closeEvents(); closeEvents = null; }
    st.run = null; st.runError = null; st.connection = '';
    st.runId = runId || null;
    if (ctx.state.runId !== (runId || null)) ctx.state.set({ runId: runId || null });
    if (!runId) { renderAll(); return; }
    try {
      const run = await fetchRun(runId);
      if (st.runId !== runId) return; // superseded by a newer selection
      st.run = run;
    } catch (err) {
      if (st.runId !== runId) return;
      st.runError = err;
      renderAll();
      return;
    }
    // Show the run's pinned revision so the overlay matches what it executes.
    if (st.run.graphId && st.run.graphId !== st.graphId && !st.draft) {
      await selectGraph(st.run.graphId, Number(st.run.graphRevision));
    } else if (st.record && Number(st.record.revision) !== Number(st.run.graphRevision) && !st.draft
      && st.revisions.some((r) => Number(r.revision) === Number(st.run.graphRevision))) {
      await loadRevision(Number(st.run.graphRevision));
    }
    closeEvents = ctx.events(runId, onRunEvent, { onStatus: (c) => { st.connection = c; renderConn(); } });
    renderAll();
  }

  function onRunEvent(ev) {
    if (!st.run || (ev.runId && ev.runId !== st.run.runId)) return;
    if (ev.type === 'graph.revision') {
      loadRevisions().then(renderToolbar);
      ctx.notify?.('A new graph revision was created. Active runs stay pinned to their revision.', 'info');
      return;
    }
    const r = M.applyEventToLedger(st.run, ev);
    if (r.changed) { st.run = r.ledger; renderLive(); }
    if (r.refetch) scheduleRefetch();
  }

  function scheduleRefetch() {
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(async () => {
      if (!st.run) return;
      try { st.run = await fetchRun(st.run.runId); renderLive(); } catch { /* keep last known ledger */ }
    }, 400);
  }

  async function refreshAll() {
    await loadGraphs();
    if (st.graphId) {
      await loadRevisions();
      if (st.record && !st.draft) await loadRevision(Number(st.record.revision));
      await loadRuns();
    }
    if (st.run) { try { st.run = await fetchRun(st.run.runId); } catch (err) { st.runError = err; } }
    renderAll();
  }

  // ---------- drafts / editing ----------
  async function confirmDiscard() {
    if (!st.draft || !M.isDirty(st.draft)) return true;
    // eslint-disable-next-line no-alert
    return window.confirm('Discard the unsaved graph edits?');
  }

  function edit(op) {
    if (!st.record) return false;
    try {
      const base = st.draft || M.createDraft({ ...st.record, graphId: st.record.graphId || st.graphId });
      st.draft = M.applyEdit(base, op);
      renderAll();
      return true;
    } catch (err) {
      ctx.notify?.(err.message, 'error');
      return false;
    }
  }

  async function saveDraft() {
    if (!st.draft || !M.isDirty(st.draft)) return;
    const req = M.revisionRequest(st.draft);
    const btn = draftBar.querySelector('[data-action="save"]');
    if (btn) btn.disabled = true;
    try {
      const body = await api(req.path, { method: 'POST', body: req.body });
      const rec = body && body.definition ? body : M.unwrap(body, 'record');
      const newRev = rec && Number(rec.revision);
      const runNote = st.run ? ` Run ${st.run.runId} stays pinned to revision ${st.run.graphRevision}.` : '';
      ctx.notify?.(`Saved revision ${newRev || '(new)'} from parent ${req.body.parentRevision}. Applies to future runs only.${runNote}`, 'ok');
      st.draft = null;
      await loadRevisions();
      await loadRevision(newRev || st.latestRevision);
    } catch (err) {
      const conflict = err.status === 409;
      ctx.notify?.(conflict
        ? `Save rejected: revision ${req.body.parentRevision} is no longer the parent the server accepts (${errText(err)}). Your draft is kept.`
        : `Save failed: ${errText(err)}. Your draft is kept.`, 'error');
      if (btn) btn.disabled = false;
    }
  }

  // ---------- import ----------
  async function doImport(projectId, yaml) {
    st.importIssues = null;
    try {
      const body = await api('graphs/import', { method: 'POST', body: { projectId, yaml } });
      const validation = body && body.validation;
      const rec = body && (body.record || (body.definition ? body : undefined));
      if (validation && validation.valid === false) st.importIssues = validation.issues || [];
      if (rec) {
        ctx.notify?.(`Imported ${rec.definition?.name || rec.graphId} as revision ${rec.revision}.`, 'ok');
        st.importOpen = false;
        await loadGraphs();
        await selectGraph(rec.graphId, Number(rec.revision));
      } else if (!st.importIssues) {
        st.importIssues = [{ code: 'SCHEMA', message: 'Import returned no record.' }];
      }
    } catch (err) {
      const issues = err.details && (err.details.issues || err.details.validation?.issues);
      st.importIssues = Array.isArray(issues) && issues.length ? issues : [{ code: err.code || 'ERROR', message: errText(err) }];
    }
    renderImport();
  }

  // ---------- seed nobel & create goal ----------
  async function seedNobel() {
    try {
      const callApi = ctx.apiJson ? (p, i) => ctx.apiJson(p, i) : api;
      const res = await callApi('graphs/seed-nobel', { method: 'POST', body: { projectId: 'nobel-example' } });
      const record = res?.record || res?.graph || res;
      const graphId = record?.graphId || res?.graphId || 'nobel-example';
      const revision = record?.revision ?? res?.revision ?? 1;
      ctx.state.set({ graphId, revision });
      ctx.notify?.(`Loaded Nobel example graph (${graphId} r${revision}).`, 'ok');
      await loadGraphs();
      await selectGraph(graphId, revision);
      return res;
    } catch (err) {
      ctx.notify?.(`Failed to load Nobel example: ${errText(err)}`, 'error');
      throw err;
    }
  }

  async function createGoal(customParams = {}) {
    const name = customParams.name || createNameInput?.value?.trim() || st.createName || 'New Goal';
    const objective = customParams.objective || createObjInput?.value?.trim() || st.createObjective || 'Autonomous goal execution';
    const projectId = customParams.projectId || createProjInput?.value?.trim() || st.createProject || 'default';
    try {
      const callApi = ctx.apiJson ? (p, i) => ctx.apiJson(p, i) : api;
      const res = await callApi('graphs/create', { method: 'POST', body: { name, objective, projectId } });
      const record = res?.record || res?.graph || res;
      const graphId = record?.graphId || res?.graphId;
      const revision = record?.revision ?? res?.revision ?? 1;
      if (graphId) {
        ctx.state.set({ graphId, revision });
        ctx.notify?.(`Created goal graph "${name}" (${graphId} r${revision}).`, 'ok');
        st.createOpen = false;
        renderCreate();
        await loadGraphs();
        await selectGraph(graphId, revision);
      }
      return res;
    } catch (err) {
      ctx.notify?.(`Failed to create goal: ${errText(err)}`, 'error');
      throw err;
    }
  }

  // ---------- rendering ----------
  function renderAll() {
    if (disposed) return;
    renderToolbar();
    renderCreate();
    renderImport();
    renderBanners();
    renderDashboard();
    renderDraftBar();
    renderDiff();
    renderGraph();
    renderInspector();
    renderConn();
  }
  function renderLive() {
    renderBanners();
    renderDashboard();
    renderGraph();
    if (!inspector.contains(document.activeElement)) renderInspector();
  }

  function option(value, label, selected) {
    const o = h('option', { value: value ?? '' }, label);
    if (selected) o.selected = true;
    return o;
  }

  function renderToolbar() {
    graphSel.replaceChildren(option('', st.graphs.length ? '— select graph —' : '(no graphs)', !st.graphId),
      ...st.graphs.map((x) => option(x.graphId, `${x.name || x.graphId} · r${x.latestRevision ?? '?'}`, x.graphId === st.graphId)));
    if (st.graphId && !st.graphs.some((x) => x.graphId === st.graphId)) graphSel.append(option(st.graphId, st.graphId, true));
    const curRev = st.record ? Number(st.record.revision) : null;
    const pinned = st.run ? Number(st.run.graphRevision) : null;
    const revLabel = (r) => {
      const n = Number(r.revision);
      const tags = [n === st.latestRevision ? 'latest' : '', n === pinned ? 'pinned by run' : ''].filter(Boolean).join(', ');
      return `r${n}${tags ? ` (${tags})` : ''} · ${shortDigest(r.digest).slice(0, 8)}`;
    };
    revSel.replaceChildren(...(st.revisions.length ? st.revisions.map((r) => option(r.revision, revLabel(r), Number(r.revision) === curRev)) : [option('', '—', true)]));
    revSel.disabled = !st.revisions.length;
    cmpSel.replaceChildren(option('', 'none', !st.compareRev),
      ...st.revisions.filter((r) => Number(r.revision) !== curRev).map((r) => option(r.revision, `r${r.revision}`, Number(r.revision) === st.compareRev)));
    cmpSel.disabled = st.revisions.length < 2;
    const runIds = new Set(st.runs.map((r) => r.runId));
    runSel.replaceChildren(option('', st.runsError ? '(runs unavailable)' : st.runs.length ? 'none' : '(no runs)', !st.run),
      ...st.runs.map((r) => option(r.runId, `${r.runId} · ${r.status} · r${r.graphRevision}`, st.run && r.runId === st.run.runId)));
    if (st.run && !runIds.has(st.run.runId)) runSel.append(option(st.run.runId, `${st.run.runId} · ${st.run.status} · r${st.run.graphRevision}`, true));

    statusFilterSel.replaceChildren(
      option('', 'all statuses', !st.filterStatus),
      ...M.TARGET_STATUSES.map((sName) => option(sName, `${M.statusMeta(sName).glyph} ${M.statusMeta(sName).label}`, st.filterStatus === sName)),
      option(M.NO_RUN_STATUS, 'Not in run', st.filterStatus === M.NO_RUN_STATUS),
    );
    const stages = M.extractStages(currentTargets());
    stageFilterSel.replaceChildren(
      option('', 'all stages', !st.filterStage),
      ...stages.map((stg) => option(stg.stage, `${stg.label} (${stg.targetIds.length})`, st.filterStage === stg.stage)),
    );
  }

  function renderConn() {
    if (!st.run) { connChip.textContent = 'no run'; connChip.className = 'gs-chip gs-muted'; return; }
    const label = { open: '● live', connecting: '○ connecting', reconnecting: '◌ reconnecting', closed: '■ closed', unsupported: 'no SSE' }[st.connection] || '○';
    connChip.textContent = `${label} · run ${st.run.status}`;
    connChip.className = `gs-chip ${st.connection === 'open' ? '' : 'gs-muted'}`;
  }

  function renderImport() {
    importBox.hidden = !st.importOpen;
    if (!st.importOpen) return;
    const project = h('input', { type: 'text', value: 'default', size: 16, 'aria-label': 'Project id' });
    const ta = h('textarea', { spellcheck: 'false', placeholder: 'Paste a goal graph YAML (e.g. nobel_goal_graph.yaml)…', 'aria-label': 'Goal graph YAML', oninput: (e) => { st.importYamlText = e.target.value; } });
    if (st.importYamlText) ta.value = st.importYamlText;
    const file = h('input', { type: 'file', accept: '.yaml,.yml,text/yaml,text/plain', 'aria-label': 'Load YAML file',
      onchange: () => { const f = file.files && file.files[0]; if (f) f.text().then((t) => { st.importYamlText = t; ta.value = t; }); } });
    const loadPresetBtn = h('button', {
      class: 'gs-btn gs-btn-sm',
      type: 'button',
      'data-action': 'load-nobel-preset',
      onclick: () => {
        st.importYamlText = M.NOBEL_PRESET_YAML;
        ta.value = M.NOBEL_PRESET_YAML;
        ctx.notify?.('Loaded nobel_goal_graph.yaml preset into editor.', 'info');
      },
    }, 'Load nobel_goal_graph.yaml preset');
    const issues = st.importIssues && st.importIssues.length
      ? h('div', { class: 'gs-banner gs-banner-err', role: 'alert' }, h('b', {}, 'Validation failed'),
        h('ul', { class: 'gs-list' }, st.importIssues.map((i) => h('li', {}, `${i.code || ''} ${i.path ? `(${i.path}) ` : ''}${i.message || ''}${i.targetIds?.length ? ` [${i.targetIds.join(', ')}]` : ''}`))))
      : null;
    importBox.replaceChildren(
      h('h3', {}, 'Import goal graph (YAML)'),
      h('p', { class: 'gs-muted', style: 'margin:0 0 6px' }, 'The server validates the graph (schema, unknown dependencies, cycles) and stores it as revision 1 of a new graph.'),
      h('div', { class: 'gs-row', style: 'margin-bottom:6px' }, h('label', { class: 'gs-field' }, 'Project', project), file, loadPresetBtn),
      ta,
      issues,
      h('div', { class: 'gs-row', style: 'margin-top:6px' },
        h('button', { class: 'gs-btn gs-btn-primary', type: 'button', 'data-action': 'submit-import', onclick: () => ta.value.trim() ? doImport(project.value.trim() || 'default', ta.value) : ctx.notify?.('Paste YAML first', 'error') }, 'Import'),
        h('button', { class: 'gs-btn gs-btn-ghost', type: 'button', onclick: () => { st.importOpen = false; renderImport(); } }, 'Cancel')),
    );
  }

  let createNameInput = null;
  let createObjInput = null;
  let createProjInput = null;

  function renderCreate() {
    createBox.hidden = !st.createOpen;
    if (!st.createOpen) return;
    createProjInput = h('input', { type: 'text', value: st.createProject || 'default', size: 16, 'aria-label': 'Project id', oninput: (e) => { st.createProject = e.target.value; } });
    createNameInput = h('input', { type: 'text', value: st.createName || 'New Goal', placeholder: 'e.g. Formal Verification Pipeline', 'aria-label': 'Goal name', oninput: (e) => { st.createName = e.target.value; } });
    createObjInput = h('textarea', { rows: 2, placeholder: 'Objective / description of this autonomous goal…', 'aria-label': 'Goal objective', oninput: (e) => { st.createObjective = e.target.value; } });
    if (st.createObjective) createObjInput.value = st.createObjective;

    createBox.replaceChildren(
      h('h3', {}, 'Create New Goal Graph'),
      h('p', { class: 'gs-muted', style: 'margin:0 0 6px' }, 'Initialize an autonomous goal graph on the server with name and objective.'),
      h('div', { class: 'gs-row', style: 'margin-bottom:6px' },
        h('label', { class: 'gs-field' }, 'Project', createProjInput),
        h('label', { class: 'gs-field', style: 'flex:1' }, 'Name', createNameInput)),
      h('label', { class: 'gs-field' }, 'Objective', createObjInput),
      h('div', { class: 'gs-row', style: 'margin-top:6px' },
        h('button', {
          class: 'gs-btn gs-btn-primary',
          type: 'button',
          'data-action': 'submit-create-goal',
          onclick: () => createGoal({
            name: createNameInput.value.trim() || 'New Goal',
            objective: createObjInput.value.trim() || 'Autonomous goal execution',
            projectId: createProjInput.value.trim() || 'default',
          }),
        }, 'Create Goal'),
        h('button', {
          class: 'gs-btn gs-btn-ghost',
          type: 'button',
          onclick: () => { st.createOpen = false; renderCreate(); },
        }, 'Cancel')),
    );
  }

  function renderBanners() {
    const out = [];
    if (st.graphsError) out.push(h('div', { class: 'gs-banner gs-banner-err', role: 'alert' }, `Goal graph API unavailable: ${errText(st.graphsError)}`));
    if (st.runError) out.push(h('div', { class: 'gs-banner gs-banner-warn' }, `Run ledger unavailable: ${errText(st.runError)}`));
    if (st.run) {
      const p = M.pinInfo(st.run, st.record?.revision, st.latestRevision);
      const parts = [
        h('b', {}, `Run ${p.runId}`), ` (${st.run.status}) is pinned to revision ${p.pinnedRevision} · digest ${shortDigest(p.digest)}. `,
        'Graph edits create a new revision and apply to future runs only — this run keeps executing its pinned snapshot.',
      ];
      if (!p.viewingPinned && st.record) parts.push(h('div', { class: 'gs-muted' }, `You are viewing r${st.record.revision}; live statuses come from the run's pinned r${p.pinnedRevision}. Targets that differ between them may not match.`));
      if (p.behindLatest) parts.push(h('div', { class: 'gs-muted' }, `A newer revision (r${st.latestRevision}) exists; start a new run to execute it.`));
      out.push(h('div', { class: `gs-banner ${p.active ? 'gs-banner-ok' : ''}` }, parts));
    }
    if (st.record && st.latestRevision && Number(st.record.revision) !== st.latestRevision && !st.run) {
      out.push(h('div', { class: 'gs-banner gs-banner-warn' }, `Viewing r${st.record.revision}; latest is r${st.latestRevision}. Edits made here are saved as a new revision with parentRevision ${st.record.revision}.`));
    }
    banners.replaceChildren(...out);
  }

  function criticalPathInfo(targets) {
    if (st.run || st.draft || !st.serverCriticalPath) return { path: M.criticalPath(targets, st.run), source: st.run ? 'remaining work, computed locally' : st.draft ? 'draft, computed locally' : 'computed locally' };
    return { path: st.serverCriticalPath, source: 'server' };
  }

  function selectButton(id) {
    const status = M.statusOf(st.run, id);
    return h('button', { class: 'gs-link', type: 'button', title: currentTargets().find((t) => t.id === id)?.title || id, onclick: () => selectTarget(id) },
      h('i', { class: `gs-dot gs-st-${M.statusMeta(status).cls}`, style: 'margin-right:3px' }), id);
  }

  function renderDashboard() {
    const def = currentDefinition();
    if (!def) {
      dash.replaceChildren();
      if (!st.graphId) {
        dash.append(h('div', { class: 'gs-card', style: 'grid-column:1/-1' },
          h('h3', {}, 'Strategic dashboard'),
          h('p', { style: 'margin:0' }, st.graphs.length ? 'Select a goal graph above, or import one.' : 'No goal graphs yet. Use "Import YAML" to load a goal graph such as nobel_goal_graph.yaml.')));
      }
      return;
    }
    const targets = def.targets;
    const counts = M.statusCounts(targets, st.run);
    const statuses = st.run ? M.TARGET_STATUSES : [];
    const countCard = h('div', { class: 'gs-card' },
      h('h3', {}, st.run ? `Targets by status · ${targets.length} total` : `Targets · ${targets.length} total (select a run for live status)`),
      h('div', { class: 'gs-counts' },
        statuses.map((sname) => h('span', { class: `gs-count ${counts[sname] ? '' : 'gs-zero'}`, title: sname },
          h('i', { class: `gs-dot gs-st-${M.statusMeta(sname).cls}` }), M.statusMeta(sname).label, h('b', {}, String(counts[sname])))),
        !st.run || counts[M.NO_RUN_STATUS] ? h('span', { class: 'gs-count' }, h('i', { class: 'gs-dot gs-st-none' }), st.run ? 'Not in ledger' : 'Defined', h('b', {}, String(counts[M.NO_RUN_STATUS]))) : null,
      ),
      h('div', { class: 'gs-row gs-muted', style: 'margin-top:8px' },
        `stages: ${[...new Set(targets.map((t) => t.stage))].filter(Boolean).join(' → ') || '—'}`),
      st.run ? h('div', { class: 'gs-muted' }, `tasks started ${st.run.resource?.tasksStarted ?? 0}/${def.constitution?.resourceLimits?.maxTasksPerRun ?? '?'} · hosted spend $${st.run.resource?.hostedSpendUsd ?? 0} of $${def.constitution?.resourceLimits?.hostedSpendUsd ?? 0}`) : null,
    );
    const cp = criticalPathInfo(targets);
    const cpEls = [];
    cp.path.forEach((id, i) => { if (i) cpEls.push(h('span', { class: 'gs-arrow' }, '→')); cpEls.push(selectButton(id)); });
    const cpCard = h('div', { class: 'gs-card' },
      h('h3', {}, `Critical path · ${cp.path.length} targets`),
      h('div', { class: 'gs-cpath' }, cpEls.length ? cpEls : h('span', { class: 'gs-muted' }, st.run ? 'all done' : '—')),
      h('div', { class: 'gs-muted', style: 'margin-top:6px;font-size:11px' }, `source: ${cp.source}`));
    const bl = M.blockers(targets, st.run);
    const blCard = h('div', { class: 'gs-card' },
      h('h3', {}, st.run ? `Blockers & attention · ${bl.length}` : `Human / external gates · ${bl.length}`),
      bl.length
        ? h('ul', { class: 'gs-list gs-scroll' }, bl.map((b) => h('li', {}, selectButton(b.targetId), ' ', h('span', { class: 'gs-muted' }, b.reason))))
        : h('span', { class: 'gs-muted' }, 'none'));
    dash.replaceChildren(countCard, cpCard, blCard);
  }

  function renderDraftBar() {
    if (!st.draft) { draftBar.hidden = true; draftBar.replaceChildren(); return; }
    const ch = M.draftChanges(st.draft);
    const n = ch.added.length + ch.removed.length + ch.changed.reduce((a, c) => a + c.fields.length, 0);
    draftBar.hidden = false;
    draftBar.className = 'gs-draftbar';
    draftBar.replaceChildren(
      h('b', {}, '✎ Draft'),
      h('span', {}, `based on r${st.draft.baseRevision} · ${n} change${n === 1 ? '' : 's'} (${st.draft.ops.length} edit op${st.draft.ops.length === 1 ? '' : 's'})`),
      h('span', { class: 'gs-muted' }, `Saving creates r${(st.latestRevision || st.draft.baseRevision) + 1}-or-later with parentRevision ${st.draft.baseRevision}; no run's pinned revision changes.`),
      h('span', { class: 'gs-spacer' }),
      h('button', { class: 'gs-btn gs-btn-primary', type: 'button', 'data-action': 'save', disabled: n === 0, onclick: saveDraft }, 'Save as new revision'),
      h('button', { class: 'gs-btn gs-btn-danger', type: 'button', onclick: () => { st.draft = null; renderAll(); } }, 'Discard'),
    );
  }

  function activeDiff() {
    if (st.draft && M.isDirty(st.draft)) return { diff: M.draftChanges(st.draft), title: `Draft changes vs r${st.draft.baseRevision}` };
    if (st.compareRecord && st.record) {
      const older = Number(st.compareRecord.revision) < Number(st.record.revision);
      const [a, b] = older ? [st.compareRecord, st.record] : [st.record, st.compareRecord];
      return { diff: M.diffDefinitions(a.definition, b.definition), title: `Changes r${a.revision} → r${b.revision}`, reversed: !older };
    }
    return null;
  }

  function fmtVal(v) {
    if (Array.isArray(v)) return v.length ? v.join(' | ') : '[]';
    if (v === undefined) return '—';
    return String(v);
  }

  function renderDiff() {
    const d = activeDiff();
    if (!d) { diffBox.hidden = true; diffBox.replaceChildren(); return; }
    diffBox.hidden = false;
    const { diff } = d;
    const items = [];
    for (const id of diff.added) items.push(h('li', { class: 'gs-add' }, '+ target ', selectButton(id)));
    for (const id of diff.removed) items.push(h('li', { class: 'gs-rem' }, `− target ${id}`));
    for (const c of diff.changed) {
      items.push(h('li', { class: 'gs-chg' }, '~ ', selectButton(c.targetId), h('ul', { class: 'gs-list' }, c.fields.map((f) => f.field === 'dependsOn'
        ? h('li', {}, 'dependsOn ', f.added.map((x) => h('span', { class: 'gs-add' }, ` +${x}`)), f.removed.map((x) => h('span', { class: 'gs-rem' }, ` −${x}`)))
        : h('li', {}, `${f.field}: `, h('span', { class: 'gs-rem' }, fmtVal(f.from)), ' → ', h('span', { class: 'gs-add' }, fmtVal(f.to)))))));
    }
    for (const k of diff.other) items.push(h('li', { class: 'gs-chg' }, `~ ${k} changed`));
    diffBox.replaceChildren(h('h3', {}, d.title), diff.empty ? h('span', { class: 'gs-muted' }, 'No differences.') : h('ul', { class: 'gs-list gs-scroll', style: 'max-height:180px' }, items));
  }

  function renderGraph() {
    const def = currentDefinition();
    viewport.replaceChildren();
    if (!def) {
      viewport.append(s('text', { x: 24, y: 40, fill: 'currentColor', class: 'gs-muted', text: st.graphId ? 'Loading graph…' : 'No graph selected.' }));
      return;
    }
    const targets = def.targets;
    const layout = M.layoutGraph(targets);
    st.layout = layout;
    const byId = new Map(targets.map((t) => [t.id, t]));
    const cp = criticalPathInfo(targets).path;
    const cpNodes = new Set(cp);
    const cpEdges = M.pathEdges(cp);
    const d = activeDiff();
    const added = new Set(d && !d.reversed ? d.diff.added : d ? d.diff.removed : []);
    const changed = new Set(d ? d.diff.changed.map((c) => c.targetId) : []);
    let related = null;
    if (st.selected && byId.has(st.selected)) {
      related = new Set([st.selected, ...M.ancestors(targets, st.selected), ...M.descendants(targets, st.selected)]);
    }
    const hasFilter = Boolean((st.searchQuery && st.searchQuery.trim()) || st.filterStatus || st.filterStage);
    const matchedIds = hasFilter ? M.filterTargets(targets, st.run, { query: st.searchQuery, status: st.filterStatus, stage: st.filterStage }) : null;

    // Multi-year stage swimlanes
    const laneLayer = s('g', { class: 'gs-swimlanes' });
    for (const lane of layout.swimlanes || []) {
      const isStageFiltered = st.filterStage && st.filterStage !== lane.stage;
      laneLayer.append(
        s('g', { class: `gs-swimlane${isStageFiltered ? ' gs-dim' : ''}`, 'data-stage': lane.stage },
          s('rect', { class: 'gs-swimlane-bg', x: lane.x, y: lane.y, width: lane.width, height: lane.height, rx: 10 }),
          s('text', { class: 'gs-swimlane-title', x: lane.x + 12, y: lane.y + 18, text: `${lane.label} (${lane.targetIds.length})` }),
        ),
      );
    }

    const edgeLayer = s('g', { class: 'gs-edges' });
    for (const e of layout.edges) {
      const key = `${e.from}->${e.to}`;
      const isRel = st.selected && (e.from === st.selected || e.to === st.selected);
      const isCrit = cpEdges.has(key);
      const chainDim = related && st.focusChain && !(related.has(e.from) && related.has(e.to));
      const filterDim = matchedIds && !(matchedIds.has(e.from) || matchedIds.has(e.to));
      const dim = chainDim || filterDim;
      edgeLayer.append(s('path', {
        d: e.path,
        class: `gs-edge${isCrit ? ' gs-critical' : ''}${isRel ? ' gs-related' : ''}${dim ? ' gs-dim' : ''}`,
        'marker-end': `url(#gs-arrow${isRel ? '-related' : isCrit ? '-critical' : ''})`,
      }, s('title', { text: `${e.to} depends on ${e.from}` })));
    }
    const nodeLayer = s('g', { class: 'gs-nodes' });
    for (const n of layout.nodes) {
      const t = byId.get(n.id);
      const status = M.statusOf(st.run, n.id);
      const meta = M.statusMeta(status);
      const cls = ['gs-node', `gs-st-${meta.cls}`];
      if (n.id === st.selected) cls.push('gs-selected');
      if (cpNodes.has(n.id)) cls.push('gs-critical');
      if (added.has(n.id)) cls.push('gs-diff-added');
      else if (changed.has(n.id)) cls.push('gs-diff-changed');
      const chainDim = related && st.focusChain && !related.has(n.id);
      const filterDim = matchedIds && !matchedIds.has(n.id);
      if (chainDim || filterDim) cls.push('gs-dim');
      const lines = wrapText(t.title, 30, 2);
      const flags = [t.externalDependency ? 'EXT' : '', t.requiresApproval ? 'APR' : ''].filter(Boolean).join(' ');
      const node = s('g', {
        class: cls.join(' '), transform: `translate(${n.x},${n.y})`, tabindex: '0', role: 'button',
        'data-target': n.id, 'data-stage': t.stage, 'data-status': status,
        'aria-label': `${n.id}: ${t.title}. Status ${meta.label}.`,
      },
      s('title', { text: `${n.id} — ${t.title}\nstatus: ${meta.label}\npriority ${t.priority} · ${t.executor}${t.externalDependency ? '\nneeds external record' : ''}${t.requiresApproval ? '\nneeds human approval' : ''}` }),
      s('rect', { class: 'gs-body', width: n.width, height: n.height, rx: 8 }),
      s('rect', { class: 'gs-band', width: 6, height: n.height, rx: 3 }),
      s('text', { class: 'gs-node-id', x: 14, y: 16, text: n.id }),
      s('text', { class: 'gs-node-meta', x: n.width - 8, y: 16, 'text-anchor': 'end', text: `P${t.priority}${flags ? ' · ' + flags : ''}` }),
      lines.map((l, i) => s('text', { x: 14, y: 33 + i * 14, text: l })),
      s('text', { class: 'gs-node-status', x: 14, y: n.height - 8, text: `${meta.glyph} ${meta.label}` }),
      s('text', { class: 'gs-node-meta', x: n.width - 8, y: n.height - 8, 'text-anchor': 'end', text: t.executor }),
      );
      node.addEventListener('click', (e) => { if (drag.moved) return; e.stopPropagation(); selectTarget(n.id); });
      node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectTarget(n.id); } });
      nodeLayer.append(node);
    }
    viewport.append(laneLayer, edgeLayer, nodeLayer);
    if (layout.cyclic.length) viewport.append(s('text', { x: 24, y: layout.height + 10, fill: 'var(--err)', text: `cycle detected among: ${layout.cyclic.join(', ')}` }));
    if (!st.fitted) fit(); else applyView();
  }

  function selectTarget(id) {
    st.selected = id === st.selected ? null : id;
    if (st.selected && st.run) {
      const key = `${st.run.runId}:${st.selected}`;
      if (!st.evidenceRecords[key]) {
        api(`runs/${encodeURIComponent(st.run.runId)}/evidence?targetId=${encodeURIComponent(st.selected)}`)
          .then((body) => {
            const list = M.unwrap(body, 'evidence', 'items', 'records');
            if (Array.isArray(list)) {
              st.evidenceRecords[key] = list;
              if (st.selected === id) renderInspector();
            }
          })
          .catch(() => { /* ignore if verification route not mounted */ });
      }
    }
    renderGraph();
    renderInspector();
  }

  function kv(pairs) {
    return h('dl', { class: 'gs-kv' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')]));
  }

  function renderInspector() {
    const def = currentDefinition();
    if (!def) {
      inspector.replaceChildren(h('h2', {}, 'Inspector'), h('p', { class: 'gs-muted' }, 'Select or import a goal graph.'));
      return;
    }
    const t = st.selected && def.targets.find((x) => x.id === st.selected);
    if (!t) { renderGraphSummary(def); return; }
    const targets = def.targets;
    const idx = M.indexGraph(targets);
    const status = M.statusOf(st.run, t.id);
    const meta = M.statusMeta(status);
    const entry = st.run?.targets?.[t.id];
    const cp = new Set(criticalPathInfo(targets).path);
    const layer = st.layout?.layer?.get(t.id);
    const children = [
      h('div', { class: 'gs-row' }, h('h2', {}, t.id), h('span', { class: `gs-status gs-st-${meta.cls}` }, `${meta.glyph} ${meta.label}`), h('span', { class: 'gs-spacer' }),
        h('button', { class: 'gs-btn gs-btn-sm gs-btn-ghost', type: 'button', title: 'Close inspector', onclick: () => selectTarget(t.id) }, '×')),
      h('div', {}, t.title),
      h('div', { class: 'gs-badges' },
        t.externalDependency ? h('span', { class: 'gs-badge gs-badge-ext', title: 'Completion needs an external-record or human-signoff evidence record' }, 'EXTERNAL DEPENDENCY') : null,
        t.requiresApproval ? h('span', { class: 'gs-badge gs-badge-appr', title: 'Completion/execution needs explicit human approval' }, 'REQUIRES APPROVAL') : null,
        cp.has(t.id) ? h('span', { class: 'gs-badge gs-badge-crit' }, 'CRITICAL PATH') : null),
      kv([['stage', t.stage], ['executor', t.executor], ['priority', String(t.priority)], ['layer', layer === undefined ? '—' : String(layer)]]),
    ];
    if (st.run) {
      children.push(h('div', { class: 'gs-section' }, h('h4', {}, `Ledger · run ${st.run.runId}`), entry ? kv([
        ['attempts', String(entry.attempts ?? 0)],
        ['repairs', String(entry.repairs ?? 0)],
        ['last attempt', entry.lastAttemptId],
        ['execution', entry.lastExecutionId],
        ['updated', fmtTime(entry.updatedAt)],
        entry.blockers?.length ? ['blockers', entry.blockers.join('; ')] : null,
      ]) : h('span', { class: 'gs-muted' }, 'Not in this run\'s ledger (target may not exist in the pinned revision).')));
      const evIds = entry?.evidenceIds || [];
      const fetchedEv = st.evidenceRecords[`${st.run.runId}:${t.id}`] || [];
      children.push(h('div', { class: 'gs-section' }, h('h4', {}, `Evidence · ${Math.max(evIds.length, fetchedEv.length)}`),
        fetchedEv.length
          ? h('ul', { class: 'gs-list' }, fetchedEv.map((ev) => h('li', {},
              h('b', {}, ev.verdict || 'RECORD'),
              ` · ${ev.validationMethod || 'check'} · validator: ${ev.validatorIdentity || '?'}`,
              ev.criterion ? h('div', { class: 'gs-muted' }, ev.criterion) : null,
            )))
          : evIds.length
            ? h('ul', { class: 'gs-list' }, evIds.map((id) => h('li', {}, h('code', {}, id))))
            : h('span', { class: 'gs-muted' }, 'none recorded'),
        h('div', {}, h('a', { href: `/api/v1/goal-studio/runs/${encodeURIComponent(st.run.runId)}/evidence?targetId=${encodeURIComponent(t.id)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Open evidence records ↗'))));
    }
    const depList = (ids, empty) => ids.length ? h('div', { class: 'gs-deps' }, ids.map((id) => selectButton(id))) : h('span', { class: 'gs-muted' }, empty);
    children.push(
      h('div', { class: 'gs-section' }, h('h4', {}, `Depends on · ${idx.deps.get(t.id).length}`), depList(idx.deps.get(t.id), 'none (root target)')),
      h('div', { class: 'gs-section' }, h('h4', {}, `Dependents · ${idx.dependents.get(t.id).length}`), depList(idx.dependents.get(t.id), 'none (leaf target)')),
      h('div', { class: 'gs-section' }, h('h4', {}, `Acceptance criteria · ${t.acceptance.length}`), h('ol', { class: 'gs-list' }, t.acceptance.map((a) => h('li', {}, a)))),
      h('div', { class: 'gs-section' }, h('h4', {}, `Artifacts · ${t.artifacts.length}`), t.artifacts.length ? h('ul', { class: 'gs-list' }, t.artifacts.map((a) => h('li', {}, h('code', {}, a)))) : h('span', { class: 'gs-muted' }, 'none')),
      h('label', { class: 'gs-row gs-muted' }, (() => { const c = h('input', { type: 'checkbox', onchange: (e) => { st.focusChain = e.target.checked; renderGraph(); } }); c.checked = st.focusChain; return c; })(), 'Dim targets outside this dependency chain'),
      renderEditor(t),
    );
    inspector.replaceChildren(...children);
  }

  function renderEditor(t) {
    if (!st.record) return null;
    const wrap = h('div', { class: 'gs-edit' }, h('h4', { style: 'margin:0' }, 'Edit (creates a new revision)'));
    if (st.run) wrap.append(h('div', { class: 'gs-muted', style: 'font-size:11px' }, `Run ${st.run.runId} remains pinned to r${st.run.graphRevision}; these edits apply to future runs only.`));
    const title = h('input', { type: 'text', value: t.title, 'aria-label': 'Title' });
    const prio = h('input', { type: 'number', value: String(t.priority), step: '1', 'aria-label': 'Priority', style: 'width:90px' });
    const acc = h('textarea', { rows: Math.min(8, Math.max(3, t.acceptance.length + 1)), 'aria-label': 'Acceptance criteria, one per line' });
    acc.value = t.acceptance.join('\n');
    const draft = st.draft || M.createDraft({ ...st.record, graphId: st.record.graphId || st.graphId });
    const candidates = M.dependencyCandidates(draft, t.id);
    const addSel = h('select', { 'aria-label': 'Add dependency' }, option('', candidates.length ? 'add dependency…' : '(no valid candidates)', true), candidates.map((id) => option(id, id)));
    wrap.append(
      h('label', { class: 'gs-field' }, 'Title', h('div', { class: 'gs-row' }, title,
        h('button', { class: 'gs-btn gs-btn-sm', type: 'button', onclick: () => title.value.trim() !== t.title && edit({ op: 'setTitle', targetId: t.id, title: title.value }) }, 'Apply'))),
      h('label', { class: 'gs-field' }, 'Priority', h('div', { class: 'gs-row' }, prio,
        h('button', { class: 'gs-btn gs-btn-sm', type: 'button', onclick: () => Number(prio.value) !== t.priority && edit({ op: 'setPriority', targetId: t.id, priority: prio.value }) }, 'Apply'))),
      h('label', { class: 'gs-field' }, 'Acceptance criteria (one per line)', acc,
        h('div', {}, h('button', { class: 'gs-btn gs-btn-sm', type: 'button', onclick: () => edit({ op: 'setAcceptance', targetId: t.id, acceptance: acc.value }) }, 'Apply'))),
      h('div', { class: 'gs-field' }, 'Dependencies',
        h('div', { class: 'gs-deps' }, t.dependsOn.length ? t.dependsOn.map((d) => h('span', { class: 'gs-chip' }, d,
          h('button', { class: 'gs-btn gs-btn-sm gs-btn-ghost gs-btn-danger', type: 'button', title: `Remove dependency on ${d}`, 'aria-label': `Remove dependency on ${d}`, onclick: () => edit({ op: 'removeDependency', targetId: t.id, dependsOn: d }) }, '×')))
          : h('span', { class: 'gs-muted' }, 'none')),
        h('div', { class: 'gs-row', style: 'margin-top:4px' }, addSel,
          h('button', { class: 'gs-btn gs-btn-sm', type: 'button', onclick: () => addSel.value && edit({ op: 'addDependency', targetId: t.id, dependsOn: addSel.value }) }, 'Add'))),
    );
    return wrap;
  }

  function renderGraphSummary(def) {
    const rec = st.record;
    const lim = def.constitution?.resourceLimits || {};
    inspector.replaceChildren(
      h('h2', {}, def.name || st.graphId),
      def.purpose ? h('p', { class: 'gs-muted', style: 'margin:0' }, def.purpose) : null,
      kv([
        ['graph', st.graphId],
        ['revision', rec ? `r${rec.revision}${Number(rec.revision) === st.latestRevision ? ' (latest)' : ''}` : '—'],
        ['parent', rec?.parentRevision ? `r${rec.parentRevision}` : '—'],
        ['digest', rec ? h('code', { title: rec.digest }, shortDigest(rec.digest)) : '—'],
        ['created', rec ? `${fmtTime(rec.createdAt)} by ${rec.createdBy || '?'}` : '—'],
        ['targets', String(def.targets.length)],
        ['schema', def.schemaVersion],
      ]),
      h('div', { class: 'gs-section' }, h('h4', {}, 'Resource limits'), kv(Object.entries(lim).map(([k, v]) => [k, String(v)]))),
      def.constitution?.needsApproval?.length ? h('div', { class: 'gs-section' }, h('h4', {}, 'Needs approval'), h('ul', { class: 'gs-list' }, def.constitution.needsApproval.map((x) => h('li', {}, x)))) : null,
      h('div', { class: 'gs-section' }, h('h4', {}, 'Revisions'), st.revisions.length ? h('ul', { class: 'gs-list gs-scroll' }, st.revisions.map((r) => h('li', {},
        h('button', { class: 'gs-link', type: 'button', onclick: () => selectRevision(Number(r.revision)) }, `r${r.revision}`),
        ` ${shortDigest(r.digest).slice(0, 8)} · ${fmtTime(r.createdAt)} · ${r.createdBy || ''}`,
        st.run && Number(st.run.graphRevision) === Number(r.revision) ? h('b', {}, ' ← pinned by run') : null))) : h('span', { class: 'gs-muted' }, '—')),
      h('p', { class: 'gs-muted' }, 'Click a target to inspect dependencies, acceptance criteria, artifacts and evidence, or to edit it. Scroll to zoom, drag to pan.'),
    );
  }

  // ---------- zoom / pan ----------
  const drag = { active: false, moved: false, x: 0, y: 0, id: null };
  function applyView() {
    viewport.setAttribute('transform', `translate(${st.view.x},${st.view.y}) scale(${st.view.k})`);
  }
  function fit() {
    const r = svg.getBoundingClientRect();
    if (!st.layout || !r.width || !r.height) { applyView(); return; }
    st.view = M.fitView(st.layout.width, st.layout.height + 40, r.width, r.height);
    st.fitted = true;
    applyView();
  }
  function zoomCenter(f) {
    const r = svg.getBoundingClientRect();
    st.view = M.zoomAt(st.view, f, r.width / 2, r.height / 2);
    applyView();
  }
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    st.view = M.zoomAt(st.view, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    applyView();
  }, { passive: false });
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    Object.assign(drag, { active: true, moved: false, x: e.clientX, y: e.clientY, id: e.pointerId });
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag.active || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) { drag.moved = true; svg.classList.add('gs-dragging'); try { svg.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
    st.view = M.panBy(st.view, dx, dy);
    drag.x = e.clientX; drag.y = e.clientY;
    applyView();
  });
  const endDrag = (e) => {
    if (!drag.active || (e && e.pointerId !== drag.id)) return;
    drag.active = false;
    svg.classList.remove('gs-dragging');
    setTimeout(() => { drag.moved = false; }, 0);
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('click', (e) => { if (!drag.moved && e.target === svg && st.selected) selectTarget(st.selected); });
  svg.addEventListener('keydown', (e) => {
    if (e.target !== svg) return;
    const step = 40;
    const map = { '+': () => zoomCenter(1.2), '=': () => zoomCenter(1.2), '-': () => zoomCenter(1 / 1.2), '0': () => fit(),
      ArrowLeft: () => { st.view = M.panBy(st.view, step, 0); }, ArrowRight: () => { st.view = M.panBy(st.view, -step, 0); },
      ArrowUp: () => { st.view = M.panBy(st.view, 0, step); }, ArrowDown: () => { st.view = M.panBy(st.view, 0, -step); },
      Escape: () => { if (st.selected) selectTarget(st.selected); } };
    if (map[e.key]) { e.preventDefault(); map[e.key](); applyView(); }
  });
  const panel = root.closest('.gs-panel');
  const onShow = () => { if (!st.fitted) fit(); };
  panel?.addEventListener('goal-studio:show', onShow);
  let ro;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { if (!st.fitted) fit(); });
    ro.observe(svg);
  }

  // ---------- shared state ----------
  unsubs.push(ctx.state.subscribe((next, _prev, changed) => {
    if (changed.includes('graphId') && next.graphId !== st.graphId && next.graphId) selectGraph(next.graphId);
    if (changed.includes('runId') && (next.runId || null) !== st.runId) selectRun(next.runId);
  }));

  // ---------- boot ----------
  renderAll();
  (async () => {
    await loadGraphs();
    const initialGraph = ctx.state.graphId || (st.graphs.length === 1 ? st.graphs[0].graphId : null);
    if (initialGraph) await selectGraph(initialGraph, ctx.state.revision ?? undefined);
    if (ctx.state.runId) await selectRun(ctx.state.runId);
  })();

  return {
    dispose() {
      disposed = true;
      if (closeEvents) closeEvents();
      clearTimeout(refetchTimer);
      unsubs.forEach((u) => u());
      panel?.removeEventListener('goal-studio:show', onShow);
      ro?.disconnect();
      root.replaceChildren();
    },
    // Exposed for debugging/integration tests.
    _state: st,
  };
}

let instance = null;
if (typeof window !== 'undefined' && window.WazirGoalStudio) {
  window.WazirGoalStudio.register('graph', {
    mount(el, ctx) { instance = mountGraphStudio(el, ctx); },
    unmount() { instance?.dispose(); instance = null; },
  });
}
