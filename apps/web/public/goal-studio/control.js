/**
 * Goal Studio — Execution Control Center UI (`control.js`)
 * Owned by Workstream 07.
 *
 * Registers `window.WazirGoalStudio.register('control', { mount(el, ctx), unmount?() })`
 * where `ctx = { api(path, init?) => Promise<Response>, events(runId, onEvent) => close, state }`.
 * No build step; vanilla ES module.
 */

const PHASE_ORDER = [
  'LOAD_LEDGER',
  'SELECT_TARGET',
  'PLAN_TASK',
  'PREFLIGHT',
  'ROUTE_MODEL',
  'EXECUTE',
  'CHALLENGE',
  'INDEPENDENT_VERIFY',
  'ACCEPTANCE_GATE',
  'COMMIT_PROGRESS',
  'UNLOCK_DEPENDENCIES',
  'SELECT_NEXT_TARGET',
  'DIAGNOSE',
  'REPAIR_HYPOTHESIS',
  'REPLAN',
  'RETEST',
  'BLOCK_TARGET',
  'RECORD_EVIDENCE',
  'AWAIT_APPROVAL',
  'PERSIST_STATE',
];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusBadgeColor(status) {
  switch (status) {
    case 'completed':
    case 'verified':
    case 'approved':
      return '#22c55e';
    case 'active':
    case 'running':
    case 'verifying':
    case 'eligible':
      return '#38bdf8';
    case 'needs_approval':
    case 'awaiting_external':
    case 'pausing':
    case 'paused':
    case 'repairing':
    case 'pending':
      return '#eab308';
    case 'failed':
    case 'blocked':
    case 'denied':
    case 'expired':
    case 'stopped':
    case 'stopping':
      return '#ef4444';
    default:
      return '#94a3b8';
  }
}

export function createControlModule() {
  let rootEl = null;
  let currentCtx = null;
  let closeEvents = null;
  let activeRunId = null;
  let currentRun = null;
  let runsList = [];
  let approvalsList = [];
  let attemptsList = [];
  let transitionsList = [];
  let eventsLog = [];
  let currentPhase = null;
  let lastError = null;
  let statusFilter = 'all';
  let runResults = null;
  let wfPrompt = '';
  let wfMode = 'auto';
  let wfMaxIterations = '';
  let wfMaxConcurrency = '';
  let wfItems = '';
  let wfDryRun = false;
  let wfFilterStatus = 'all';
  let wfFilterMode = 'all';
  let wfAnalysis = null;
  let wfJobs = [];
  let wfInspection = null;
  let wfError = null;
  let wfBusy = false;

  function extractArtifacts(res) {
    if (!res) return [];
    const list = res.artifacts || res.results?.artifacts || res.verifiedArtifacts || res.results?.verifiedArtifacts || [];
    if (Array.isArray(list)) return list;
    if (typeof list === 'object' && list !== null) {
      return Object.entries(list).map(([k, v]) => (typeof v === 'object' && v !== null ? { path: k, ...v } : { path: k, value: v }));
    }
    return [];
  }

  async function apiJson(path, init = {}) {
    if (!currentCtx || typeof currentCtx.api !== 'function') {
      throw new Error('Control context API client unavailable');
    }
    const headers = { Accept: 'application/json', ...(init.headers || {}) };
    if (init.body && typeof init.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      init = { ...init, headers, body: JSON.stringify(init.body) };
    } else {
      init = { ...init, headers };
    }
    const res = await currentCtx.api(path, init);
    const text = await res.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (!res.ok) {
      const msg = payload?.error?.message || payload?.error || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.code = payload?.error?.code || 'HTTP_ERROR';
      err.status = res.status;
      throw err;
    }
    return payload;
  }

  function disconnectStream() {
    if (typeof closeEvents === 'function') {
      try {
        closeEvents();
      } catch {
        // ignore
      }
      closeEvents = null;
    }
  }

  function connectStream(runId) {
    disconnectStream();
    if (!runId || !currentCtx || typeof currentCtx.events !== 'function') return;
    closeEvents = currentCtx.events(runId, (event) => {
      if (!event) return;
      if (!eventsLog.some((e) => e.seq === event.seq)) {
        eventsLog.push(event);
        eventsLog.sort((a, b) => a.seq - b.seq);
        if (eventsLog.length > 300) eventsLog = eventsLog.slice(-300);
      }
      if (event.type === 'target.phase' && event.data?.phase) {
        currentPhase = String(event.data.phase);
      } else if (event.type === 'attempt.started' && event.data?.phase) {
        currentPhase = String(event.data.phase);
      }
      if (
        event.type === 'run.status' ||
        event.type === 'target.transition' ||
        event.type === 'approval.requested' ||
        event.type === 'approval.resolved' ||
        event.type === 'attempt.started' ||
        event.type === 'attempt.finished' ||
        event.type === 'gate.decided'
      ) {
        void refreshActiveRun(runId, false);
      } else {
        render();
      }
    });
  }

  async function refreshRuns() {
    try {
      const [runsResult, wfResult] = await Promise.allSettled([
        apiJson('/runs'),
        refreshWorkflowJobs(false),
      ]);
      if (runsResult.status === 'fulfilled') {
        runsList = Array.isArray(runsResult.value.runs) ? runsResult.value.runs : [];
        lastError = null;
      } else {
        runsList = [];
        if (wfResult.status === 'rejected') {
          lastError = runsResult.reason?.message || String(runsResult.reason);
        }
      }
      const stateRunId = currentCtx?.state?.runId;
      const targetRunId = activeRunId || stateRunId || (runsList[0] && runsList[0].runId) || null;
      if (targetRunId) {
        await selectRun(targetRunId);
      } else {
        render();
      }
    } catch (err) {
      lastError = err.message || String(err);
      render();
    }
  }

  function buildWorkflowPayload() {
    const prompt = wfPrompt.trim();
    const payload = {
      prompt,
      originInterface: 'web',
      dryRun: Boolean(wfDryRun),
    };
    const maxIter = Number(wfMaxIterations);
    if (wfMaxIterations !== '' && Number.isFinite(maxIter) && maxIter > 0) {
      payload.maxIterations = Math.floor(maxIter);
    }
    const maxConc = Number(wfMaxConcurrency);
    if (wfMaxConcurrency !== '' && Number.isFinite(maxConc) && maxConc > 0) {
      payload.maxConcurrency = Math.floor(maxConc);
    }
    const parsedItems = wfItems
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (parsedItems.length > 0) {
      payload.items = parsedItems;
    }
    return payload;
  }

  async function refreshWorkflowJobs(shouldRender = true) {
    try {
      const params = new URLSearchParams();
      if (wfFilterStatus && wfFilterStatus !== 'all') params.set('status', wfFilterStatus);
      if (wfFilterMode && wfFilterMode !== 'all') params.set('mode', wfFilterMode);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const data = await apiJson(`/workflows/jobs${qs}`);
      wfJobs = Array.isArray(data.jobs) ? data.jobs : [];
      if (wfInspection?.summary?.runId) {
        const refreshed = await apiJson(`/workflows/${encodeURIComponent(wfInspection.summary.runId)}`).catch(() => null);
        if (refreshed) wfInspection = refreshed;
      }
      wfError = null;
    } catch (err) {
      wfError = err.message || String(err);
    }
    if (shouldRender) render();
  }

  async function handleWorkflowCompile() {
    syncWorkflowInputsFromDom();
    const payload = buildWorkflowPayload();
    if (!payload.prompt) {
      wfError = 'Enter a goal or task prompt to analyze.';
      render();
      return;
    }
    wfBusy = true;
    wfError = null;
    render();
    try {
      const body = {
        ...payload,
        requestedMode: wfMode === 'auto' ? 'auto' : wfMode,
      };
      wfAnalysis = await apiJson('/workflows/compile', { method: 'POST', body });
      wfError = null;
    } catch (err) {
      wfError = err.message || String(err);
    } finally {
      wfBusy = false;
      render();
    }
  }

  async function handleWorkflowLaunch() {
    syncWorkflowInputsFromDom();
    const payload = buildWorkflowPayload();
    if (!payload.prompt) {
      wfError = 'Enter a goal or task prompt to launch.';
      render();
      return;
    }
    let endpoint = '/workflows/goal';
    const body = { ...payload };
    if (wfMode === 'loop') {
      endpoint = '/workflows/loop';
    } else if (wfMode === 'graph') {
      endpoint = '/workflows/graph';
    } else if (wfMode === 'single' || wfMode === 'hybrid') {
      endpoint = '/workflows/goal';
      body.overrideMode = wfMode;
    }
    wfBusy = true;
    wfError = null;
    render();
    try {
      const res = await apiJson(endpoint, { method: 'POST', body });
      wfAnalysis = res;
      wfError = null;
      await refreshWorkflowJobs(false);
      if (res.run?.runId) {
        await inspectWorkflowRun(res.run.runId, false);
        await apiJson(`/runs/${encodeURIComponent(res.run.runId)}`)
          .then(async () => {
            await selectRun(res.run.runId);
          })
          .catch(() => undefined);
      }
    } catch (err) {
      wfError = err.message || String(err);
    } finally {
      wfBusy = false;
      render();
    }
  }

  async function inspectWorkflowRun(runId, shouldRender = true) {
    if (!runId) return;
    try {
      wfInspection = await apiJson(`/workflows/${encodeURIComponent(runId)}`);
      wfError = null;
    } catch (err) {
      wfError = err.message || String(err);
    }
    if (shouldRender) render();
  }

  async function handleWorkflowControl(runId, action, targetId, note) {
    if (!runId) return;
    wfError = null;
    try {
      if (action === 'approve') {
        await apiJson(`/workflows/${encodeURIComponent(runId)}/approve`, {
          method: 'POST',
          body: {
            ...(targetId ? { targetId } : {}),
            note: note || 'Approved in Goal Studio Control Center',
          },
        });
      } else {
        await apiJson(`/workflows/${encodeURIComponent(runId)}/${action}`, {
          method: 'POST',
          body: {},
        });
      }
      await refreshWorkflowJobs(false);
      await inspectWorkflowRun(runId, false);
      if (activeRunId === runId) {
        await refreshActiveRun(runId, false);
      } else {
        render();
      }
    } catch (err) {
      wfError = err.message || String(err);
      render();
    }
  }

  function syncWorkflowInputsFromDom() {
    if (!rootEl) return;
    const pEl = rootEl.querySelector('#gs-wf-prompt');
    if (pEl) wfPrompt = pEl.value;
    const mEl = rootEl.querySelector('#gs-wf-mode');
    if (mEl) wfMode = mEl.value;
    const iterEl = rootEl.querySelector('#gs-wf-max-iterations');
    if (iterEl) wfMaxIterations = iterEl.value;
    const concEl = rootEl.querySelector('#gs-wf-max-concurrency');
    if (concEl) wfMaxConcurrency = concEl.value;
    const itemsEl = rootEl.querySelector('#gs-wf-items');
    if (itemsEl) wfItems = itemsEl.value;
    const dryEl = rootEl.querySelector('#gs-wf-dry-run');
    if (dryEl) wfDryRun = Boolean(dryEl.checked);
  }

  async function selectRun(runId) {
    const changed = activeRunId !== runId;
    activeRunId = runId;
    if (currentCtx?.state) currentCtx.state.runId = runId;
    if (changed) {
      eventsLog = [];
      currentPhase = null;
      runResults = null;
      connectStream(runId);
    }
    await refreshActiveRun(runId, changed);
  }

  async function refreshActiveRun(runId, loadEventsSnapshot = false) {
    if (!runId) return;
    try {
      const [runRes, apprRes, attRes, trRes, resultsRes] = await Promise.all([
        apiJson(`/runs/${encodeURIComponent(runId)}`),
        apiJson(`/runs/${encodeURIComponent(runId)}/approvals?status=all`).catch(() => ({ approvals: [] })),
        apiJson(`/runs/${encodeURIComponent(runId)}/attempts`).catch(() => ({ attempts: [] })),
        apiJson(`/runs/${encodeURIComponent(runId)}/transitions`).catch(() => ({ transitions: [] })),
        apiJson(`/runs/${encodeURIComponent(runId)}/results`).catch(() => null),
      ]);
      currentRun = runRes.run || null;
      approvalsList = Array.isArray(apprRes.approvals) ? apprRes.approvals : [];
      attemptsList = Array.isArray(attRes.attempts) ? attRes.attempts : [];
      transitionsList = Array.isArray(trRes.transitions) ? trRes.transitions : [];
      runResults = resultsRes?.results || resultsRes || null;
      if (attemptsList.length > 0) {
        const latestAttempt = attemptsList[attemptsList.length - 1];
        if (latestAttempt?.phase) currentPhase = latestAttempt.phase;
      }
      if (loadEventsSnapshot) {
        const evRes = await apiJson(`/runs/${encodeURIComponent(runId)}/events?format=json&after=0`).catch(() => ({ events: [] }));
        if (Array.isArray(evRes.events)) {
          for (const ev of evRes.events) {
            if (!eventsLog.some((x) => x.seq === ev.seq)) eventsLog.push(ev);
          }
          eventsLog.sort((a, b) => a.seq - b.seq);
        }
      }
      lastError = null;
    } catch (err) {
      lastError = err.message || String(err);
    }
    render();
  }

  async function handleStartRun(graphIdInput, revisionInput) {
    const graphId = (graphIdInput || currentCtx?.state?.graphId || '').trim();
    if (!graphId) {
      lastError = 'Graph ID is required to start a run.';
      render();
      return;
    }
    const body = { graphId };
    if (revisionInput && /^\d+$/.test(String(revisionInput).trim())) {
      body.graphRevision = Number(String(revisionInput).trim());
    }
    try {
      const res = await apiJson('/runs', { method: 'POST', body });
      lastError = null;
      if (res.run?.runId) {
        await refreshRuns();
        await selectRun(res.run.runId);
      }
    } catch (err) {
      lastError = err.message || String(err);
      render();
    }
  }

  async function handleRunControl(action) {
    if (!activeRunId) return;
    try {
      const endpoint = action === 'cancel'
        ? `/runs/${encodeURIComponent(activeRunId)}/cancel`
        : `/runs/${encodeURIComponent(activeRunId)}/${action}`;
      await apiJson(endpoint, { method: 'POST' });
      lastError = null;
      await refreshRuns();
      await refreshActiveRun(activeRunId, false);
    } catch (err) {
      lastError = err.message || String(err);
      render();
    }
  }

  async function handleTargetAction(targetId, segment) {
    if (!activeRunId || !targetId) return;
    try {
      await apiJson(
        `/runs/${encodeURIComponent(activeRunId)}/targets/${encodeURIComponent(targetId)}/${segment}`,
        { method: 'POST' },
      );
      lastError = null;
      await refreshActiveRun(activeRunId, false);
    } catch (err) {
      lastError = err.message || String(err);
      render();
    }
  }

  async function handleResolveApproval(approval, decision, reason) {
    if (!approval || !approval.id) return;
    const runId = approval.runId || activeRunId;
    const body = {
      decision,
      runId: approval.runId,
      targetId: approval.targetId,
      attempt: approval.attempt,
      action: approval.action,
      reason: reason || undefined,
    };
    try {
      if (runId) {
        await apiJson(
          `/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approval.id)}/resolve`,
          { method: 'POST', body },
        );
      } else {
        const endpoint = decision === 'approve' ? 'approve' : 'deny';
        await apiJson(`/approvals/${encodeURIComponent(approval.id)}/${endpoint}`, {
          method: 'POST',
          body,
        });
      }
      lastError = null;
      if (activeRunId) await refreshActiveRun(activeRunId, false);
    } catch (err) {
      lastError = err.message || String(err);
      render();
    }
  }

  function renderWorkflowAnalysisHtml() {
    if (!wfAnalysis) {
      return '<div style="color:#94a3b8;font-size:12px;">Enter a natural-language goal or task and click <strong>Analyze / Preview</strong> to inspect intent classification, Loop items, DAG critical path, and policy gates.</div>';
    }
    const exp = wfAnalysis.explanation || wfAnalysis.plan?.explanation || {};
    const mode = wfAnalysis.mode || wfAnalysis.plan?.mode || exp.selectedMode || 'single';
    const reasons = Array.isArray(exp.reasons) ? exp.reasons : [];
    const signals = exp.signals || {};
    const policy = exp.policyAssessment || {};
    const cp = wfAnalysis.criticalPath?.targets || wfAnalysis.plan?.criticalPath?.targets || [];
    const loop = wfAnalysis.loop || wfAnalysis.plan?.loop;
    const targets = wfAnalysis.definition?.targets || wfAnalysis.graph?.definition?.targets || [];

    return `
      <div style="display:grid;gap:8px;font-size:12px;">
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;">
          <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
            <strong>Selected Mode:</strong>
            <span style="padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;background:#38bdf822;color:#38bdf8;border:1px solid #38bdf8;">${escapeHtml(mode)}</span>
            ${exp.overridden ? '<span style="padding:2px 8px;border-radius:999px;font-size:11px;background:#eab30822;color:#eab308;border:1px solid #eab308;">overridden</span>' : ''}
            ${wfAnalysis.plan?.dryRun ? '<span style="padding:2px 8px;border-radius:999px;font-size:11px;background:#eab30822;color:#eab308;border:1px solid #eab308;">dry-run</span>' : ''}
            ${wfAnalysis.run?.runId ? `<span style="padding:2px 8px;border-radius:999px;font-size:11px;background:#22c55e22;color:#22c55e;border:1px solid #22c55e;">run: ${escapeHtml(wfAnalysis.run.runId)}</span>` : ''}
          </div>
          <span style="font-size:11px;color:#94a3b8;">Confidence: ${Number(exp.confidence ?? 0).toFixed(2)}</span>
        </div>
        ${reasons.length ? `<ul style="margin:0;padding-left:18px;color:#cbd5e1;">${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
        <div style="font-size:11px;color:#94a3b8;">
          Signals: loop=[${escapeHtml((signals.loopSignals || []).join(', ') || 'none')}] · graph=[${escapeHtml((signals.graphSignals || []).join(', ') || 'none')}] · items=${escapeHtml(signals.iterativeTargetsCount ?? 0)} · localFirst=${escapeHtml(policy.localModelFirst !== false)}
        </div>
        ${(policy.requiresApprovalGates || []).length ? `<div style="font-size:11px;color:#eab308;">Approval Gate: ${escapeHtml(policy.requiresApprovalGates.join('; '))}</div>` : ''}
        ${(policy.blockedUnsafeActions || []).length ? `<div style="font-size:11px;color:#ef4444;">Policy Blocked: ${escapeHtml(policy.blockedUnsafeActions.join('; '))}</div>` : ''}
        ${cp.length ? `<div style="font-size:11px;color:#38bdf8;"><strong>Critical Path (${cp.length}):</strong> ${cp.map(escapeHtml).join(' → ')}</div>` : ''}
        ${loop ? `<div style="font-size:11px;color:#22c55e;"><strong>Loop (${escapeHtml(loop.kind)}):</strong> cursor ${escapeHtml(loop.cursor ?? 0)}/${escapeHtml((loop.items || []).length)} · maxIter=${escapeHtml(loop.maxIterations)} · conc=${escapeHtml(loop.maxConcurrency)}</div>` : ''}
        ${targets.length ? `
          <div style="display:grid;gap:4px;max-height:150px;overflow:auto;">
            ${targets.slice(0, 12).map((t) => `
              <div style="padding:4px 8px;background:#0f131a;border:1px solid #1e293b;border-radius:4px;font-size:11px;">
                <strong>${escapeHtml(t.id)}</strong> [${escapeHtml(t.stage)}] — ${escapeHtml(t.title)}
                ${t.dependsOn?.length ? `<span style="color:#94a3b8;"> (deps: ${t.dependsOn.map(escapeHtml).join(', ')})</span>` : ''}
                ${t.requiresApproval ? '<span style="margin-left:6px;color:#eab308;">[requires_approval]</span>' : ''}
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  function render() {
    if (!rootEl) return;
    syncWorkflowInputsFromDom();
    const targets = Object.values(currentRun?.targets || {});
    const filteredTargets = statusFilter === 'all'
      ? targets
      : targets.filter((t) => t.status === statusFilter);
    const pendingApprovals = approvalsList.filter((a) => a.status === 'pending');
    const defaultGraphId = currentCtx?.state?.graphId || currentRun?.graphId || '';

    rootEl.innerHTML = `
      <div class="gs-control-center" data-testid="gs-control-center" style="display:grid;gap:16px;font-family:var(--font-mono, monospace);color:var(--text, #f8fafc);">
        ${lastError ? `<div class="gs-alert-error" role="alert" style="padding:10px 14px;border:1px solid #ef4444;background:rgba(239,68,68,0.12);color:#fca5a5;border-radius:6px;">${escapeHtml(lastError)}</div>` : ''}
        ${wfError ? `<div class="gs-alert-error" role="alert" style="padding:10px 14px;border:1px solid #ef4444;background:rgba(239,68,68,0.12);color:#fca5a5;border-radius:6px;">${escapeHtml(wfError)}</div>` : ''}

        <!-- Unified Workflow Launcher (Goal / Loop / Graph) -->
        <section class="gs-panel" data-testid="gs-workflow-launcher" style="padding:14px;border:1px solid var(--border, #2f4469);background:var(--panel, #162032);border-radius:8px;display:grid;gap:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <h3 style="margin:0;font-size:14px;">Workflow Launcher (Goal · Loop · Graph)</h3>
            <span style="font-size:11px;color:var(--muted, #94a3b8);">Shared @wazir/goals runtime across Shell, CLI, API &amp; Web</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(320px, 1fr));gap:12px;">
            <div style="display:grid;gap:8px;">
              <textarea id="gs-wf-prompt" rows="3" placeholder="Describe a goal, bounded loop across items/cities/files, or multi-stage dependency graph..." style="padding:8px 10px;border:1px solid var(--border, #2f4469);background:#0f131a;color:#f8fafc;border-radius:6px;width:100%;">${escapeHtml(wfPrompt)}</textarea>
              <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;">
                <label style="display:grid;gap:4px;font-size:11px;color:#94a3b8;">
                  <span>Mode</span>
                  <select id="gs-wf-mode" style="padding:6px 10px;border:1px solid var(--border, #2f4469);background:#0f131a;color:#f8fafc;border-radius:4px;">
                    <option value="auto" ${wfMode === 'auto' ? 'selected' : ''}>Auto (Goal)</option>
                    <option value="loop" ${wfMode === 'loop' ? 'selected' : ''}>Loop</option>
                    <option value="graph" ${wfMode === 'graph' ? 'selected' : ''}>Graph</option>
                    <option value="single" ${wfMode === 'single' ? 'selected' : ''}>Single</option>
                    <option value="hybrid" ${wfMode === 'hybrid' ? 'selected' : ''}>Hybrid</option>
                  </select>
                </label>
                <label style="display:grid;gap:4px;font-size:11px;color:#94a3b8;">
                  <span>Loop Max Iterations</span>
                  <input id="gs-wf-max-iterations" type="number" min="1" max="100" placeholder="25" value="${escapeHtml(wfMaxIterations)}" style="padding:6px 8px;border:1px solid var(--border, #2f4469);background:#0f131a;color:#f8fafc;border-radius:4px;width:115px;" />
                </label>
                <label style="display:grid;gap:4px;font-size:11px;color:#94a3b8;">
                  <span>Concurrency</span>
                  <input id="gs-wf-max-concurrency" type="number" min="1" max="16" placeholder="1-16" value="${escapeHtml(wfMaxConcurrency)}" style="padding:6px 8px;border:1px solid var(--border, #2f4469);background:#0f131a;color:#f8fafc;border-radius:4px;width:95px;" />
                </label>
                <label style="display:grid;gap:4px;font-size:11px;color:#94a3b8;flex:1;min-width:140px;">
                  <span>Items (optional CSV)</span>
                  <input id="gs-wf-items" type="text" placeholder="alpha, beta, gamma" value="${escapeHtml(wfItems)}" style="padding:6px 8px;border:1px solid var(--border, #2f4469);background:#0f131a;color:#f8fafc;border-radius:4px;" />
                </label>
              </div>
              <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;">
                <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#94a3b8;cursor:pointer;">
                  <input id="gs-wf-dry-run" type="checkbox" ${wfDryRun ? 'checked' : ''} />
                  <span>Dry-run preview</span>
                </label>
                <div style="display:flex;gap:8px;">
                  <button id="gs-btn-wf-compile" type="button" ${wfBusy ? 'disabled' : ''} style="padding:6px 12px;background:transparent;color:#38bdf8;border:1px solid #38bdf8;border-radius:4px;font-weight:600;cursor:pointer;">Analyze / Preview</button>
                  <button id="gs-btn-wf-start" type="button" ${wfBusy ? 'disabled' : ''} style="padding:6px 12px;background:#22c55e;color:#0f131a;border:none;border-radius:4px;font-weight:700;cursor:pointer;">Launch Workflow</button>
                </div>
              </div>
            </div>
            <div id="gs-wf-analysis" data-testid="gs-wf-explanation" style="padding:10px;border:1px solid #1e293b;background:#0f131a;border-radius:6px;max-height:240px;overflow:auto;">
              ${renderWorkflowAnalysisHtml()}
            </div>
          </div>
        </section>

        <!-- Live Workflow Jobs Table -->
        <section class="gs-panel" data-testid="gs-workflow-jobs" style="padding:14px;border:1px solid var(--border, #2f4469);background:var(--panel, #162032);border-radius:8px;display:grid;gap:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <h3 style="margin:0;font-size:14px;">Live Workflow Jobs (${wfJobs.length})</h3>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              <select id="gs-wf-filter-mode" style="padding:4px 8px;border:1px solid var(--border, #2f4469);background:#0f131a;color:#f8fafc;border-radius:4px;font-size:12px;">
                <option value="all" ${wfFilterMode === 'all' ? 'selected' : ''}>All modes</option>
                ${['loop', 'graph', 'hybrid', 'single'].map((m) => `<option value="${m}" ${wfFilterMode === m ? 'selected' : ''}>${m}</option>`).join('')}
              </select>
              <select id="gs-wf-filter-status" style="padding:4px 8px;border:1px solid var(--border, #2f4469);background:#0f131a;color:#f8fafc;border-radius:4px;font-size:12px;">
                <option value="all" ${wfFilterStatus === 'all' ? 'selected' : ''}>All statuses</option>
                ${['running', 'paused', 'idle', 'completed', 'stopped', 'failed', 'created'].map((s) => `<option value="${s}" ${wfFilterStatus === s ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
              <button id="gs-btn-wf-refresh" type="button" style="padding:4px 10px;background:transparent;color:#94a3b8;border:1px solid var(--border, #2f4469);border-radius:4px;font-size:12px;cursor:pointer;">Refresh Jobs</button>
            </div>
          </div>
          ${wfJobs.length === 0 ? '<div style="color:#94a3b8;font-size:12px;">No workflow jobs recorded yet. Launch a Goal, Loop, or Graph above or via Shell / CLI.</div>' : `
            <div style="overflow-x:auto;">
              <table style="width:100%;border-collapse:collapse;font-size:12px;text-align:left;">
                <thead>
                  <tr style="border-bottom:1px solid #2f4469;color:#94a3b8;">
                    <th style="padding:6px 8px;">Run / Goal</th>
                    <th style="padding:6px 8px;">Origin / Mode</th>
                    <th style="padding:6px 8px;">Status</th>
                    <th style="padding:6px 8px;">Loop Cursor &amp; Progress</th>
                    <th style="padding:6px 8px;">DAG Nodes / Critical Path</th>
                    <th style="padding:6px 8px;">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${wfJobs.map((job) => {
                    const p = job.progress || {};
                    const loopTotal = job.loop?.total;
                    const cursorVal = p.cursor ?? job.loop?.cursor;
                    const hasLoop = typeof cursorVal === 'number' && typeof loopTotal === 'number' && loopTotal > 0;
                    const cpTargets = job.criticalPath?.targets || [];
                    const wfTargets = Array.isArray(job.targets) ? job.targets : [];
                    const depCount = wfTargets.reduce((sum, t) => sum + (Array.isArray(t.dependsOn) ? t.dependsOn.length : 0), 0);
                    const pendingTarget = wfTargets.find((t) => t.status === 'needs_approval');
                    const needsAppr = (p.needsApproval || 0) > 0 || Boolean(pendingTarget);
                    const canPause = job.status === 'running';
                    const canResume = job.status === 'paused' || job.status === 'idle' || job.status === 'created';
                    const canStop = !['completed', 'stopped', 'failed'].includes(job.status);

                    return `
                      <tr data-wf-run-id="${escapeHtml(job.runId)}" style="border-bottom:1px solid #1e293b;">
                        <td style="padding:6px 8px;">
                          <div style="font-weight:600;">${escapeHtml(String(job.prompt || job.graphId).slice(0, 72))}</div>
                          <div style="font-size:11px;color:#94a3b8;"><code>${escapeHtml(job.runId)}</code></div>
                        </td>
                        <td style="padding:6px 8px;">
                          <span style="padding:1px 6px;border-radius:4px;font-size:11px;background:#38bdf822;color:#38bdf8;border:1px solid #38bdf8;">${escapeHtml(job.originInterface || 'cli')}</span>
                          <span style="margin-left:4px;padding:1px 6px;border-radius:4px;font-size:11px;background:#94a3b822;color:#cbd5e1;border:1px solid #475569;">${escapeHtml(job.mode)}</span>
                        </td>
                        <td style="padding:6px 8px;">
                          <span style="padding:2px 7px;border-radius:999px;font-size:11px;font-weight:700;color:${statusBadgeColor(job.status)};border:1px solid ${statusBadgeColor(job.status)};">${escapeHtml(job.status)}</span>
                          ${needsAppr ? '<div style="margin-top:3px;font-size:10px;color:#eab308;">approval required</div>' : ''}
                        </td>
                        <td style="padding:6px 8px;font-size:11px;">
                          ${hasLoop ? `<div>Cursor: <strong>${escapeHtml(cursorVal)}/${escapeHtml(loopTotal)}</strong></div>` : ''}
                          <div>Done: ${escapeHtml(p.completed || 0)}/${escapeHtml(p.total || 0)}${p.failed ? ` · <span style="color:#ef4444;">${escapeHtml(p.failed)} failed</span>` : ''}</div>
                        </td>
                        <td style="padding:6px 8px;font-size:11px;">
                          <div>${escapeHtml(wfTargets.length || p.total || 0)} node(s) · ${escapeHtml(depCount)} dep(s)</div>
                          <div style="color:#38bdf8;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(cpTargets.join(' → '))}">
                            ${cpTargets.length ? cpTargets.map(escapeHtml).join(' → ') : '—'}
                          </div>
                        </td>
                        <td style="padding:6px 8px;">
                          <div style="display:flex;gap:4px;flex-wrap:wrap;">
                            <button type="button" class="gs-btn-wf-inspect" data-run-id="${escapeHtml(job.runId)}" style="padding:3px 7px;background:#0f131a;color:#38bdf8;border:1px solid #38bdf8;border-radius:4px;font-size:11px;cursor:pointer;">Inspect</button>
                            ${canPause ? `<button type="button" class="gs-btn-wf-action" data-action="pause" data-run-id="${escapeHtml(job.runId)}" style="padding:3px 7px;background:#eab308;color:#0f131a;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;">Pause</button>` : ''}
                            ${canResume ? `<button type="button" class="gs-btn-wf-action" data-action="resume" data-run-id="${escapeHtml(job.runId)}" style="padding:3px 7px;background:#38bdf8;color:#0f131a;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;">Resume</button>` : ''}
                            ${canStop ? `<button type="button" class="gs-btn-wf-action" data-action="stop" data-run-id="${escapeHtml(job.runId)}" style="padding:3px 7px;background:#ef4444;color:#fff;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;">Stop</button>` : ''}
                            ${needsAppr ? `<button type="button" class="gs-btn-wf-action" data-action="approve" data-run-id="${escapeHtml(job.runId)}" data-target-id="${escapeHtml(pendingTarget?.id || '')}" style="padding:3px 7px;background:#22c55e;color:#0f131a;border:none;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;">Approve</button>` : ''}
                          </div>
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          `}

          ${wfInspection ? (() => {
            const ins = wfInspection;
            const insSummary = ins.summary || {};
            const insRun = ins.run || {};
            const insCp = ins.criticalPath?.targets || [];
            const insTargets = Array.isArray(ins.targets) ? ins.targets : [];
            const insLoop = ins.loop;
            const insExp = ins.explanation || {};
            const insEvidence = Array.isArray(ins.evidence) ? ins.evidence : [];
            const approvalPendingTargets = insTargets.filter((t) => insRun.targets?.[t.id]?.status === 'needs_approval');
            return `
              <div data-testid="gs-wf-inspection" style="margin-top:8px;padding:12px;border:1px solid #2f4469;background:#0f131a;border-radius:6px;display:grid;gap:8px;font-size:12px;">
                <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
                  <strong>Workflow Inspection: <code>${escapeHtml(insSummary.runId)}</code> (${escapeHtml(insSummary.mode)} · ${escapeHtml(insRun.status)})</strong>
                  <span style="color:#38bdf8;font-size:11px;">Critical Path: ${insCp.length ? insCp.map(escapeHtml).join(' → ') : '—'}</span>
                </div>
                ${insExp.reasons?.length ? `<div style="color:#cbd5e1;font-size:11px;"><strong>Intent:</strong> ${insExp.reasons.map(escapeHtml).join(' | ')}</div>` : ''}
                ${insLoop ? `
                  <div style="font-size:11px;color:#22c55e;">
                    <strong>Loop (${escapeHtml(insLoop.kind)}):</strong> cursor ${escapeHtml(insSummary.progress?.cursor ?? insLoop.cursor ?? 0)}/${escapeHtml((insLoop.items || []).length)}
                  </div>
                ` : ''}
                ${approvalPendingTargets.length ? `
                  <div style="padding:8px;border:1px solid #eab308;border-radius:4px;background:rgba(234,179,8,0.08);display:grid;gap:6px;">
                    <strong style="color:#eab308;">Human Approval Gate Pending</strong>
                    ${approvalPendingTargets.map((t) => `
                      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                        <code>${escapeHtml(t.id)}</code>
                        <input type="text" class="gs-wf-approve-note" data-target-id="${escapeHtml(t.id)}" placeholder="Approval note (optional)" style="flex:1;padding:4px 8px;border:1px solid #2f4469;background:#162032;color:#f8fafc;border-radius:4px;font-size:11px;" />
                        <button type="button" class="gs-btn-wf-approve-gate" data-run-id="${escapeHtml(insSummary.runId)}" data-target-id="${escapeHtml(t.id)}" style="padding:4px 10px;background:#22c55e;color:#0f131a;border:none;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;">Approve Gate</button>
                      </div>
                    `).join('')}
                  </div>
                ` : ''}
                <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:6px;">
                  ${insTargets.map((t) => {
                    const st = insRun.targets?.[t.id]?.status || 'queued';
                    return `
                      <div style="padding:6px 8px;border:1px solid #1e293b;background:#162032;border-radius:4px;font-size:11px;">
                        <div style="display:flex;justify-content:space-between;">
                          <strong>${escapeHtml(t.id)}</strong>
                          <span style="color:${statusBadgeColor(st)};font-weight:700;">${escapeHtml(st)}</span>
                        </div>
                        <div style="color:#cbd5e1;">${escapeHtml(t.title)}</div>
                        ${t.dependsOn?.length ? `<div style="color:#94a3b8;">deps: ${t.dependsOn.map(escapeHtml).join(', ')}</div>` : ''}
                      </div>
                    `;
                  }).join('')}
                </div>
                <div style="font-size:11px;color:#94a3b8;">
                  Evidence records: ${escapeHtml(insEvidence.length)} · Events recorded: ${escapeHtml((ins.events || []).length)}
                </div>
              </div>
            `;
          })() : ''}
        </section>

        <!-- Top Control Bar -->
        <section class="gs-panel" style="padding:14px;border:1px solid var(--border, #2f4469);background:var(--panel, #162032);border-radius:8px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;">
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
            <label style="font-size:12px;color:var(--muted, #94a3b8);">Graph ID</label>
            <input id="gs-ctrl-graph-id" type="text" placeholder="graph-id" value="${escapeHtml(defaultGraphId)}" style="padding:6px 10px;border:1px solid var(--border, #2f4469);background:#0f131a;color:#f8fafc;border-radius:4px;width:160px;" />
            <input id="gs-ctrl-graph-rev" type="number" min="1" placeholder="rev (latest)" style="padding:6px 10px;border:1px solid var(--border, #2f4469);background:#0f131a;color:#f8fafc;border-radius:4px;width:105px;" />
            <button id="gs-btn-start-run" type="button" style="padding:6px 12px;background:#22c55e;color:#0f131a;border:none;border-radius:4px;font-weight:700;cursor:pointer;">Start Run</button>
          </div>

          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
            <label style="font-size:12px;color:var(--muted, #94a3b8);">Active Run</label>
            <select id="gs-ctrl-run-select" style="padding:6px 10px;border:1px solid var(--border, #2f4469);background:#0f131a;color:#f8fafc;border-radius:4px;">
              ${runsList.length === 0 ? '<option value="">No runs yet</option>' : runsList.map((r) => `<option value="${escapeHtml(r.runId)}" ${r.runId === activeRunId ? 'selected' : ''}>${escapeHtml(r.runId)} (${escapeHtml(r.status)})</option>`).join('')}
            </select>
            <button id="gs-btn-pause-run" type="button" ${!currentRun ? 'disabled' : ''} style="padding:6px 12px;background:#eab308;color:#0f131a;border:none;border-radius:4px;font-weight:600;cursor:pointer;">Pause</button>
            <button id="gs-btn-resume-run" type="button" ${!currentRun ? 'disabled' : ''} style="padding:6px 12px;background:#38bdf8;color:#0f131a;border:none;border-radius:4px;font-weight:600;cursor:pointer;">Resume</button>
            <button id="gs-btn-stop-run" type="button" ${!currentRun ? 'disabled' : ''} style="padding:6px 12px;background:#ef4444;color:#fff;border:none;border-radius:4px;font-weight:600;cursor:pointer;">Stop</button>
            <button id="gs-btn-cancel-run" type="button" ${!currentRun ? 'disabled' : ''} style="padding:6px 12px;background:#b91c1c;color:#fff;border:none;border-radius:4px;font-weight:600;cursor:pointer;">Cancel</button>
            <button id="gs-btn-refresh-run" type="button" style="padding:6px 10px;background:transparent;color:#94a3b8;border:1px solid var(--border, #2f4469);border-radius:4px;cursor:pointer;">Refresh</button>
          </div>
        </section>

        <!-- Run Status Summary & Phase Timeline -->
        ${currentRun ? `
          <section class="gs-panel" style="padding:14px;border:1px solid var(--border, #2f4469);background:var(--panel, #162032);border-radius:8px;">
            <div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;margin-bottom:12px;">
              <div>
                <strong>Run:</strong> <code>${escapeHtml(currentRun.runId)}</code>
                &nbsp;·&nbsp;
                <strong>Graph:</strong> <code>${escapeHtml(currentRun.graphId)}@${escapeHtml(currentRun.graphRevision)}</code>
                &nbsp;·&nbsp;
                <span style="padding:2px 8px;border-radius:999px;font-size:12px;font-weight:700;background:${statusBadgeColor(currentRun.status)}22;color:${statusBadgeColor(currentRun.status)};border:1px solid ${statusBadgeColor(currentRun.status)};">${escapeHtml(currentRun.status)}</span>
              </div>
              <div style="font-size:12px;color:var(--muted, #94a3b8);">
                Tasks: ${escapeHtml(currentRun.resource?.tasksStarted ?? 0)}
                · Spend: $${Number(currentRun.resource?.hostedSpendUsd ?? 0).toFixed(2)}
                · Ledger rev: ${escapeHtml(currentRun.ledgerRevision)}
              </div>
            </div>
            <div style="font-size:11px;color:var(--muted, #94a3b8);margin-bottom:6px;">Phase Timeline</div>
            <div class="gs-phase-timeline" style="display:flex;flex-wrap:wrap;gap:6px;">
              ${PHASE_ORDER.map((phase) => {
                const active = currentPhase === phase;
                return `<span data-phase="${escapeHtml(phase)}" style="padding:3px 8px;border-radius:4px;font-size:11px;border:1px solid ${active ? '#38bdf8' : '#1e293b'};background:${active ? 'rgba(56,189,248,0.18)' : '#0f131a'};color:${active ? '#38bdf8' : '#94a3b8'};font-weight:${active ? '700' : '400'};">${escapeHtml(phase)}</span>`;
              }).join('')}
            </div>
          </section>
        ` : ''}

        <!-- Targets & Approval Queue Grid -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(340px, 1fr));gap:16px;">
          <!-- Targets Control Panel -->
          <section class="gs-panel" style="padding:14px;border:1px solid var(--border, #2f4469);background:var(--panel, #162032);border-radius:8px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
              <h3 style="margin:0;font-size:14px;">Targets (${targets.length})</h3>
              <select id="gs-target-filter" style="padding:4px 8px;border:1px solid var(--border, #2f4469);background:#0f131a;color:#f8fafc;border-radius:4px;font-size:12px;">
                <option value="all" ${statusFilter === 'all' ? 'selected' : ''}>All statuses</option>
                ${['eligible', 'active', 'verifying', 'completed', 'failed', 'repairing', 'needs_approval', 'blocked', 'queued'].map((s) => `<option value="${s}" ${statusFilter === s ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
            </div>
            ${filteredTargets.length === 0 ? '<div style="color:#94a3b8;font-size:12px;">No targets match filter.</div>' : `
              <div style="display:grid;gap:8px;max-height:360px;overflow:auto;">
                ${filteredTargets.map((t) => {
                  const canRetry = ['failed', 'blocked', 'stopped', 'repairing'].includes(t.status);
                  const canRun = ['eligible', 'queued'].includes(t.status);
                  return `
                    <div data-target-id="${escapeHtml(t.targetId)}" style="padding:10px;border:1px solid #1e293b;background:#0f131a;border-radius:6px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
                      <div>
                        <div style="font-weight:700;">
                          <code>${escapeHtml(t.targetId)}</code>
                          <span style="margin-left:6px;padding:1px 6px;border-radius:4px;font-size:11px;color:${statusBadgeColor(t.status)};border:1px solid ${statusBadgeColor(t.status)};">${escapeHtml(t.status)}</span>
                        </div>
                        <div style="font-size:11px;color:#94a3b8;margin-top:3px;">
                          Attempts: ${escapeHtml(t.attempts)} · Repairs: ${escapeHtml(t.repairs)} · Evidence: ${escapeHtml((t.evidenceIds || []).length)}
                          ${t.blockers?.length ? ` · Blockers: ${escapeHtml(t.blockers.join(', '))}` : ''}
                        </div>
                      </div>
                      <div style="display:flex;gap:6px;">
                        ${canRun ? `<button type="button" class="gs-btn-run-target" data-target="${escapeHtml(t.targetId)}" style="padding:4px 8px;background:#38bdf8;color:#0f131a;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;">Run Eligible</button>` : ''}
                        ${canRetry ? `<button type="button" class="gs-btn-retry-target" data-target="${escapeHtml(t.targetId)}" style="padding:4px 8px;background:#eab308;color:#0f131a;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;">Retry Target</button>` : ''}
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            `}
          </section>

          <!-- Approval Queue UI -->
          <section class="gs-panel" style="padding:14px;border:1px solid var(--border, #2f4469);background:var(--panel, #162032);border-radius:8px;">
            <h3 style="margin:0 0 10px 0;font-size:14px;">Approval Queue (${pendingApprovals.length} pending)</h3>
            ${approvalsList.length === 0 ? '<div style="color:#94a3b8;font-size:12px;">No approvals requested for this run.</div>' : `
              <div style="display:grid;gap:8px;max-height:360px;overflow:auto;">
                ${approvalsList.map((appr) => `
                  <div data-approval-id="${escapeHtml(appr.id)}" style="padding:10px;border:1px solid #1e293b;background:#0f131a;border-radius:6px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                      <strong><code>${escapeHtml(appr.targetId || appr.scope?.targetId || '-')}</code> · ${escapeHtml(appr.action || appr.scope?.action || appr.tool)}</strong>
                      <span style="font-size:11px;color:${statusBadgeColor(appr.status)};">${escapeHtml(appr.status)}</span>
                    </div>
                    <div style="font-size:11px;color:#94a3b8;margin-top:4px;">
                      Scope: run=${escapeHtml(appr.runId || appr.scope?.runId)} target=${escapeHtml(appr.targetId || appr.scope?.targetId)} attempt=${escapeHtml(appr.attempt ?? appr.scope?.attempt)}
                    </div>
                    <div style="font-size:11px;color:#cbd5e1;margin-top:4px;">
                      ${escapeHtml((appr.reasons || []).join('; '))}
                    </div>
                    ${appr.status === 'pending' ? `
                      <div style="display:flex;gap:6px;margin-top:8px;align-items:center;">
                        <input type="text" class="gs-approval-reason" data-approval-id="${escapeHtml(appr.id)}" placeholder="Reason / note (optional)" style="flex:1;padding:4px 8px;border:1px solid #2f4469;background:#162032;color:#f8fafc;border-radius:4px;font-size:11px;" />
                        <button type="button" class="gs-btn-approve" data-approval-id="${escapeHtml(appr.id)}" style="padding:4px 10px;background:#22c55e;color:#0f131a;border:none;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;">Approve</button>
                        <button type="button" class="gs-btn-reject" data-approval-id="${escapeHtml(appr.id)}" style="padding:4px 10px;background:#ef4444;color:#fff;border:none;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;">Reject</button>
                      </div>
                    ` : `
                      <div style="font-size:11px;color:#94a3b8;margin-top:4px;">
                        Resolved by ${escapeHtml(appr.resolvedBy || '-')} ${appr.resolutionReason ? `(${escapeHtml(appr.resolutionReason)})` : ''}
                      </div>
                    `}
                  </div>
                `).join('')}
              </div>
            `}
          </section>
        </div>

        <!-- Results & Artifacts Summary Section -->
        <section class="gs-panel gs-results-artifacts" data-testid="gs-results-artifacts" style="padding:14px;border:1px solid var(--border, #2f4469);background:var(--panel, #162032);border-radius:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
            <h3 style="margin:0;font-size:14px;">Results &amp; Artifacts</h3>
            ${activeRunId ? `<span style="font-size:12px;color:var(--muted, #94a3b8);">Run: <code>${escapeHtml(activeRunId)}</code></span>` : ''}
          </div>
          ${!activeRunId ? `
            <div style="color:#94a3b8;font-size:12px;">Select or start a run to view verified results and artifacts.</div>
          ` : (!runResults || (extractArtifacts(runResults).length === 0 && !runResults.digest && !runResults.summary && !runResults.resultsDigest)) ? `
            <div style="color:#94a3b8;font-size:12px;">No results or artifacts recorded for run <code>${escapeHtml(activeRunId)}</code> yet.</div>
          ` : `
            <div style="display:grid;gap:12px;">
              ${(runResults.digest || runResults.resultsDigest || runResults.summary || runResults.status) ? `
                <div style="display:flex;flex-wrap:wrap;gap:12px;padding:8px 12px;background:#0f131a;border:1px solid #1e293b;border-radius:6px;font-size:12px;">
                  ${runResults.digest || runResults.resultsDigest ? `<div><strong>Digest:</strong> <code title="${escapeHtml(runResults.digest || runResults.resultsDigest)}">${escapeHtml(String(runResults.digest || runResults.resultsDigest).slice(0, 16))}…</code></div>` : ''}
                  ${runResults.status ? `<div><strong>Status:</strong> <span style="color:${statusBadgeColor(runResults.status)};font-weight:600;">${escapeHtml(runResults.status)}</span></div>` : ''}
                  ${runResults.summary ? `<div><strong>Summary:</strong> ${escapeHtml(runResults.summary)}</div>` : ''}
                </div>
              ` : ''}
              ${extractArtifacts(runResults).length === 0 ? `
                <div style="color:#94a3b8;font-size:12px;">No artifacts listed in results.</div>
              ` : `
                <div style="overflow-x:auto;">
                  <table style="width:100%;border-collapse:collapse;font-size:12px;text-align:left;">
                    <thead>
                      <tr style="border-bottom:1px solid #2f4469;color:#94a3b8;">
                        <th style="padding:6px 8px;">Target</th>
                        <th style="padding:6px 8px;">Artifact Path</th>
                        <th style="padding:6px 8px;">Verification</th>
                        <th style="padding:6px 8px;">Digest (SHA-256)</th>
                        <th style="padding:6px 8px;">Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${extractArtifacts(runResults).map((art) => {
                        const verified = art.verified === true || art.status === 'verified' || art.valid === true;
                        const digest = art.digest || art.sha256 || art.hash || '—';
                        return `
                          <tr style="border-bottom:1px solid #1e293b;">
                            <td style="padding:6px 8px;"><code>${escapeHtml(art.targetId || art.target || '—')}</code></td>
                            <td style="padding:6px 8px;font-weight:600;"><code>${escapeHtml(art.path || art.name || art.id || 'artifact')}</code></td>
                            <td style="padding:6px 8px;">
                              <span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;background:${verified ? '#22c55e22' : '#94a3b822'};color:${verified ? '#22c55e' : '#94a3b8'};border:1px solid ${verified ? '#22c55e' : '#94a3b8'};">
                                ${verified ? '✓ Verified' : 'Unverified'}
                              </span>
                            </td>
                            <td style="padding:6px 8px;">
                              ${digest !== '—' ? `<code title="${escapeHtml(digest)}">${escapeHtml(String(digest).slice(0, 16))}…</code>` : '<span style="color:#64748b;">—</span>'}
                            </td>
                            <td style="padding:6px 8px;color:#94a3b8;">${escapeHtml(art.size !== undefined ? `${art.size} B` : (art.bytes !== undefined ? `${art.bytes} B` : '—'))}</td>
                          </tr>
                        `;
                      }).join('')}
                    </tbody>
                  </table>
                </div>
              `}
            </div>
          `}
        </section>

        <!-- Live SSE Activity Stream & Attempts -->
        <section class="gs-panel" style="padding:14px;border:1px solid var(--border, #2f4469);background:var(--panel, #162032);border-radius:8px;">
          <h3 style="margin:0 0 10px 0;font-size:14px;">Live Activity Stream (${eventsLog.length} events)</h3>
          <div class="gs-event-stream" style="max-height:260px;overflow:auto;display:grid;gap:4px;font-size:12px;">
            ${eventsLog.length === 0 ? '<div style="color:#94a3b8;">Waiting for run events...</div>' : eventsLog.slice().reverse().map((ev) => `
              <div data-event-seq="${escapeHtml(ev.seq)}" style="padding:6px 8px;border-left:3px solid #38bdf8;background:#0f131a;border-radius:2px;">
                <span style="color:#94a3b8;">#${escapeHtml(ev.seq)}</span>
                <strong style="margin-left:6px;color:#38bdf8;">${escapeHtml(ev.type)}</strong>
                ${ev.targetId ? `<span style="margin-left:6px;color:#eab308;">[${escapeHtml(ev.targetId)}]</span>` : ''}
                <span style="margin-left:6px;color:#cbd5e1;">${escapeHtml(JSON.stringify(ev.data || {}))}</span>
              </div>
            `).join('')}
          </div>
        </section>
      </div>
    `;

    bindEvents();
  }

  function bindEvents() {
    if (!rootEl) return;
    const startBtn = rootEl.querySelector('#gs-btn-start-run');
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        const graphId = rootEl.querySelector('#gs-ctrl-graph-id')?.value;
        const rev = rootEl.querySelector('#gs-ctrl-graph-rev')?.value;
        void handleStartRun(graphId, rev);
      });
    }
    const runSelect = rootEl.querySelector('#gs-ctrl-run-select');
    if (runSelect) {
      runSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        if (val) void selectRun(val);
      });
    }
    const pauseBtn = rootEl.querySelector('#gs-btn-pause-run');
    if (pauseBtn) pauseBtn.addEventListener('click', () => void handleRunControl('pause'));
    const resumeBtn = rootEl.querySelector('#gs-btn-resume-run');
    if (resumeBtn) resumeBtn.addEventListener('click', () => void handleRunControl('resume'));
    const stopBtn = rootEl.querySelector('#gs-btn-stop-run');
    if (stopBtn) stopBtn.addEventListener('click', () => void handleRunControl('stop'));
    const cancelBtn = rootEl.querySelector('#gs-btn-cancel-run');
    if (cancelBtn) cancelBtn.addEventListener('click', () => void handleRunControl('cancel'));
    const refreshBtn = rootEl.querySelector('#gs-btn-refresh-run');
    if (refreshBtn) refreshBtn.addEventListener('click', () => void refreshRuns());

    const filterSelect = rootEl.querySelector('#gs-target-filter');
    if (filterSelect) {
      filterSelect.addEventListener('change', (e) => {
        statusFilter = e.target.value;
        render();
      });
    }

    for (const btn of rootEl.querySelectorAll('.gs-btn-run-target')) {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-target');
        void handleTargetAction(targetId, 'run');
      });
    }
    for (const btn of rootEl.querySelectorAll('.gs-btn-retry-target')) {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-target');
        void handleTargetAction(targetId, 'retry');
      });
    }

    for (const btn of rootEl.querySelectorAll('.gs-btn-approve')) {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-approval-id');
        const appr = approvalsList.find((a) => a.id === id);
        const reasonInput = rootEl.querySelector(`.gs-approval-reason[data-approval-id="${id}"]`);
        void handleResolveApproval(appr, 'approve', reasonInput?.value);
      });
    }
    for (const btn of rootEl.querySelectorAll('.gs-btn-reject')) {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-approval-id');
        const appr = approvalsList.find((a) => a.id === id);
        const reasonInput = rootEl.querySelector(`.gs-approval-reason[data-approval-id="${id}"]`);
        void handleResolveApproval(appr, 'deny', reasonInput?.value);
      });
    }

    const wfPromptEl = rootEl.querySelector('#gs-wf-prompt');
    if (wfPromptEl) wfPromptEl.addEventListener('input', (e) => { wfPrompt = e.target.value; });
    const wfModeEl = rootEl.querySelector('#gs-wf-mode');
    if (wfModeEl) wfModeEl.addEventListener('change', (e) => { wfMode = e.target.value; });
    const wfIterEl = rootEl.querySelector('#gs-wf-max-iterations');
    if (wfIterEl) wfIterEl.addEventListener('input', (e) => { wfMaxIterations = e.target.value; });
    const wfConcEl = rootEl.querySelector('#gs-wf-max-concurrency');
    if (wfConcEl) wfConcEl.addEventListener('input', (e) => { wfMaxConcurrency = e.target.value; });
    const wfItemsEl = rootEl.querySelector('#gs-wf-items');
    if (wfItemsEl) wfItemsEl.addEventListener('input', (e) => { wfItems = e.target.value; });
    const wfDryEl = rootEl.querySelector('#gs-wf-dry-run');
    if (wfDryEl) wfDryEl.addEventListener('change', (e) => { wfDryRun = Boolean(e.target.checked); });

    const wfCompileBtn = rootEl.querySelector('#gs-btn-wf-compile');
    if (wfCompileBtn) wfCompileBtn.addEventListener('click', () => void handleWorkflowCompile());
    const wfStartBtn = rootEl.querySelector('#gs-btn-wf-start');
    if (wfStartBtn) wfStartBtn.addEventListener('click', () => void handleWorkflowLaunch());

    const wfModeFilterEl = rootEl.querySelector('#gs-wf-filter-mode');
    if (wfModeFilterEl) {
      wfModeFilterEl.addEventListener('change', (e) => {
        wfFilterMode = e.target.value;
        void refreshWorkflowJobs();
      });
    }
    const wfStatusFilterEl = rootEl.querySelector('#gs-wf-filter-status');
    if (wfStatusFilterEl) {
      wfStatusFilterEl.addEventListener('change', (e) => {
        wfFilterStatus = e.target.value;
        void refreshWorkflowJobs();
      });
    }
    const wfRefreshBtn = rootEl.querySelector('#gs-btn-wf-refresh');
    if (wfRefreshBtn) wfRefreshBtn.addEventListener('click', () => void refreshWorkflowJobs());

    for (const btn of rootEl.querySelectorAll('.gs-btn-wf-inspect')) {
      btn.addEventListener('click', () => {
        const runId = btn.getAttribute('data-run-id');
        void inspectWorkflowRun(runId);
      });
    }
    for (const btn of rootEl.querySelectorAll('.gs-btn-wf-action')) {
      btn.addEventListener('click', () => {
        const runId = btn.getAttribute('data-run-id');
        const action = btn.getAttribute('data-action');
        const targetId = btn.getAttribute('data-target-id');
        void handleWorkflowControl(runId, action, targetId);
      });
    }
    for (const btn of rootEl.querySelectorAll('.gs-btn-wf-approve-gate')) {
      btn.addEventListener('click', () => {
        const runId = btn.getAttribute('data-run-id');
        const targetId = btn.getAttribute('data-target-id');
        const noteInput = rootEl.querySelector(`.gs-wf-approve-note[data-target-id="${targetId}"]`);
        void handleWorkflowControl(runId, 'approve', targetId, noteInput?.value);
      });
    }
  }

  return {
    mount(el, ctx) {
      rootEl = el;
      currentCtx = ctx;
      render();
      void refreshRuns();
    },
    unmount() {
      disconnectStream();
      if (rootEl) rootEl.innerHTML = '';
      rootEl = null;
      currentCtx = null;
    },
  };
}

if (typeof window !== 'undefined') {
  window.WazirGoalStudio = window.WazirGoalStudio || {
    modules: {},
    register(name, mod) {
      this.modules[name] = mod;
    },
  };
  window.WazirGoalStudio.register('control', createControlModule());
}
