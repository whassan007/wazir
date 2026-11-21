/**
 * Modular Goal Studio TUI Panel, Keyboard Shortcut Discoverability, & Immediate Command Feedback.
 *
 * Extracted from FleetTui / FleetTuiPanes to keep the TUI controller modular while providing:
 * 1. Goal Studio phase indicator and target dependency status presenter (aligned with `@wazir/goals` contracts).
 * 2. Discoverable keyboard shortcut catalog and compact footer/header hints (`?`, `/goals`, `/status`, `7`/`g`).
 * 3. Immediate visible command feedback presenter for all slash commands and unknown commands.
 */

import type {
  GoalPhase,
  GoalRunStatus,
  TargetStatus,
  GoalRunLedger,
  GoalGraphDefinition,
  TargetLedgerEntry,
  WorkflowInspection,
  WorkflowJobSummary,
  WorkflowMode,
  WorkflowPlanRecord,
} from '@wazir/goals';
import { color } from '../colors.js';
import { padRightAnsi, stripAnsiStr, truncateAnsiStr } from './fleetTuiTypes.js';

export const GOAL_PRIMARY_LIFECYCLE_PHASES: readonly GoalPhase[] = [
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
  'PERSIST_STATE',
] as const;

export const GOAL_RECOVERY_PHASES: readonly GoalPhase[] = [
  'DIAGNOSE',
  'REPAIR_HYPOTHESIS',
  'REPLAN',
  'RETEST',
  'BLOCK_TARGET',
  'RECORD_EVIDENCE',
  'AWAIT_APPROVAL',
] as const;

export interface KeyboardShortcutEntry {
  readonly key: string;
  readonly command?: string;
  readonly category: 'Navigation' | 'Goal Studio' | 'Approvals & Recovery' | 'Workspace & Telemetry';
  readonly description: string;
}

export const TUI_KEYBOARD_SHORTCUTS: readonly KeyboardShortcutEntry[] = [
  { key: '1 / F3', command: '/fleet', category: 'Navigation', description: 'Open Mission Control & Fleet Overview' },
  { key: '2 / F4', command: '/improvement', category: 'Navigation', description: 'Open Self-Improvement & Canary Experiments' },
  { key: '3 / F2', command: '/search', category: 'Navigation', description: 'Open Solution Search & MCTS Tree' },
  { key: '4 / F5', command: '/context', category: 'Navigation', description: 'Open Context Utilization & Compaction' },
  { key: '5', command: '/models', category: 'Navigation', description: 'Open Models & Providers Intelligence' },
  { key: '6 / F6', command: '/evidence', category: 'Navigation', description: 'Open Verification Evidence & Provenance' },
  { key: '7 / g', command: '/goals', category: 'Goal Studio', description: 'Open Goal Studio DAG, Phase & Target Ledger' },
  { key: 'Tab / Shift+Tab', category: 'Navigation', description: 'Cycle primary operational panes (Fleet, Tail, Approval, Worktrees, Goals)' },
  { key: '[ / ]', category: 'Navigation', description: 'Cycle active tasks or pending policy approvals' },
  { key: '?', command: '/help', category: 'Navigation', description: 'Toggle keyboard shortcut & command reference' },
  { key: 'Ctrl+P', category: 'Navigation', description: 'Open Quick Actions command palette' },
  { key: 'Ctrl+R / Ctrl+L', command: '/repaint', category: 'Workspace & Telemetry', description: 'Refresh fleet state / Force full screen repaint' },
  { key: '!', command: '/sh <cmd>', category: 'Workspace & Telemetry', description: 'Execute inline workspace shell command as @block' },
  { key: 'A / D / V / I', category: 'Approvals & Recovery', description: 'Approve / Deny / View Details / Snooze policy ask' },
  { key: 'q / Ctrl+C', command: '/exit', category: 'Navigation', description: 'Cleanly exit TUI and restore terminal state' },
] as const;

export function formatShortcutFooterHint(width: number): string {
  const full = ' 1 Home   Tab Views   5 Models   6 Evidence   7/g Goals   [ / ] Tasks   /status   ? Help';
  const compact = ' 1 Home · Tab Views · 7/g Goals · /status · ? Help';
  const chosen = width >= 88 ? full : compact;
  return color.gray(stripAnsiStr(chosen).length > width ? truncateAnsiStr(chosen, width) : chosen);
}

export function formatGoalPhaseIndicator(currentPhase?: GoalPhase, width = 80): string {
  const activePhase: GoalPhase = currentPhase ?? 'LOAD_LEDGER';
  const isRecovery = (GOAL_RECOVERY_PHASES as readonly string[]).includes(activePhase);

  const compactSteps: Array<{ label: string; phases: readonly GoalPhase[] }> = [
    { label: 'LEDGER', phases: ['LOAD_LEDGER', 'SELECT_TARGET', 'SELECT_NEXT_TARGET'] },
    { label: 'PLAN', phases: ['PLAN_TASK', 'PREFLIGHT', 'ROUTE_MODEL'] },
    { label: 'EXECUTE', phases: ['EXECUTE'] },
    { label: 'CHALLENGE', phases: ['CHALLENGE'] },
    { label: 'VERIFY', phases: ['INDEPENDENT_VERIFY', 'ACCEPTANCE_GATE'] },
    { label: 'COMMIT', phases: ['COMMIT_PROGRESS', 'UNLOCK_DEPENDENCIES', 'PERSIST_STATE'] },
  ];

  const renderedSteps = compactSteps.map((step) => {
    const isCurrent = step.phases.includes(activePhase);
    if (isCurrent) {
      return color.bold(color.cyan(`[● ${step.label}]`));
    }
    return color.gray(`[○ ${step.label}]`);
  });

  const chain = renderedSteps.join(color.gray('→'));
  const phaseTag = isRecovery
    ? color.bold(color.yellow(` ⚠ RECOVERY:${activePhase}`))
    : color.cyan(` (${activePhase})`);

  const line = `  Phase: ${chain}${phaseTag}`;
  return stripAnsiStr(line).length > width ? truncateAnsiStr(line, width) : line;
}

export function formatTargetStatusBadge(status: TargetStatus): string {
  switch (status) {
    case 'completed':
      return color.green('[COMPLETED ✓ unlocks deps]');
    case 'verified':
      return color.cyan('[VERIFIED · awaiting gate/commit]');
    case 'verifying':
      return color.cyan('[VERIFYING]');
    case 'active':
      return color.bold(color.cyan('[ACTIVE]'));
    case 'eligible':
      return color.blue('[ELIGIBLE]');
    case 'queued':
      return color.gray('[QUEUED]');
    case 'repairing':
      return color.yellow('[REPAIRING]');
    case 'needs_approval':
      return color.bold(color.yellow('[NEEDS APPROVAL]'));
    case 'awaiting_external':
      return color.yellow('[AWAITING EXTERNAL]');
    case 'blocked':
      return color.red('[BLOCKED]');
    case 'failed':
      return color.bold(color.red('[FAILED]'));
    case 'stopped':
      return color.gray('[STOPPED]');
    default:
      return color.gray(`[${String(status).toUpperCase()}]`);
  }
}

export function formatGoalRunStatusBadge(status: GoalRunStatus): string {
  switch (status) {
    case 'running':
      return color.bold(color.cyan('RUNNING'));
    case 'completed':
      return color.bold(color.green('COMPLETED'));
    case 'paused':
    case 'pausing':
      return color.yellow(status.toUpperCase());
    case 'failed':
      return color.bold(color.red('FAILED'));
    case 'stopped':
    case 'stopping':
      return color.gray(status.toUpperCase());
    default:
      return color.blue(status.toUpperCase());
  }
}

export interface GoalStudioSnapshot {
  readonly run?: GoalRunLedger;
  readonly graph?: GoalGraphDefinition;
  readonly activePhase?: GoalPhase;
  readonly selectedTargetIndex?: number;
  readonly plan?: WorkflowPlanRecord;
  readonly summary?: WorkflowJobSummary;
  readonly jobs?: readonly WorkflowJobSummary[];
  readonly inspection?: WorkflowInspection;
}

export function formatWorkflowModeBadge(mode: WorkflowMode | 'goal', requestedMode?: string): string {
  const badgeFor = (m: WorkflowMode | 'goal'): string => {
    switch (m) {
      case 'loop':
        return color.bold(color.cyan('[LOOP]'));
      case 'graph':
        return color.bold(color.magenta('[GRAPH]'));
      case 'hybrid':
        return color.bold(color.yellow('[HYBRID]'));
      case 'single':
      case 'goal':
      default:
        return color.bold(color.green('[GOAL]'));
    }
  };
  if (requestedMode === 'auto' && mode !== 'single' && mode !== 'goal') {
    return `${color.bold(color.green('[GOAL]'))} ${badgeFor(mode)}`;
  }
  return badgeFor(mode);
}

export function formatWorkflowRationaleLines(plan: WorkflowPlanRecord, width = 100): string[] {
  const lines: string[] = [];
  const exp = plan.explanation;
  const conf = `${Math.round(exp.confidence * 100)}%`;
  const overrideTag = plan.overridden ? ' (overridden)' : '';
  const modeBadge = formatWorkflowModeBadge(plan.mode, plan.requestedMode);
  lines.push(`  Mode: ${modeBadge}  ·  Origin: ${plan.originInterface}  ·  Confidence: ${conf}${overrideTag}`);
  for (const reason of exp.reasons.slice(0, 2)) {
    lines.push(`  Rationale: ${reason}`);
  }
  const signals: string[] = [];
  if (exp.signals.loopSignals.length > 0) signals.push(`loop=[${exp.signals.loopSignals.join(', ')}]`);
  if (exp.signals.graphSignals.length > 0) signals.push(`graph=[${exp.signals.graphSignals.join(', ')}]`);
  if (exp.policyAssessment.requiresApprovalGates.length > 0) {
    signals.push(`gates=[${exp.policyAssessment.requiresApprovalGates.join('; ')}]`);
  }
  if (signals.length > 0) {
    lines.push(`  Signals: ${color.gray(signals.join(' · '))}`);
  }
  return lines.map((l) => (stripAnsiStr(l).length > width ? truncateAnsiStr(l, width) : l));
}

export function formatLoopCursorProgressLines(
  plan: WorkflowPlanRecord,
  run?: GoalRunLedger,
  width = 100,
  maxItems = 5,
): string[] {
  const loops = plan.loop
    ? [plan.loop]
    : (plan.nestedLoops?.map((n) => n.loop) ?? []);
  if (loops.length === 0) return [];
  const loop = loops[0]!;
  const total = loop.items.length;
  const completedCount = run
    ? loop.items.filter((it) => run.targets[it.targetId]?.status === 'completed').length
    : 0;
  const cursor = run
    ? loop.items.filter((it) => {
        const s = run.targets[it.targetId]?.status;
        return s === 'completed' || s === 'blocked' || s === 'stopped';
      }).length
    : loop.cursor;

  const lines: string[] = [];
  lines.push(
    `  Loop Cursor: ${color.bold(color.cyan(`${cursor}/${total}`))} (${completedCount} completed)  ·  Kind: ${loop.kind}  ·  Concurrency: ${loop.maxConcurrency}`,
  );
  lines.push(`  Until: ${color.gray(loop.completionPredicate)}`);
  for (const item of loop.items.slice(0, maxItems)) {
    const status = run?.targets[item.targetId]?.status ?? 'queued';
    const pathPart = item.path ? color.gray(` (${item.path})`) : '';
    lines.push(`    • [${item.index + 1}/${total}] ${color.bold(item.targetId)} ${formatTargetStatusBadge(status)} ${item.label}${pathPart}`);
  }
  if (loop.items.length > maxItems) {
    lines.push(color.gray(`    … +${loop.items.length - maxItems} more loop item(s)`));
  }
  return lines.map((l) => (stripAnsiStr(l).length > width ? truncateAnsiStr(l, width) : l));
}

export function formatGraphCriticalPathLines(
  plan?: WorkflowPlanRecord,
  summary?: WorkflowJobSummary,
  run?: GoalRunLedger,
  width = 100,
): string[] {
  const lines: string[] = [];
  if (plan?.criticalPath && plan.criticalPath.targets.length > 0) {
    lines.push(
      `  Critical Path (depth ${plan.criticalPath.depth}): ${color.magenta(plan.criticalPath.targets.join(' → '))}`,
    );
  }
  if (summary) {
    const p = summary.progress;
    const cursorPart = p.cursor !== undefined ? ` · cursor=${p.cursor}/${p.total}` : '';
    lines.push(
      `  DAG Progress: ${color.green(`${p.completed}/${p.total} completed`)} · ${color.cyan(`${p.active} active`)} · ${color.gray(`${p.queued} queued`)}${p.blocked > 0 ? ` · ${color.red(`${p.blocked} blocked`)}` : ''}${p.failed > 0 ? ` · ${color.red(`${p.failed} failed`)}` : ''}${p.needsApproval > 0 ? ` · ${color.yellow(`${p.needsApproval} needs_approval`)}` : ''}${cursorPart}`,
    );
  } else if (run) {
    const c = summarizeGoalTargets(run.targets);
    lines.push(
      `  DAG Progress: ${color.green(`${c.completed}/${c.total} completed`)} · ${color.cyan(`${c.active} active`)} · ${color.gray(`${c.queued} queued`)}`,
    );
  }
  return lines.map((l) => (stripAnsiStr(l).length > width ? truncateAnsiStr(l, width) : l));
}

export function formatWorkflowJobsList(jobs: readonly WorkflowJobSummary[], width = 100): string[] {
  if (jobs.length === 0) {
    return ['  No Loop, Graph, or Goal workflow jobs recorded yet.'];
  }
  const lines: string[] = [`  ${color.bold(`Workflow Jobs (${jobs.length})`)}`];
  for (const job of jobs) {
    const badge = formatWorkflowModeBadge(job.mode);
    const status = formatGoalRunStatusBadge(job.status);
    const cursorPart = job.progress.cursor !== undefined ? ` · cursor ${job.progress.cursor}/${job.progress.total}` : '';
    const progress = `${job.progress.completed}/${job.progress.total} done${cursorPart}`;
    const promptPreview = job.prompt.replace(/\s+/g, ' ').trim();
    const line = `  ${badge} ${color.bold(job.runId)} · ${status} · ${progress} · [${job.originInterface}] ${color.gray(promptPreview)}`;
    lines.push(stripAnsiStr(line).length > width ? truncateAnsiStr(line, width) : line);
  }
  return lines;
}

export function formatWorkflowInspectionSummary(inspection: WorkflowInspection, width = 100): string[] {
  const { summary, run, plan, evidence, targets } = inspection;
  const lines: string[] = [
    `  ${formatWorkflowModeBadge(summary.mode, plan?.requestedMode)} ${color.bold(run.runId)} · Status: ${formatGoalRunStatusBadge(run.status)} · Origin: ${summary.originInterface}`,
    `  Prompt: ${summary.prompt}`,
  ];
  if (plan) {
    lines.push(...formatWorkflowRationaleLines(plan, width));
    lines.push(...formatLoopCursorProgressLines(plan, run, width, 8));
  }
  lines.push(...formatGraphCriticalPathLines(plan, summary, run, width));
  const defMap = new Map(targets.map((t) => [t.id, t]));
  for (const entry of Object.values(run.targets).slice(0, 10)) {
    const def = defMap.get(entry.targetId);
    const deps = def?.dependsOn?.length ? color.gray(` deps=[${def.dependsOn.join(',')}]`) : '';
    lines.push(`    ${color.bold(entry.targetId)} ${formatTargetStatusBadge(entry.status)} ${def?.title ?? entry.targetId}${deps}`);
  }
  lines.push(`  Evidence records: ${evidence.length}`);
  return lines.map((l) => (stripAnsiStr(l).length > width ? truncateAnsiStr(l, width) : l));
}

export function summarizeGoalTargets(entries: Record<string, TargetLedgerEntry>): {
  total: number;
  completed: number;
  verifiedOnly: number;
  active: number;
  eligible: number;
  queued: number;
  blockedOrFailed: number;
  needsApproval: number;
} {
  const list = Object.values(entries);
  let completed = 0;
  let verifiedOnly = 0;
  let active = 0;
  let eligible = 0;
  let queued = 0;
  let blockedOrFailed = 0;
  let needsApproval = 0;

  for (const entry of list) {
    switch (entry.status) {
      case 'completed':
        completed++;
        break;
      case 'verified':
      case 'verifying':
        verifiedOnly++;
        break;
      case 'active':
      case 'repairing':
        active++;
        break;
      case 'eligible':
        eligible++;
        break;
      case 'queued':
        queued++;
        break;
      case 'blocked':
      case 'failed':
        blockedOrFailed++;
        break;
      case 'needs_approval':
        needsApproval++;
        break;
      default:
        break;
    }
  }

  return {
    total: list.length,
    completed,
    verifiedOnly,
    active,
    eligible,
    queued,
    blockedOrFailed,
    needsApproval,
  };
}

export function renderGoalStudioPane(
  snapshot: GoalStudioSnapshot,
  cols: number,
  maxRows: number,
): string[] {
  const lines: string[] = [];
  const run = snapshot.run;
  const graph = snapshot.graph;

  lines.push(
    `${color.bold(color.cyan('  GOAL STUDIO — CONTINUOUS GOAL-DRIVEN AUTONOMY'))}  ·  ${color.gray('7 / g · /goals · /status')}`,
  );
  lines.push(
    color.gray('  Invariant: Only COMPLETED unlocks dependents; VERIFIED alone never does.'),
  );
  lines.push(color.gray('  ' + '─'.repeat(Math.max(10, cols - 4))));

  if (!run) {
    lines.push(formatGoalPhaseIndicator(snapshot.activePhase ?? 'LOAD_LEDGER', cols));
    lines.push('');
    if (snapshot.jobs && snapshot.jobs.length > 0) {
      lines.push(...formatWorkflowJobsList(snapshot.jobs, cols));
      lines.push('');
      lines.push(color.gray('  Commands: /loop <task> · /graph <goal> · /goal <goal> · /inspect <runId> · /pause|/resume|/stop <runId>'));
    } else {
      lines.push(color.yellow('  No active Goal Studio run loaded in this workspace.'));
      lines.push('  Start or inspect a workflow via TUI slash commands or CLI:');
      lines.push(`    • ${color.cyan('/loop <task>')}           Run bounded iterative Loop workflow`);
      lines.push(`    • ${color.cyan('/graph <goal>')}          Compile & run DAG Graph workflow`);
      lines.push(`    • ${color.cyan('/goal <goal>')}           Auto-select Single, Loop, Graph, or Hybrid workflow`);
      lines.push(`    • ${color.cyan('/jobs')} · ${color.cyan('/inspect <id>')}   List and inspect shared workflow runs`);
      lines.push(`    • ${color.cyan('wa goals init')}          Initialize a GoalGraphDefinition`);
      lines.push(`    • ${color.cyan('wa goals run <goalId>')}  Start continuous autonomous goal execution`);
      lines.push(`    • ${color.cyan('wa goals status')}        Inspect pinned graph digest & target ledger`);
      lines.push(`    • ${color.cyan('/status')}                Display immediate fleet & Goal Studio status summary`);
    }
    while (lines.length < maxRows) lines.push('');
    return lines.slice(0, maxRows).map((l) => padRightAnsi(l, cols));
  }

  const counts = summarizeGoalTargets(run.targets);
  const currentEntries = Object.values(run.targets);
  const activePhase = snapshot.activePhase ?? 'SELECT_TARGET';
  const limits = graph?.constitution?.resourceLimits;
  const modeBadge = snapshot.plan
    ? `  ·  Mode: ${formatWorkflowModeBadge(snapshot.plan.mode, snapshot.plan.requestedMode)}`
    : snapshot.summary
      ? `  ·  Mode: ${formatWorkflowModeBadge(snapshot.summary.mode)}`
      : '';

  lines.push(
    `  Run: ${color.bold(run.runId)}  ·  Graph: ${color.cyan(run.graphId)} (rev ${run.graphRevision})  ·  Status: ${formatGoalRunStatusBadge(run.status)}${modeBadge}`,
  );
  lines.push(
    `  Graph Digest: ${color.gray(run.graphDigest.slice(0, 24))}  ·  Tasks: ${run.resource.tasksStarted}/${limits?.maxTasksPerRun ?? '∞'}  ·  Spend: $${run.resource.hostedSpendUsd.toFixed(2)}/$${limits?.hostedSpendUsd?.toFixed(2) ?? '∞'}`,
  );
  if (snapshot.plan) {
    lines.push(...formatWorkflowRationaleLines(snapshot.plan, cols));
    lines.push(...formatLoopCursorProgressLines(snapshot.plan, run, cols, 4));
    lines.push(...formatGraphCriticalPathLines(snapshot.plan, snapshot.summary, run, cols));
  } else if (snapshot.summary) {
    lines.push(...formatGraphCriticalPathLines(undefined, snapshot.summary, run, cols));
  }
  lines.push(formatGoalPhaseIndicator(activePhase, cols));
  lines.push(
    `  Targets (${counts.total}): ${color.green(`${counts.completed} completed`)} · ${color.cyan(`${counts.verifiedOnly} verified`)} · ${color.blue(`${counts.eligible} eligible`)} · ${color.cyan(`${counts.active} active`)} · ${color.gray(`${counts.queued} queued`)} · ${counts.blockedOrFailed > 0 ? color.red(`${counts.blockedOrFailed} blocked/failed`) : color.gray('0 blocked')}`,
  );
  lines.push(color.gray('  ' + '─'.repeat(Math.max(10, cols - 4))));

  const targetDefs = new Map((graph?.targets ?? []).map((t) => [t.id, t]));
  const selectedIdx = Math.max(0, Math.min(snapshot.selectedTargetIndex ?? 0, Math.max(0, currentEntries.length - 1)));

  for (let i = 0; i < currentEntries.length && lines.length < maxRows - 1; i++) {
    const entry = currentEntries[i];
    const def = targetDefs.get(entry.targetId);
    const cursor = i === selectedIdx ? color.cyan('>') : ' ';
    const title = def?.title ?? entry.targetId;
    const deps = def?.dependsOn?.length ? `deps: [${def.dependsOn.join(', ')}]` : 'deps: none';
    const badge = formatTargetStatusBadge(entry.status);
    lines.push(`  ${cursor} ${color.bold(entry.targetId.padEnd(16))} ${badge}  ${title}`);
    if (lines.length < maxRows - 1) {
      const reason = entry.blockers?.length
        ? color.red(`blockers: ${entry.blockers.join('; ')}`)
        : entry.evidenceIds?.length
          ? color.gray(`evidence: ${entry.evidenceIds.join(', ')}`)
          : color.gray('awaiting execution evidence');
      lines.push(`      ${color.gray(deps)} · attempts: ${entry.attempts} (repairs: ${entry.repairs}) · ${reason}`);
    }
  }

  while (lines.length < maxRows) lines.push('');
  return lines.slice(0, maxRows).map((l) => padRightAnsi(l, cols));
}

export interface CommandFeedbackInput {
  readonly command: string;
  readonly currentView: string;
  readonly activeAgents: number;
  readonly totalAgents: number;
  readonly readyModels: number;
  readonly installedModels: number;
  readonly pendingApprovals: number;
  readonly selectedModelId?: string;
  readonly goalRun?: GoalRunLedger;
}

/**
 * Formats immediate, deterministic, human-readable feedback for user slash commands
 * so no command ever executes silently without visible status bar / transcript feedback.
 */
export function formatCommandFeedback(input: CommandFeedbackInput): string {
  const cmd = input.command.trim();
  const routing = input.selectedModelId ? `pinned (${input.selectedModelId})` : 'auto (scheduler)';
  const goalPart = input.goalRun
    ? ` · Goal ${input.goalRun.graphId} [${input.goalRun.status.toUpperCase()}]`
    : '';

  if (cmd === '/status') {
    return `Status: view=${input.currentView.toUpperCase()} · ${input.activeAgents}/${input.totalAgents} agents running · ${input.readyModels}/${input.installedModels} models ready · ${input.pendingApprovals} approvals · routing=${routing}${goalPart}`;
  }
  if (cmd === '/goals' || cmd === '/goal') {
    return input.goalRun
      ? `Goal Studio: ${input.goalRun.graphId} (${input.goalRun.status.toUpperCase()}) — press ↑/↓ to inspect targets, ? for help.`
      : 'Switched to Goal Studio view (7 / g). Use /loop <task>, /graph <goal>, /goal <goal>, or /jobs.';
  }
  if (cmd === '/loop' || cmd.startsWith('/loop ')) {
    const task = cmd.slice(5).trim();
    return task ? `Starting Loop workflow: ${task}` : 'Usage: /loop <task> — run a bounded iterative Loop workflow.';
  }
  if (cmd === '/graph' || cmd.startsWith('/graph ')) {
    const goal = cmd.slice(6).trim();
    return goal ? `Starting Graph workflow: ${goal}` : 'Usage: /graph <goal> — compile and run a DAG Graph workflow.';
  }
  if (cmd.startsWith('/goal ')) {
    const goal = cmd.slice(5).trim();
    return goal ? `Starting Goal workflow: ${goal}` : 'Usage: /goal <goal> — auto-select and run a workflow.';
  }
  if (cmd === '/jobs' || cmd.startsWith('/jobs ')) {
    return 'Listing shared Loop, Graph, and Goal workflow jobs...';
  }
  if (cmd === '/inspect' || cmd.startsWith('/inspect ')) {
    const id = cmd.slice(8).trim();
    return id ? `Inspecting workflow run ${id}...` : 'Usage: /inspect <runId>';
  }
  if (cmd === '/pause' || cmd.startsWith('/pause ')) {
    const id = cmd.slice(6).trim();
    return id ? `Pausing workflow run ${id}...` : 'Usage: /pause <runId>';
  }
  if (cmd === '/resume' || cmd.startsWith('/resume ')) {
    const id = cmd.slice(7).trim();
    return id ? `Resuming workflow run or session ${id}...` : 'Usage: /resume <runId | session-id>';
  }
  if (cmd === '/stop' || cmd.startsWith('/stop ')) {
    const id = cmd.slice(5).trim();
    return id ? `Stopping workflow run ${id}...` : 'Usage: /stop <runId>';
  }
  if (cmd === '/help' || cmd === '?') {
    return 'Showing keyboard shortcuts & command reference. Press Esc or ? to return.';
  }
  if (cmd === '/fleet') {
    return `Switched to Fleet Overview (${input.activeAgents} running, ${input.readyModels}/${input.installedModels} models ready).`;
  }
  if (cmd === '/task' || cmd === '/tasks') {
    return 'Switched to Task Execution & Verification view.';
  }
  if (cmd === '/search') {
    return 'Switched to Solution Search & MCTS Tree view.';
  }
  if (cmd === '/improvement') {
    return 'Switched to Self-Improvement & Canary Experiments view.';
  }
  if (cmd === '/context') {
    return 'Switched to Context Utilization & Compaction view.';
  }
  if (cmd === '/evidence' || cmd === '/provenance') {
    return 'Switched to Verification Evidence & Provenance view.';
  }
  if (cmd === '/canary') {
    return 'Switched to Canary Deployment Dashboard view.';
  }
  if (cmd === '/tail') {
    return 'Switched to Live Agent Event Stream (Tail) view.';
  }
  if (cmd === '/worktrees') {
    return 'Switched to Git Worktree Isolation view.';
  }
  if (cmd === '/repaint') {
    return 'Screen repainted.';
  }
  if (cmd === '/model-intelligence') {
    return 'Switched to Models & Providers Intelligence view.';
  }
  if (cmd.startsWith('/')) {
    return `Unknown command '${cmd}'. Type /help or press ? for available commands (/status, /goals, /fleet, /models, /doctor, /exit).`;
  }
  return `Submitted: ${cmd}`;
}
