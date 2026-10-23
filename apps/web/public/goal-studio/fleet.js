/**
 * Goal Studio Model Routing & Worker Fleet UI Module (Workstream 09).
 *
 * Registers `window.WazirGoalStudio.register('fleet', { mount(el, ctx), unmount() })`
 * per reports/goal-studio-12-agents/INTEGRATION-CONTRACTS.md §9.
 *
 * Capabilities:
 *  - Model Fleet Readiness table (verified-ready vs configured/stale/failed, local vs hosted,
 *    capabilities tags, tool-use verification badge, circuit-breaker reliability, cost/latency accounting)
 *  - One-click Local Readiness Probe sweep (and per-model probe trigger)
 *  - Interactive Route Simulator (`POST /api/v1/goal-studio/fleet/route`) with required capability tags,
 *    hosted spend budget ceiling ($0 default), local-first toggle, exclusions, and full candidate scoring breakdown
 *  - Worker & Computer Health matrix (`GET /api/v1/goal-studio/fleet/workers`) with RAM/VRAM headroom and heartbeat status
 *  - Operator Model Registration form (`POST /api/v1/goal-studio/fleet/models/register`)
 */

const BASE_PATH = '/api/v1/goal-studio';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '$0.00';
  if (n === 0) return '$0.00';
  return n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(2)}`;
}

function formatAge(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return `${m}m ago`;
}

export function createFleetModule() {
  let rootEl = null;
  let currentCtx = null;
  let unmounted = false;
  let refreshTimer = null;

  const state = {
    loading: false,
    probing: false,
    routing: false,
    registering: false,
    error: null,
    notice: null,
    models: [],
    runtimes: [],
    workers: [],
    summary: {
      models: 0,
      verifiedReady: 0,
      hosted: 0,
      computers: 0,
      computersOnline: 0,
      runtimes: 0,
      runtimesHealthy: 0,
    },
    readinessTtlMs: 600000,
    probeSweep: null,
    simulator: {
      requiredCapabilities: 'coding, toolCalling',
      remainingHostedBudgetUsd: '0',
      localFirst: true,
      excludeModelIds: '',
      result: null,
    },
  };

  async function apiCall(path, init) {
    const fullPath = path.startsWith('/api/') ? path : `${BASE_PATH}${path}`;
    if (currentCtx && typeof currentCtx.api === 'function') {
      return currentCtx.api(fullPath, init);
    }
    return fetch(fullPath, init);
  }

  async function refreshFleet() {
    if (!rootEl || unmounted) return;
    state.loading = true;
    state.error = null;
    render();
    try {
      const [modelsRes, workersRes] = await Promise.all([
        apiCall('/fleet/models'),
        apiCall('/fleet/workers'),
      ]);
      if (!modelsRes.ok) {
        const errBody = await modelsRes.json().catch(() => ({}));
        throw new Error(errBody?.error?.message || `HTTP ${modelsRes.status} loading fleet models`);
      }
      const modelsData = await modelsRes.json();
      const workersData = workersRes.ok ? await workersRes.json() : { workers: [] };

      state.models = Array.isArray(modelsData.models) ? modelsData.models : [];
      state.runtimes = Array.isArray(modelsData.runtimes) ? modelsData.runtimes : [];
      state.workers = Array.isArray(workersData.workers)
        ? workersData.workers
        : Array.isArray(workersData.computers)
          ? workersData.computers
          : [];
      state.summary = {
        ...state.summary,
        ...(modelsData.summary || {}),
        ...(workersData.summary || {}),
      };
      if (typeof modelsData.readinessTtlMs === 'number') {
        state.readinessTtlMs = modelsData.readinessTtlMs;
      }
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function runProbe(modelId) {
    if (!rootEl || unmounted) return;
    state.probing = true;
    state.error = null;
    state.notice = modelId ? `Probing ${modelId}...` : 'Probing all local model instances...';
    render();
    try {
      const res = await apiCall('/fleet/models/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(modelId ? { modelId } : {}),
          force: true,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.error?.message || body?.error || `Probe failed with HTTP ${res.status}`);
      }
      state.probeSweep = body;
      const probedCount = Array.isArray(body.probed) ? body.probed.length : 0;
      const readyCount = Array.isArray(body.probed) ? body.probed.filter((r) => r.ready).length : 0;
      const skippedCount = Array.isArray(body.skipped) ? body.skipped.length : 0;
      state.notice = `Probe finished: ${readyCount}/${probedCount} verified ready (${skippedCount} skipped).`;
      await refreshFleet();
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      state.notice = null;
    } finally {
      state.probing = false;
      render();
    }
  }

  async function runSimulator() {
    if (!rootEl || unmounted) return;
    state.routing = true;
    state.error = null;
    render();
    try {
      const requiredCapabilities = state.simulator.requiredCapabilities
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const excludeModelIds = state.simulator.excludeModelIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const remainingHostedBudgetUsd = Math.max(0, Number(state.simulator.remainingHostedBudgetUsd) || 0);

      const res = await apiCall('/fleet/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requiredCapabilities,
          remainingHostedBudgetUsd,
          localFirst: Boolean(state.simulator.localFirst),
          excludeModelIds,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.error?.message || body?.error || `Route simulation failed (HTTP ${res.status})`);
      }
      state.simulator.result = body;
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      state.routing = false;
      render();
    }
  }

  async function registerModelFromForm(formEl) {
    if (!rootEl || unmounted) return;
    const formData = new FormData(formEl);
    const id = String(formData.get('id') || '').trim();
    const name = String(formData.get('name') || '').trim() || id;
    const provider = String(formData.get('provider') || 'ollama').trim();
    const runtimeId = String(formData.get('runtimeId') || provider).trim();
    const computerId = String(formData.get('computerId') || 'local').trim();
    const contextMax = Number(formData.get('contextMax') || 32768);
    const local = formData.get('kind') !== 'hosted';
    const toolCalling = formData.get('toolCalling') === 'on';
    const capabilities = String(formData.get('capabilities') || 'generalChat, coding')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (!id) {
      state.error = 'Model ID is required to register a model.';
      render();
      return;
    }

    state.registering = true;
    state.error = null;
    render();
    try {
      const res = await apiCall('/fleet/models/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          name,
          provider,
          local,
          contextMax: Number.isFinite(contextMax) && contextMax > 0 ? contextMax : 32768,
          toolCalling,
          capabilities,
          instance: {
            runtimeId,
            computerId: local ? computerId : undefined,
            loaded: true,
            state: 'READY',
            health: 'healthy',
          },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.error?.message || body?.error || `Model registration failed (HTTP ${res.status})`);
      }
      state.notice = `Registered model '${id}' on runtime '${runtimeId}'. Run a probe to verify readiness.`;
      await refreshFleet();
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      state.registering = false;
      render();
    }
  }

  function renderCapabilityBadges(caps) {
    if (!caps) return '';
    const badges = [];
    if (Array.isArray(caps.declared)) {
      for (const c of caps.declared) {
        badges.push(`<span class="gs-badge gs-badge-cap" style="display:inline-block;padding:2px 6px;margin:1px;border-radius:4px;background:rgba(56,189,248,0.12);border:1px solid rgba(56,189,248,0.35);font-size:11px;">${escapeHtml(c)}</span>`);
      }
    }
    if (caps.toolCalling) {
      badges.push(`<span class="gs-badge gs-badge-tool" style="display:inline-block;padding:2px 6px;margin:1px;border-radius:4px;background:rgba(34,197,94,0.14);border:1px solid rgba(34,197,94,0.4);font-size:11px;">toolCalling</span>`);
    }
    if (caps.structuredOutput) {
      badges.push(`<span class="gs-badge" style="display:inline-block;padding:2px 6px;margin:1px;border-radius:4px;background:rgba(148,163,184,0.14);border:1px solid rgba(148,163,184,0.35);font-size:11px;">json</span>`);
    }
    if (caps.reasoning) {
      badges.push(`<span class="gs-badge" style="display:inline-block;padding:2px 6px;margin:1px;border-radius:4px;background:rgba(234,179,8,0.14);border:1px solid rgba(234,179,8,0.35);font-size:11px;">reasoning</span>`);
    }
    if (caps.vision) {
      badges.push(`<span class="gs-badge" style="display:inline-block;padding:2px 6px;margin:1px;border-radius:4px;background:rgba(168,85,247,0.14);border:1px solid rgba(168,85,247,0.35);font-size:11px;">vision</span>`);
    }
    if (caps.contextTokens) {
      badges.push(`<span class="gs-badge" style="display:inline-block;padding:2px 6px;margin:1px;border-radius:4px;background:rgba(148,163,184,0.1);border:1px solid rgba(148,163,184,0.25);font-size:11px;">ctx:${Math.round(caps.contextTokens / 1024)}k</span>`);
    }
    return badges.join(' ');
  }

  function renderModelsTable() {
    if (state.models.length === 0) {
      return `<p style="color:var(--muted,#94a3b8);margin:8px 0;">No models registered in fleet yet.</p>`;
    }
    const rows = state.models
      .map((m) => {
        const ready = Boolean(m.readiness && m.readiness.ready && m.readiness.fresh);
        const statusColor = ready ? '#22c55e' : m.readiness?.checkedAt ? '#eab308' : '#ef4444';
        const statusLabel = ready ? 'VERIFIED READY' : m.readiness?.checkedAt ? 'STALE / FAILED' : 'UNVERIFIED';
        const kindBadge = m.hosted
          ? `<span style="padding:2px 6px;border-radius:4px;background:rgba(234,179,8,0.15);border:1px solid rgba(234,179,8,0.45);color:#eab308;font-size:11px;">HOSTED (PAID)</span>`
          : `<span style="padding:2px 6px;border-radius:4px;background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.45);color:#22c55e;font-size:11px;">LOCAL ($0)</span>`;
        const toolBadge = m.readiness?.toolUse
          ? `<span style="font-size:11px;color:var(--muted,#94a3b8);">tools: <strong>${escapeHtml(m.readiness.toolUse)}</strong></span>`
          : '';
        const circuitColor = m.reliability?.state === 'CLOSED' ? '#22c55e' : m.reliability?.state === 'HALF_OPEN' ? '#eab308' : '#ef4444';
        const probeBtn = m.hosted
          ? `<span style="font-size:11px;color:var(--muted,#94a3b8);">never probed</span>`
          : `<button type="button" data-action="probe-model" data-model-id="${escapeHtml(m.modelId)}" ${state.probing ? 'disabled' : ''} style="padding:4px 8px;border-radius:4px;border:1px solid var(--border,#2f4469);background:var(--panel,#162032);color:var(--text,#f8fafc);cursor:pointer;font-size:11px;">Probe</button>`;

        return `
          <tr data-fleet-model="${escapeHtml(m.modelId)}" style="border-bottom:1px solid var(--border-subtle,#1e293b);">
            <td style="padding:8px;">
              <div style="font-weight:700;">${escapeHtml(m.modelId)}</div>
              <div style="font-size:11px;color:var(--muted,#94a3b8);">${escapeHtml(m.provider)} · state: ${escapeHtml(m.state)}</div>
            </td>
            <td style="padding:8px;">${kindBadge}</td>
            <td style="padding:8px;">
              <span style="display:inline-block;padding:2px 6px;border-radius:4px;border:1px solid ${statusColor};color:${statusColor};font-size:11px;font-weight:700;">${statusLabel}</span>
              <div style="font-size:11px;color:var(--muted,#94a3b8);margin-top:2px;">
                ${escapeHtml(m.readiness?.reason || 'never verified')}
                ${m.readiness?.latencyMs !== undefined ? ` (${m.readiness.latencyMs}ms)` : ''}
                ${m.readiness?.ageMs !== undefined ? ` · ${formatAge(m.readiness.ageMs)}` : ''}
              </div>
              <div>${toolBadge}</div>
            </td>
            <td style="padding:8px;">${renderCapabilityBadges(m.capabilities)}</td>
            <td style="padding:8px;font-size:12px;">
              <span style="color:${circuitColor};font-weight:700;">${escapeHtml(m.reliability?.state || 'CLOSED')}</span>
              <div style="font-size:11px;color:var(--muted,#94a3b8);">
                routes: ${m.accounting?.routes ?? 0} (${m.accounting?.successes ?? 0} ok / ${m.accounting?.failures ?? 0} err)
                · spend: ${formatUsd(m.accounting?.actualCostUsd ?? 0)}
              </div>
            </td>
            <td style="padding:8px;text-align:right;">${probeBtn}</td>
          </tr>
        `;
      })
      .join('');

    return `
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="text-align:left;border-bottom:1px solid var(--border,#2f4469);color:var(--muted,#94a3b8);font-size:11px;text-transform:uppercase;">
              <th style="padding:8px;">Model</th>
              <th style="padding:8px;">Locality &amp; Cost</th>
              <th style="padding:8px;">Verified Readiness</th>
              <th style="padding:8px;">Capabilities</th>
              <th style="padding:8px;">Reliability &amp; Spend</th>
              <th style="padding:8px;text-align:right;">Action</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderSimulatorResult() {
    const res = state.simulator.result;
    if (!res) return '';
    const d = res.decision;
    const candidates = Array.isArray(res.candidates) ? res.candidates : [];

    const decisionHtml = d
      ? `
        <div data-route-decision="${escapeHtml(d.modelId)}" style="padding:10px;border-radius:6px;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.4);margin-bottom:10px;">
          <div style="font-weight:700;color:#22c55e;">
            Selected: ${escapeHtml(d.modelId)} via ${escapeHtml(d.runtimeId)}${d.computerId ? ` on ${escapeHtml(d.computerId)}` : ''}
            (score ${d.score}, ${d.hosted ? `hosted est. ${formatUsd(d.estimatedCostUsd)}` : 'local $0.00'})
          </div>
          <ul style="margin:6px 0 0 18px;padding:0;font-size:12px;color:var(--text,#f8fafc);">
            ${(d.reasons || []).map((r) => `<li>${escapeHtml(r)}</li>`).join('')}
          </ul>
        </div>
      `
      : `
        <div data-route-decision="none" style="padding:10px;border-radius:6px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.45);margin-bottom:10px;color:#ef4444;font-weight:700;">
          No verified-ready model satisfied the capability and budget constraints.
        </div>
      `;

    const candRows = candidates
      .map(
        (c) => `
        <tr style="border-bottom:1px solid var(--border-subtle,#1e293b);font-size:12px;">
          <td style="padding:6px;font-weight:600;">${escapeHtml(c.modelId)}</td>
          <td style="padding:6px;">${c.hosted ? 'hosted' : 'local'}</td>
          <td style="padding:6px;color:${c.eligible ? '#22c55e' : '#ef4444'};">${c.eligible ? `ELIGIBLE (score ${c.score})` : 'REJECTED'}</td>
          <td style="padding:6px;color:var(--muted,#94a3b8);">${escapeHtml(c.rejection || (c.reasons || []).join('; '))}</td>
        </tr>
      `,
      )
      .join('');

    return `
      <div style="margin-top:12px;">
        ${decisionHtml}
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="text-align:left;border-bottom:1px solid var(--border,#2f4469);color:var(--muted,#94a3b8);font-size:11px;">
              <th style="padding:6px;">Candidate</th>
              <th style="padding:6px;">Type</th>
              <th style="padding:6px;">Verdict</th>
              <th style="padding:6px;">Explanation / Rejection Reason</th>
            </tr>
          </thead>
          <tbody>${candRows}</tbody>
        </table>
      </div>
    `;
  }

  function renderWorkersTable() {
    if (state.workers.length === 0) {
      return `<p style="color:var(--muted,#94a3b8);margin:8px 0;">No compute workers registered.</p>`;
    }
    const cards = state.workers
      .map((w) => {
        const online = w.status === 'online';
        const badgeColor = online ? '#22c55e' : '#ef4444';
        const mem = w.resources
          ? `${w.resources.availableMemoryGB ?? '?'} GB free / ${w.resources.totalMemoryGB ?? '?'} GB total${w.resources.unifiedMemory ? ' (unified)' : ''}`
          : w.resourceError || 'resource snapshot unavailable';

        return `
          <div data-fleet-worker="${escapeHtml(w.id)}" style="padding:10px;border-radius:6px;border:1px solid var(--border,#2f4469);background:var(--panel,#162032);">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <strong>${escapeHtml(w.name || w.id)} (${escapeHtml(w.workerId || w.id)})</strong>
              <span style="padding:2px 6px;border-radius:4px;border:1px solid ${badgeColor};color:${badgeColor};font-size:11px;font-weight:700;">
                ${escapeHtml(w.status?.toUpperCase() || 'UNKNOWN')} · ${escapeHtml(w.heartbeat || '')}
              </span>
            </div>
            <div style="font-size:12px;color:var(--muted,#94a3b8);margin-top:6px;">
              <div>Host: ${w.local ? 'Local Control Plane' : 'Remote Worker'} · Health: ${escapeHtml(w.health)}</div>
              <div>Memory: ${escapeHtml(mem)}</div>
              <div>Runtimes: ${escapeHtml((w.runtimes || []).join(', ') || 'none')}</div>
            </div>
          </div>
        `;
      })
      .join('');

    return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;">${cards}</div>`;
  }

  function render() {
    if (!rootEl || unmounted) return;
    const s = state.summary;

    rootEl.innerHTML = `
      <div class="gs-fleet-view" style="display:flex;flex-direction:column;gap:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;padding:12px;border-radius:8px;border:1px solid var(--border,#2f4469);background:var(--panel,#162032);">
          <div>
            <h2 style="margin:0;font-size:16px;">Model Fleet &amp; Verified Readiness Router</h2>
            <div style="font-size:12px;color:var(--muted,#94a3b8);margin-top:2px;">
              Models: <strong>${s.verifiedReady}/${s.models}</strong> verified ready · Hosted: <strong>${s.hosted}</strong> ·
              Workers Online: <strong>${s.computersOnline}/${s.computers}</strong> ·
              Runtimes Healthy: <strong>${s.runtimesHealthy}/${s.runtimes}</strong> ·
              Readiness TTL: ${Math.round(state.readinessTtlMs / 1000)}s
            </div>
          </div>
          <div style="display:flex;gap:8px;">
            <button type="button" data-action="probe-all" ${state.probing ? 'disabled' : ''} style="padding:6px 12px;border-radius:4px;border:1px solid var(--accent,#38bdf8);background:rgba(56,189,248,0.15);color:var(--text,#f8fafc);cursor:pointer;font-weight:600;">
              ${state.probing ? 'Probing Local Fleet...' : 'Probe Local Models ($0)'}
            </button>
            <button type="button" data-action="refresh-fleet" ${state.loading ? 'disabled' : ''} style="padding:6px 12px;border-radius:4px;border:1px solid var(--border,#2f4469);background:var(--panel,#162032);color:var(--text,#f8fafc);cursor:pointer;">
              Refresh
            </button>
          </div>
        </div>

        ${state.error ? `<div role="alert" style="padding:10px;border-radius:6px;background:rgba(239,68,68,0.15);border:1px solid #ef4444;color:#ef4444;font-size:12px;">${escapeHtml(state.error)}</div>` : ''}
        ${state.notice ? `<div style="padding:10px;border-radius:6px;background:rgba(56,189,248,0.12);border:1px solid rgba(56,189,248,0.4);color:var(--text,#f8fafc);font-size:12px;">${escapeHtml(state.notice)}</div>` : ''}

        <section style="padding:12px;border-radius:8px;border:1px solid var(--border,#2f4469);background:var(--panel,#162032);">
          <h3 style="margin:0 0 8px 0;font-size:14px;">Model Readiness &amp; Capability Inventory</h3>
          ${renderModelsTable()}
        </section>

        <section style="padding:12px;border-radius:8px;border:1px solid var(--border,#2f4469);background:var(--panel,#162032);">
          <h3 style="margin:0 0 8px 0;font-size:14px;">Route Simulator (Verified-Ready + Budget Gate)</h3>
          <form data-form="route-simulator" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;align-items:end;">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">
              <span>Required Capabilities (comma-separated)</span>
              <input name="requiredCapabilities" value="${escapeHtml(state.simulator.requiredCapabilities)}" placeholder="coding, toolCalling, context:32k" style="padding:6px;border-radius:4px;border:1px solid var(--border,#2f4469);background:var(--bg,#0f131a);color:var(--text,#f8fafc);" />
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">
              <span>Remaining Hosted Budget (USD)</span>
              <input name="remainingHostedBudgetUsd" type="number" step="0.01" min="0" value="${escapeHtml(state.simulator.remainingHostedBudgetUsd)}" style="padding:6px;border-radius:4px;border:1px solid var(--border,#2f4469);background:var(--bg,#0f131a);color:var(--text,#f8fafc);" />
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">
              <span>Exclude Model IDs (fallback test)</span>
              <input name="excludeModelIds" value="${escapeHtml(state.simulator.excludeModelIds)}" placeholder="model-a, model-b" style="padding:6px;border-radius:4px;border:1px solid var(--border,#2f4469);background:var(--bg,#0f131a);color:var(--text,#f8fafc);" />
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;padding-bottom:6px;">
              <input name="localFirst" type="checkbox" ${state.simulator.localFirst ? 'checked' : ''} />
              <span>Local-First Policy ($0 preferred)</span>
            </label>
            <div>
              <button type="submit" ${state.routing ? 'disabled' : ''} style="padding:6px 14px;border-radius:4px;border:1px solid var(--accent,#38bdf8);background:var(--accent,#38bdf8);color:#0f131a;font-weight:700;cursor:pointer;">
                ${state.routing ? 'Simulating...' : 'Simulate Route'}
              </button>
            </div>
          </form>
          ${renderSimulatorResult()}
        </section>

        <section style="padding:12px;border-radius:8px;border:1px solid var(--border,#2f4469);background:var(--panel,#162032);">
          <h3 style="margin:0 0 8px 0;font-size:14px;">Worker &amp; Computer Fleet Health</h3>
          ${renderWorkersTable()}
        </section>

        <section style="padding:12px;border-radius:8px;border:1px solid var(--border,#2f4469);background:var(--panel,#162032);">
          <h3 style="margin:0 0 8px 0;font-size:14px;">Register Model Instance (Operator)</h3>
          <form data-form="register-model" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;align-items:end;">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">
              <span>Model ID</span>
              <input name="id" placeholder="qwen2.5-coder:14b" required style="padding:6px;border-radius:4px;border:1px solid var(--border,#2f4469);background:var(--bg,#0f131a);color:var(--text,#f8fafc);" />
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">
              <span>Runtime ID</span>
              <input name="runtimeId" value="ollama" style="padding:6px;border-radius:4px;border:1px solid var(--border,#2f4469);background:var(--bg,#0f131a);color:var(--text,#f8fafc);" />
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">
              <span>Locality</span>
              <select name="kind" style="padding:6px;border-radius:4px;border:1px solid var(--border,#2f4469);background:var(--bg,#0f131a);color:var(--text,#f8fafc);">
                <option value="local">Local ($0)</option>
                <option value="hosted">Hosted (Paid)</option>
              </select>
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;">
              <span>Capabilities</span>
              <input name="capabilities" value="generalChat, coding, agenticExecution" style="padding:6px;border-radius:4px;border:1px solid var(--border,#2f4469);background:var(--bg,#0f131a);color:var(--text,#f8fafc);" />
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;padding-bottom:6px;">
              <input name="toolCalling" type="checkbox" checked />
              <span>Declares Tool Calling</span>
            </label>
            <div>
              <button type="submit" ${state.registering ? 'disabled' : ''} style="padding:6px 12px;border-radius:4px;border:1px solid var(--border,#2f4469);background:var(--panel-hover,#1e293b);color:var(--text,#f8fafc);cursor:pointer;">
                ${state.registering ? 'Registering...' : 'Register Model'}
              </button>
            </div>
          </form>
        </section>
      </div>
    `;
  }

  function onClick(event) {
    const target = event.target?.closest?.('[data-action]');
    if (!target) return;
    const action = target.getAttribute('data-action');
    if (action === 'refresh-fleet') {
      void refreshFleet();
    } else if (action === 'probe-all') {
      void runProbe(undefined);
    } else if (action === 'probe-model') {
      const modelId = target.getAttribute('data-model-id');
      if (modelId) void runProbe(modelId);
    }
  }

  function onSubmit(event) {
    const form = event.target?.closest?.('form[data-form]');
    if (!form) return;
    event.preventDefault();
    const formKind = form.getAttribute('data-form');
    if (formKind === 'route-simulator') {
      const fd = new FormData(form);
      state.simulator.requiredCapabilities = String(fd.get('requiredCapabilities') || '');
      state.simulator.remainingHostedBudgetUsd = String(fd.get('remainingHostedBudgetUsd') || '0');
      state.simulator.excludeModelIds = String(fd.get('excludeModelIds') || '');
      state.simulator.localFirst = fd.get('localFirst') === 'on';
      void runSimulator();
    } else if (formKind === 'register-model') {
      void registerModelFromForm(form);
    }
  }

  return {
    mount(el, ctx) {
      unmounted = false;
      rootEl = el;
      currentCtx = ctx || {};
      rootEl.addEventListener('click', onClick);
      rootEl.addEventListener('submit', onSubmit);
      render();
      void refreshFleet();
      if (typeof window !== 'undefined' && typeof window.setInterval === 'function') {
        refreshTimer = window.setInterval(() => {
          void refreshFleet();
        }, 30000);
      }
    },
    unmount() {
      unmounted = true;
      if (refreshTimer !== null && typeof window !== 'undefined') {
        window.clearInterval(refreshTimer);
        refreshTimer = null;
      }
      if (rootEl) {
        rootEl.removeEventListener('click', onClick);
        rootEl.removeEventListener('submit', onSubmit);
        rootEl.innerHTML = '';
        rootEl = null;
      }
      currentCtx = null;
    },
  };
}

const fleetModule = createFleetModule();

if (typeof window !== 'undefined') {
  window.WazirGoalStudio = window.WazirGoalStudio || {
    modules: {},
    register(name, mod) {
      this.modules = this.modules || {};
      this.modules[name] = mod;
    },
  };
  if (typeof window.WazirGoalStudio.register === 'function') {
    window.WazirGoalStudio.register('fleet', fleetModule);
  }
}

export default fleetModule;
