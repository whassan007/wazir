import { ModelLifecycleError } from '@wazir/core';
import type { RookEngine } from '../engine.js';
import { color } from '../colors.js';
import {
  table,
  gib,
  type LifecycleCommandOptions,
  lifecycleOptions,
  formatModelLoadPlan,
} from './formatters.js';

export function listAgents(engine: RookEngine): string {
  const agents = engine.agents.list();
  if (agents.length === 0) return color.yellow('no agents registered');
  return table(
    ['name', 'version', 'task types', 'capabilities', 'source'],
    agents.map((a) => [
      a.descriptor.name,
      a.descriptor.version,
      a.descriptor.taskTypes.join(','),
      a.descriptor.capabilities.join(','),
      a.source,
    ]),
  );
}

export function listModels(engine: RookEngine, options: { json?: boolean; computer?: string; runtime?: string } = {}): string {
  const instances = engine.lifecycle.list().filter(i => (!options.computer || i.computerId === options.computer) && (!options.runtime || i.runtimeId === options.runtime));
  if (options.json) return JSON.stringify(engine.models.list().map(m => ({ ...m, instances: instances.filter(i => i.modelId === m.id) })), null, 2);
  const capacity = engine.computers.list().filter(c => !options.computer || c.id === options.computer).flatMap(c => {
    const snapshot = engine.computers.resourceSnapshot(c.id);
    return engine.runtimes.list().filter(r => r.computerId === c.id && (!options.runtime || r.id === options.runtime)).map(r => {
      const rows = instances.filter(i => i.computerId === c.id && i.runtimeId === r.id);
      return [c.name, `${gib(snapshot.totalMemoryBytes)} / ${gib(snapshot.availableMemoryBytes)} free`, r.name,
        String(engine.models.listInstallations().filter(i => i.computerId === c.id && i.runtimeId === r.id && i.installed).length || rows.length),
        String(rows.filter(i => i.loaded).length), String(rows.filter(i => i.state === 'READY').length)];
    });
  });
  return ['WAZIR MODELS', '', 'Fleet Capacity', table(['COMPUTER', 'MEMORY', 'RUNTIME', 'INSTALLED', 'LOADED', 'READY'], capacity),
    '', 'Models', table(['MODEL', 'COMPUTER', 'RUNTIME', 'STATE', 'CTX', 'PIN'], instances.map(i => [i.modelId, i.computerId ?? 'hosted', i.runtimeId,
      i.state ?? (i.loaded ? 'LOADED' : 'INSTALLED'), i.contextTokens ? String(i.contextTokens) : '-', i.pinned ? 'yes' : 'no'])),
    '', `Summary: Installed ${instances.length}  Loaded ${instances.filter(i => i.loaded).length}  Ready ${instances.filter(i => i.state === 'READY').length}  Loading ${instances.filter(i => i.state === 'LOADING').length}  Failed ${instances.filter(i => i.state === 'FAILED').length}`].join('\n');
}

export function listLoadedModels(engine: RookEngine, options: { json?: boolean; computer?: string; runtime?: string } = {}): string {
  const rows = engine.lifecycle.list().filter(i => i.loaded && (!options.computer || options.computer === i.computerId) && (!options.runtime || options.runtime === i.runtimeId));
  if (options.json) return JSON.stringify(rows, null, 2);
  if (!rows.length) return 'No models are currently loaded in memory.';
  return table(['MODEL', 'COMPUTER', 'RUNTIME', 'STATE', 'CTX', 'PIN'], rows.map(i => [i.modelId, i.computerId ?? 'hosted', i.runtimeId, i.state ?? 'LOADED', String(i.contextTokens ?? '-'), i.pinned ? 'yes' : 'no']));
}

export async function discoverModelsCommand(engine: RookEngine, options: { json?: boolean } = {}): Promise<string> {
  const result = await engine.lifecycle.discoverAndReconcile();
  if (options.json) {
    return JSON.stringify(
      {
        ...result,
        readiness: engine.lifecycle.getReadiness(),
      },
      null,
      2,
    );
  }
  const readiness = engine.lifecycle.getReadiness();
  const lines = [
    color.bold('Model Discovery & Reconciliation'),
    `  Total discovered across runtimes: ${result.totalDiscovered}`,
    `  Newly registered:                 ${result.newlyRegistered}`,
    `  Installed models:                 ${readiness.installedCount}`,
    `  Ready in memory:                  ${readiness.readyCount}`,
    '',
    listModels(engine),
  ];
  return lines.join('\n');
}

export async function loadModelCommand(engine: RookEngine, modelId: string, options: LifecycleCommandOptions = {}): Promise<{ ok: boolean; message: string }> {
  try {
    const plan = await engine.lifecycle.load(modelId, lifecycleOptions(options));
    const ok = plan.admissionDecision.status === 'ADMITTED';
    return { ok, message: options.json ? JSON.stringify({ ok, dryRun: !!options.dryRun, plan }, null, 2)
      : formatModelLoadPlan(plan) + (options.dryRun ? '\n\nDry run: no runtime mutation.' : '\n\nVerified context and health probe: READY') };
  } catch (e) {
    const code = e instanceof ModelLifecycleError ? e.code : 'RUNTIME_LOAD_FAILED';
    const reasons = e instanceof ModelLifecycleError ? e.reasons : [];
    const plan = e instanceof ModelLifecycleError ? e.plan : undefined;
    return { ok: false, message: options.json ? JSON.stringify({ ok: false, code, reasons, plan }, null, 2)
      : (plan ? formatModelLoadPlan(plan) + '\n\n' : '') + code + (reasons.length ? '\n' + reasons.join('\n') : '') +
        (code === 'MODEL_ADMISSION_DENIED' ? '\nRuntime load was NOT attempted.' : '') };
  }
}

export async function unloadModelCommand(engine: RookEngine, modelId: string, options: LifecycleCommandOptions = {}): Promise<{ ok: boolean; message: string }> {
  try {
    await engine.lifecycle.unload(modelId, { ...lifecycleOptions(options), drain: options.drain });
    return { ok: true, message: options.json ? JSON.stringify({ ok: true, modelId, state: 'UNLOADED' }) : `${modelId} unloaded successfully: UNLOADED` };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, message: options.json ? JSON.stringify({ ok: false, error }) : error };
  }
}

export function listRuntimes(engine: RookEngine): string {
  const discoveredById = new Map(engine.discovered.map((d) => [d.id, d]));
  const rows = engine.runtimes.list().map((r) => {
    const disc = discoveredById.get(r.id);
    const modelCount = disc ? disc.models.length : engine.models.instancesForRuntime(r.id).length;
    return [
      r.id,
      r.name,
      r.version,
      disc?.info.url ?? r.url ?? '—',
      disc?.health ?? r.health,
      modelCount > 0 ? `${modelCount} models` : '—',
    ];
  });
  return table(['runtime', 'name', 'version', 'url', 'health', 'models'], rows);
}

export function listComputers(engine: RookEngine): string {
  const computers = engine.computers.list();
  const rows = computers.map((c) => {
    const load = c.load;
    return [
      c.id,
      c.name,
      c.local ? 'local' : 'remote',
      c.os?.platform ?? '—',
      `${c.hardware?.cpuCores ?? '—'} cores`,
      `${c.hardware?.memoryGB ?? '—'}GB`,
      c.hardware?.gpu?.model ?? 'no GPU',
      load ? `${load.cpuPercent}% cpu` : '—',
      c.status,
    ];
  });
  return table(
    ['id', 'name', 'scope', 'os', 'cpu', 'ram', 'gpu', 'load', 'status'],
    rows,
  );
}

export function listWorkers(engine: RookEngine): string {
  const w = engine.worker;
  const lines = [
    color.bold('Local worker'),
    `  id:        ${w.id}`,
    `  computer:  ${w.computerId}`,
    `  name:      ${w.name}`,
    `  status:    ${w.info.status}`,
    `  runtimes:  ${w.info.runtimes.join(', ') || '—'}`,
    `  models:    ${w.info.models.length} discovered`,
  ];
  return lines.join('\n');
}

export function listTools(engine: RookEngine): string {
  const tools = engine.tools.list();
  const rows = tools.map((t) => [
    t.descriptor.name,
    t.descriptor.permissions.join(','),
    t.descriptor.riskLevel,
    t.descriptor.description.slice(0, 60),
  ]);
  return table(['tool', 'permissions', 'risk', 'description'], rows);
}

export function inspectPolicy(engine: RookEngine): string {
  const lines: string[] = [color.bold('Policy rules'), ''];
  for (const rule of engine.policy.rules) {
    lines.push(`  ${rule.scope.padEnd(12)} ${rule.pattern.padEnd(10)} → ${rule.effect.padEnd(6)} ${color.gray(rule.description)}`);
  }
  lines.push('');
  lines.push(color.bold('Policy options'));
  lines.push(`  projectRoot:    ${engine.projectRoot}`);
  lines.push(`  networkAllowed: ${engine.config.networkAllowed}`);
  lines.push(`  allowCommands:  ${engine.config.allowCommands.join(', ') || '—'}`);
  lines.push(`  denyCommands:   ${engine.config.denyCommands.join(', ') || '—'}`);
  lines.push(`  mcpServers:     ${engine.config.allowedMcpServers.join(', ') || '—'}`);
  return lines.join('\n');
}

export async function discover(engine: RookEngine): Promise<string> {
  const lines: string[] = [color.bold('Runtime discovery'), ''];
  for (const discovered of engine.discovered) {
    lines.push(`  ${discovered.info.name} (${discovered.id}) — ${discovered.health}${discovered.healthMessage ? color.gray(`: ${discovered.healthMessage}`) : ''}`);
    for (const model of discovered.models) {
      lines.push(color.gray(`    ${model.id}${model.parameters ? color.gray(` (${model.parameters})`) : ''}${model.toolCalling ? ' tool-calling' : ''}`));
    }
  }
  for (const [providerId] of engine.hostedAdapters) {
    const rt = engine.runtimes.get(providerId);
    if (!rt) continue;
    const providerModels = engine.models.list().filter((m) => m.provider === providerId);
    lines.push(`  ${rt.name} (${rt.id}) — ${rt.health} [hosted]`);
    for (const model of providerModels) {
      lines.push(color.gray(`    ${model.id}${model.parameters ? color.gray(` (${model.parameters})`) : ''}${model.toolCalling ? ' tool-calling' : ''}`));
    }
  }
  return lines.join('\n');
}

export async function inspectRuntime(engine: RookEngine, id: string): Promise<void> {
  const runtime = engine.discovered.find((r) => r.id === id);
  const hostedAdapter = engine.hostedAdapters.get(id as any);
  const runtimeReg = engine.runtimes.get(id);
  if (!runtime && !hostedAdapter && !runtimeReg) {
    console.error(color.red(`Runtime '${id}' not found.`));
    return;
  }

  if (!runtime && (hostedAdapter || runtimeReg)) {
    const info = hostedAdapter ? await hostedAdapter.discover() : { id, name: runtimeReg?.name ?? id, version: runtimeReg?.version ?? 'v1', url: runtimeReg?.url };
    const status = hostedAdapter ? await hostedAdapter.status() : { authenticated: runtimeReg?.health === 'healthy', eligible: runtimeReg?.health === 'healthy' };
    const models = engine.models.list().filter((m) => m.provider === id);
    console.log(`\n${color.bold(info.name || id)}`);
    console.log('-'.repeat(48));
    console.log(`Kind:       hosted (HOSTED_INFERENCE)`);
    console.log(`Endpoint:   ${info.url || 'unknown'}`);
    console.log(`Auth:       ${status.authenticated ? color.green(`authenticated (${(status as any).credentialSource ?? (status as any).method ?? 'api-key'})`) : color.yellow('unauthenticated')}`);
    console.log(`Health:     ${runtimeReg?.health === 'healthy' ? color.green('healthy') : color.yellow(runtimeReg?.health ?? 'unavailable')}`);
    console.log(`Models:     ${models.length} registered`);
    console.log();
    return;
  }

  console.log(`\n${color.bold(runtime!.info.name || id)}`);
  console.log('-'.repeat(48));
  console.log(`Computer:   ${process.env.WAZIR_COMPUTER_ID || 'local'}`);

  if (runtime!.healthDiagnostics) {
    const diag = runtime!.healthDiagnostics;
    console.log(`CLI:        ${diag.cliAvailable ? color.green('available') : color.red('unavailable')}`);
    console.log(`Server:     ${diag.serverRunning ? color.green('running') : color.red('stopped')}`);
    console.log(`Endpoint:   ${diag.endpoint}`);
    console.log(`API:        ${diag.apiReachable ? color.green('reachable') : color.red('unreachable')}`);
    console.log('');
    console.log(`Models:     ${diag.installedModels} installed | ${diag.loadedModels} loaded | ${diag.readyModels} ready`);
  } else {
    console.log(`Endpoint:   ${runtime!.info.url || 'unknown'}`);
    console.log(`Health:     ${runtime!.health === 'healthy' ? color.green('healthy') : color.red(runtime!.health)}`);
  }

  if (runtime!.health !== 'healthy') {
    console.log(`\n${color.red('Error:')}`);
    console.log(`  ${runtime!.healthReason || 'UNAVAILABLE'} ${runtime!.healthMessage}`);
  }

  if (runtime!.healthDiagnostics?.cliAvailable && !runtime!.healthDiagnostics.serverRunning && runtime!.adapter.startServer) {
    console.log(`\n${color.yellow('Suggested action:')}`);
    console.log(`  Start LM Studio API server or correct runtime endpoint.`);
    console.log(`  Run: wa runtimes start ${id}`);
  }

  console.log();
}
