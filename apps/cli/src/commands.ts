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
    `  est. cost:    $${rollup.estimatedCostUsd.toFixed(4)}`,
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

  if (json) {
    return {
      code: 0,
      output: JSON.stringify(
        { id, task: execution.task, scheduling: execution.scheduling, policyDecisions: execution.policyDecisions },
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
    lines.push(color.bold('Selected computer'));
    lines.push(`  ${s.computerId}`);
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
  lines.push(`Tokens: ${rollup.tokens.total}  Duration: ${(rollup.durationMs / 1000).toFixed(1)}s  Est. cost: $${rollup.estimatedCostUsd.toFixed(4)}`);
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
      lines.push(`  -> ${s.modelId} on ${s.computerId} via ${s.runtimeId}`);
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

