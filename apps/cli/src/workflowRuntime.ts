import fs from 'node:fs';
import path from 'node:path';
import type { KeyValueStore } from '@wazir/shared';
import {
  createWorkflowRuntimeService,
  type CheckRunner,
  type EvidenceRecord,
  type GoalGraphRevisionRecord,
  type GoalRunLedger,
  type GoalRunStatus,
  type RequestedWorkflowMode,
  type WorkflowCompileRequest,
  type WorkflowInspection,
  type WorkflowJobSummary,
  type WorkflowMode,
  type WorkflowOriginInterface,
  type WorkflowPlanRecord,
  type WorkflowRuntimeService,
  type WorkflowTargetHandler,
} from '@wazir/goals';
import { color } from './colors.js';
import { createStore } from './engine.js';
import { table } from './commands/table.js';

export interface CreateCliWorkflowRuntimeOptions {
  workspaceRoot?: string;
  store?: KeyValueStore;
  defaultModel?: string;
  defaultComputer?: string;
  holderId?: string;
  leaseTtlMs?: number;
  autoAdvance?: boolean;
  checkRunner?: CheckRunner;
  targetHandler?: WorkflowTargetHandler;
  modelExecutor?: WorkflowTargetHandler;
}

export interface CliWorkflowRuntimeHandle {
  store: KeyValueStore;
  runtime: WorkflowRuntimeService;
  workspaceRoot: string;
  close: () => Promise<void>;
}

export async function createCliWorkflowRuntime(
  options: CreateCliWorkflowRuntimeOptions = {},
): Promise<CliWorkflowRuntimeHandle> {
  const workspaceRoot = path.resolve(
    options.workspaceRoot ?? process.env.WAZIR_WORKSPACE_DIR ?? process.cwd(),
  );
  const store = options.store ?? (await createStore());
  const runtime = createWorkflowRuntimeService({
    store,
    workspaceRoot,
    defaultModel: options.defaultModel,
    defaultComputer: options.defaultComputer,
    holderId: options.holderId,
    leaseTtlMs: options.leaseTtlMs,
    autoAdvance: options.autoAdvance,
    checkRunner: options.checkRunner,
    targetHandler: options.targetHandler,
    modelExecutor: options.modelExecutor,
  });
  return {
    store,
    runtime,
    workspaceRoot,
    close: async () => {
      await runtime.shutdown({ releaseLeases: true });
    },
  };
}

export function assertValidWorkspaceDir(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Workspace directory does not exist: ${resolved}`);
  }
  return resolved;
}

export async function resolveWorkflowRunId(
  runtime: WorkflowRuntimeService,
  rawRunId: string,
): Promise<string> {
  const trimmed = rawRunId.trim();
  if (!trimmed) {
    throw new Error('Run ID is required');
  }
  const exact = await runtime.getStatus(trimmed);
  if (exact) return exact.runId;

  const jobs = await runtime.listJobs();
  const matches = jobs.filter((j) => j.runId.startsWith(trimmed));
  if (matches.length === 1) {
    return matches[0]!.runId;
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous run ID prefix '${trimmed}'; matches: ${matches.map((m) => m.runId).join(', ')}`,
    );
  }
  throw new Error(`Workflow run '${trimmed}' not found`);
}

export async function settlePendingApprovalsIfApprovedAll(
  runtime: WorkflowRuntimeService,
  runId: string,
  actor = 'user:local',
): Promise<{ run: GoalRunLedger; evidence: EvidenceRecord[] }> {
  let current = await runtime.ledger.getRun(runId);
  for (let pass = 0; pass < 16; pass += 1) {
    if (!current) break;
    const pendingTargets = Object.values(current.targets).filter(
      (t) => t.status === 'needs_approval',
    );
    if (pendingTargets.length === 0) break;
    for (const target of pendingTargets) {
      await runtime.approve(
        runId,
        target.targetId,
        actor,
        'Auto-approved via --approve-all',
      );
    }
    await runtime.controller.settled(runId);
    current = await runtime.ledger.getRun(runId);
    if (current && (current.status === 'completed' || current.status === 'stopped' || current.status === 'failed')) {
      break;
    }
  }
  const finalRun = (await runtime.ledger.getRun(runId)) ?? current!;
  const inspection = await runtime.inspect(runId);
  return { run: finalRun, evidence: inspection?.evidence ?? [] };
}

export interface ParsedShellWorkflowArgs {
  prompt: string;
  positionals: string[];
  workspace?: string;
  mode?: RequestedWorkflowMode;
  maxIterations?: number;
  concurrency?: number;
  budget?: number;
  duration?: number;
  repairs?: number;
  model?: string;
  computer?: string;
  items?: string[];
  until?: string;
  verify: string[];
  dryRun: boolean;
  detach: boolean;
  json: boolean;
  approveAll: boolean;
  status?: string;
  reason?: string;
  note?: string;
  background: boolean;
  help: boolean;
}

const VALID_MODES: ReadonlySet<string> = new Set(['auto', 'single', 'loop', 'graph', 'hybrid']);

export function tokenizeShellArgs(raw: string): { tokens: string[]; background: boolean } {
  const input = raw.trim();
  if (!input) return { tokens: [], background: false };

  const tokens: string[] = [];
  let current = '';
  let hasToken = false;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let lastAmpersandTokenIndex = -1;

  const pushCurrent = () => {
    if (hasToken) {
      tokens.push(current);
      current = '';
      hasToken = false;
    }
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (escaped) {
      current += ch;
      hasToken = true;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      hasToken = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      hasToken = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }
    if (ch === '&' && i === input.length - 1) {
      pushCurrent();
      lastAmpersandTokenIndex = tokens.length;
      tokens.push('&');
      continue;
    }
    current += ch;
    hasToken = true;
  }

  if (quote) {
    throw new Error(`Unclosed ${quote} quote in command arguments`);
  }
  pushCurrent();

  let background = false;
  if (lastAmpersandTokenIndex === tokens.length - 1 && tokens[tokens.length - 1] === '&') {
    tokens.pop();
    background = true;
  }
  return { tokens, background };
}

function parseFiniteNumberFlag(flag: string, value: string | undefined): number {
  if (value === undefined) {
    throw new Error(`Flag ${flag} requires a numeric value`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric value for ${flag}: '${value}'`);
  }
  return n;
}

function requireStringFlag(flag: string, value: string | undefined): string {
  if (value === undefined || !value.trim()) {
    throw new Error(`Flag ${flag} requires a value`);
  }
  return value;
}

export function parseShellWorkflowArgs(rawArgs: string): ParsedShellWorkflowArgs {
  const { tokens, background } = tokenizeShellArgs(rawArgs);
  const parsed: ParsedShellWorkflowArgs = {
    prompt: '',
    positionals: [],
    verify: [],
    dryRun: false,
    detach: false,
    json: false,
    approveAll: false,
    background,
    help: false,
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const rawTok = tokens[i]!;
    if (rawTok === '--') {
      parsed.positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (!rawTok.startsWith('-') || rawTok === '-') {
      parsed.positionals.push(rawTok);
      continue;
    }

    let flag = rawTok;
    let inlineVal: string | undefined;
    const eqIdx = rawTok.indexOf('=');
    if (eqIdx > 0) {
      flag = rawTok.slice(0, eqIdx);
      inlineVal = rawTok.slice(eqIdx + 1);
    }

    const takeValue = (): string | undefined => {
      if (inlineVal !== undefined) return inlineVal;
      if (i + 1 < tokens.length) {
        i += 1;
        return tokens[i];
      }
      return undefined;
    };

    switch (flag) {
      case '-h':
      case '--help':
        parsed.help = true;
        break;
      case '-j':
      case '--json':
        parsed.json = true;
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--detach':
        parsed.detach = true;
        break;
      case '--approve-all':
        parsed.approveAll = true;
        break;
      case '-C':
      case '-w':
      case '--workspace':
      case '--cwd':
        parsed.workspace = requireStringFlag(flag, takeValue());
        break;
      case '--mode': {
        const modeVal = requireStringFlag(flag, takeValue()).toLowerCase();
        if (!VALID_MODES.has(modeVal)) {
          throw new Error(
            `Invalid --mode '${modeVal}'. Expected one of: auto, single, loop, graph, hybrid`,
          );
        }
        parsed.mode = modeVal as RequestedWorkflowMode;
        break;
      }
      case '--max-iterations':
        parsed.maxIterations = Math.max(1, Math.floor(parseFiniteNumberFlag(flag, takeValue())));
        break;
      case '-c':
      case '--concurrency':
        parsed.concurrency = Math.max(1, Math.floor(parseFiniteNumberFlag(flag, takeValue())));
        break;
      case '--budget':
        parsed.budget = Math.max(0, parseFiniteNumberFlag(flag, takeValue()));
        break;
      case '--duration':
        parsed.duration = Math.max(1, Math.floor(parseFiniteNumberFlag(flag, takeValue())));
        break;
      case '--repairs':
        parsed.repairs = Math.max(0, Math.floor(parseFiniteNumberFlag(flag, takeValue())));
        break;
      case '-m':
      case '--model':
        parsed.model = requireStringFlag(flag, takeValue());
        break;
      case '--computer':
        parsed.computer = requireStringFlag(flag, takeValue());
        break;
      case '--items': {
        const val = requireStringFlag(flag, takeValue());
        const splitItems = val
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        parsed.items = [...(parsed.items ?? []), ...splitItems];
        break;
      }
      case '--until':
        parsed.until = requireStringFlag(flag, takeValue());
        break;
      case '--verify': {
        const firstCmd = requireStringFlag(flag, takeValue());
        parsed.verify.push(firstCmd);
        // Support `--verify cmd1 cmd2` when multiple non-flag args follow in CLI/shell style
        // only when followed by another token and prompt was already collected, or rely on repeated --verify.
        break;
      }
      case '-s':
      case '--status':
        parsed.status = requireStringFlag(flag, takeValue());
        break;
      case '--reason':
        parsed.reason = requireStringFlag(flag, takeValue());
        break;
      case '--note':
        parsed.note = requireStringFlag(flag, takeValue());
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  parsed.prompt = parsed.positionals.join(' ').trim();
  return parsed;
}

export function buildCompileRequestFromParsed(
  parsed: ParsedShellWorkflowArgs,
  defaults: {
    originInterface: WorkflowOriginInterface;
    workspaceRoot: string;
    requestedMode?: RequestedWorkflowMode;
    overrideMode?: WorkflowMode;
    actor?: string;
  },
): WorkflowCompileRequest {
  const effectiveMode = parsed.mode ?? defaults.requestedMode ?? 'auto';
  const effectiveOverride =
    defaults.overrideMode ??
    (parsed.mode && parsed.mode !== 'auto' ? parsed.mode : undefined);

  return {
    prompt: parsed.prompt,
    requestedMode: effectiveMode,
    overrideMode: effectiveOverride,
    originInterface: defaults.originInterface,
    workspaceRoot: defaults.workspaceRoot,
    actor: defaults.actor ?? 'user:local',
    maxIterations: parsed.maxIterations,
    maxConcurrency: parsed.concurrency,
    maxBudgetUsd: parsed.budget,
    maxDurationMinutes: parsed.duration,
    maxRepairsPerTask: parsed.repairs,
    preferredModel: parsed.model,
    computer: parsed.computer,
    items: parsed.items,
    completionCondition: parsed.until,
    verifyCommands: parsed.verify.length > 0 ? parsed.verify : undefined,
    dryRun: parsed.dryRun,
    approveAll: parsed.approveAll,
  };
}

export function modeBadge(mode: WorkflowMode): string {
  return `[${mode.toUpperCase()}]`;
}

export function formatWorkflowPlanText(
  plan: WorkflowPlanRecord,
  graph?: GoalGraphRevisionRecord,
): string {
  const lines: string[] = [];
  const badge = modeBadge(plan.mode);
  lines.push(
    color.bold(`${badge} Workflow Plan${plan.dryRun ? ' (DRY RUN)' : ''}`),
  );
  if (plan.runId) lines.push(`  runId:         ${plan.runId}`);
  lines.push(`  graph:         ${plan.graphId}@${plan.graphRevision}`);
  lines.push(
    `  mode:          ${plan.mode} (requested: ${plan.requestedMode}${plan.overridden ? ', overridden' : ''}, confidence: ${(plan.explanation.confidence * 100).toFixed(0)}%)`,
  );
  lines.push(`  origin:        ${plan.originInterface}`);
  lines.push(`  workspace:     ${plan.workspaceRoot}`);
  if (plan.preferredModel) lines.push(`  model:         ${plan.preferredModel}`);
  if (plan.preferredComputer) lines.push(`  computer:      ${plan.preferredComputer}`);
  lines.push(`  localFirst:    ${plan.localModelFirst ? 'yes' : 'no'}`);
  if (plan.criticalPath.targets.length > 0) {
    lines.push(
      `  criticalPath:  ${plan.criticalPath.targets.join(' -> ')} (depth ${plan.criticalPath.depth})`,
    );
  }
  if (plan.explanation.reasons.length > 0) {
    lines.push('');
    lines.push(color.bold('Mode Decision Rationale:'));
    for (const reason of plan.explanation.reasons) {
      lines.push(`  - ${reason}`);
    }
  }
  if (plan.explanation.policyAssessment.requiresApprovalGates.length > 0) {
    lines.push('');
    lines.push(color.yellow('Approval Gates:'));
    for (const gate of plan.explanation.policyAssessment.requiresApprovalGates) {
      lines.push(`  - ${gate}`);
    }
  }
  if (plan.loop) {
    lines.push('');
    lines.push(
      color.bold(
        `Loop Plan (${plan.loop.kind}, cursor ${plan.loop.cursor}/${plan.loop.items.length}, maxIter=${plan.loop.maxIterations}, concurrency=${plan.loop.maxConcurrency}):`,
      ),
    );
    if (plan.loop.collectionSource) {
      lines.push(`  source:        ${plan.loop.collectionSource}`);
    }
    lines.push(`  until:         ${plan.loop.completionPredicate}`);
    for (const item of plan.loop.items) {
      lines.push(
        `  [${item.index + 1}/${plan.loop.items.length}] ${item.targetId} (${item.kind}): ${item.label}${item.path ? ` (${item.path})` : ''}`,
      );
    }
  }
  if (plan.verifyCommands.length > 0) {
    lines.push('');
    lines.push(color.bold('Verification Commands:'));
    for (const cmd of plan.verifyCommands) {
      lines.push(`  - ${cmd}`);
    }
  }
  if (graph && graph.definition.targets.length > 0) {
    lines.push('');
    lines.push(
      table(
        ['TARGET', 'STAGE', 'DEPENDS ON', 'APPROVAL', 'TITLE'],
        graph.definition.targets.map((t) => [
          t.id,
          t.stage,
          t.dependsOn.join(',') || '-',
          t.requiresApproval ? 'yes' : 'no',
          t.title.slice(0, 64),
        ]),
      ),
    );
  }
  return lines.join('\n');
}

export function formatWorkflowSummaryText(result: {
  run: GoalRunLedger;
  plan: WorkflowPlanRecord;
  evidence?: EvidenceRecord[];
  interrupted?: boolean;
}): string {
  const { run, plan, evidence = [], interrupted } = result;
  if (plan.dryRun) {
    return formatWorkflowPlanText(plan);
  }

  const badge = modeBadge(plan.mode);
  const targets = Object.values(run.targets);
  const completedCount = targets.filter((t) => t.status === 'completed').length;
  const blockedCount = targets.filter((t) => t.status === 'blocked').length;
  const failedCount = targets.filter((t) => t.status === 'failed').length;
  const approvalTargets = targets.filter((t) => t.status === 'needs_approval');

  const lines: string[] = [];
  lines.push(
    color.bold(
      `${badge} Run ${run.runId} -> ${run.status}${interrupted ? ' (interrupted)' : ''}`,
    ),
  );
  lines.push(`  graph:      ${run.graphId}@${run.graphRevision}`);
  lines.push(`  origin:     ${plan.originInterface}`);
  lines.push(`  workspace:  ${plan.workspaceRoot}`);
  lines.push(`  progress:   ${completedCount}/${targets.length} completed`);
  if (plan.loop) {
    lines.push(`  cursor:     ${plan.loop.cursor}/${plan.loop.items.length}`);
  }
  if (plan.criticalPath.targets.length > 0) {
    lines.push(`  critical:   ${plan.criticalPath.targets.join(' -> ')}`);
  }
  if (blockedCount > 0) lines.push(color.red(`  blocked:    ${blockedCount}`));
  if (failedCount > 0) lines.push(color.red(`  failed:     ${failedCount}`));
  if (plan.explanation.reasons.length > 0) {
    lines.push(`  rationale:  ${plan.explanation.reasons.join(' ')}`);
  }

  if (targets.length > 0) {
    lines.push('');
    lines.push(
      table(
        ['TARGET', 'STATUS', 'ATTEMPTS', 'REPAIRS', 'EVIDENCE', 'BLOCKERS'],
        targets.map((t) => [
          t.targetId,
          t.status,
          String(t.attempts),
          String(t.repairs),
          String(t.evidenceIds.length),
          t.blockers.join('; ') || '-',
        ]),
      ),
    );
  }

  const passEv = evidence.filter((e) => e.verdict === 'PASS').length;
  const failEv = evidence.filter((e) => e.verdict === 'FAIL').length;
  const otherEv = evidence.length - passEv - failEv;
  lines.push('');
  lines.push(
    color.bold(
      `Verification Evidence: ${evidence.length} record(s) (PASS=${passEv}, FAIL=${failEv}, OTHER=${otherEv})`,
    ),
  );
  for (const ev of evidence.slice(0, 12)) {
    const cmdOrExcerpt = ev.command ? `${ev.command} (exit ${ev.exitCode ?? '-'})` : ev.outputExcerpt ?? '-';
    lines.push(
      `  [${ev.verdict}] ${ev.targetId} (${ev.validationMethod} by ${ev.validatorIdentity}): ${cmdOrExcerpt.split('\n')[0]!.slice(0, 100)}`,
    );
  }
  if (evidence.length > 12) {
    lines.push(`  ... (${evidence.length - 12} more evidence records; run 'wa inspect ${run.runId}')`);
  }

  if (approvalTargets.length > 0) {
    lines.push('');
    lines.push(color.yellow('Pending Human Approvals:'));
    for (const t of approvalTargets) {
      lines.push(`  - ${t.targetId}: run \`wa approve ${run.runId} ${t.targetId}\``);
    }
  }

  return lines.join('\n');
}

export function formatJobsTable(jobs: WorkflowJobSummary[]): string {
  if (jobs.length === 0) {
    return 'No workflow runs recorded.';
  }
  return table(
    ['RUN ID', 'MODE', 'STATUS', 'ORIGIN', 'PROGRESS', 'CURSOR', 'UPDATED', 'PROMPT'],
    jobs.map((j) => [
      j.runId,
      j.mode,
      j.status,
      j.originInterface,
      `${j.progress.completed}/${j.progress.total}${j.progress.needsApproval ? ` (approval:${j.progress.needsApproval})` : ''}`,
      j.progress.cursor !== undefined ? String(j.progress.cursor) : '-',
      j.updatedAt.replace('T', ' ').slice(0, 19),
      j.prompt.slice(0, 48),
    ]),
  );
}

export function formatWorkflowStatusText(
  summary: WorkflowJobSummary,
  inspection?: WorkflowInspection,
): string {
  const lines = [
    color.bold(`${modeBadge(summary.mode)} ${summary.runId}`),
    `  status:    ${summary.status}`,
    `  graph:     ${summary.graphId}@${summary.graphRevision}`,
    `  origin:    ${summary.originInterface}`,
    `  progress:  ${summary.progress.completed}/${summary.progress.total} completed (active=${summary.progress.active}, queued=${summary.progress.queued}, blocked=${summary.progress.blocked}, failed=${summary.progress.failed}, needsApproval=${summary.progress.needsApproval})`,
    ...(summary.progress.cursor !== undefined ? [`  cursor:    ${summary.progress.cursor}`] : []),
    `  updated:   ${summary.updatedAt}`,
    `  prompt:    ${summary.prompt}`,
  ];
  if (inspection) {
    const targets = Object.values(inspection.run.targets);
    if (targets.length > 0) {
      lines.push('');
      lines.push(
        table(
          ['TARGET', 'STATUS', 'ATTEMPTS', 'REPAIRS', 'BLOCKERS'],
          targets.map((t) => [
            t.targetId,
            t.status,
            String(t.attempts),
            String(t.repairs),
            t.blockers.join('; ') || '-',
          ]),
        ),
      );
    }
  }
  return lines.join('\n');
}

export function formatInspectionReport(inspection: WorkflowInspection): string {
  const { summary, run, graph, plan, targets, evidence, events } = inspection;
  const lines: string[] = [];
  lines.push(color.bold(`${modeBadge(summary.mode)} Workflow Inspection: ${run.runId}`));
  lines.push(`  status:      ${run.status}`);
  lines.push(`  graph:       ${graph.graphId}@${graph.revision} (${graph.digest.slice(0, 16)}...)`);
  lines.push(`  mode:        ${summary.mode}${plan ? ` (requested: ${plan.requestedMode}${plan.overridden ? ', overridden' : ''})` : ''}`);
  lines.push(`  origin:      ${summary.originInterface}`);
  lines.push(`  workspace:   ${plan?.workspaceRoot ?? '-'}`);
  lines.push(`  createdBy:   ${run.createdBy}`);
  lines.push(`  createdAt:   ${run.createdAt}`);
  lines.push(`  updatedAt:   ${run.updatedAt}`);
  lines.push(
    `  progress:    ${summary.progress.completed}/${summary.progress.total} completed, ${summary.progress.active} active, ${summary.progress.blocked} blocked, ${summary.progress.failed} failed, ${summary.progress.needsApproval} needsApproval`,
  );

  if (plan?.criticalPath?.targets.length) {
    lines.push(
      `  criticalPath: ${plan.criticalPath.targets.join(' -> ')} (depth ${plan.criticalPath.depth})`,
    );
  }
  if (plan?.explanation.reasons.length) {
    lines.push('');
    lines.push(color.bold('Mode Explanation:'));
    for (const r of plan.explanation.reasons) {
      lines.push(`  - ${r}`);
    }
  }

  if (plan?.loop) {
    lines.push('');
    lines.push(
      color.bold(
        `Loop Cursor & Items (${plan.loop.cursor}/${plan.loop.items.length}, kind=${plan.loop.kind}):`,
      ),
    );
    lines.push(`  predicate: ${plan.loop.completionPredicate}`);
    lines.push(
      table(
        ['#', 'TARGET', 'KIND', 'STATUS', 'LABEL', 'PATH'],
        plan.loop.items.map((item) => [
          String(item.index + 1),
          item.targetId,
          item.kind,
          run.targets[item.targetId]?.status ?? 'unknown',
          item.label,
          item.path ?? '-',
        ]),
      ),
    );
  }

  lines.push('');
  lines.push(color.bold('Targets & Acceptance Criteria:'));
  lines.push(
    table(
      ['TARGET', 'STAGE', 'STATUS', 'ATTEMPTS', 'REPAIRS', 'ACCEPTANCE', 'BLOCKERS'],
      targets.map((t) => {
        const entry = run.targets[t.id];
        return [
          t.id,
          t.stage,
          entry?.status ?? 'queued',
          String(entry?.attempts ?? 0),
          String(entry?.repairs ?? 0),
          t.acceptance.join('; ') || '-',
          (entry?.blockers ?? []).join('; ') || '-',
        ];
      }),
    ),
  );

  lines.push('');
  lines.push(color.bold(`Evidence (${evidence.length}):`));
  if (evidence.length === 0) {
    lines.push('  No evidence recorded yet.');
  } else {
    lines.push(
      table(
        ['EVIDENCE ID', 'TARGET', 'METHOD', 'VERDICT', 'VALIDATOR', 'DETAIL'],
        evidence.map((e) => [
          e.id,
          e.targetId,
          e.validationMethod,
          e.verdict,
          e.validatorIdentity,
          (e.command ?? e.outputExcerpt ?? '-').split('\n')[0]!.slice(0, 64),
        ]),
      ),
    );
  }

  if (events.length > 0) {
    lines.push('');
    lines.push(color.bold(`Recent Events (showing last ${Math.min(10, events.length)} of ${events.length}):`));
    for (const ev of events.slice(-10)) {
      lines.push(
        `  #${ev.seq} ${ev.timestamp.replace('T', ' ').slice(0, 19)} ${ev.type}${ev.targetId ? ` [${ev.targetId}]` : ''}`,
      );
    }
  }

  return lines.join('\n');
}

export function normalizeRunStatusFilter(raw?: string): GoalRunStatus | undefined {
  if (!raw) return undefined;
  const val = raw.trim().toLowerCase();
  const valid: ReadonlySet<string> = new Set([
    'created',
    'running',
    'pausing',
    'paused',
    'stopping',
    'stopped',
    'idle',
    'completed',
    'failed',
  ]);
  if (!valid.has(val)) {
    throw new Error(`Invalid workflow run status '${raw}'`);
  }
  return val as GoalRunStatus;
}

export function normalizeWorkflowModeFilter(raw?: string): WorkflowMode | undefined {
  if (!raw) return undefined;
  const val = raw.trim().toLowerCase();
  if (!new Set(['single', 'loop', 'graph', 'hybrid']).has(val)) {
    throw new Error(`Invalid workflow mode '${raw}'`);
  }
  return val as WorkflowMode;
}
