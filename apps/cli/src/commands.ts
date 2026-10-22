import { formatVerificationInspection } from './tui/observabilityViews.js';
import {
  explainExecution,
  inspectVerificationEvidence,
  explainCompletion,
  summarizeExecution,
  captureHeadFingerprint,
  describeUnexpectedHeadDrift,
  type BlockStatus,
  type ExecutionRecord,
  type Job,
  type TaskType,
} from '@wazir/core';
import type { RookEngine } from './engine.js';
import { color } from './colors.js';
import { executeTask, planTask } from './run.js';
import { ensureNvidiaModelRegistered } from './hostedProviders.js';
import { readAuditEvents, stripTerminalEscapes } from '@wazir/shared';
import { listBlocks, getBlock } from './blocks.js';
import { resolveReference } from './references.js';
import { table, formatAge, formatTaskStatusRecord } from './commands/formatters.js';

export * from './commands/formatters.js';
export * from './commands/inventoryCommands.js';
export * from './commands/contextCommands.js';
export * from './commands/artifactAndVerifyCommands.js';
export * from './commands/providerCommands.js';
export * from './commands/improveAndCanaryCommands.js';

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

export async function planTaskCommand(engine: RookEngine, description: string, options: {
  type?: TaskType;
  model?: string;
  agent?: string;
  allowHosted?: boolean;
  routingMode?: import('@wazir/core').RoutingMode;
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
  if (scheduling.resourceType) {
    lines.push(`    resource:  ${scheduling.resourceType}`);
  }
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
  /** Run even when the agent's last (fresh) preflight check failed. */
  force?: boolean;
  maxTurns?: number;
  expectedFiles?: string[];
  allowHosted?: boolean;
  routingMode?: import('@wazir/core').RoutingMode;
  json?: boolean;
  preset?: string;
  fullVerification?: boolean;
}): Promise<{ code: number; output: string }> {
  // A fresh, failed preflight means this agent would fail too: say why now rather than after
  // a full launch. Agents never checked (or with an expired result) run normally.
  if (options.agent && !options.force) {
    const registeredAgent = engine.agents.get(options.agent) as (import('@wazir/core').AgentAdapter & {
      preflight?: () => Promise<{ ok: boolean; reason?: string; reasons?: string[] }> | { ok: boolean; reason?: string; reasons?: string[] };
    }) | undefined;
    let preflightMessage: string | undefined;
    if (typeof registeredAgent?.preflight === 'function') {
      const check = await registeredAgent.preflight();
      if (check && check.ok === false) {
        preflightMessage = check.reason ?? check.reasons?.join('; ') ?? `agent '${options.agent}' failed preflight`;
      }
    }
    if (!preflightMessage) {
      const { knownAgentFailure, refusalMessage, checkAgents } = await import('./agentPreflight.js');
      let failure = knownAgentFailure(options.agent);
      // Probe lazily when an operator selects an installed vendor agent. Other CLI commands
      // remain passive, and the existing fingerprint/TTL cache avoids repeated paid sessions.
      if (!failure && ['codex', 'claude-code', 'antigravity'].includes(options.agent.split('@')[0]) && registeredAgent) {
        const [result] = await checkAgents(engine, [options.agent]);
        if (result && result.status !== 'READY') failure = result;
      }
      if (failure) {
        preflightMessage = refusalMessage(failure);
      }
    }
    if (preflightMessage) {
      let executionId = '—';
      try {
        await engine.executions.ready;
        const failedTask = {
          id: `task-preflight-${Date.now()}`,
          type: options.type ?? ('coding' as TaskType),
          input: description,
          requirements: {
            minimumContext: 8192,
            ...(options.expectedFiles?.length ? { expectedArtifacts: options.expectedFiles } : {}),
          },
          priority: 'normal' as const,
          status: 'failed' as const,
          createdAt: new Date(),
        };
        const failedRec = await engine.executions.create({
          task: failedTask,
          agentId: options.agent,
          computerId: engine.worker?.computerId ?? 'local',
          runtimeId: 'external',
          modelId: options.model ?? `external:${options.agent}`,
          workerId: engine.worker?.id ?? 'local-cli',
          workspaceRoot: engine.projectRoot,
        });
        await engine.executions.recordError(failedRec.execution.id, preflightMessage);
        await engine.executions.setStatus(failedRec.execution.id, 'failed');
        executionId = failedRec.execution.id;
      } catch {
        // Best effort if store rejects
      }
      return {
        code: 1,
        output: options.json
          ? JSON.stringify({ success: false, executionId, reasons: [preflightMessage], filesChanged: [], errors: [preflightMessage] }, null, 2)
          : preflightMessage,
      };
    }
  }
  // Defense-in-depth (see packages/core/src/services/repoIntegrityGuard.ts): a 2026-10-17
  // audit observed a single task invocation coincide with an unauthorized merge commit
  // landing on the user's checked-out branch, with no trace in any of Wazir's own
  // policy/audit/event logs. The exact trigger wasn't isolated. Regardless of mechanism,
  // never hand back a result without telling the user their repository moved underneath them.
  const headBefore = await captureHeadFingerprint(engine.projectRoot);
  const outcome = await executeTask(engine, description, {
    type: options.type,
    model: options.model,
    agent: options.agent,
    maxTurns: options.maxTurns,
    expectedFiles: options.expectedFiles,
    allowHosted: options.allowHosted,
    routingMode: options.routingMode,
    json: options.json,
    quiet: options.json === true,
    preset: options.preset,
    fullVerification: options.fullVerification,
  });
  const headDrift = await describeUnexpectedHeadDrift(engine.projectRoot, headBefore);
  if (headDrift) {
    outcome.success = false;
    outcome.reasons = [headDrift, ...outcome.reasons];
    outcome.errors = [headDrift, ...outcome.errors];
  }

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
    lines.push(`  result: ${outcome.result}`);
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

export function taskStatusCommand(
  engine: RookEngine,
  id: string,
  options?: { json?: boolean },
): { code: number; output: string } & PromiseLike<{ code: number; output: string }> {
  const execStore = engine.executions as unknown as {
    records?: Map<string, ExecutionRecord>;
    store?: unknown;
    get: (executionId: string) => Promise<ExecutionRecord | undefined> | ExecutionRecord | undefined;
    list: () => Promise<ExecutionRecord[]> | ExecutionRecord[];
  };

  const findInList = (all: ExecutionRecord[]): ExecutionRecord | undefined =>
    all.find((r) => r.execution.id === id || r.task.id === id || r.execution.id.includes(id) || r.task.id.includes(id));

  if (execStore.records instanceof Map && (!execStore.store || execStore.records.size > 0)) {
    const direct = execStore.records.get(id) ?? findInList(Array.from(execStore.records.values()));
    const result = formatTaskStatusRecord(direct, id, options);
    const plain = { code: result.code, output: result.output };
    return Object.assign(result, {
      then<TResult1 = { code: number; output: string }, TResult2 = never>(
        onfulfilled?: ((value: { code: number; output: string }) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): Promise<TResult1 | TResult2> {
        return Promise.resolve(plain).then(onfulfilled, onrejected);
      },
    });
  }

  const asyncPromise = (async () => {
    let record = await execStore.get(id);
    if (!record) {
      const all = await execStore.list();
      record = findInList(all);
    }
    return formatTaskStatusRecord(record, id, options);
  })();

  const fallbackSync = formatTaskStatusRecord(
    execStore.records instanceof Map
      ? execStore.records.get(id) ?? findInList(Array.from(execStore.records.values()))
      : undefined,
    id,
    options,
  );
  return Object.assign(fallbackSync, {
    then: asyncPromise.then.bind(asyncPromise),
  });
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

  if (decisions.resumes.length > 0) {
    lines.push('');
    lines.push(color.bold('Why it resumed'));
    for (const r of decisions.resumes) {
      lines.push(`  attempt ${r.attempt ?? '?'} continued this execution at revision ${r.workspaceRevision ?? '?'}`);
      for (const reason of r.reasons) lines.push(color.gray(`    ${reason}`));
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
function safeToolCheckpoints(engine: RookEngine, id: string): Array<{ state: string }> | undefined {
  try { return engine.executions.toolCheckpoints(id); } catch { return undefined; }
}

/**
 * `wa evidence <ref>` — read-only verification evidence inspector.
 * Projects the durable ExecutionRecord; model narration (record.result) is never read.
 */
export async function evidenceCommand(engine: RookEngine, ref: string, opts: { json?: boolean } = {}): Promise<{ code: number; output: string }> {
  const resolved = await resolveReference(engine, ref);
  let execution: ExecutionRecord | undefined;
  let id = ref;
  if (resolved.kind === 'execution') { execution = resolved.execution; id = resolved.id; }
  else if (resolved.kind === 'block' && resolved.block?.executionId) { id = resolved.block.executionId; execution = await engine.executions.get(id); }
  if (!execution) return { code: 1, output: color.red(`execution '${id}' not found`) };
  const artifacts = await engine.provenance.getArtifactsByExecution(execution.execution.id).catch(() => []);
  const inspection = inspectVerificationEvidence(execution, { artifacts, toolCheckpoints: safeToolCheckpoints(engine, execution.execution.id) });
  const why = explainCompletion(inspection);
  if (opts.json) return { code: 0, output: JSON.stringify({ inspection, why }, null, 2) };
  return { code: 0, output: formatVerificationInspection(inspection, why).join('\n') };
}

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

export const explainExecutionCommand = explainCommand;

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

export async function askCommand(
  engine: RookEngine,
  prompt: string,
  options: {
    model?: string;
    computer?: string;
    localOnly?: boolean;
    allowHosted?: boolean;
    routingMode?: import('@wazir/core').RoutingMode;
  } = {},
): Promise<{ code: number; output: string }> {
  const routingCfg = engine.config.routing;
  const effectiveRoutingMode: import('@wazir/core').RoutingMode | undefined =
    options.routingMode ??
    (options.localOnly
      ? 'LOCAL_ONLY'
      : routingCfg?.mode === 'provider_only'
      ? routingCfg.provider === 'nvidia'
        ? 'NVIDIA'
        : 'PROVIDER_ONLY'
      : routingCfg?.mode
      ? (routingCfg.mode.toUpperCase() as import('@wazir/core').RoutingMode)
      : undefined);
  const effectiveRoutingProvider =
    options.routingMode === 'NVIDIA'
      ? 'nvidia'
      : routingCfg?.provider;
  const isProviderOnly =
    effectiveRoutingMode === 'NVIDIA' ||
    effectiveRoutingMode === 'PROVIDER_ONLY' ||
    routingCfg?.mode === 'provider_only';

  if (options.localOnly && isProviderOnly && effectiveRoutingProvider && engine.runtimes.get(effectiveRoutingProvider)?.runtimeKind === 'hosted') {
    return {
      code: 1,
      output: color.red(`refused: localOnly conflicts with provider-only routing mode for hosted provider '${effectiveRoutingProvider}'`),
    };
  }

  // Ensure custom or default NVIDIA model is registered when NVIDIA runtime is healthy
  if (options.model && !engine.models.get(options.model) && (options.model.startsWith('nvidia/') || (isProviderOnly && effectiveRoutingProvider === 'nvidia' && options.model.includes('/')))) {
    ensureNvidiaModelRegistered(engine.models, engine.runtimes, engine.config, options.model);
  }
  if (routingCfg?.provider === 'nvidia' && routingCfg.defaultModel) {
    ensureNvidiaModelRegistered(engine.models, engine.runtimes, engine.config, routingCfg.defaultModel);
  }

  const models = engine.models.list();
  if (models.length === 0) {
    if (isProviderOnly) {
      return {
        code: 1,
        output: color.red(`refused: provider-only routing (${effectiveRoutingProvider ?? 'nvidia'}) is enabled, but no eligible models are registered or authenticated`),
      };
    }
    return {
      code: 1,
      output: color.yellow('no models registered — start LM Studio or Ollama to enable completions'),
    };
  }

  // Enforce provider-only and localOnly filtering on candidate models
  let eligibleModels = models.filter((m) => !m.embedding && !m.id.toLowerCase().includes('embed'));
  if (options.localOnly || effectiveRoutingMode === 'LOCAL_ONLY') {
    eligibleModels = eligibleModels.filter((m) => m.local);
  }
  if (isProviderOnly && effectiveRoutingProvider) {
    if (options.model) {
      const requestedModel = models.find((m) => m.id === options.model || m.id.toLowerCase().includes(options.model!.toLowerCase()));
      if (requestedModel && requestedModel.provider !== effectiveRoutingProvider) {
        return {
          code: 1,
          output: color.red(
            `refused: pinned model '${requestedModel.id}' belongs to provider '${requestedModel.provider}', which violates provider-only routing for '${effectiveRoutingProvider}'`,
          ),
        };
      }
      if (!requestedModel && !options.model.toLowerCase().includes(effectiveRoutingProvider.toLowerCase())) {
        return {
          code: 1,
          output: color.red(
            `refused: requested model '${options.model}' is not an eligible '${effectiveRoutingProvider}' model under provider-only routing`,
          ),
        };
      }
    }
    eligibleModels = eligibleModels.filter((m) => {
      if (m.provider !== effectiveRoutingProvider) return false;
      const rt = engine.runtimes.get(m.provider);
      if (!rt || rt.health !== 'healthy') return false;
      return engine.models.instancesOf(m.id).some((i) => i.loaded && i.state === 'READY' && i.health === 'healthy');
    });
    if (eligibleModels.length === 0) {
      return {
        code: 1,
        output: color.red(
          `refused: provider-only routing (${effectiveRoutingProvider}) is enabled, but no healthy/authenticated '${effectiveRoutingProvider}' model is available`,
        ),
      };
    }
  }

  const defaultModelId =
    routingCfg?.defaultModel ??
    (effectiveRoutingProvider === 'nvidia' ? engine.config.providers?.nvidia?.defaultModel : undefined);

  const target = options.model
    ? eligibleModels.find((m) => m.id === options.model || m.id.toLowerCase().includes(options.model!.toLowerCase()))
    : (defaultModelId ? eligibleModels.find((m) => m.id === defaultModelId) : undefined) ??
      eligibleModels[0] ??
      (!isProviderOnly ? models[0] : undefined);

  if (!target) {
    return {
      code: 1,
      output: color.red(
        `model '${options.model ?? defaultModelId ?? '(auto)'}' not found or not eligible under active routing policy. Eligible models:\n${eligibleModels.map((m) => `  - ${m.id}`).join('\n') || '  (none)'}`,
      ),
    };
  }

  const targetRuntime = engine.runtimes.get(target.provider);
  if (targetRuntime?.runtimeKind === 'hosted') {
    const implicitProviderOnlyAllow = isProviderOnly && effectiveRoutingProvider === target.provider;
    const gate = engine.policy.checkHostedEligibility(
      {
        localOnly: options.localOnly,
        allowHostedProviders:
          options.allowHosted ??
          (implicitProviderOnlyAllow ? true : engine.config.providers?.allowHostedProviders),
      },
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

  // Record durable routing decision in ResourceLedger so wa resources reflects askCommand placement
  const accountId = engine.resources.resolveAccount(target.provider, target.id);
  const askTaskId = `ask-${Date.now()}`;
  engine.resources.ledger.appendEvent(
    'routing',
    { accountId, taskId: askTaskId },
    {
      modelId: target.id,
      runtimeId: target.provider,
      provider: target.provider,
      mode: isProviderOnly ? 'provider_only' : (routingCfg?.mode ?? 'auto'),
      command: 'ask',
    },
  );

  if (engine.mcp && engine.tools.descriptors().some(t => t.provenance?.source === 'mcp')) {
    const outcome = await executeTask(engine, prompt, {
      type: 'coding',
      model: target.id,
      agent: 'wazir-step',
      allowHosted: options.allowHosted,
      routingMode: effectiveRoutingMode,
    });
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
      resourceContext: { taskId: askTaskId, workload: 'interactive', agent: 'wa-ask' },
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
