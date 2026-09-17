import type { TaskType } from '@wazir/core';
import type { RookEngine } from './engine.js';
import { color } from './colors.js';
import { executeTask, planTask } from './run.js';

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

export function listModels(engine: RookEngine): string {
  const models = engine.models.list();
  if (models.length === 0) {
    return color.yellow('no models registered (is Ollama / LM Studio running?)');
  }
  const rows = models.map((m) => {
    const instances = engine.models.instancesOf(m.id);
    return [
      m.id,
      m.provider,
      m.family,
      String(m.contextMax),
      m.toolCalling ? 'yes' : 'no',
      m.reasoning ? 'yes' : 'no',
      `${instances.length}`,
    ];
  });
  return table(
    ['model', 'provider', 'family', 'context', 'toolCalling', 'reasoning', 'instances'],
    rows,
  );
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
  if (json) return JSON.stringify(record, null, 2);

  const e = record.execution;
  const lines: string[] = [];
  lines.push(color.bold(record.execution.id));
  lines.push(`  status:    ${e.status}`);
  lines.push(`  task:      ${record.task.type} — ${record.task.input.slice(0, 80)}`);
  lines.push(`  agent:     ${e.agentId ?? '—'}`);
  lines.push(`  model:     ${e.modelId ?? '—'}`);
  lines.push(`  runtime:   ${e.runtimeId ?? '—'}`);
  lines.push(`  computer:  ${e.computerId ?? '—'}`);
  lines.push(`  created:   ${e.createdAt.toISOString()}`);
  if (e.completedAt) lines.push(`  completed: ${e.completedAt.toISOString()}`);

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
  const tokPerSec = outputTokens > 0 ? (outputTokens / elapsedMs) * 1000 : 0;

  lines.push(`  first token: ${firstTokenMs !== undefined ? `${firstTokenMs}ms` : '—'}`);
  lines.push(`  total time:  ${elapsedMs}ms`);
  lines.push(`  input:       ${inputTokens} tokens`);
  lines.push(`  output:      ${outputTokens} tokens`);
  lines.push(`  throughput:  ${tokPerSec.toFixed(1)} tok/s`);
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

export function planTaskCommand(engine: RookEngine, description: string, options: {
  type?: TaskType;
  model?: string;
  agent?: string;
  json?: boolean;
}): { code: number; output: string } {
  const planned = planTask(engine, description, options);

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
  lines.push(`    computer:  ${scheduling.computerId}`);
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
}): Promise<{ code: number; output: string }> {
  const outcome = await executeTask(engine, description, {
    type: options.type,
    model: options.model,
    agent: options.agent,
    maxTurns: options.maxTurns,
    expectedFiles: options.expectedFiles,
    json: options.json,
    quiet: options.json === true,
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
