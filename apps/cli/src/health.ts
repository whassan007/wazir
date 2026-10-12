import { buildHealthReport, formatAgo, type HealthReport, type HealthDiagnostic } from '@wazir/core';
import type { ResourceSnapshot } from '@wazir/core';
import type { RookEngine } from './engine.js';
import { color } from './colors.js';
import type { FleetNodeHealth } from './tui/observabilityViews.js';

type HealthEngine = Pick<RookEngine, 'runtimes' | 'models' | 'computers' | 'health'> & {
  worker?: Pick<RookEngine['worker'], 'id' | 'computerId' | 'isRunning' | 'info'>;
};

/** Snapshots the authoritative registries and projects them into a health report. */
export function collectHealthReport(engine: HealthEngine, now = new Date()): HealthReport {
  const computers = engine.computers.list();
  const resources: Record<string, ResourceSnapshot> = {};
  for (const c of computers) {
    try {
      resources[c.id] = engine.computers.resourceSnapshot(c.id);
    } catch {
      // unobserved resources stay UNKNOWN
    }
  }
  const worker = engine.worker;
  return buildHealthReport({
    runtimes: engine.runtimes.list(),
    models: engine.models.list(),
    instances: engine.models.listInstances(),
    computers,
    resources,
    workers: worker
      ? [{ id: worker.id, computerId: worker.computerId, status: worker.info.status, running: worker.isRunning, lastHeartbeat: worker.info.lastHeartbeat }]
      : [],
    observations: engine.health?.snapshot(),
    now,
  });
}

const GiB = 1024 ** 3;
const gib = (n?: number) => (n === undefined ? '?' : (n / GiB).toFixed(0));

function stateColor(s: string): (t: string) => string {
  if (['READY', 'HEALTHY', 'OBSERVED', 'OK', 'online'].includes(s)) return color.green;
  if (['UNREACHABLE', 'UNAVAILABLE', 'FAILING', 'CRITICAL', 'FAILED', 'offline'].includes(s)) return color.red;
  if (['DEGRADED', 'HIGH', 'LOADED', 'LOADING'].includes(s)) return color.yellow;
  return color.gray;
}
const paint = (s: string) => stateColor(s)(s);

export function renderDiagnosticDetail(d: HealthDiagnostic): string[] {
  const sev = d.severity === 'error' ? color.red : d.severity === 'warning' ? color.yellow : color.gray;
  const lines = [`${sev(d.code)}  ${color.gray(`${d.subject.kind} ${d.subject.id} · ${d.domain}`)}`, `  Reason: ${d.reason}`];
  for (const e of d.evidence) {
    lines.push(color.gray(`    ${e.label} = ${e.value === null ? 'unknown' : String(e.value)}  (${e.source}${e.observedAt ? ` @ ${e.observedAt}` : ''})`));
  }
  return lines;
}

export function renderHealthReport(report: HealthReport, options: { detail?: boolean } = {}): string {
  const now = new Date(report.generatedAt);
  const lines: string[] = [color.bold('Runtime & Model Health'), ''];

  if (report.runtimes.length === 0) lines.push(color.gray('  no runtimes registered'));
  for (const r of report.runtimes) {
    const p = r.resourcePressure;
    lines.push(`${color.bold(r.runtimeId)} ${color.gray(`(${r.runtimeType}${r.computerId ? ` on ${r.computerId}` : ''})`)}`);
    lines.push(`  Runtime     ${paint(r.state)}`);
    lines.push(`  Inference   ${paint(r.inference)}${r.lastSuccessfulInference ? color.gray(`  last ok ${formatAgo(r.lastSuccessfulInference, now)}`) : ''}`);
    lines.push(`  Telemetry   ${paint(r.telemetryStatus)}`);
    lines.push(`  Memory      ${p.level === 'UNKNOWN' && p.totalMemoryBytes === undefined ? paint('UNKNOWN') : `${gib(p.usedMemoryBytes)} / ${gib(p.totalMemoryBytes)} GiB ${paint(p.level)}`}${p.reservedMemoryBytes > 0 ? color.gray(`  reserved ${gib(p.reservedMemoryBytes)} GiB`) : ''}`);
    lines.push(`  Queue       ${r.queueDepth ?? color.gray('unknown')}`);
    for (const m of report.models.filter((x) => x.runtimeId === r.runtimeId && (x.loaded || x.lifecycleState !== 'INSTALLED' || options.detail))) {
      const flags = [`loaded=${m.loaded}`, `ready=${m.ready}`, m.contextLimit ? `ctx=${m.contextLimit}` : '', m.currentReservations.count ? `res=${m.currentReservations.count}` : '']
        .filter(Boolean).join(' ');
      lines.push(`  Model       ${m.modelId}  ${paint(m.lifecycleState)} ${color.gray(flags)}`);
    }
    lines.push('');
  }
  for (const w of report.workers) {
    lines.push(`Worker ${w.workerId} on ${w.computerId}  ${paint(w.status)}`);
  }
  if (report.workers.length) lines.push('');

  if (report.diagnostics.length === 0) {
    lines.push(color.green('No problems classified.'));
  } else {
    lines.push(color.bold(`Diagnostics (${report.diagnostics.length})`));
    for (const d of report.diagnostics) {
      if (options.detail) lines.push(...renderDiagnosticDetail(d), '');
      else lines.push(`  ${d.severity === 'error' ? color.red(d.code) : d.severity === 'warning' ? color.yellow(d.code) : color.gray(d.code)}  ${d.subject.id}: ${d.reason}`);
    }
    if (!options.detail) lines.push(color.gray('  (use --detail to show evidence)'));
  }
  return lines.join('\n');
}

/** Exit code: 1 when any error-severity diagnostic exists; info/UNKNOWN never fail. */
export function healthExitCode(report: HealthReport): number {
  return report.diagnostics.some((d) => d.severity === 'error') ? 1 : 0;
}

export async function healthCommand(options: { json?: boolean; detail?: boolean }): Promise<{ code: number; output: string }> {
  const { createEngine } = await import('./engine.js');
  const engine = await createEngine({ readOnlyLifecycle: true });
  const report = collectHealthReport(engine);
  const output = options.json ? JSON.stringify(report, null, 2) : renderHealthReport(report, options);
  return { code: healthExitCode(report), output };
}

const SEVERITY_RANK: Record<string, number> = { error: 0, warning: 1, info: 2 };

/** Per-computer compact projection for the Mission Control FLEET view. */
export function fleetNodeHealth(report: HealthReport, computerId: string): FleetNodeHealth {
  const now = new Date(report.generatedAt);
  const runtimes = report.runtimes.filter((r) => r.computerId === computerId);
  const runtimeIds = new Set(runtimes.map((r) => r.runtimeId));
  const models = report.models.filter((m) => m.computerId === computerId || runtimeIds.has(m.runtimeId));
  const primary = runtimes.find((r) => r.state === 'READY') ?? runtimes[0];
  const model = models.find((m) => m.ready) ?? models.find((m) => m.loaded);
  const pressure = primary?.resourcePressure;
  const workerIds = new Set(report.workers.filter((w) => w.computerId === computerId).map((w) => w.workerId));
  const diagnostics = report.diagnostics
    .filter((d) =>
      (d.subject.kind === 'runtime' && runtimeIds.has(d.subject.id)) ||
      (d.subject.kind === 'model' && runtimeIds.has(d.subject.id.slice(d.subject.id.lastIndexOf('@') + 1))) ||
      (d.subject.kind === 'worker' && workerIds.has(d.subject.id)) ||
      (d.subject.kind === 'computer' && d.subject.id === computerId))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .map((d) => ({
      code: d.code,
      severity: d.severity,
      subject: d.subject.id,
      reason: d.reason,
      evidence: d.evidence.map((e) => {
        const v = e.value === null ? 'unknown' : String(e.value);
        return `${e.label} = ${e.label.startsWith('last') && e.observedAt ? `${v} (${formatAgo(e.observedAt, now)})` : v}`;
      }),
    }));
  const queued = runtimes.map((r) => r.queueDepth).filter((q): q is number => q !== null);
  return {
    runtime: primary ? { name: primary.runtimeType, state: primary.state } : undefined,
    model: model ? { id: model.modelId, state: model.ready ? 'READY' : model.lifecycleState } : undefined,
    memory: pressure
      ? {
          usedGiB: pressure.usedMemoryBytes !== undefined ? Math.round((pressure.usedMemoryBytes + pressure.reservedMemoryBytes) / GiB) : undefined,
          totalGiB: pressure.totalMemoryBytes !== undefined ? Math.round(pressure.totalMemoryBytes / GiB) : undefined,
          level: pressure.level,
        }
      : undefined,
    queueDepth: queued.length ? queued.reduce((a, b) => a + b, 0) : null,
    inference: primary?.inference ?? 'UNKNOWN',
    telemetry: primary?.telemetryStatus ?? 'UNKNOWN',
    diagnostics,
  };
}
