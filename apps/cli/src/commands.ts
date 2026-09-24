import { explainExecution, ModelLifecycleError, summarizeExecution, type ModelLoadOptions, type ModelLoadPlan } from '@wazir/core';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ArtifactProvenance, ArtifactType, TaskType } from '@wazir/core';
import type { RookEngine } from './engine.js';
import { color } from './colors.js';
import { executeTask, planTask } from './run.js';
import { tokensPerSecond, readAuditEvents, stripTerminalEscapes, type AuditEvent } from '@wazir/shared';
import { parseAction, normalizeAction, missingRequiredFields, REQUIRED_TOOL_FIELDS } from '@wazir/agents';

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  const out = [line(headers), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const row of rows) {
    out.push(line(row));
  }
  return out.join('\n');
}

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
function gib(bytes?: number): string { return bytes === undefined ? 'unknown' : `${(bytes / 1024 ** 3).toFixed(1)} GiB`; }
export function listLoadedModels(engine: RookEngine, options: { json?: boolean; computer?: string; runtime?: string } = {}): string {
  const rows = engine.lifecycle.list().filter(i => i.loaded && (!options.computer || options.computer === i.computerId) && (!options.runtime || options.runtime === i.runtimeId));
  if (options.json) return JSON.stringify(rows, null, 2);
  if (!rows.length) return 'No models are currently loaded in memory.';
  return table(['MODEL', 'COMPUTER', 'RUNTIME', 'STATE', 'CTX', 'PIN'], rows.map(i => [i.modelId, i.computerId ?? 'hosted', i.runtimeId, i.state ?? 'LOADED', String(i.contextTokens ?? '-'), i.pinned ? 'yes' : 'no']));
}

export interface LifecycleCommandOptions {
  json?: boolean; wait?: boolean; computer?: string; runtime?: string; context?: string | number;
  fit?: boolean; evict?: boolean; dryRun?: boolean; drain?: boolean;
}
export function lifecycleOptions(options: LifecycleCommandOptions): ModelLoadOptions {
  const raw = options.context;
  let context: number | undefined;
  let mode: ModelLoadOptions['mode'] = 'AUTO';
  if (raw !== undefined) {
    if (String(raw).toLowerCase() === 'max-safe') mode = 'MAX_SAFE';
    else if (String(raw).toLowerCase() !== 'auto') {
      const match = String(raw).match(/^(\d+)(k)?$/i);
      if (!match) throw new ModelLifecycleError('CONTEXT_TOO_LARGE', ['invalid --context']);
      context = Number(match[1]) * (match[2] ? 1024 : 1); mode = 'EXPLICIT';
      if (!Number.isSafeInteger(context) || context <= 0) throw new ModelLifecycleError('CONTEXT_TOO_LARGE');
    }
  }
  return { computerId: options.computer, runtimeId: options.runtime, context, mode, fit: options.fit,
    evict: options.evict, dryRun: options.dryRun, initiator: 'cli', timeoutMs: options.wait ? 120_000 : undefined };
}
export function formatModelLoadPlan(plan: ModelLoadPlan): string {
  const e = plan.estimate;
  return ['MODEL LOAD PLAN', '', `Model               ${plan.modelId}`, `Target              ${plan.computerId} / ${plan.runtimeId}`,
    '', 'Resources', `  Available         ${gib(e.currentlyAvailableMemory)}`, `  Safety reserve    ${gib(e.safetyReserve)}`, `  Usable            ${gib(e.usableMemory)}`,
    '', 'Context', `  Requested         ${plan.requestedContext ?? 'AUTO'}`, `  Model maximum     ${plan.modelContextLimit ?? 'unknown'}`,
    `  Runtime maximum   ${plan.runtimeContextLimit ?? 'unknown'}`, `  Machine safe      ${plan.machineSafeContext ?? 'unknown'}`, `  Selected          ${plan.effectiveContext}`,
    ...(plan.contextReason ? [`  Reason            ${plan.contextReason}`] : []),
    '', 'Estimate', `  Weights           ${gib(e.weightMemory)}`, `  Context           ${gib(e.contextMemory)}`, `  Runtime overhead  ${gib(e.runtimeOverhead)}`,
    `  Total             ${gib(e.estimatedTotalMemory)}`, `  Source            ${e.estimateSource} (${e.confidence})`,
    '', `Admission           ${plan.admissionDecision.status}`, ...plan.admissionDecision.reasons.map(r => `  ${r}`),
    ...plan.modelsToEvict.map(v => `  Evict ${v.instanceId}: estimated reclaim ${gib(v.reclaimBytes)}`)].join('\n');
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
  const rows = engine.discovered.map((r) => [
    r.id,
    r.info.name,
    r.info.version,
    r.info.url ?? '—',
    r.health,
    r.models.length > 0 ? `${r.models.length} models` : '—',
  ]);
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

/** Build ContextPart[] from active context block IDs, for use in run.ts */
export async function buildContextPartsFromActive(
  engine: RookEngine,
): Promise<ContextPart[]> {
  const ids = await getActiveContext(engine);
  if (ids.length === 0) return [];

  const parts: ContextPart[] = [];
  for (const id of ids) {
    const block = await getBlock(engine, id);
    if (!block) continue;
    // Use stdout as content; if failed, use stderr or error message
    const content = block.stdout || (block.stderr ? `Error: ${block.stderr}` : 'No output');
    parts.push({
      kind: 'retrieved',
      label: `block #${id} (${block.command})`,
      content,
      priority: 'optional',
    });
  }
  return parts;
}

/** Add a block to active context */
export async function addContext(engine: RookEngine, id: string): Promise<{ code: number; output: string }> {
  const block = await getBlock(engine, id);
  if (!block) {
    return { code: 1, output: color.red(`block '${id}' not found`) };
  }
  try {
    await addContextBlock(engine, id);
    return { code: 0, output: color.green(`added block #${id} to context`) };
  } catch (err) {
    return { code: 1, output: color.red(String(err)) };
  }
}

/** Remove a block from active context */
export async function removeContext(engine: RookEngine, id: string): Promise<{ code: number; output: string }> {
  const current = await getActiveContext(engine);
  if (!current.includes(id)) {
    return { code: 1, output: color.yellow(`block '${id}' is not in active context`) };
  }
  try {
    await removeContextBlock(engine, id);
    return { code: 0, output: color.green(`removed block #${id} from context`) };
  } catch (err) {
    return { code: 1, output: color.red(String(err)) };
  }
}

/** List active context blocks with token estimate */
export async function listContext(engine: RookEngine): Promise<{ code: number; output: string }> {
  const ids = await getActiveContext(engine);
  if (ids.length === 0) {
    return { code: 0, output: color.yellow('no active context blocks') };
  }

  const lines: string[] = [];
  let totalTokens = 0;

  for (const id of ids) {
    const block = await getBlock(engine, id);
    if (!block) {
      lines.push(color.red(`  #${id} — not found`));
      continue;
    }
    // First ~60 chars of stdout or error
    let summary: string;
    if (block.stdout) {
      summary = block.stdout.slice(0, 60);
      if (block.stdout.length > 60) summary += '…';
    } else if (block.stderr) {
      summary = `Error: ${block.stderr.slice(0, 57)}…`;
    } else {
      summary = 'No output';
    }
    // Estimate tokens using same method as ContextCompiler
    const estTokens = Math.ceil((block.stdout?.length || block.stderr?.length || 0) / 4);
    totalTokens += estTokens;
    lines.push(`  #${id} (${block.command}) — ${summary} (~${estTokens} tok)`);
  }

  lines.push('');
  lines.push(color.bold(`Total token estimate: ~${totalTokens} tokens`));

  return { code: 0, output: lines.join('\n') };
}

/** Clear all active context blocks */
export async function clearContextCommand(engine: RookEngine): Promise<{ code: number; output: string }> {
  try {
    await clearContext(engine);
    return { code: 0, output: color.green('context cleared') };
  } catch (err) {
    return { code: 1, output: color.red(String(err)) };
  }
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

export async function listExecutions(engine: RookEngine, json: boolean): Promise<string> {
  const records = await engine.executions.list();
  if (records.length === 0) return color.yellow('no executions recorded yet');
  if (json) return JSON.stringify(records, null, 2);
  const rows = records.slice(0, 50).map((r) => [
    r.execution.id,
    r.execution.status,
    r.task.type,
    r.execution.agentId ?? '—',
    r.execution.modelId ?? '—',
    r.execution.computerId ?? '—',
    new Date(r.execution.createdAt).toISOString().replace('T', ' ').slice(0, 19),
    r.usage ? `${r.usage.input}+${r.usage.output} tok` : '—',
  ]);
  return table(['id', 'status', 'type', 'agent', 'model', 'computer', 'created', 'tokens'], rows);
}

export async function inspectExecution(engine: RookEngine, id: string, json: boolean): Promise<string> {
  let record = await engine.executions.get(id);
  if (!record) {
    const all = await engine.executions.list();
    const fuzzy = all.find((r) => r.execution.id.includes(id));
    if (!fuzzy) {
      return color.red(`execution '${id}' not found`);
    }
    record = fuzzy;
  }
  // Derived, content-free projection; the record itself remains the evidence.
  const summary = summarizeExecution(record);
  if (json) return JSON.stringify({ ...record, summary }, null, 2);

  const e = record.execution;
  const lines: string[] = [];
  lines.push(color.bold(record.execution.id));
  lines.push(`  status:    ${e.status}`);
  lines.push(`  task:      ${record.task.type} — ${record.task.input.slice(0, 80)}`);
  lines.push(`  agent:     ${e.agentId ?? '—'}`);
  lines.push(`  model:     ${e.modelId ?? '—'}`);
  lines.push(`  runtime:   ${e.runtimeId ?? '—'}`);
  lines.push(`  computer:  ${e.computerId ?? '—'}`);
  if (e.parentExecutionId) lines.push(`  parent:    ${e.parentExecutionId}`);
  lines.push(`  created:   ${e.createdAt.toISOString()}`);
  if (e.completedAt) lines.push(`  completed: ${e.completedAt.toISOString()}`);

  const ms = (value: number | null): string => (value === null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`);
  lines.push('');
  lines.push(color.bold('  Summary:'));
  lines.push(`    termination: ${summary.terminationReason ?? '—'}${summary.models.length > 1 ? `  models: ${summary.models.join(' -> ')}` : ''}`);
  lines.push(
    `    time:        total ${ms(summary.durations.totalMs)}, inference ${ms(summary.durations.modelInferenceMs)}, ` +
      `tools ${ms(summary.durations.toolMs)} (verification ${ms(summary.durations.verificationMs)}), backoff ${ms(summary.durations.retryBackoffMs)}, ` +
      `unattributed ${ms(summary.durations.unattributedMs)}`,
  );
  lines.push(
    `    counts:      ${summary.counts.modelRequests} model requests, ${summary.counts.toolCalls} tool calls (${summary.counts.failedToolCalls} failed), ` +
      `${summary.counts.invalidActions} invalid actions, ${summary.counts.duplicateActionsBlocked} duplicates blocked, ` +
      `${summary.counts.repairPhases} repair phases, ${summary.counts.retries} retries, ${summary.counts.escalations} escalations`,
  );
  lines.push(`    workspace:   revision ${summary.workspaceRevision}, ${summary.filesChanged} files changed`);

  if (record.scheduling) {
    lines.push('');
    lines.push(color.bold('  Scheduling decision:'));
    for (const reason of record.scheduling.reasons) {
      lines.push(color.gray(`    - ${reason}`));
    }
  }

  if (record.context) {
    lines.push('');
    lines.push(color.bold('  Context budget:'));
    lines.push(color.gray(`    required:  ${record.context.finalRequiredTokens} tokens`));
    lines.push(color.gray(`    available: ${record.context.available.tokens} (${record.context.available.source})`));
    lines.push(color.gray(`    fits:      ${record.context.fits ? 'PASS' : 'FAIL'}`));
  }

  lines.push('');
  lines.push(color.bold(`  Tool calls (${record.toolCalls.length}):`));
  for (const call of record.toolCalls.slice(0, 30)) {
    lines.push(
      `    ${call.tool} ${call.ok ? color.green('ok') : color.red('failed')} ${color.gray(`${call.durationMs}ms ${call.policyEffect}`)}`,
    );
  }

  if (record.policyDecisions.length > 0) {
    lines.push('');
    lines.push(color.bold(`  Policy decisions (${record.policyDecisions.length}):`));
    for (const d of record.policyDecisions.slice(0, 30)) {
      lines.push(`    ${d.tool} → ${d.decision} ${color.gray(`(${d.rule})`)}`);
    }
  }

  if (record.checks.length > 0) {
    lines.push('');
    lines.push(color.bold(`  Checks (${record.checks.length}):`));
    for (const c of record.checks) {
      lines.push(`    ${c.name} ${c.ok ? color.green('ok') : color.red('failed')}`);
    }
  }

  if (record.filesChanged.length > 0) {
    lines.push('');
    lines.push(color.bold(`  Files changed (${record.filesChanged.length}):`));
    for (const f of record.filesChanged.slice(0, 40)) {
      lines.push(color.gray(`    ${f}`));
    }
  }

  if (record.usage) {
    lines.push('');
    lines.push(`  Tokens: ${record.usage.input} input, ${record.usage.output} output, ${record.usage.total} total`);
  }

  if (record.evaluation) {
    lines.push('');
    lines.push(color.bold('  Evaluation:'));
    lines.push(`    success: ${record.evaluation.success ? color.green('yes') : color.red('no')}`);
    for (const reason of record.evaluation.reasons) {
      lines.push(color.gray(`    - ${reason}`));
    }
  }

  if (record.result) {
    lines.push('');
    lines.push(color.bold('  Result:'));
    lines.push(color.gray(`    ${record.result.slice(0, 500)}`));
  }

  if (record.errors.length > 0) {
    lines.push('');
    lines.push(color.bold('  Errors:'));
    for (const err of record.errors) {
      lines.push(color.red(`    ${err.slice(0, 300)}`));
    }
  }

  const children = await engine.executions.listChildren(record.execution.id);
  if (children.length > 0) {
    lines.push('');
    lines.push(color.bold(`  Child executions (${children.length}):`));
    for (const child of children) {
      lines.push(
        `    └── ${child.execution.id} [${child.execution.status}] ${color.gray(child.task.input.slice(0, 60))}`,
      );
    }
  }

  return lines.join('\n');
}

export async function replayExecution(engine: RookEngine, id: string): Promise<string> {
  let record = await engine.executions.get(id);
  if (!record) {
    const all = await engine.executions.list();
    const fuzzy = all.find((r) => r.execution.id.includes(id));
    if (!fuzzy) return color.red(`execution '${id}' not found`);
    record = fuzzy;
  }
  const events = await engine.executions.events(record.execution.id);
  const lines: string[] = [color.bold(`Replay of ${record.execution.id}`), ''];
  for (const event of events) {
    const data = event.data ? ` ${JSON.stringify(event.data).slice(0, 160)}` : '';
    lines.push(color.gray(event.timestamp.toISOString().replace('T', ' ').slice(0, 19)) + `  ${color.cyan(event.type)}${color.gray(data)}`);
  }
  return lines.join('\n');
}

const BENCHMARK_PROMPT =
  'Write a short haiku (17 syllables) about a TypeScript compiler checking types.';

export async function runBenchmark(engine: RookEngine, modelId?: string, prompt?: string): Promise<string> {
  const models = engine.models.list();
  if (models.length === 0) {
    return color.yellow('no models registered — cannot benchmark');
  }

  const target = modelId ? models.find((m) => m.id === modelId) : models[0];
  if (!target) {
    return color.red(`model '${modelId}' not found`);
  }
  if (modelId && target.id !== modelId) {
    return color.red(`model '${modelId}' not found`);
  }

  const text = prompt ?? BENCHMARK_PROMPT;
  const lines: string[] = [];
  lines.push(color.bold(`Benchmark: ${target.id}`));
  lines.push(color.gray(`  prompt: ${text.slice(0, 80)}`));
  lines.push('');

  const started = Date.now();
  let firstTokenMs: number | undefined;
  let output = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let error: string | undefined;

  const adapter = engine.worker.adapterForModel(target.id);
  if (!adapter) {
    return color.red(`no runtime can serve '${target.id}'`);
  }

  for await (const event of adapter.generate({
    modelId: target.id,
    messages: [{ role: 'user', content: text }],
    maxTokens: 256,
    temperature: 0.3,
    stream: true,
  })) {
    if (event.type === 'token' && event.content) {
      if (firstTokenMs === undefined) firstTokenMs = Date.now() - started;
      output += event.content;
    } else if (event.type === 'completed') {
      if (event.content) output = event.content;
      inputTokens = event.usage?.inputTokens ?? 0;
      outputTokens = event.usage?.outputTokens ?? 0;
    } else if (event.type === 'error') {
      error = event.error;
    }
  }

  const elapsedMs = Date.now() - started;

  lines.push(`  first token: ${firstTokenMs !== undefined ? `${firstTokenMs}ms` : '—'}`);
  lines.push(`  total time:  ${elapsedMs}ms`);
  lines.push(`  input:       ${inputTokens} tokens`);
  lines.push(`  output:      ${outputTokens} tokens`);
  lines.push(`  throughput:  ${tokensPerSecond(outputTokens, elapsedMs).toFixed(1)} tok/s`);
  if (error) {
    lines.push(color.red(`  error: ${error}`));
  }
  lines.push('');
  lines.push(color.bold('  Output:'));
  lines.push(color.gray(`  ${output.slice(0, 400)}`));

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
  return lines.join('\n');
}

export async function planTaskCommand(engine: RookEngine, description: string, options: {
  type?: TaskType;
  model?: string;
  agent?: string;
  json?: boolean;
}): Promise<{ code: number; output: string }> {
  const planned = await planTask(engine, description, options);

  if (options.json) {
    return { code: planned.ok ? 0 : 1, output: JSON.stringify(planned.ok ? planned.plan : planned, null, 2) };
  }

  if (planned.ok === false) {
    const lines = [color.red('  Scheduling failed'), ...planned.reasons.map((r) => color.gray(`    ${r}`))];
    return { code: 1, output: lines.join('\n') };
  }

  const { scheduling, context, agent } = planned.plan;
  const lines: string[] = [];
  lines.push(color.bold('  Scheduling decision'));
  lines.push(`    agent:     ${agent.descriptor.name}`);
  lines.push(`    model:     ${scheduling.modelId} (${scheduling.modelDecision.strategy})`);
  lines.push(`    runtime:   ${scheduling.runtimeId}`);
  lines.push(`    computer:  ${scheduling.computerId ?? `hosted (${scheduling.runtimeId})`}`);
  lines.push(`    context:   ${context.finalRequiredTokens} / ${context.available.tokens} tokens (${context.available.source})`);
  lines.push('');
  lines.push(color.bold('  Reasons'));
  for (const reason of scheduling.reasons) {
    lines.push(color.gray(`    - ${reason}`));
  }
  return { code: 0, output: lines.join('\n') };
}

export async function runTaskCommand(engine: RookEngine, description: string, options: {
  type?: TaskType;
  model?: string;
  agent?: string;
  maxTurns?: number;
  expectedFiles?: string[];
  json?: boolean;
  preset?: string;
}): Promise<{ code: number; output: string }> {
  const outcome = await executeTask(engine, description, {
    type: options.type,
    model: options.model,
    agent: options.agent,
    maxTurns: options.maxTurns,
    expectedFiles: options.expectedFiles,
    json: options.json,
    quiet: options.json === true,
    preset: options.preset,
  });

  if (options.json) {
    return { code: outcome.success ? 0 : 1, output: JSON.stringify(outcome, null, 2) };
  }

  const lines: string[] = [];
  lines.push('');
  lines.push(outcome.success ? color.green('  Task completed') : color.red('  Task failed'));
  for (const reason of outcome.reasons) {
    lines.push(color.gray(`    ${reason}`));
  }
  if (outcome.result) {
    lines.push(`  result: ${outcome.result.slice(0, 500)}`);
  }
  if (outcome.filesChanged.length > 0) {
    lines.push(`  files changed: ${outcome.filesChanged.join(', ')}`);
  }
  if (outcome.executionId !== '—') {
    lines.push('');
    lines.push(color.gray(`  inspect: wa executions inspect ${outcome.executionId}`));
  }
  return { code: outcome.success ? 0 : 1, output: lines.join('\n') };
}

export function listJobs(engine: RookEngine): string {
  const jobs = engine.orchestrator.listJobs();
  if (jobs.length === 0) return color.yellow('no jobs recorded yet');
  const rows = jobs.map((j) => [
    j.id,
    j.status,
    j.title.slice(0, 40),
    String(j.tasks.length),
    `${j.concurrencyLimit ?? 'default'}`,
    j.createdAt.toISOString().replace('T', ' ').slice(0, 19),
  ]);
  return table(['job id', 'status', 'title', 'tasks', 'concurrency', 'created'], rows);
}

export async function inspectJob(engine: RookEngine, id: string): Promise<string> {
  let job = engine.orchestrator.getJob(id);
  if (!job) {
    const all = engine.orchestrator.listJobs();
    const fuzzy = all.find((j) => j.id.includes(id));
    if (!fuzzy) return color.red(`job '${id}' not found`);
    job = fuzzy;
  }

  const rollup = await engine.orchestrator.getJobRollup(job.id);
  const lines: string[] = [
    color.bold(`Job ${job.id}: ${job.title}`),
    `  status:       ${job.status}`,
    `  tasks:        ${rollup.taskCount} total (${rollup.completedTasks} completed, ${rollup.failedTasks} failed, ${rollup.runningTasks} running)`,
    `  concurrency:  ${job.concurrencyLimit ?? 4}`,
    `  duration:     ${(rollup.durationMs / 1000).toFixed(1)}s`,
    `  tokens:       ${rollup.tokens.input} in + ${rollup.tokens.output} out = ${rollup.tokens.total} total`,
    `  est. cost:    $${rollup.estimatedCostUsd.toFixed(4)}  ${rollup.tokensPerSecond.toFixed(1)} tok/s`,
    `  computers:    ${rollup.computersUsed.join(', ') || '—'}`,
    `  models:       ${rollup.modelsUsed.join(', ') || '—'}`,
  ];

  if (rollup.filesChanged.length > 0) {
    lines.push('');
    lines.push(color.bold(`  Files changed (${rollup.filesChanged.length}):`));
    for (const file of rollup.filesChanged) {
      lines.push(`    ${color.gray(file)}`);
    }
  }

  lines.push('');
  lines.push(color.bold('  Sub-tasks:'));
  for (const node of job.graph.nodes) {
    const taskId = node.taskId ?? node.id;
    const task = job.tasks.find((t) => t.id === taskId);
    const stateColor = node.state === 'completed' ? color.green : node.state === 'failed' ? color.red : color.yellow;
    lines.push(`    [${stateColor(node.state)}] ${taskId}: ${task?.input.slice(0, 60) ?? ''}`);
  }

  return lines.join('\n');
}

export async function mergeJob(engine: RookEngine, id: string, targetBranch?: string): Promise<string> {
  let job = engine.orchestrator.getJob(id);
  if (!job) {
    const all = engine.orchestrator.listJobs();
    const fuzzy = all.find((j) => j.id.includes(id));
    if (!fuzzy) return color.red(`job '${id}' not found`);
    job = fuzzy;
  }

  const lines: string[] = [color.bold(`Merging branches for job ${job.id}:`), ''];
  for (const task of job.tasks) {
    const branch = `wazir/${job.id}/${task.id}`;
    const res = await engine.worktrees.mergeBranch(engine.projectRoot, branch, targetBranch);
    if (res.success) {
      lines.push(color.green(`  ✓ Merged ${branch} -> ${res.targetBranch}`));
    } else {
      lines.push(color.red(`  ✗ Failed to merge ${branch}: ${res.error ?? 'conflicts detected'}`));
      if (res.conflicts && res.conflicts.length > 0) {
        lines.push(color.yellow(`    Conflicting files: ${res.conflicts.join(', ')}`));
      }
    }
  }
  return lines.join('\n');
}

import type { Block, BlockStatus, ContextPart } from '@wazir/core';
import {
  listBlocks,
  getBlock,
  getActiveContext,
  addContextBlock,
  removeContextBlock,
  clearContext,
} from './blocks.js';

function formatAge(timestamp: Date): string {
  const diff = Date.now() - timestamp.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

export async function listHistory(
  engine: RookEngine,
  options?: { status?: string; commandContains?: string; json?: boolean },
): Promise<string> {
  const blocks = await listBlocks(engine, {
    status: options?.status as BlockStatus,
    commandContains: options?.commandContains,
  });

  if (blocks.length === 0) return color.yellow('no history recorded yet');

  if (options?.json) {
    return JSON.stringify(blocks, null, 2);
  }

  const rows = blocks.map((b) => [
    b.id,
    b.command,
    b.status,
    formatAge(new Date(b.timestamp)),
  ]);

  return table(
    ['id', 'command', 'status', 'age'],
    rows,
  );
}

export async function inspectHistory(engine: RookEngine, id: string, json?: boolean): Promise<string> {
  const block = await getBlock(engine, id);
  if (!block) {
    return color.red(`history entry '${id}' not found`);
  }

  if (json) {
    return JSON.stringify(block, null, 2);
  }

  const lines: string[] = [];
  lines.push(color.bold(`Block ${block.id}`));
  lines.push(`  command:     ${block.command} ${block.argv.join(' ')}`);
  lines.push(`  status:      ${block.status}`);
  lines.push(`  timestamp:   ${new Date(block.timestamp).toISOString()}`);
  if (block.durationMs !== undefined) {
    lines.push(`  duration:    ${block.durationMs}ms`);
  }
  if (block.exitCode !== undefined) {
    lines.push(`  exit code:   ${block.exitCode}`);
  }
  if (block.executionId) {
    lines.push(`  executionId: ${block.executionId}`);
  }
  if (block.jobId) {
    lines.push(`  jobId:       ${block.jobId}`);
  }

  if (block.stdout) {
    lines.push('');
    lines.push(color.bold('  stdout:'));
    const linesOut = block.stdout.split('\n').slice(0, 50);
    for (const line of linesOut) {
      lines.push(color.gray(`    ${line}`));
    }
    if (block.stdout.length > 50 * 100) {
      lines.push(color.gray('    ... (truncated)'));
    }
  }

  if (block.stderr) {
    lines.push('');
    lines.push(color.bold('  stderr:'));
    const linesErr = block.stderr.split('\n').slice(0, 50);
    for (const line of linesErr) {
      lines.push(color.red(`    ${line}`));
    }
    if (block.stderr.length > 50 * 100) {
      lines.push(color.gray('    ... (truncated)'));
    }
  }

  if (block.filesChanged.length > 0) {
    lines.push('');
    lines.push(color.bold(`  files changed (${block.filesChanged.length}):`));
    for (const f of block.filesChanged.slice(0, 40)) {
      lines.push(color.gray(`    ${f}`));
    }
  }

  if (block.errors.length > 0) {
    lines.push('');
    lines.push(color.bold(`  errors (${block.errors.length}):`));
    for (const err of block.errors) {
      lines.push(color.red(`    ${err}`));
    }
  }

  return lines.join('\n');
}

// ---- explain -----------------------------------------------------------

import type { ExecutionRecord, Job } from '@wazir/core';
import { resolveReference } from './references.js';

function renderExecutionExplain(execution: ExecutionRecord | undefined, id: string, json?: boolean): { code: number; output: string } {
  if (!execution) {
    return { code: 1, output: color.red(`execution '${id}' not found`) };
  }

  // Every "why" below is derived from the durable record (see explainExecution).
  const decisions = explainExecution(execution);
  if (json) {
    return {
      code: 0,
      output: JSON.stringify(
        { id, task: execution.task, scheduling: execution.scheduling, policyDecisions: execution.policyDecisions, decisions },
        null,
        2,
      ),
    };
  }

  const lines: string[] = [];
  lines.push(color.bold(`EXECUTION: ${id}`));
  lines.push('');

  const capabilities = execution.task.requirements?.capabilities ?? [];
  lines.push(`Requested capabilities: ${capabilities.length > 0 ? capabilities.join(', ') : '(none)'}`);
  lines.push('');

  if (!execution.scheduling) {
    lines.push(color.yellow('This execution has no recorded scheduling decision (task was never scheduled).'));
  } else {
    const s = execution.scheduling;
    lines.push(color.bold('Selected model'));
    lines.push(`  ${s.modelId}`);
    for (const reason of s.modelDecision.reasons) lines.push(`    - ${reason}`);
    lines.push('');
    if (s.computerDecision.placementKind === 'hosted') {
      lines.push(color.bold('Placement'));
      lines.push(`  hosted provider (no local computer) — provider: ${s.runtimeId}`);
    } else {
      lines.push(color.bold('Selected computer'));
      lines.push(`  ${s.computerId}`);
    }
    for (const reason of s.computerDecision.reasons) lines.push(`    - ${reason}`);
    lines.push('');
    lines.push(color.bold('Selected runtime'));
    lines.push(`  ${s.runtimeId}`);
    lines.push('');
    lines.push(color.bold('Overall reasons'));
    for (const reason of s.reasons) lines.push(`  - ${reason}`);
  }

  lines.push('');
  const nonAllow = execution.policyDecisions.filter((d) => d.decision !== 'allow');
  if (nonAllow.length === 0) {
    lines.push(color.green('Policy: all tool calls allowed'));
  } else {
    lines.push(color.bold('Policy'));
    for (const decision of nonAllow) {
      lines.push(`  ${decision.decision.toUpperCase()} (${decision.rule}): ${decision.reasons.join('; ')}`);
    }
  }

  if (decisions.retries.length > 0) {
    lines.push('');
    lines.push(color.bold('Why retries'));
    for (const r of decisions.retries) {
      lines.push(r.exhausted
        ? `  retry budget exhausted (${r.failureClass}) for ${r.model ?? 'model'}`
        : `  attempt ${r.attempt ?? '?'}: ${r.failureClass} from ${r.provider ?? 'provider'}/${r.model ?? 'model'}; backed off ${r.delayMs}ms`);
    }
  }

  if (decisions.escalations.length > 0) {
    lines.push('');
    lines.push(color.bold('Why the model changed'));
    for (const e of decisions.escalations) {
      lines.push(e.accepted
        ? `  ${e.previousModel} -> ${e.newModel} after ${e.failureClass}: ${e.trigger}`
        : `  kept ${e.previousModel} after ${e.failureClass}: escalation declined`);
      lines.push(color.gray(`    ${e.decision}`));
    }
  }

  if (decisions.toolOutcomes.unknown.length > 0 || decisions.toolOutcomes.reconciled.length > 0) {
    lines.push('');
    lines.push(color.bold('Tool outcomes'));
    for (const u of decisions.toolOutcomes.unknown) lines.push(color.yellow(`  UNKNOWN: '${u.tool}' (${u.callId ?? '?'}) was dispatched with no confirmed result — must be reconciled, never replayed blindly`));
    for (const r of decisions.toolOutcomes.reconciled) lines.push(`  reconciled '${r.tool}' (${r.callId ?? '?'}) as ${r.outcome} by ${r.inspectedBy}: ${r.evidence}`);
  }

  if (decisions.completionRejections.length > 0 || decisions.evidenceInvalidations.length > 0) {
    lines.push('');
    lines.push(color.bold('Why completion was rejected'));
    for (const c of decisions.completionRejections) lines.push(`  ${c.reason}: ${c.detail}`);
    for (const v of decisions.evidenceInvalidations) lines.push(color.gray(`  evidence invalidated by a mutation at revision ${v.workspaceRevision ?? '?'}`));
  }

  lines.push('');
  lines.push(color.bold('Why it stopped'));
  lines.push(`  ${decisions.termination.reason ?? '(no typed termination recorded)'}` +
    `${decisions.termination.modelId ? ` on ${decisions.termination.modelId}` : ''} — status ${decisions.termination.status}`);
  for (const error of decisions.termination.errors.slice(0, 3)) lines.push(color.gray(`    ${error.split('\n')[0]}`));

  return { code: 0, output: lines.join('\n') };
}

/**
 * `wa executions events <id>`: the execution's durable event log in sequence order.
 * `type` filters by event-type prefix (e.g. `tool.`, `model.route`). Text output shows
 * a bounded preview of each payload; `--json` returns the events unmodified.
 */
export async function listExecutionEvents(engine: RookEngine, id: string, options: { json?: boolean; type?: string } = {}): Promise<{ code: number; output: string }> {
  let record = await engine.executions.get(id);
  if (!record) record = (await engine.executions.list()).find((r) => r.execution.id.includes(id));
  if (!record) return { code: 1, output: color.red(`execution '${id}' not found`) };
  const events = (await engine.executions.events(record.execution.id))
    .filter((e) => !options.type || (e.eventType ?? e.type).startsWith(options.type));
  if (options.json) return { code: 0, output: JSON.stringify({ executionId: record.execution.id, events }, null, 2) };
  const lines = [color.bold(`${record.execution.id} — ${events.length} event(s)${options.type ? ` matching '${options.type}'` : ''}`)];
  for (const e of events) {
    const data = e.data === undefined ? '' : stripTerminalEscapes(JSON.stringify(e.data));
    const preview = data.length > 160 ? `${data.slice(0, 160)}…` : data;
    lines.push(`  ${String(e.sequence ?? '?').padStart(4)}  ${new Date(e.timestamp).toISOString()}  ${e.eventType ?? e.type}${e.callId ? color.gray(` [${e.callId}]`) : ''}  ${color.gray(preview)}`);
  }
  return { code: 0, output: lines.join('\n') };
}

async function renderJobExplain(engine: RookEngine, job: Job, json?: boolean): Promise<{ code: number; output: string }> {
  const rollup = await engine.orchestrator.getJobRollup(job.id);

  if (json) {
    const tasks = await Promise.all(
      job.tasks.map(async (task) => ({
        taskId: task.id,
        executions: (await engine.executions.listByTask(task.id)).map((r) => ({
          id: r.execution.id,
          scheduling: r.scheduling,
        })),
      })),
    );
    return { code: 0, output: JSON.stringify({ jobId: job.id, rollup, tasks }, null, 2) };
  }

  const lines: string[] = [];
  lines.push(color.bold(`JOB: ${job.id} — ${job.title}`));
  lines.push('');
  lines.push(
    `Tasks: ${rollup.taskCount}  Completed: ${rollup.completedTasks}  Failed: ${rollup.failedTasks}  Running: ${rollup.runningTasks}  Queued: ${rollup.queuedTasks}`,
  );
  lines.push(`Tokens: ${rollup.tokens.total}  Duration: ${(rollup.durationMs / 1000).toFixed(1)}s  Est. cost: $${rollup.estimatedCostUsd.toFixed(4)}  ${rollup.tokensPerSecond.toFixed(1)} tok/s`);
  lines.push(`Computers used: ${rollup.computersUsed.join(', ') || '(none)'}`);
  lines.push(`Models used: ${rollup.modelsUsed.join(', ') || '(none)'}`);
  lines.push('');

  for (const task of job.tasks) {
    const records = await engine.executions.listByTask(task.id);
    lines.push(color.bold(`Task ${task.id}: ${task.title ?? task.input.slice(0, 40)}`));
    if (records.length === 0) {
      lines.push('  (no execution recorded yet)');
      lines.push('');
      continue;
    }
    for (const record of records) {
      if (!record.scheduling) {
        lines.push('  no scheduling decision recorded');
        continue;
      }
      const s = record.scheduling;
      lines.push(`  -> ${s.modelId} on ${s.computerId ?? `hosted (${s.runtimeId})`} via ${s.runtimeId}`);
      for (const reason of s.reasons) lines.push(`     - ${reason}`);
    }
    lines.push('');
  }

  return { code: 0, output: lines.join('\n') };
}

/**
 * `wa explain <ref>` — accepts a bare execution id, a block reference
 * (@123, resolved to its linked execution if any), or a job reference
 * (@job:x). Renders the scheduling decision already recorded at execution
 * time — never recomputes one.
 */
export async function explainCommand(engine: RookEngine, ref: string, json?: boolean): Promise<{ code: number; output: string }> {
  const resolved = await resolveReference(engine, ref);

  if (resolved.kind === 'execution') {
    return renderExecutionExplain(resolved.execution, resolved.id, json);
  }

  if (resolved.kind === 'block') {
    if (!resolved.block) {
      return { code: 1, output: color.red(`block '${resolved.id}' not found`) };
    }
    if (!resolved.block.executionId) {
      return {
        code: 1,
        output: color.yellow(`block #${resolved.id} (${resolved.block.command}) has no linked execution — nothing to explain`),
      };
    }
    const execution = await engine.executions.get(resolved.block.executionId);
    return renderExecutionExplain(execution, resolved.block.executionId, json);
  }

  if (resolved.kind === 'job') {
    if (!resolved.job) {
      return { code: 1, output: color.red(`job '${resolved.id}' not found`) };
    }
    return renderJobExplain(engine, resolved.job, json);
  }

  return {
    code: 1,
    output: color.red(
      `cannot explain a '${resolved.kind}' reference — only executions, blocks (linked to an execution), and jobs can be explained`,
    ),
  };
}

export interface AuditCommandOptions {
  limit?: number;
  tool?: string;
  decision?: 'allow' | 'ask' | 'deny';
  json?: boolean;
}

export async function auditCommand(options: AuditCommandOptions = {}): Promise<string> {
  const events = await readAuditEvents({
    limit: options.limit ?? 50,
    tool: options.tool,
    decision: options.decision,
  });

  if (events.length === 0) {
    return options.json ? '[]' : color.yellow('no audit events recorded yet');
  }

  if (options.json) {
    return JSON.stringify(events, null, 2);
  }

  const rows = events.map((e) => {
    const time = e.timestamp.replace('T', ' ').slice(0, 19);
    const decColor =
      e.decision === 'allow' ? color.green :
      e.decision === 'ask' ? color.yellow :
      e.decision === 'deny' ? color.red :
      color.gray;
    const decisionStr = e.decision ? decColor(e.decision) : '—';
    // Audit text originates from the model; keep it from driving the terminal.
    const detail = stripTerminalEscapes(e.command
      ? e.command.slice(0, 40)
      : (e.reasons?.[0] ?? e.rule ?? '—').slice(0, 40));
    return [
      time,
      e.type,
      e.tool ?? '—',
      decisionStr,
      e.executionId ?? e.taskId ?? '—',
      detail,
    ];
  });

  return table(['timestamp', 'type', 'tool', 'decision', 'target', 'detail'], rows);
}

export interface ExplainPolicyOptions {
  json?: boolean;
}

export function explainPolicyCommand(engine: RookEngine, command: string, options: ExplainPolicyOptions = {}): string {
  const decision = engine.policy.explainCommand(command);
  if (options.json) {
    return JSON.stringify(decision, null, 2);
  }

  const lines: string[] = [];
  lines.push(color.bold('Policy Explanation'));
  lines.push(`  Command:   ${command}`);
  const decColor =
    decision.decision === 'allow' ? color.green :
    decision.decision === 'ask' ? color.yellow :
    color.red;
  lines.push(`  Decision:  ${decColor(decision.decision.toUpperCase())}`);
  lines.push(`  Rule:      ${decision.rule}`);
  if (decision.reasons && decision.reasons.length > 0) {
    lines.push(color.bold('  Reasons:'));
    for (const r of decision.reasons) {
      lines.push(`    - ${r}`);
    }
  }
  return lines.join('\n');
}

export interface ArtifactListOptions {
  execution?: string;
  job?: string;
  type?: string;
  json?: boolean;
}

export async function listArtifacts(engine: RookEngine, options: ArtifactListOptions = {}): Promise<string> {
  const artifacts = await engine.provenance.listArtifacts({
    executionId: options.execution,
    jobId: options.job,
    type: options.type as ArtifactType | undefined,
  });
  if (artifacts.length === 0) {
    return options.json ? JSON.stringify([], null, 2) : color.yellow('no artifacts registered');
  }

  if (options.json) {
    return JSON.stringify(artifacts, null, 2);
  }

  const rows = artifacts.map((a) => [
    a.artifactId,
    a.type,
    a.name,
    a.location,
    a.contentHash.slice(0, 12),
    a.executionId,
    a.jobId ?? '-',
  ]);
  return table(['id', 'type', 'name', 'location', 'hash', 'execution', 'job'], rows);
}

function artifactNotFound(id: string, json?: boolean): string {
  return json ? JSON.stringify({ error: `artifact not found: ${id}` }) : color.red(`artifact not found: ${id}`);
}

export async function inspectArtifact(engine: RookEngine, id: string, json?: boolean): Promise<string> {
  const artifact = await engine.provenance.getProvenance(id);
  if (!artifact) return artifactNotFound(id, json);
  if (json) return JSON.stringify(artifact, null, 2);

  const lines: string[] = [];
  lines.push(color.bold('Artifact'));
  lines.push(`  id:          ${artifact.artifactId}`);
  lines.push(`  type:        ${artifact.type}`);
  lines.push(`  name:        ${artifact.name}`);
  lines.push(`  location:    ${artifact.location}`);
  lines.push(`  hash:        sha256:${artifact.contentHash}`);
  lines.push(`  size:        ${artifact.sizeBytes} bytes`);
  lines.push(`  created:     ${new Date(artifact.createdAt).toISOString()}`);
  lines.push(`  workspace:   ${artifact.workspace}`);
  lines.push(color.bold('  execution'));
  lines.push(`    execution: ${artifact.executionId}`);
  lines.push(`    job:       ${artifact.jobId ?? '-'}`);
  lines.push(`    agent:     ${artifact.agentId || '-'}`);
  lines.push(`    model:     ${artifact.modelId}`);
  lines.push(`    runtime:   ${artifact.runtimeId}`);
  lines.push(`    computer:  ${artifact.computerId ?? '—'}`);
  if (artifact.git) {
    lines.push(color.bold('  git'));
    lines.push(`    branch:    ${artifact.git.branch ?? '-'}`);
    lines.push(`    commit:    ${artifact.git.commit ?? '-'}`);
    lines.push(`    dirty:     ${artifact.git.dirty}`);
  }
  lines.push(`  tools:       ${artifact.toolsUsed.join(', ') || '-'}`);
  lines.push(`  policies:    ${artifact.policyDecisions.join(', ') || '-'}`);
  lines.push(`  evaluations: ${artifact.evaluations.join(', ') || '-'}`);
  lines.push(`  inputs:      ${artifact.inputArtifactIds.join(', ') || '-'}`);
  lines.push(`  parents:     ${artifact.parentArtifactIds.join(', ') || '-'}`);
  return lines.join('\n');
}

export async function showArtifactLineage(engine: RookEngine, id: string, json?: boolean): Promise<string> {
  const artifact = await engine.provenance.getProvenance(id);
  if (!artifact) return artifactNotFound(id, json);
  const lineage = await engine.provenance.getLineage(id);
  if (json) return JSON.stringify(lineage, null, 2);

  const lines: string[] = [color.bold('Artifact Lineage (root → target)')];
  lineage.forEach((node, i) => {
    lines.push(`${'  '.repeat(i)}${i === 0 ? '' : '└─ '}${node.artifactId}  ${color.dim(`${node.type} ${node.name}`)}`);
  });
  return lines.join('\n');
}

export async function showArtifactWhy(engine: RookEngine, id: string, json?: boolean): Promise<string> {
  const artifact = await engine.provenance.getProvenance(id);
  if (!artifact) return artifactNotFound(id, json);
  const why = await engine.provenance.getWhy(id);
  if (json) return JSON.stringify(why, null, 2);

  const lines: string[] = [color.bold('Why this artifact exists')];
  lines.push(`  execution: ${why.executionContext.executionId}`);
  lines.push(`  job:       ${why.executionContext.jobId ?? '-'}`);
  lines.push(`  agent:     ${why.executionContext.agentId || '-'}`);
  lines.push(`  model:     ${why.executionContext.modelId}`);
  lines.push(`  computer:  ${why.executionContext.computerId ?? '—'}`);
  lines.push(color.bold('  policy decisions'));
  if (why.policyDecisions.length === 0) lines.push('    (none recorded)');
  for (const d of why.policyDecisions) lines.push(`    ${d.decision.padEnd(5)} ${d.rule}  ${color.dim(d.reason)}`);
  lines.push(color.bold('  checks'));
  if (why.checks.length === 0) lines.push('    (none recorded)');
  for (const c of why.checks) lines.push(`    ${c.status.padEnd(6)} ${c.name}${c.details ? `  ${color.dim(c.details)}` : ''}`);
  if (why.modelRationale) {
    lines.push(color.bold('  model rationale'));
    for (const step of why.modelRationale.reasoningSteps) lines.push(`    - ${step}`);
  }
  return lines.join('\n');
}

export async function showArtifactInputs(engine: RookEngine, id: string, json?: boolean): Promise<string> {
  const artifact = await engine.provenance.getProvenance(id);
  if (!artifact) return artifactNotFound(id, json);
  const inputs = (
    await Promise.all(artifact.inputArtifactIds.map((inputId) => engine.provenance.getProvenance(inputId)))
  ).filter((a): a is ArtifactProvenance => a !== undefined);
  if (json) return JSON.stringify(inputs, null, 2);
  if (inputs.length === 0) return color.yellow('no input artifacts recorded');
  return table(
    ['id', 'type', 'name', 'location'],
    inputs.map((a) => [a.artifactId, a.type, a.name, a.location]),
  );
}

// ---- verify commands (Phase 1: Continuous Verification & Anomaly Rollback Engine) ----

import type {
  AnomalyEvent,
  TelemetryMetricSnapshot,
  MetricBaseline,
  VerificationResult,
} from '@wazir/evaluation';
import {
  verifyExecution,
  createBaseline,
  clusterLogLines,
  normalizeLogLine,
} from '@wazir/evaluation';

export type VerifySensitivity = 'high' | 'medium' | 'low';

/**
 * Run verification on an execution with anomaly detection and rollback.
 */
export async function verifyRunCommand(
  engine: RookEngine,
  executionId: string,
  options?: { sensitivity?: VerifySensitivity; baselineName?: string },
): Promise<{ code: number; output: string }> {
  const record = await engine.executions.get(executionId);
  if (!record) {
    return { code: 1, output: color.red(`execution '${executionId}' not found`) };
  }

  // Get telemetry snapshot from execution
  const telemetry: TelemetryMetricSnapshot = {
    timestamp: record.execution.createdAt.toISOString(),
    durationMs: record.execution.completedAt
      ? record.execution.completedAt.getTime() - (record.execution.startedAt ?? record.execution.createdAt).getTime()
      : Date.now() - record.execution.createdAt.getTime(),
    cpuPercent: 0, // TODO: extract from worker hardware report if available
    memoryBytes: 0, // TODO: extract from worker hardware report if available
    errorCount: record.errors.length,
    exitCode: 0, // TODO: extract from execution result
  };

  // Get baselines (from store or create fresh)
  const baselineName = options?.baselineName ?? `default/${record.execution.modelId}`;
  let baselines = new Map<string, MetricBaseline>();
  
  try {
    const storedBaseline = await engine.store?.get(`verification/baseline/${baselineName}`);
    if (storedBaseline) {
      // Reconstruct baselines from stored data
      for (const [name, b] of Object.entries(storedBaseline as Record<string, any>)) {
        baselines.set(name, {
          metricName: name,
          mean: b.mean,
          stdDev: b.stdDev,
          sampleCount: b.sampleCount,
          p95: b.p95,
        });
      }
    } else if (record.execution.completedAt && telemetry.durationMs > 0) {
      // Create baseline from this execution for future comparisons
      const durationBaseline = createBaseline([telemetry.durationMs]);
      baselines.set('durationMs', durationBaseline);
    }
  } catch {
    // Use empty baselines if store access fails
  }

  // Collect logs (stdout + stderr)
  const allLogs: string[] = [];
  if (record.execution.status === 'failed' || record.errors.length > 0) {
    for (const err of record.errors) {
      allLogs.push(err);
    }
  }

  // Get baseline log signatures from store
  const storedSignatures = await engine.store?.get(`verification/signatures/${baselineName}`);
  const baselineLogSignatures = new Set<string>(
    (storedSignatures as string[]) ?? []
  );

  // Run verification
  const result: VerificationResult = verifyExecution(
    telemetry,
    baselines,
    allLogs,
    baselineLogSignatures,
    options?.sensitivity ?? 'medium',
  );

  // If rollback is triggered, execute it
  if (result.rollbackTriggered) {
    try {
      // TODO: Implement worktree rollback via WorktreeManager
      // const worktreePath = getWorktreeForExecution(engine, executionId);
      // await engine.worktrees.rollback(worktreePath);
      result.rollbackReason = `rollback triggered for ${executionId}`;
    } catch (err) {
      result.rollbackReason = `rollback failed: ${String(err)}`;
    }
  }

  // Store new baseline if verification passed and we have good data
  if (result.passed && telemetry.durationMs > 0) {
    const durationBaseline = createBaseline([telemetry.durationMs]);
    baselines.set('durationMs', durationBaseline);
    try {
      await engine.store?.put(
        `verification/baseline/${baselineName}`,
        Object.fromEntries(baselines),
      );
      // Store normalized log signatures
      const clusters = clusterLogLines(allLogs);
      const newSignatures = Array.from(clusters.keys());
      await engine.store?.put(
        `verification/signatures/${baselineName}`,
        [...baselineLogSignatures, ...newSignatures],
      );
    } catch {
      // Best effort store
    }
  }

  const lines: string[] = [];
  lines.push(color.bold(`Verification Result for ${executionId}`));
  lines.push('');
  
  if (result.passed) {
    lines.push(color.green(`  ✓ PASSED (score: ${(result.score * 100).toFixed(1)}%)`));
  } else {
    lines.push(color.red(`  ✗ FAILED (score: ${(result.score * 100).toFixed(1)}%)`));
  }

  if (result.anomalies.length > 0) {
    lines.push('');
    lines.push(color.bold(`  Anomalies (${result.anomalies.length}):`));
    for (const anomaly of result.anomalies) {
      const severityColor =
        anomaly.severity === 'critical' ? color.red :
        anomaly.severity === 'high' ? color.yellow :
        anomaly.severity === 'medium' ? color.gray : color.blue;
      lines.push(`    ${severityColor(anomaly.severity.toUpperCase())}: ${anomaly.metricName}`);
      lines.push(color.gray(`      observed: ${anomaly.observedValue}, baseline: ${anomaly.baselineMean}, sigma: ${anomaly.sigmaDeviation.toFixed(2)}`));
    }
  } else {
    lines.push('');
    lines.push(color.green('  No anomalies detected'));
  }

  if (result.rollbackTriggered) {
    lines.push('');
    lines.push(color.yellow(`  Rollback triggered: ${result.rollbackReason}`));
  }

  return { code: result.passed ? 0 : 1, output: lines.join('\n') };
}

/**
 * Show verification baselines for a service/model.
 */
export async function verifyBaselineShowCommand(
  engine: RookEngine,
  options?: { serviceName?: string },
): Promise<{ code: number; output: string }> {
  const baselineName = options?.serviceName ?? 'default';
  
  try {
    const storedBaseline = await engine.store?.get(`verification/baseline/${baselineName}`);
    if (!storedBaseline) {
      return { code: 1, output: color.yellow(`no baseline found for '${baselineName}'`) };
    }

    const lines: string[] = [color.bold(`Baseline: ${baselineName}`), ''];
    
    for (const [name, b] of Object.entries(storedBaseline as Record<string, any>)) {
      lines.push(color.bold(`  ${name}:`));
      lines.push(`    mean:       ${b.mean.toFixed(2)}`);
      lines.push(`    std dev:    ${b.stdDev.toFixed(2)}`);
      lines.push(`    sample cnt: ${b.sampleCount}`);
      lines.push(`    p95:        ${b.p95.toFixed(2)}`);
      lines.push('');
    }

    return { code: 0, output: lines.join('\n') };
  } catch {
    return { code: 1, output: color.red(`failed to load baseline for '${baselineName}'`) };
  }
}

/**
 * Show verification status for a job.
 */
export async function verifyStatusCommand(
  engine: RookEngine,
  jobId: string,
): Promise<{ code: number; output: string }> {
  const job = engine.orchestrator.getJob(jobId);
  if (!job) {
    return { code: 1, output: color.red(`job '${jobId}' not found`) };
  }

  // Check verification status for each task execution
  const results: { taskId: string; passed: boolean; score?: number }[] = [];
  
  for (const task of job.tasks) {
    const records = await engine.executions.listByTask(task.id);
    if (records.length > 0) {
      // Use the latest execution
      const record = records[records.length - 1];
      results.push({
        taskId: task.id,
        passed: record.evaluation?.success ?? false,
        score: record.evaluation ? 1.0 : undefined, // TODO: calculate from anomalies
      });
    }
  }

  const lines: string[] = [color.bold(`Job Verification Status: ${jobId}`), ''];
  
  if (results.length === 0) {
    lines.push(color.yellow('  No executions found for verification'));
  } else {
    let allPassed = true;
    for (const r of results) {
      const statusColor = r.passed ? color.green : color.red;
      lines.push(`  ${statusColor(r.passed ? '✓' : '✗')} ${r.taskId}`);
      if (!r.passed) allPassed = false;
    }
    
    lines.push('');
    const summaryColor = allPassed ? color.green : color.red;
    lines.push(summaryColor(`  Overall: ${allPassed ? 'VERIFIED' : 'FAILED'}`));
  }

  return { code: allPassed(results) ? 0 : 1, output: lines.join('\n') };
}

function allPassed(results: { passed: boolean }[]): boolean {
  return results.every(r => r.passed);
}

export async function askCommand(
  engine: RookEngine,
  prompt: string,
  options: { model?: string; computer?: string; allowHosted?: boolean } = {},
): Promise<{ code: number; output: string }> {
  const models = engine.models.list();
  if (models.length === 0) {
    return {
      code: 1,
      output: color.yellow('no models registered — start LM Studio or Ollama to enable completions'),
    };
  }

  const target = options.model
    ? models.find((m) => m.id === options.model || m.id.toLowerCase().includes(options.model!.toLowerCase()))
    : models.find((m) => !m.id.toLowerCase().includes('embed')) || models[0];

  if (!target) {
    return {
      code: 1,
      output: color.red(`model '${options.model}' not found. Available models:\n${models.map((m) => `  - ${m.id}`).join('\n')}`),
    };
  }

  // askCommand bypasses the Scheduler entirely (it resolves a model directly
  // from a --model flag or the first non-embedding model, not via
  // Scheduler.plan()), so it is the one place a hosted model could reach
  // generate() without ever passing through PolicyEngine.checkHostedEligibility().
  // Gate explicitly here — never rely on engine.worker.adapterForModel()'s
  // structural inability to find a hosted adapter as the only safeguard.
  const targetRuntime = engine.runtimes.get(target.provider);
  if (targetRuntime?.runtimeKind === 'hosted') {
    const gate = engine.policy.checkHostedEligibility(
      { allowHostedProviders: options.allowHosted ?? engine.config.providers?.allowHostedProviders },
      target.provider,
    );
    if (!gate.allowed) {
      return { code: 1, output: color.red(`refused: ${gate.reason} (pass --allow-hosted to opt in for this command)`) };
    }
  }

  const adapter = engine.adapters.get(target.provider) ?? engine.worker.adapterForModel(target.id);
  if (!adapter) {
    return {
      code: 1,
      output: color.red(`no runtime adapter available to serve model '${target.id}'`),
    };
  }

  if (engine.mcp && engine.tools.descriptors().some(t => t.provenance?.source === 'mcp')) {
    const outcome = await executeTask(engine, prompt, { type: 'coding', model: target.id, agent: 'wazir-step', allowHosted: options.allowHosted });
    return { code: outcome.success ? 0 : 1, output: outcome.result ?? outcome.reasons.join('\n') };
  }

  process.stdout.write(color.bold(`[${target.id}]\n`));

  let fullResponse = '';
  try {
    for await (const event of adapter.generate({
      modelId: target.id,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 1024,
      temperature: 0.7,
      stream: true,
    })) {
      if (event.type === 'token' && event.content) {
        process.stdout.write(event.content);
        fullResponse += event.content;
      } else if (event.type === 'completed' && event.content && !fullResponse) {
        process.stdout.write(event.content);
        fullResponse = event.content;
      } else if (event.type === 'error') {
        return {
          code: 1,
          output: `\n${color.red(`error: ${event.error}`)}`,
        };
      }
    }
    process.stdout.write('\n');
    return { code: 0, output: '' };
  } catch (err: any) {
    return {
      code: 1,
      output: color.red(`inference failed: ${err?.message || err}`),
    };
  }
}

interface ActionProtocolCase {
  description: string;
  raw: string;
  expected: 'VALID' | 'INVALID';
}

// Real-world cases: `write`'s own `content` field is a plain string (never the sole key,
// never itself an object) so it's exempt from the content-wrapper case; the brace-in-prose
// case reproduces the exact live transcript that exposed extractFirstObject()'s bug
// (quoting "the array {5,3,1,4,2}" before the real action).
const ACTION_PROTOCOL_CASES: ActionProtocolCase[] = [
  { description: 'read(path="src/main.cpp")', raw: '{"action":"tool","tool":"read","input":{"path":"src/main.cpp"}}', expected: 'VALID' },
  { description: 'read(path="") — blank path', raw: '{"action":"tool","tool":"read","input":{"path":""}}', expected: 'VALID' },
  { description: 'read({}) — missing path', raw: '{"action":"tool","tool":"read","input":{}}', expected: 'INVALID' },
  { description: 'write(path, content)', raw: '{"action":"tool","tool":"write","input":{"path":"main.cpp","content":"int main(){}"}}', expected: 'VALID' },
  { description: 'write(path, content="") — legitimate empty file', raw: '{"action":"tool","tool":"write","input":{"path":"empty.txt","content":""}}', expected: 'VALID' },
  { description: 'write(path) — missing content', raw: '{"action":"tool","tool":"write","input":{"path":"main.cpp"}}', expected: 'INVALID' },
  { description: 'write(content) — missing path', raw: '{"action":"tool","tool":"write","input":{"content":"x"}}', expected: 'INVALID' },
  { description: 'write({}) — missing both', raw: '{"action":"tool","tool":"write","input":{}}', expected: 'INVALID' },
  { description: 'shell(command="ls")', raw: '{"action":"tool","tool":"shell","input":{"command":"ls"}}', expected: 'VALID' },
  { description: 'shell({}) — missing command', raw: '{"action":"tool","tool":"shell","input":{}}', expected: 'INVALID' },
  { description: 'glob(pattern="*.cpp")', raw: '{"action":"tool","tool":"glob","input":{"pattern":"*.cpp"}}', expected: 'VALID' },
  { description: 'glob({}) — missing pattern', raw: '{"action":"tool","tool":"glob","input":{}}', expected: 'INVALID' },
  {
    description: 'real bug: shell args wrapped one level too deep under "content"',
    raw: '{"action":"tool","tool":"shell","input":{"content":{"command":"ls -la"}}}',
    expected: 'VALID',
  },
  {
    description: 'real bug: task prose quotes a brace before the real action',
    raw: 'The user asked to sort the array {5,3,1,4,2}.\n{"action":"plan","content":"go"}',
    expected: 'VALID',
  },
  { description: 'not JSON at all', raw: 'I will now think about this for a while.', expected: 'INVALID' },
];

/**
 * `wa test action-protocol` — the parser/validator matrix from the follow-up architecture
 * review's "test I would run right now", made real: never invokes a model, only exercises
 * parseAction -> normalizeAction -> missingRequiredFields exactly as the live agent loop
 * does, and asserts the deterministic pipeline (§10 there): INVALID never reaches Policy or
 * the tool executor. Fast enough for CI; the companion `wa test model-protocol` is the one
 * that needs a real runtime.
 */
export function actionProtocolTestCommand(): { code: number; output: string } {
  const toolNames = new Set(Object.keys(REQUIRED_TOOL_FIELDS));
  const rows: string[][] = [];
  let failures = 0;

  for (const c of ACTION_PROTOCOL_CASES) {
    const action = normalizeAction(parseAction(c.raw), toolNames);
    let actual: 'VALID' | 'INVALID';
    let detail = '';
    if (!action) {
      actual = 'INVALID';
      detail = 'unparseable';
    } else if (action.action === 'tool' && action.tool) {
      const missing = missingRequiredFields(action.tool, action.input ?? {});
      actual = missing.length === 0 ? 'VALID' : 'INVALID';
      detail = missing.length > 0 ? `missing: ${missing.join(', ')}` : '';
    } else {
      actual = 'VALID';
      detail = `action=${action.action}`;
    }

    const status = actual === c.expected ? color.green('PASS') : color.red('FAIL');
    if (actual !== c.expected) failures += 1;
    rows.push([c.description, c.expected, actual, status, detail]);
  }

  const lines = [
    color.bold('Action protocol matrix (no model invoked)'),
    '',
    table(['case', 'expected', 'actual', 'status', 'detail'], rows),
    '',
    `${rows.length - failures}/${rows.length} passed`,
  ];
  return { code: failures === 0 ? 0 : 1, output: lines.join('\n') };
}

/**
 * `wa test model-protocol --model <id>` — runs one deterministic, easily-verified task
 * (write a known file with known content) through the real agent loop against a real
 * model/runtime, in an isolated throwaway project directory, and reports:
 *   - a per-turn trace (kind, tool, whether a locally-rejected/duplicate action fired)
 *   - whether the file actually ended up with the exact expected content on disk
 *   - the task's own deterministic evaluation (evaluateExecution)
 * This is the live counterpart to actionProtocolTestCommand() — comparing two models'
 * output here (`wa test model-protocol --model A` vs `--model B`) is exactly the
 * "if both fail identically, Wazir is the problem; if only one fails, it's a model/
 * protocol compatibility problem" comparison the architecture review asked for.
 */
export async function modelProtocolTestCommand(modelId: string): Promise<{ code: number; output: string }> {
  const { createEngine } = await import('./engine.js');
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-protocol-'));
  const targetFile = 'wazir-protocol-check.txt';
  const marker = 'WAZIR_OK';

  const lines: string[] = [
    color.bold(`Model protocol test — ${modelId}`),
    color.gray(`  task: create ${targetFile} containing exactly "${marker}"`),
    color.gray(`  workspace: ${projectRoot}`),
    '',
  ];

  try {
    const engine = await createEngine({ projectRoot, quiet: true });
    const description =
      `Create a file named ${targetFile} in the project root containing exactly the text ` +
      `${marker} and nothing else, then respond with the done action.`;

    const outcome = await executeTask(engine, description, {
      type: 'coding',
      model: modelId,
      maxTurns: 15,
      expectedFiles: [targetFile],
      quiet: true,
    });

    const record = engine.executions.require(outcome.executionId);
    const turnEvents = record.events.filter((e) => e.type === 'agent.turn') as Array<{
      data?: { kind?: string; tool?: string; content?: string; error?: string };
    }>;
    const PROTOCOL_PREFIXES = ['ACTION_VALIDATION_FAILED', 'ACTION_BLOCKED_DUPLICATE', 'INVALID_JSON_ACTION'];
    const isProtocolNote = (content?: string) => PROTOCOL_PREFIXES.some((p) => content?.startsWith(p));

    const rows = turnEvents.map((e, i) => {
      const d = e.data ?? {};
      const note = isProtocolNote(d.content) ? color.yellow('REJECTED') : d.error ? color.red('failed') : d.tool ? 'ok' : '';
      const summary = (d.content ?? d.error ?? '').slice(0, 70);
      return [String(i + 1), d.kind ?? '', d.tool ?? '', note, summary];
    });
    lines.push(table(['#', 'kind', 'tool', 'note', 'summary'], rows));

    const protocolCorrections = turnEvents.filter((e) => isProtocolNote(e.data?.content)).length;
    lines.push('');
    lines.push(`Protocol corrections needed: ${protocolCorrections}`);

    let actualContent = '';
    let fileOk = false;
    try {
      actualContent = (await fs.readFile(path.join(projectRoot, targetFile), 'utf8')).trim();
      fileOk = actualContent === marker;
    } catch {
      fileOk = false;
    }

    lines.push(
      `File has exact expected content: ${fileOk ? color.green('PASS') : color.red('FAIL')}` +
        (fileOk ? '' : ` (got ${JSON.stringify(actualContent.slice(0, 80))})`),
    );
    lines.push(`Task-level evaluation: ${outcome.success ? color.green('PASS') : color.red('FAIL')} (${outcome.reasons.join('; ')})`);

    const passed = fileOk && outcome.success;
    lines.push('');
    lines.push(passed ? color.green('RESULT: PASS') : color.red('RESULT: FAIL'));

    return { code: passed ? 0 : 1, output: lines.join('\n') };
  } catch (err) {
    lines.push(color.red(`error: ${err instanceof Error ? err.message : String(err)}`));
    return { code: 1, output: lines.join('\n') };
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function inspectRuntime(engine: RookEngine, id: string): Promise<void> {
  const runtime = engine.discovered.find((r) => r.id === id);
  if (!runtime) {
    console.error(color.red(`Runtime '${id}' not found.`));
    return;
  }
  
  console.log(`\n${color.bold(runtime.info.name || id)}`);
  console.log('-'.repeat(48));
  console.log(`Computer:   ${process.env.WAZIR_COMPUTER_ID || 'local'}`);
  
  if (runtime.healthDiagnostics) {
    const diag = runtime.healthDiagnostics;
    console.log(`CLI:        ${diag.cliAvailable ? color.green('available') : color.red('unavailable')}`);
    console.log(`Server:     ${diag.serverRunning ? color.green('running') : color.red('stopped')}`);
    console.log(`Endpoint:   ${diag.endpoint}`);
    console.log(`API:        ${diag.apiReachable ? color.green('reachable') : color.red('unreachable')}`);
    console.log('');
    console.log(`Models:     ${diag.installedModels} installed | ${diag.loadedModels} loaded | ${diag.readyModels} ready`);
  } else {
    console.log(`Endpoint:   ${runtime.info.url || 'unknown'}`);
    console.log(`Health:     ${runtime.health === 'healthy' ? color.green('healthy') : color.red(runtime.health)}`);
  }
  
  if (runtime.health !== 'healthy') {
    console.log(`\n${color.red('Error:')}`);
    console.log(`  ${runtime.healthReason || 'UNAVAILABLE'} ${runtime.healthMessage}`);
  }
  
  if (runtime.healthDiagnostics?.cliAvailable && !runtime.healthDiagnostics.serverRunning && runtime.adapter.startServer) {
    console.log(`\n${color.yellow('Suggested action:')}`);
    console.log(`  Start LM Studio API server or correct runtime endpoint.`);
    console.log(`  Run: wa runtimes start ${id}`); // If we add a start command
  }
  
  console.log();
}
