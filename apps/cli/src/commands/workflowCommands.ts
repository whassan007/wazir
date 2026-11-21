import type { Command } from 'commander';
import type {
  RequestedWorkflowMode,
  WorkflowMode,
  WorkflowOriginInterface,
} from '@wazir/goals';
import { color } from '../colors.js';

export interface WorkflowCommandResult {
  code: number;
  output: string;
  data?: unknown;
}

export interface WorkflowRunCliOptions {
  workspace?: string;
  mode?: RequestedWorkflowMode | string;
  maxIterations?: number | string;
  concurrency?: number | string;
  budget?: number | string;
  duration?: number | string;
  repairs?: number | string;
  model?: string;
  computer?: string;
  items?: string | string[];
  until?: string;
  verify?: string[];
  dryRun?: boolean;
  detach?: boolean;
  json?: boolean;
  approveAll?: boolean;
  originInterface?: WorkflowOriginInterface;
}

function parseOptionalInt(val: number | string | undefined, name: string, min: number): number | undefined {
  if (val === undefined) return undefined;
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid value for ${name}: '${String(val)}'`);
  }
  return Math.max(min, Math.floor(n));
}

function parseOptionalFloat(val: number | string | undefined, name: string, min: number): number | undefined {
  if (val === undefined) return undefined;
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid value for ${name}: '${String(val)}'`);
  }
  return Math.max(min, n);
}

function normalizeItemsOption(raw: string | string[] | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parts = Array.isArray(raw) ? raw : [raw];
  const out = parts
    .flatMap((p) => p.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function normalizeVerifyOption(raw: string[] | string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const arr = Array.isArray(raw) ? raw : [raw];
  const out = arr.map((s) => s.trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function formatCliError(err: unknown, json?: boolean): WorkflowCommandResult {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | undefined)?.code ?? 'WORKFLOW_ERROR';
  if (json) {
    return {
      code: 1,
      output: JSON.stringify({ ok: false, error: { code, message } }, null, 2),
      data: { ok: false, error: { code, message } },
    };
  }
  return { code: 1, output: color.red(`[${code}] ${message}`) };
}

export async function runWorkflowCommand(
  prompt: string,
  options: WorkflowRunCliOptions & {
    defaultRequestedMode?: RequestedWorkflowMode;
    overrideMode?: WorkflowMode;
  } = {},
): Promise<WorkflowCommandResult> {
  try {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return formatCliError(new Error('Workflow prompt must be a non-empty string'), options.json);
    }

    const wf = await import('../workflowRuntime.js');
    const rawWorkspace = options.workspace ?? process.env.WAZIR_WORKSPACE_DIR ?? process.cwd();
    const workspaceRoot = wf.assertValidWorkspaceDir(rawWorkspace);

    const requestedModeRaw = options.mode ? String(options.mode).trim().toLowerCase() : undefined;
    if (
      requestedModeRaw &&
      !new Set(['auto', 'single', 'loop', 'graph', 'hybrid']).has(requestedModeRaw)
    ) {
      throw new Error(
        `Invalid --mode '${requestedModeRaw}'. Expected one of: auto, single, loop, graph, hybrid`,
      );
    }
    const requestedMode = (requestedModeRaw as RequestedWorkflowMode | undefined) ?? options.defaultRequestedMode ?? 'auto';
    const overrideMode =
      options.overrideMode ??
      (requestedModeRaw && requestedModeRaw !== 'auto' ? (requestedModeRaw as WorkflowMode) : undefined);

    const handle = await wf.createCliWorkflowRuntime({
      workspaceRoot,
      defaultModel: options.model,
      defaultComputer: options.computer,
      autoAdvance: options.detach ? false : true,
    });

    try {
      const request = {
        prompt: trimmed,
        requestedMode,
        overrideMode,
        originInterface: options.originInterface ?? 'cli',
        workspaceRoot,
        actor: 'user:local',
        maxIterations: parseOptionalInt(options.maxIterations, '--max-iterations', 1),
        maxConcurrency: parseOptionalInt(options.concurrency, '--concurrency', 1),
        maxBudgetUsd: parseOptionalFloat(options.budget, '--budget', 0),
        maxDurationMinutes: parseOptionalInt(options.duration, '--duration', 1),
        maxRepairsPerTask: parseOptionalInt(options.repairs, '--repairs', 0),
        preferredModel: options.model,
        computer: options.computer,
        items: normalizeItemsOption(options.items),
        completionCondition: options.until,
        verifyCommands: normalizeVerifyOption(options.verify),
        dryRun: Boolean(options.dryRun),
        approveAll: Boolean(options.approveAll),
      };

      if (options.detach && !options.dryRun) {
        const started = await handle.runtime.start(request);
        const payload = {
          ok: true,
          detached: true,
          runId: started.run.runId,
          graphId: started.graph.graphId,
          graphRevision: started.graph.revision,
          mode: started.plan.mode,
          status: started.run.status,
          run: started.run,
          plan: started.plan,
        };
        if (options.json) {
          return { code: 0, output: JSON.stringify(payload, null, 2), data: payload };
        }
        return {
          code: 0,
          output: [
            color.bold(`${wf.modeBadge(started.plan.mode)} Detached Workflow Started: ${started.run.runId}`),
            `  graph:     ${started.graph.graphId}@${started.graph.revision}`,
            `  mode:      ${started.plan.mode}`,
            `  status:    ${started.run.status}`,
            `  workspace: ${workspaceRoot}`,
            `  inspect:   wa inspect ${started.run.runId}`,
          ].join('\n'),
          data: payload,
        };
      }

      const initialResult = await handle.runtime.executeToCompletion(request);
      let finalRun = initialResult.run;
      let finalEvidence = initialResult.evidence;

      if (options.approveAll && !options.dryRun) {
        const settled = await wf.settlePendingApprovalsIfApprovedAll(
          handle.runtime,
          initialResult.run.runId,
          'user:local',
        );
        finalRun = settled.run;
        if (settled.evidence.length > 0) {
          finalEvidence = settled.evidence;
        }
      }

      const finalResult = {
        run: finalRun,
        plan: initialResult.plan,
        evidence: finalEvidence,
        interrupted: initialResult.interrupted,
      };
      const hasFailure =
        !options.dryRun &&
        (finalRun.status === 'failed' ||
          Object.values(finalRun.targets).some((t) => t.status === 'failed' || t.status === 'blocked'));

      const payload = {
        ok: !hasFailure,
        runId: finalRun.runId,
        mode: initialResult.plan.mode,
        status: finalRun.status,
        ...finalResult,
      };

      if (options.json) {
        return {
          code: hasFailure ? 1 : 0,
          output: JSON.stringify(payload, null, 2),
          data: payload,
        };
      }

      return {
        code: hasFailure ? 1 : 0,
        output: wf.formatWorkflowSummaryText(finalResult),
        data: payload,
      };
    } finally {
      await handle.close();
    }
  } catch (err) {
    return formatCliError(err, options.json);
  }
}

export async function loopCommand(
  task: string,
  options: WorkflowRunCliOptions = {},
): Promise<WorkflowCommandResult> {
  return runWorkflowCommand(task, {
    ...options,
    defaultRequestedMode: 'loop',
  });
}

export async function graphCommand(
  goal: string,
  options: WorkflowRunCliOptions = {},
): Promise<WorkflowCommandResult> {
  return runWorkflowCommand(goal, {
    ...options,
    defaultRequestedMode: 'graph',
  });
}

export async function workflowJobsCommand(
  options: { status?: string; mode?: string; workspace?: string; json?: boolean } = {},
): Promise<WorkflowCommandResult> {
  try {
    const wf = await import('../workflowRuntime.js');
    const statusFilter = wf.normalizeRunStatusFilter(options.status);
    const modeFilter = wf.normalizeWorkflowModeFilter(options.mode);
    const handle = await wf.createCliWorkflowRuntime({ workspaceRoot: options.workspace });
    try {
      const jobs = await handle.runtime.listJobs({
        status: statusFilter,
        mode: modeFilter,
      });
      if (options.json) {
        return { code: 0, output: JSON.stringify({ ok: true, jobs }, null, 2), data: { jobs } };
      }
      return { code: 0, output: wf.formatJobsTable(jobs), data: { jobs } };
    } finally {
      await handle.close();
    }
  } catch (err) {
    return formatCliError(err, options.json);
  }
}

export async function workflowInspectCommand(
  runId: string,
  options: { workspace?: string; json?: boolean } = {},
): Promise<WorkflowCommandResult> {
  try {
    const wf = await import('../workflowRuntime.js');
    const handle = await wf.createCliWorkflowRuntime({ workspaceRoot: options.workspace });
    try {
      const resolvedId = await wf.resolveWorkflowRunId(handle.runtime, runId);
      const inspection = await handle.runtime.inspect(resolvedId);
      if (!inspection) {
        return formatCliError(new Error(`Workflow run '${runId}' not found`), options.json);
      }
      if (options.json) {
        const payload = { ok: true, ...inspection };
        return { code: 0, output: JSON.stringify(payload, null, 2), data: payload };
      }
      return {
        code: 0,
        output: wf.formatInspectionReport(inspection),
        data: inspection,
      };
    } finally {
      await handle.close();
    }
  } catch (err) {
    return formatCliError(err, options.json);
  }
}

export async function workflowStatusCommand(
  runId: string,
  options: { workspace?: string; json?: boolean } = {},
): Promise<WorkflowCommandResult> {
  try {
    const wf = await import('../workflowRuntime.js');
    const handle = await wf.createCliWorkflowRuntime({ workspaceRoot: options.workspace });
    try {
      const resolvedId = await wf.resolveWorkflowRunId(handle.runtime, runId);
      const summary = await handle.runtime.getStatus(resolvedId);
      if (!summary) {
        return formatCliError(new Error(`Workflow run '${runId}' not found`), options.json);
      }
      const inspection = await handle.runtime.inspect(resolvedId);
      if (options.json) {
        const payload = { ok: true, summary, ...(inspection ? { run: inspection.run, plan: inspection.plan } : {}) };
        return { code: 0, output: JSON.stringify(payload, null, 2), data: payload };
      }
      return {
        code: 0,
        output: wf.formatWorkflowStatusText(summary, inspection),
        data: { summary, inspection },
      };
    } finally {
      await handle.close();
    }
  } catch (err) {
    return formatCliError(err, options.json);
  }
}

export async function workflowPauseCommand(
  runId: string,
  options: { reason?: string; workspace?: string; json?: boolean } = {},
): Promise<WorkflowCommandResult> {
  try {
    const wf = await import('../workflowRuntime.js');
    const handle = await wf.createCliWorkflowRuntime({ workspaceRoot: options.workspace });
    try {
      const resolvedId = await wf.resolveWorkflowRunId(handle.runtime, runId);
      const run = await handle.runtime.pause(resolvedId, 'user:local', options.reason);
      const payload = { ok: true, runId: run.runId, status: run.status, ledgerRevision: run.ledgerRevision, run };
      if (options.json) {
        return { code: 0, output: JSON.stringify(payload, null, 2), data: payload };
      }
      return {
        code: 0,
        output: `Workflow ${run.runId} -> ${run.status} (ledger rev ${run.ledgerRevision})${options.reason ? ` — ${options.reason}` : ''}`,
        data: payload,
      };
    } finally {
      await handle.close();
    }
  } catch (err) {
    return formatCliError(err, options.json);
  }
}

export async function workflowStopCommand(
  runId: string,
  options: { reason?: string; workspace?: string; json?: boolean } = {},
): Promise<WorkflowCommandResult> {
  try {
    const wf = await import('../workflowRuntime.js');
    const handle = await wf.createCliWorkflowRuntime({ workspaceRoot: options.workspace });
    try {
      const resolvedId = await wf.resolveWorkflowRunId(handle.runtime, runId);
      const run = await handle.runtime.stop(resolvedId, 'user:local', options.reason);
      const payload = { ok: true, runId: run.runId, status: run.status, ledgerRevision: run.ledgerRevision, run };
      if (options.json) {
        return { code: 0, output: JSON.stringify(payload, null, 2), data: payload };
      }
      return {
        code: 0,
        output: `Workflow ${run.runId} -> ${run.status} (ledger rev ${run.ledgerRevision})${options.reason ? ` — ${options.reason}` : ''}`,
        data: payload,
      };
    } finally {
      await handle.close();
    }
  } catch (err) {
    return formatCliError(err, options.json);
  }
}

export async function workflowResumeCommand(
  runId: string,
  options: { detach?: boolean; workspace?: string; json?: boolean } = {},
): Promise<WorkflowCommandResult> {
  try {
    const wf = await import('../workflowRuntime.js');
    const handle = await wf.createCliWorkflowRuntime({
      workspaceRoot: options.workspace,
      autoAdvance: options.detach ? false : true,
    });
    try {
      const resolvedId = await wf.resolveWorkflowRunId(handle.runtime, runId);
      const resumed = await handle.runtime.resume(resolvedId, 'user:local', {
        wait: !options.detach,
      });
      const inspection = await handle.runtime.inspect(resolvedId);
      if (options.detach) {
        const payload = {
          ok: true,
          detached: true,
          runId: resumed.runId,
          status: resumed.status,
          ledgerRevision: resumed.ledgerRevision,
          run: resumed,
        };
        if (options.json) {
          return { code: 0, output: JSON.stringify(payload, null, 2), data: payload };
        }
        return {
          code: 0,
          output: `Workflow ${resumed.runId} resumed (detached) -> ${resumed.status} (ledger rev ${resumed.ledgerRevision})`,
          data: payload,
        };
      }

      const finalRun = inspection?.run ?? resumed;
      const hasFailure =
        finalRun.status === 'failed' ||
        Object.values(finalRun.targets).some((t) => t.status === 'failed' || t.status === 'blocked');
      const payload = {
        ok: !hasFailure,
        runId: finalRun.runId,
        status: finalRun.status,
        run: finalRun,
        plan: inspection?.plan,
        evidence: inspection?.evidence ?? [],
      };
      if (options.json) {
        return { code: hasFailure ? 1 : 0, output: JSON.stringify(payload, null, 2), data: payload };
      }
      if (inspection?.plan) {
        return {
          code: hasFailure ? 1 : 0,
          output: wf.formatWorkflowSummaryText({
            run: finalRun,
            plan: inspection.plan,
            evidence: inspection.evidence,
          }),
          data: payload,
        };
      }
      return {
        code: hasFailure ? 1 : 0,
        output: `Workflow ${finalRun.runId} -> ${finalRun.status} (ledger rev ${finalRun.ledgerRevision})`,
        data: payload,
      };
    } finally {
      await handle.close();
    }
  } catch (err) {
    return formatCliError(err, options.json);
  }
}

export async function tryResumeWorkflowRun(
  runId: string,
  options: { detach?: boolean; workspace?: string; json?: boolean } = {},
): Promise<{ handled: boolean; code: number; output: string; data?: unknown }> {
  const wf = await import('../workflowRuntime.js');
  const handle = await wf.createCliWorkflowRuntime({ workspaceRoot: options.workspace });
  let exists = false;
  try {
    const exact = await handle.runtime.getStatus(runId);
    if (exact) {
      exists = true;
    } else {
      const jobs = await handle.runtime.listJobs();
      const prefixMatches = jobs.filter((j) => j.runId.startsWith(runId));
      exists = prefixMatches.length === 1;
    }
  } finally {
    await handle.close();
  }
  if (!exists) {
    return { handled: false, code: 0, output: '' };
  }
  const res = await workflowResumeCommand(runId, options);
  return { handled: true, ...res };
}

export async function workflowApproveCommand(
  runId: string,
  targetId: string,
  options: { note?: string; detach?: boolean; workspace?: string; json?: boolean } = {},
): Promise<WorkflowCommandResult> {
  try {
    const wf = await import('../workflowRuntime.js');
    const handle = await wf.createCliWorkflowRuntime({ workspaceRoot: options.workspace });
    try {
      const resolvedId = await wf.resolveWorkflowRunId(handle.runtime, runId);
      const updated = await handle.runtime.approve(resolvedId, targetId, 'user:local', options.note);
      if (!options.detach) {
        await handle.runtime.controller.settled(resolvedId);
      }
      const inspection = await handle.runtime.inspect(resolvedId);
      const finalRun = inspection?.run ?? updated;
      const payload = {
        ok: true,
        runId: finalRun.runId,
        targetId,
        status: finalRun.status,
        targetStatus: finalRun.targets[targetId]?.status,
        run: finalRun,
        evidence: inspection?.evidence ?? [],
      };
      if (options.json) {
        return { code: 0, output: JSON.stringify(payload, null, 2), data: payload };
      }
      if (inspection?.plan) {
        return {
          code: 0,
          output: [
            `Approved ${targetId} in run ${finalRun.runId}${options.note ? ` (${options.note})` : ''}`,
            '',
            wf.formatWorkflowSummaryText({
              run: finalRun,
              plan: inspection.plan,
              evidence: inspection.evidence,
            }),
          ].join('\n'),
          data: payload,
        };
      }
      return {
        code: 0,
        output: `Approved ${targetId} in run ${finalRun.runId} -> run=${finalRun.status}, target=${finalRun.targets[targetId]?.status ?? 'updated'}`,
        data: payload,
      };
    } finally {
      await handle.close();
    }
  } catch (err) {
    return formatCliError(err, options.json);
  }
}

export function registerWorkflowCommands(program: Command): void {
  const hasTopLevel = (name: string) => program.commands.some((c) => c.name() === name);

  if (!hasTopLevel('loop')) {
    program
      .command('loop <task>')
      .description('Execute an iterative bounded Loop workflow with independent verification')
      .option('--workspace <dir>', 'Workspace root directory')
      .option('--max-iterations <n>', 'Maximum loop iterations', (v) => parseInt(v, 10))
      .option('--concurrency <n>', 'Maximum concurrent loop items', (v) => parseInt(v, 10))
      .option('--budget <usd>', 'Maximum hosted spend budget in USD', (v) => Number(v))
      .option('--duration <min>', 'Maximum duration in minutes', (v) => parseInt(v, 10))
      .option('--repairs <n>', 'Maximum repair attempts per target', (v) => parseInt(v, 10))
      .option('--model <id>', 'Preferred model ID')
      .option('--computer <id>', 'Preferred computer ID')
      .option('--items <items>', 'Comma-separated explicit loop items')
      .option('--until <predicate>', 'Completion predicate')
      .option('--verify <cmd...>', 'Independent verification command(s)')
      .option('--dry-run', 'Compile and print the plan without executing targets')
      .option('--detach', 'Start and persist run immediately without waiting for completion')
      .option('-j, --json', 'Output JSON')
      .option('--approve-all', 'Approve policy gates automatically for this operator invocation')
      .action(async (task: string, opts) => {
        const res = await loopCommand(task, opts);
        console.log(res.output);
        if (res.code !== 0) process.exitCode = res.code;
      });
  }

  if (!hasTopLevel('graph')) {
    program
      .command('graph <goal>')
      .description('Compile and execute a dependency-ordered DAG Graph workflow')
      .option('--workspace <dir>', 'Workspace root directory')
      .option('--concurrency <n>', 'Maximum concurrent targets', (v) => parseInt(v, 10))
      .option('--budget <usd>', 'Maximum hosted spend budget in USD', (v) => Number(v))
      .option('--duration <min>', 'Maximum duration in minutes', (v) => parseInt(v, 10))
      .option('--repairs <n>', 'Maximum repair attempts per target', (v) => parseInt(v, 10))
      .option('--model <id>', 'Preferred model ID')
      .option('--computer <id>', 'Preferred computer ID')
      .option('--verify <cmd...>', 'Independent verification command(s)')
      .option('--dry-run', 'Compile and print the plan without executing targets')
      .option('--detach', 'Start and persist run immediately without waiting for completion')
      .option('-j, --json', 'Output JSON')
      .option('--approve-all', 'Approve policy gates automatically for this operator invocation')
      .action(async (goal: string, opts) => {
        const res = await graphCommand(goal, opts);
        console.log(res.output);
        if (res.code !== 0) process.exitCode = res.code;
      });
  }

  if (!hasTopLevel('inspect')) {
    program
      .command('inspect <runId>')
      .description('Inspect a workflow run, DAG critical path, loop cursor/items, blockers, and evidence')
      .option('--workspace <dir>', 'Workspace root directory')
      .option('-j, --json', 'Output JSON')
      .action(async (runId: string, opts) => {
        const res = await workflowInspectCommand(runId, opts);
        console.log(res.output);
        if (res.code !== 0) process.exitCode = res.code;
      });
  }

  if (!hasTopLevel('pause')) {
    program
      .command('pause <runId>')
      .description('Pause an active workflow run cleanly in the shared store')
      .option('--reason <text>', 'Reason for pausing')
      .option('--workspace <dir>', 'Workspace root directory')
      .option('-j, --json', 'Output JSON')
      .action(async (runId: string, opts) => {
        const res = await workflowPauseCommand(runId, opts);
        console.log(res.output);
        if (res.code !== 0) process.exitCode = res.code;
      });
  }

  if (!hasTopLevel('stop')) {
    program
      .command('stop <runId>')
      .description('Stop a workflow run cleanly in the shared store')
      .option('--reason <text>', 'Reason for stopping')
      .option('--workspace <dir>', 'Workspace root directory')
      .option('-j, --json', 'Output JSON')
      .action(async (runId: string, opts) => {
        const res = await workflowStopCommand(runId, opts);
        console.log(res.output);
        if (res.code !== 0) process.exitCode = res.code;
      });
  }

  if (!hasTopLevel('approve')) {
    program
      .command('approve <runId> <targetId>')
      .description('Grant explicit human approval for a pending workflow approval gate')
      .option('--note <text>', 'Approval note or rationale')
      .option('--detach', 'Record approval without waiting for the resumed target to settle')
      .option('--workspace <dir>', 'Workspace root directory')
      .option('-j, --json', 'Output JSON')
      .action(async (runId: string, targetId: string, opts) => {
        const res = await workflowApproveCommand(runId, targetId, opts);
        console.log(res.output);
        if (res.code !== 0) process.exitCode = res.code;
      });
  }

  // Fallback registration when registerWorkflowCommands is mounted standalone without index.ts
  if (!hasTopLevel('jobs')) {
    program
      .command('jobs')
      .description('List persistent workflow runs from the shared runtime store')
      .option('--status <status>', 'Filter by status')
      .option('--mode <mode>', 'Filter by mode (single|loop|graph|hybrid)')
      .option('--workspace <dir>', 'Workspace root directory')
      .option('-j, --json', 'Output JSON')
      .action(async (opts) => {
        const res = await workflowJobsCommand(opts);
        console.log(res.output);
        if (res.code !== 0) process.exitCode = res.code;
      });
  }

  if (!hasTopLevel('resume')) {
    program
      .command('resume <runId>')
      .description('Resume a paused workflow run cleanly from checkpoint')
      .option('--detach', 'Resume without waiting for completion')
      .option('--workspace <dir>', 'Workspace root directory')
      .option('-j, --json', 'Output JSON')
      .action(async (runId: string, opts) => {
        const res = await workflowResumeCommand(runId, opts);
        console.log(res.output);
        if (res.code !== 0) process.exitCode = res.code;
      });
  }
}
