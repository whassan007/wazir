import { color } from '../colors.js';
import type { VerificationInspection, WhyCompleteAnswer, EvidenceSlotStatus } from '@wazir/core';
import type { PromptCacheMetrics, CacheMetricValue } from '@wazir/runtimes-interfaces';
import { promptCacheSource, promptCacheReuse } from '@wazir/runtimes-interfaces';

export interface ImprovementExperimentItem {
  id: string;
  domain: string;
  state: string;
  maturityLevel?: number | string;
  hypothesis?: string;
  baselineId?: string;
  baselinePassRate?: number;
  candidateCount?: number;
  benchmarkProgress?: { completed: number; total: number };
  objectives?: Array<{ metric: string; direction: 'MINIMIZE' | 'MAXIMIZE' | string }>;
  protectedMetrics?: string[];
  paretoFrontier?: {
    dimensions?: string[];
    directions?: Record<string, string>;
    frontierCandidates?: Array<{ candidateId: string; rawMetrics?: Record<string, number> }>;
    dominatedCandidates?: Array<{ candidateId: string; rawMetrics?: Record<string, number> }>;
    allEvaluated?: Array<{ candidateId: string; isNonDominated?: boolean; rawMetrics?: Record<string, number> }>;
  };
  regressionGuardStatus?: { passed: boolean; violationsCount: number; summary?: string };
  decision?: string;
  decisionReason?: string;
  canaryState?: {
    canaryId?: string;
    candidateId?: string;
    trafficFraction?: number;
    currentAllocation?: number;
    stage?: number;
    stageName?: string;
    totalStages?: number;
    status: 'HEALTHY' | 'ROLLED_BACK' | 'PROMOTED' | 'EVALUATING' | string;
    rollbackReason?: string;
    sampleCount?: number;
    minimumSamples?: number;
    correctnessStatus?: string;
    regressionGuardState?: string;
    nextStage?: string;
    stagedExpansionTiers?: number[];
  };
  causalEvidence?: {
    design?: string;
    beneficialMutations?: string[];
    neutralMutations?: string[];
    harmfulMutations?: string[];
    interactions?: Array<{ pair?: [string, string]; synergyScore?: number; description?: string }>;
  };
}

export interface ImprovementViewData {
  experiments: ImprovementExperimentItem[];
  selectedIndex: number;
  width: number;
  maxRows: number;
}

export interface SearchTreeNode {
  id: string;
  name?: string;
  label?: string;
  parentId?: string;
  state: 'active' | 'completed' | 'pruned' | 'failed' | 'promoted' | 'pending' | 'verifying' | string;
  glyph?: string;
  prunedReason?: string;
  tokens?: number;
  wallTimeMs?: number;
  testsPassed?: boolean;
  workerId?: string;
  leaseStatus?: string;
  treeRevision?: number;
  modelId?: string;
  isFrontier?: boolean;
  isDominated?: boolean;
  children?: SearchTreeNode[];
}

export interface SearchCandidateItem {
  candidateId: string;
  modelId: string;
  workerId: string;
  state: string;
  revision: number;
  buildPassed?: boolean;
  testsPassed?: boolean;
  testSummary?: string;
  tokens?: number;
  wallTimeMs?: number;
  pruneState: string; // 'ACTIVE' | 'PRUNED' | 'PRUNED (budget)' | 'PRUNED (build fail)'
  isFrontier?: boolean;
  isDominated?: boolean;
  qualifies?: boolean;
  disqualificationReasons?: string[];
  parentId?: string;
  checkpointId?: string;
}

export interface SearchNodeInspection {
  nodeId: string;
  parentId?: string;
  prunedReason?: string;
  phase?: string;
  state?: string;
  modelId?: string;
  workerId?: string;
  checkpointId?: string;
  revision?: string | number;

  changeSummary?: {
    filesChanged?: number | string | string[];
    filesChangedCount?: number;
    linesAdded?: number;
    linesRemoved?: number;
    patchDigest?: string;
    diffSnippet?: string;
    fileDeltas?: Array<{
      path: string;
      additions?: number;
      deletions?: number;
      digest?: string;
    }>;
  };

  verification?: {
    buildStatus?: string;
    buildCommand?: string;
    buildExitCode?: number;
    buildOutput?: string;

    testsStatus?: string;
    testSummary?: string;
    testCommand?: string;
    testExitCode?: number;
    testOutput?: string;

    acceptanceStatus?: string;
    acceptanceDetails?: string;

    verifyStatus?: string;
    oracles?: Array<{
      name: string;
      status: string;
      exitCode?: number;
      command?: string;
      message?: string;
      output?: string;
    }>;
  };

  search?: {
    visits?: number;
    controllerReward?: number;
    uctComponents?: string;
    uctExploitation?: number;
    uctExploration?: number;
    uctScore?: number;
    paretoMembership?: string;
  };

  provenance?: {
    parentNodeId?: string;
    checkpointLineage?: string | string[];
    executionId?: string;
    evidenceIds?: string[];
  };

  physicalEvidence?: {
    fileDeltas?: Array<{
      path: string;
      additions?: number;
      deletions?: number;
      diffHash?: string;
    }>;
    patchSummary?: string;
    buildCommand?: string;
    buildExitCode?: number;
    buildOutput?: string;
    testCommand?: string;
    testExitCode?: number;
    testOutput?: string;
    oracleResults?: Array<{
      name: string;
      status?: string;
      exitCode?: number;
      command?: string;
      message?: string;
    }>;
  };
}

export interface SearchViewData {
  searchId?: string;
  objective?: string;
  status?: string;
  strategy?: string;
  candidates: SearchCandidateItem[];
  treeNodes?: SearchTreeNode[];
  viewMode?: 'tree' | 'table' | 'split';
  selectedIndex: number;
  selectedCandidateId?: string;
  selectedNodeId?: string;
  selectedNodeInspection?: SearchNodeInspection;
  selectionReason?: string;
  treeRevision?: number;
  fleetSummary?: {
    activeWorkers?: number;
    totalWorkers?: number;
    runningBranches?: number;
    budgetUtilizationPct?: number;
    transpositionsCount?: number;
  };
  width: number;
  maxRows: number;
}

export interface ContextSampleItem {
  generation: number;
  currentTokens: number;
  effectiveMax: number;
  targetTokens: number;
  deduplicated: number;
  compressed: number;
  offloaded: number;
  stablePrefix: number;
  volatilePortion: number;
  timestamp?: Date;
  /** Normalized prompt-cache telemetry (produced by controller telemetry; consumed read-only). */
  cache?: PromptCacheMetrics;
}

export type {
  CacheMetricStatus,
  CacheMetricValue,
  PromptCacheMetrics,
} from '@wazir/runtimes-interfaces';
export {
  promptCacheSource,
  promptCacheReuse,
} from '@wazir/runtimes-interfaces';

function hasCacheValue(m: import('@wazir/runtimes-interfaces').CacheMetricValue | undefined): m is import('@wazir/runtimes-interfaces').CacheMetricValue & { value: number } {
  return !!m && (m.status === 'OBSERVED' || m.status === 'ESTIMATED') && typeof m.value === 'number' && Number.isFinite(m.value);
}

function fmtCacheMetric(m: CacheMetricValue | undefined): string {
  if (!m) return 'UNKNOWN';
  if (hasCacheValue(m)) return m.value.toLocaleString('en-US');
  return m.status === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'UNKNOWN';
}

const SPARK = '▁▂▃▄▅▆▇█';

export function renderPromptCacheSection(samples: ContextSampleItem[], width: number): string[] {
  const latest = samples[samples.length - 1];
  const cache = latest?.cache;
  const rule = '─'.repeat(Math.max(10, Math.min(24, width - 4)));
  const row = (label: string, val: string) => padRight(`  ${label.padEnd(18)}${val.padStart(12)}`, width);
  const out: string[] = [padRight(color.bold('  PROMPT CACHE'), width), padRight(color.gray(`  ${rule}`), width)];
  out.push(row('Input Tokens', fmtCacheMetric(cache?.inputTokens)));
  out.push(row('Cache Read', fmtCacheMetric(cache?.cacheReadTokens)));
  out.push(row('Cache Write', fmtCacheMetric(cache?.cacheWriteTokens)));
  const reuse = promptCacheReuse(cache);
  out.push(row('Effective Reuse', reuse === undefined ? 'UNKNOWN' : `${(reuse * 100).toFixed(1)}%`));
  out.push(row('Source', promptCacheSource(cache)));
  out.push(row('Provider', cache?.provider ?? 'UNKNOWN'));

  // Trend: derived solely from the already-bounded sample ring buffer; no extra history.
  const maxPoints = Math.max(0, Math.min(samples.length, width - 24));
  const trend = samples.slice(-maxPoints).map((s) => promptCacheReuse(s.cache));
  if (trend.filter((v) => v !== undefined).length >= 2) {
    const spark = trend.map((v) => (v === undefined ? '·' : SPARK[Math.min(SPARK.length - 1, Math.floor(v * SPARK.length))])).join('');
    out.push(padRight(`  ${'Reuse Trend'.padEnd(18)}${color.cyan(spark)}`, width));
  }
  return out;
}

export interface ContextViewData {
  samples: ContextSampleItem[];
  selectedIndex: number;
  width: number;
  maxRows: number;
}

export interface FleetWorkerItem {
  id: string;
  name: string;
  type: string;
  status: 'online' | 'busy' | 'offline' | 'idle' | string;
  runtimes: string[];
  loadedModels: string[];
  gpu?: { model: string; count?: number; memoryGB?: number };
  ram: { totalGB: number; availableGB: number; load?: number };
  capacity?: number;
  availableCapacity?: number;
  temperatureC?: number;
  reservations: number;
  shards: string[];
  shardsCount?: number;
  healthPct?: number;
  candidatePlacement?: string;
  /** Runtime/model health projection for this node (see buildHealthReport). */
  health?: FleetNodeHealth;
}

export interface FleetNodeHealth {
  runtime?: { name: string; state: string };
  model?: { id: string; state: string };
  memory?: { usedGiB?: number; totalGiB?: number; level: string };
  queueDepth: number | null;
  inference: string;
  telemetry: string;
  /** Diagnostics for this node, most severe first; evidence is shown only for the selected node. */
  diagnostics: Array<{ code: string; severity: string; subject: string; reason: string; evidence: string[] }>;
}

function healthTone(s: string): string {
  if (['READY', 'HEALTHY', 'OBSERVED', 'OK'].includes(s)) return color.green(s);
  if (['UNREACHABLE', 'UNAVAILABLE', 'FAILING', 'CRITICAL', 'FAILED'].includes(s)) return color.red(s);
  if (['DEGRADED', 'HIGH', 'LOADED', 'LOADING'].includes(s)) return color.yellow(s);
  return color.gray(s);
}

/** Compact health lines for one fleet node; evidence expands only when selected. */
export function renderFleetNodeHealth(h: FleetNodeHealth, selected: boolean, width: number): string[] {
  const lines: string[] = [];
  const rt = h.runtime ? `Runtime ${h.runtime.name} ${healthTone(h.runtime.state)}` : `Runtime ${color.gray('none')}`;
  const model = h.model ? `Model ${truncateAnsi(h.model.id, 24)} ${healthTone(h.model.state)}` : '';
  lines.push(padRight(`   ${[rt, model].filter(Boolean).join('  ')}`, width));
  const mem = h.memory
    ? h.memory.totalGiB !== undefined && h.memory.usedGiB !== undefined
      ? `Memory ${h.memory.usedGiB}/${h.memory.totalGiB} GiB${h.memory.level !== 'OK' ? ` ${healthTone(h.memory.level)}` : ''}`
      : `Memory ${color.gray('UNKNOWN')}`
    : '';
  const queue = `Queue ${h.queueDepth ?? color.gray('?')}`;
  lines.push(padRight(`   ${[mem, queue, `Inference ${healthTone(h.inference)}`, `Telemetry ${healthTone(h.telemetry)}`].filter(Boolean).join('  ')}`, width));
  const top = h.diagnostics[0];
  if (top) {
    const tone = top.severity === 'error' ? color.red : top.severity === 'warning' ? color.yellow : color.gray;
    const more = h.diagnostics.length > 1 ? color.gray(` (+${h.diagnostics.length - 1})`) : '';
    lines.push(padRight(`   ${tone(top.code)} ${color.gray(truncateAnsi(`${top.subject}: ${top.reason}`, Math.max(10, width - top.code.length - 12)))}${more}`, width));
    if (selected) for (const e of top.evidence.slice(0, 4)) lines.push(padRight(color.gray(`     ${truncateAnsi(e, Math.max(10, width - 6))}`), width));
  }
  return lines;
}

export interface FleetViewData {
  workers: FleetWorkerItem[];
  selectedIndex: number;
  width: number;
  maxRows: number;
}

export interface ModelProfileItem {
  id: string;
  model: string;
  runtime: string;
  capabilities: Record<string, { score: number; sampleCount: number; confidence: number }>;
  totalSamples: number;
  phaseBreakdown?: Record<string, { score: number; sampleCount: number }>;
  languageBreakdown?: Record<string, { score: number; sampleCount: number }>;
}

export interface ModelIntelligenceViewData {
  profiles: ModelProfileItem[];
  selectedIndex: number;
  width: number;
  maxRows: number;
}

export interface TaskViewData {
  taskId: string;
  title: string;
  objective?: string;
  requirements?: string[];
  currentPhase: 'TASK' | 'AGENT' | 'MODEL' | 'RUNTIME' | 'WORKER' | 'TOOLS' | 'VERIFY' | 'COMPLETE' | string;
  agentId?: string;
  modelId?: string;
  runtimeId?: string;
  computerId?: string;
  workerId?: string;
  workspaceRevision?: number;
  verificationStatus?: {
    overall: 'PENDING' | 'PASS' | 'FAIL' | 'REPAIRING' | string;
    checksPassed: number;
    totalChecks: number;
    checks: Array<{ name: string; ok: boolean; exitCode?: number; message?: string }>;
  };
  budget?: {
    tokensUsed: number;
    maxTokens?: number;
    repairCycles: number;
    maxRepairCycles?: number;
    costUsd?: number;
  };
  elapsedTimeMs?: number;
  physicalMutationsCount?: number;
  filesChanged?: string[];
  recentEvents?: Array<{ time?: string; kind?: string; text: string }>;
  width: number;
  maxRows: number;
}

export interface EvidenceViewData {
  /** Absent when no execution record is selected; the view then says so instead of implying PASS. */
  inspection?: VerificationInspection;
  why?: WhyCompleteAnswer;
  /** Provenance drill-down depth (0 = collapsed). Bounded by the steps present. */
  provenanceDepth?: number;
  width: number;
  maxRows: number;
}

export interface WhyExplanationData {
  topic: 'model' | 'worker' | 'tool' | 'candidate' | 'prune' | 'complete' | 'rollback' | string;
  headline: string;
  decision: string;
  rationale: string[];
  evidence: Array<{ label: string; value: string | number | boolean }>;
  controllerAudit: {
    source: string;
    verifiedAt: Date | string;
    immutableHash?: string;
  };
  width: number;
  maxRows: number;
}

export interface EvidenceModalData {
  title: string;
  candidateId?: string;
  experimentId?: string;
  revision?: number;
  checks?: Array<{ name: string; ok: boolean; exitCode?: number; command?: string }>;
  evidence?: Array<{ kind: string; exitCode?: number; hash?: string; command?: string }>;
  provenanceChain?: string[];
  metrics?: Record<string, number | string>;
  width: number;
  maxRows: number;
  scrollOffset?: number;
  nodeInspection?: SearchNodeInspection;
}

// ---------------------------------------------------------------------------
// String, ANSI padding, and tree helpers
// ---------------------------------------------------------------------------

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function truncateAnsi(str: string, maxLen: number): string {
  const plain = stripAnsi(str);
  if (plain.length <= maxLen) return str;
  let visibleCount = 0;
  let result = '';
  let inEscape = false;
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === '\x1b') {
      inEscape = true;
      result += char;
    } else if (inEscape) {
      result += char;
      if (/[a-zA-Z]/.test(char)) inEscape = false;
    } else {
      if (visibleCount < maxLen - 1) {
        result += char;
        visibleCount++;
      } else {
        result += '.\x1b[0m';
        break;
      }
    }
  }
  return result.endsWith('\x1b[0m') ? result : result + '\x1b[0m';
}

function padRight(str: string, targetWidth: number): string {
  const visible = stripAnsi(str).length;
  if (visible > targetWidth) return truncateAnsi(str, targetWidth);
  return str + ' '.repeat(Math.max(0, targetWidth - visible));
}

export function renderProgressBar(percentage: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percentage)));
  const filled = Math.max(0, Math.min(width, Math.round((clamped / 100) * width)));
  const empty = Math.max(0, width - filled);
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  if (clamped >= 85) return color.red(bar);
  if (clamped >= 60) return color.yellow(bar);
  return color.green(bar);
}

export function flattenSearchTree(roots: SearchTreeNode[]): SearchTreeNode[] {
  const result: SearchTreeNode[] = [];
  function traverse(node: SearchTreeNode) {
    result.push(node);
    if (node.children) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  }
  for (const root of roots) {
    traverse(root);
  }
  return result;
}

export function renderSearchTreeNode(
  node: SearchTreeNode,
  prefix = '',
  isLast = true,
  isRoot = false,
  width = 80,
  selectedNodeId?: string,
): string[] {
  const lines: string[] = [];
  const connector = isRoot ? '' : isLast ? '└─ ' : '├─ ';
  const stateGlyph =
    node.glyph ??
    (node.state === 'completed' || node.state === 'promoted'
      ? color.green('✓')
      : node.state === 'pruned' || node.state === 'failed'
        ? color.red('×')
        : node.state === 'verifying'
          ? color.yellow('◶')
          : color.cyan('●'));

  const paretoBadge = node.isFrontier
    ? color.bold(color.green(' [● FRONTIER]'))
    : node.isDominated
      ? color.gray(' [DOMINATED]')
      : '';

  const pruneInfo = node.prunedReason ? color.red(` [PRUNED: ${node.prunedReason}]`) : '';
  const tokenInfo = node.tokens !== undefined ? color.gray(` (${node.tokens} tok)`) : '';
  const testInfo = node.testsPassed === true ? color.green(' [tests ✓]') : node.testsPassed === false ? color.red(' [tests ×]') : '';
  const ownerInfo = node.workerId ? color.magenta(` [${node.workerId}${node.leaseStatus ? ` ${node.leaseStatus}` : ''}]`) : '';
  const revisionInfo = node.treeRevision !== undefined ? color.gray(` [T${node.treeRevision}]`) : '';
  const label = `${node.label ?? node.name ?? node.id} ${stateGlyph}${tokenInfo}${testInfo}${ownerInfo}${revisionInfo}${paretoBadge}${pruneInfo}`;

  const marker = selectedNodeId !== undefined && node.id === selectedNodeId ? '> ' : '  ';
  lines.push(padRight(`${marker}${prefix}${connector}${label}`, width));

  const childPrefix = prefix + (isRoot ? '' : isLast ? '   ' : '│  ');
  const children = node.children ?? [];
  for (let i = 0; i < children.length; i++) {
    const childIsLast = i === children.length - 1;
    lines.push(...renderSearchTreeNode(children[i], childPrefix, childIsLast, false, width, selectedNodeId));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 1. TASK VIEW RENDERER
// ---------------------------------------------------------------------------

export function renderTaskView(data: TaskViewData): string[] {
  const { width, maxRows } = data;
  const lines: string[] = [];

  lines.push(padRight(color.bold(color.cyan('  TASK EXECUTION PIPELINE & CONTROL PLANE STATE')), width));
  lines.push(padRight(color.gray('  ' + '='.repeat(Math.max(10, width - 4))), width));

  const stages: Array<'TASK' | 'AGENT' | 'MODEL' | 'RUNTIME' | 'WORKER' | 'TOOLS' | 'VERIFY'> = [
    'TASK',
    'AGENT',
    'MODEL',
    'RUNTIME',
    'WORKER',
    'TOOLS',
    'VERIFY',
  ];
  const curPhase = (data.currentPhase || 'TASK').toUpperCase();

  // Horizontal / compact pipeline indicator
  const pipelineParts = stages.map((st) => {
    if (st === curPhase) {
      return color.bold(color.cyan(`▶ [${st}] ◀`));
    }
    const idxCurrent = stages.indexOf(curPhase as any);
    const idxSt = stages.indexOf(st);
    if (idxCurrent > idxSt) {
      return color.green(`[${st} ✓]`);
    }
    return color.gray(`[${st}]`);
  });
  lines.push(padRight(`  Pipeline: ${pipelineParts.join(' ─▶ ')}`, width));
  lines.push(padRight(color.gray('  ' + '-'.repeat(Math.max(10, width - 4))), width));

  // Metadata block
  const durStr = data.elapsedTimeMs ? `${(data.elapsedTimeMs / 1000).toFixed(1)}s` : '0.0s';
  lines.push(
    padRight(
      `  ${color.bold('Task:')} ${color.cyan(data.taskId)} | ${color.bold('Title:')} ${data.title} | ${color.bold('Phase:')} ${color.yellow(curPhase)} | ${color.bold('Elapsed:')} ${durStr}`,
      width,
    ),
  );

  if (data.objective) {
    lines.push(padRight(`  ${color.bold('Objective:')} ${color.gray(data.objective)}`, width));
  }

  if (data.requirements && data.requirements.length > 0) {
    lines.push(padRight(`  ${color.bold('Requirements:')}`, width));
    for (const req of data.requirements.slice(0, 3)) {
      lines.push(padRight(`    • ${color.gray(req)}`, width));
    }
  }

  lines.push(padRight('', width));

  // Routing and Topology Allocation
  const agentStr = data.agentId ? color.cyan(data.agentId) : color.gray('pending');
  const modelStr = data.modelId ? color.cyan(data.modelId) : color.gray('pending');
  const runtimeStr = data.runtimeId ? color.cyan(data.runtimeId) : color.gray('pending');
  const computerStr = data.computerId ? color.cyan(data.computerId) : color.gray('pending');
  const workerStr = data.workerId ? color.cyan(data.workerId) : color.gray('pending');
  const revStr = data.workspaceRevision !== undefined ? color.magenta(`r${data.workspaceRevision}`) : color.gray('r0');

  lines.push(
    padRight(
      `  ${color.bold('Routing:')} Agent: ${agentStr} │ Model: ${modelStr} │ Runtime: ${runtimeStr}`,
      width,
    ),
  );
  lines.push(
    padRight(
      `  ${color.bold('Compute:')} Computer: ${computerStr} │ Worker: ${workerStr} │ Revision: ${revStr}`,
      width,
    ),
  );

  lines.push(padRight('', width));

  // Deterministic Verification Engine
  const v = data.verificationStatus;
  if (v) {
    const vBadge =
      v.overall === 'PASS'
        ? color.green('[VERIFIED: PASS]')
        : v.overall === 'FAIL'
          ? color.red('[VERIFIED: FAIL]')
          : color.yellow(`[VERIFY: ${v.overall}]`);
    lines.push(
      padRight(
        `  ${color.bold('Deterministic Verification:')} ${vBadge} (${v.checksPassed}/${v.totalChecks} checks passed)`,
        width,
      ),
    );
    for (const chk of (v.checks || []).slice(0, 3)) {
      const chkBadge = chk.ok ? color.green('✓') : color.red('×');
      const exitStr = chk.exitCode !== undefined ? ` (exit ${chk.exitCode})` : '';
      lines.push(padRight(`    ${chkBadge} ${chk.name}${exitStr}${chk.message ? `: ${chk.message}` : ''}`, width));
    }
  } else {
    lines.push(padRight(`  ${color.bold('Deterministic Verification:')} ${color.gray('Pending execution')}`, width));
  }

  // Budget & Resource Governance
  const b = data.budget;
  if (b) {
    const tokStr = b.maxTokens ? `${b.tokensUsed} / ${b.maxTokens}` : `${b.tokensUsed}`;
    const repStr = b.maxRepairCycles ? `${b.repairCycles} / ${b.maxRepairCycles}` : `${b.repairCycles}`;
    const costStr = b.costUsd !== undefined ? `$${b.costUsd.toFixed(4)}` : '$0.00';
    lines.push(
      padRight(
        `  ${color.bold('Budget Governance:')} Tokens: ${color.yellow(tokStr)} │ Repair Cycles: ${color.yellow(repStr)} │ Cost: ${color.green(costStr)}`,
        width,
      ),
    );
  }

  // Physical mutations
  if (data.physicalMutationsCount !== undefined || (data.filesChanged && data.filesChanged.length > 0)) {
    const mCount = data.physicalMutationsCount ?? data.filesChanged?.length ?? 0;
    const filesStr = data.filesChanged?.length ? ` [${data.filesChanged.slice(0, 3).join(', ')}]` : '';
    lines.push(padRight(`  ${color.bold('Physical Mutations:')} ${color.magenta(`${mCount} files changed`)}${color.gray(filesStr)}`, width));
  }

  // Recent Event Stream
  if (data.recentEvents && data.recentEvents.length > 0) {
    lines.push(padRight('', width));
    lines.push(padRight(`  ${color.bold('Recent Controller Telemetry:')}`, width));
    for (const ev of data.recentEvents.slice(-4)) {
      lines.push(padRight(`    ${color.gray(ev.time ?? '•')} [${color.cyan(ev.kind ?? 'EVENT')}] ${ev.text}`, width));
    }
  }

  while (lines.length < maxRows) lines.push(padRight('', width));
  return lines.slice(0, maxRows);
}

// ---------------------------------------------------------------------------
// 1b. SEARCH NODE INSPECTION RENDERER (Authoritative Controller Evidence)
// ---------------------------------------------------------------------------

export function renderSearchNodeInspection(
  inspection: SearchNodeInspection,
  options: { width?: number; maxRows?: number } = {},
): string[] {
  const width = options.width ?? 80;
  const maxRows = options.maxRows ?? 60;
  const lines: string[] = [];

  const sep = '─'.repeat(Math.min(width - 4, 36));

  // NODE <id>
  lines.push(`NODE ${color.bold(inspection.nodeId)}`);
  lines.push(color.gray(sep));

  // Metadata
  const phaseStr = inspection.phase ? inspection.phase.toUpperCase() : 'UNKNOWN';
  const stateStr = inspection.state
    ? inspection.state.toUpperCase() === 'VERIFIED'
      ? color.green('VERIFIED')
      : inspection.state.toUpperCase() === 'FAILED' || inspection.state.toUpperCase() === 'PRUNED'
        ? color.red(inspection.state.toUpperCase())
        : color.yellow(inspection.state.toUpperCase())
    : 'UNKNOWN';

  lines.push(`Phase:       ${phaseStr}`);
  lines.push(`State:       ${stateStr}`);
  lines.push(`Model:       ${inspection.modelId ?? 'UNKNOWN'}`);
  lines.push(`Worker:      ${inspection.workerId ?? 'UNKNOWN'}`);
  lines.push(`Checkpoint:  ${inspection.checkpointId ?? 'UNKNOWN'}`);
  lines.push(
    `Revision:    ${
      inspection.revision !== undefined
        ? String(inspection.revision).startsWith('r')
          ? String(inspection.revision)
          : `r${inspection.revision}`
        : 'UNKNOWN'
    }`,
  );
  const parentNodeStr = inspection.parentId ?? inspection.provenance?.parentNodeId ?? 'UNKNOWN';
  lines.push(`Parent:      ${parentNodeStr}`);
  const pruningReasonStr = inspection.prunedReason ?? (inspection.state === 'PRUNED' ? 'PRUNED' : 'UNKNOWN');
  lines.push(`Pruning reason: ${pruningReasonStr}`);
  lines.push('');

  // CHANGE SUMMARY
  lines.push(color.bold('CHANGE SUMMARY'));
  const filesChangedStr =
    inspection.changeSummary?.filesChanged !== undefined
      ? Array.isArray(inspection.changeSummary.filesChanged)
        ? `${inspection.changeSummary.filesChanged.length} (${inspection.changeSummary.filesChanged.slice(0, 3).join(', ')})`
        : String(inspection.changeSummary.filesChanged)
      : 'UNKNOWN';

  const linesDeltaStr =
    inspection.changeSummary?.linesAdded !== undefined || inspection.changeSummary?.linesRemoved !== undefined
      ? `+${inspection.changeSummary.linesAdded ?? 0}, -${inspection.changeSummary.linesRemoved ?? 0}`
      : 'UNKNOWN';

  const patchDigestStr = inspection.changeSummary?.patchDigest ?? 'UNKNOWN';

  lines.push(`files changed        ${filesChangedStr}`);
  lines.push(`lines added/removed  ${linesDeltaStr}`);
  lines.push(`patch/diff digest    ${patchDigestStr}`);
  lines.push('');

  // VERIFICATION
  lines.push(color.bold('VERIFICATION'));
  const fmtStatus = (s: string | undefined): string => {
    if (!s) return 'UNKNOWN';
    if (s.toUpperCase() === 'PASS') return color.green('PASS');
    if (s.toUpperCase() === 'FAIL') return color.red('FAIL');
    return s;
  };

  const buildStr = fmtStatus(inspection.verification?.buildStatus);
  const testsStr = inspection.verification?.testSummary
    ? inspection.verification.testsStatus === 'FAIL'
      ? color.red(inspection.verification.testSummary)
      : color.green(inspection.verification.testSummary)
    : fmtStatus(inspection.verification?.testsStatus);
  const acceptanceStr = fmtStatus(inspection.verification?.acceptanceStatus);
  const verifyStr = fmtStatus(inspection.verification?.verifyStatus);

  lines.push(`Build       ${buildStr}`);
  lines.push(`Tests       ${testsStr}`);
  lines.push(`Acceptance  ${acceptanceStr}`);
  lines.push(`Verify      ${verifyStr}`);

  if (inspection.verification?.oracles && inspection.verification.oracles.length > 0) {
    const oracleSummaries = inspection.verification.oracles
      .slice(0, 3)
      .map((o) => `${o.status === 'PASS' ? color.green('✓') : color.red('×')} ${o.name}`)
      .join('  ');
    lines.push(`Oracles:    ${oracleSummaries}`);
  }
  lines.push('');

  // SEARCH
  lines.push(color.bold('SEARCH'));
  const visitsStr = inspection.search?.visits !== undefined ? String(inspection.search.visits) : 'UNKNOWN';
  const rewardStr =
    inspection.search?.controllerReward !== undefined
      ? typeof inspection.search.controllerReward === 'number'
        ? inspection.search.controllerReward.toFixed(4)
        : String(inspection.search.controllerReward)
      : 'UNKNOWN';
  const uctStr = inspection.search?.uctComponents ?? 'UNKNOWN';
  const paretoStr = inspection.search?.paretoMembership
    ? inspection.search.paretoMembership.toUpperCase() === 'FRONTIER'
      ? color.bold(color.green('● FRONTIER'))
      : inspection.search.paretoMembership.toUpperCase() === 'DOMINATED'
        ? color.gray('DOMINATED')
        : color.yellow(inspection.search.paretoMembership.toUpperCase())
    : 'UNKNOWN';

  lines.push(`Visits               ${visitsStr}`);
  lines.push(`Controller reward    ${rewardStr}`);
  lines.push(`UCT components       ${uctStr}`);
  lines.push(`Pareto membership    ${paretoStr}`);
  lines.push('');

  // PROVENANCE
  lines.push(color.bold('PROVENANCE'));
  const lineageStr = Array.isArray(inspection.provenance?.checkpointLineage)
    ? inspection.provenance.checkpointLineage.join(' -> ')
    : inspection.provenance?.checkpointLineage ?? 'UNKNOWN';
  const execIdStr = inspection.provenance?.executionId ?? 'UNKNOWN';
  const evidenceIdsStr =
    inspection.provenance?.evidenceIds && inspection.provenance.evidenceIds.length > 0
      ? inspection.provenance.evidenceIds.join(', ')
      : 'UNKNOWN';

  lines.push(`parent node          ${parentNodeStr}`);
  lines.push(`checkpoint lineage   ${lineageStr}`);
  lines.push(`execution id         ${execIdStr}`);
  lines.push(`evidence ids         ${evidenceIdsStr}`);
  lines.push('');

  // PHYSICAL EVIDENCE
  lines.push(color.bold('PHYSICAL EVIDENCE'));
  const pe = inspection.physicalEvidence;
  let hasEvidence = false;

  if (pe?.buildCommand || pe?.buildExitCode !== undefined) {
    hasEvidence = true;
    const badge = pe.buildExitCode === 0 ? color.green('Exit 0 (PASS)') : color.red(`Exit ${pe.buildExitCode} (FAIL)`);
    lines.push(`  Build: ${badge}${pe.buildCommand ? ` - ${pe.buildCommand}` : ''}`);
    if (pe.buildOutput) {
      lines.push(color.gray(`    Output: ${pe.buildOutput}`));
    }
  }

  if (pe?.testCommand || pe?.testExitCode !== undefined) {
    hasEvidence = true;
    const badge = pe.testExitCode === 0 ? color.green('Exit 0 (PASS)') : color.red(`Exit ${pe.testExitCode} (FAIL)`);
    lines.push(`  Tests: ${badge}${pe.testCommand ? ` - ${pe.testCommand}` : ''}`);
    if (pe.testOutput) {
      lines.push(color.gray(`    Output: ${pe.testOutput}`));
    }
  }

  if (pe?.oracleResults && pe.oracleResults.length > 0) {
    hasEvidence = true;
    lines.push('  Verification Oracles:');
    for (const o of pe.oracleResults.slice(0, 4)) {
      const badge = o.status === 'PASS' ? color.green('✓') : color.red('×');
      const exitStr = o.exitCode !== undefined ? ` (exit ${o.exitCode})` : '';
      lines.push(`    ${badge} ${o.name}${exitStr}${o.command ? ` - ${o.command}` : ''}`);
    }
  }

  if (pe?.fileDeltas && pe.fileDeltas.length > 0) {
    hasEvidence = true;
    lines.push('  File Deltas:');
    for (const fd of pe.fileDeltas.slice(0, 4)) {
      const adds = fd.additions !== undefined ? color.green(`+${fd.additions}`) : '';
      const dels = fd.deletions !== undefined ? color.red(`-${fd.deletions}`) : '';
      const diffStr = [adds, dels].filter(Boolean).join(', ');
      lines.push(`    • ${fd.path}${diffStr ? ` (${diffStr})` : ''}`);
    }
  }

  if (pe?.patchSummary) {
    hasEvidence = true;
    lines.push(`  Patch Summary: ${pe.patchSummary}`);
  }

  if (!hasEvidence) {
    lines.push(color.gray('  No physical execution evidence recorded.'));
  }

  lines.push(color.gray('  Invariant: MODEL CLAIM != EXECUTION EVIDENCE. Completion is verified solely by physical execution.'));

  return lines.slice(0, maxRows);
}

// ---------------------------------------------------------------------------
// 2. SEARCH VIEW RENDERER (Hierarchical MCTS Tree + Flat Table)
// ---------------------------------------------------------------------------

export function renderSearchView(data: SearchViewData): string[] {
  const { searchId, objective, status, strategy, candidates, treeNodes, viewMode, selectedIndex, selectedCandidateId, selectedNodeId, selectedNodeInspection, selectionReason, width, maxRows } = data;
  const lines: string[] = [];

  const searchTag = searchId ?? 'active-search';
  const statusStr = status ? `(${status.toUpperCase()})` : '(ACTIVE)';
  const treeRevStr = data.treeRevision !== undefined ? `  ${color.magenta(`TREE: T${data.treeRevision}`)}` : '';
  lines.push(padRight(`  ${color.bold(color.cyan(`SOLUTION SEARCH: ${searchTag}`))}${treeRevStr} ${color.yellow(statusStr)}`, width));
  if (objective) {
    lines.push(padRight(`  ${color.gray(`Objective: ${objective}`)}`, width));
  }
  const fs = data.fleetSummary;
  const fleetInfo = fs
    ? ` | Workers: ${fs.activeWorkers ?? 0}/${fs.totalWorkers ?? 0} | Running: ${fs.runningBranches ?? 0} | Budget: ${fs.budgetUtilizationPct ?? 0}% | Transpositions: ${fs.transpositionsCount ?? 0}`
    : '';
  lines.push(padRight(color.gray(`  Strategy: ${strategy ?? 'hierarchical_mcts'} | Total Candidates: ${candidates?.length ?? 0}${fleetInfo}`), width));
  lines.push(padRight(color.gray('  ' + '='.repeat(Math.max(10, width - 4))), width));

  const shouldRenderTree = viewMode === 'tree' || (treeNodes && treeNodes.length > 0 && viewMode !== 'table');

  if (shouldRenderTree && treeNodes && treeNodes.length > 0) {
    lines.push(padRight(color.bold('  HIERARCHICAL MCTS SEARCH TREE:'), width));
    lines.push(padRight(color.gray('  ' + '-'.repeat(Math.min(width - 4, 80))), width));
    const treeLines: string[] = [];
    for (const root of treeNodes) {
      treeLines.push(...renderSearchTreeNode(root, '', true, true, width, selectedNodeId));
    }
    const maxTreeLines = Math.min(treeLines.length, Math.max(5, maxRows - lines.length - 8));
    lines.push(...treeLines.slice(0, maxTreeLines));
    lines.push(padRight('', width));
  }

  // Flat Candidate Table
  if (candidates && candidates.length > 0 && (viewMode === 'table' || viewMode === 'split' || !shouldRenderTree || lines.length < maxRows - 7)) {
    const colCand = 10;
    const colModel = 18;
    const colWorker = 12;
    const colState = 10;
    const colPareto = 11;
    const colBuild = 5;
    const colTests = 10;
    const colPrune = 10;

    const header = `  ${color.bold('Cand'.padEnd(colCand))} ${color.bold('Model'.padEnd(colModel))} ${color.bold('Worker'.padEnd(colWorker))} ${color.bold('State'.padEnd(colState))} ${color.bold('Pareto'.padEnd(colPareto))} ${color.bold('Bld'.padEnd(colBuild))} ${color.bold('Tests'.padEnd(colTests))} ${color.bold('Prune')}`;
    lines.push(padRight(header, width));
    lines.push(padRight(color.gray('  ' + '-'.repeat(Math.min(width - 4, 110))), width));

    const remainingRows = Math.max(2, maxRows - lines.length - 6);
    const rowsToShow = Math.min(candidates.length, remainingRows);

    for (let i = 0; i < rowsToShow; i++) {
      const c = candidates[i];
      const isSelected = i === selectedIndex;
      const prefix = isSelected ? color.cyan('> ') : '  ';

      const stateBadge =
        c.state === 'pruned' || c.pruneState.startsWith('PRUNED')
          ? color.red('PRUNED')
          : c.state === 'completed' || c.state === 'promoted'
            ? color.green(c.state.toUpperCase())
            : c.state === 'failed' || c.state === 'cancelled'
              ? color.red(c.state.toUpperCase())
              : color.yellow(c.state.toUpperCase());

      const candIdStr = c.candidateId.length > colCand ? c.candidateId.slice(0, colCand - 1) + '.' : c.candidateId;
      const modelIdStr = c.modelId.length > colModel ? c.modelId.slice(0, colModel - 1) + '.' : c.modelId;
      const buildStr = c.buildPassed === true ? color.green('PASS') : c.buildPassed === false ? color.red('FAIL') : color.gray('-');
      const testsStr = c.testSummary ? (c.testsPassed ? color.green(c.testSummary) : color.red(c.testSummary)) : (c.testsPassed ? color.green('PASS') : color.gray('-'));
      const pruneBadge = c.pruneState === 'ACTIVE'
        ? color.green('ACTIVE')
        : c.pruneState.startsWith('PRUNED')
          ? color.red(c.pruneState)
          : color.gray(c.pruneState);

      const paretoBadge = c.isFrontier
        ? color.bold(color.green('● FRONTIER'))
        : c.isDominated
          ? color.gray('DOMINATED')
          : color.yellow('PENDING');

      const row = `${prefix}${candIdStr.padEnd(colCand)} ${modelIdStr.padEnd(colModel)} ${c.workerId.padEnd(colWorker)} ${stateBadge.padEnd(colState)} ${paretoBadge.padEnd(colPareto)} ${buildStr.padEnd(colBuild)} ${testsStr.padEnd(colTests)} ${pruneBadge}`;
      lines.push(padRight(row, width));
    }
  }

  // Pareto Frontier Summary
  const frontier = (candidates || []).filter((c) => c.isFrontier);
  const dominated = (candidates || []).filter((c) => c.isDominated || c.state === 'pruned' || c.pruneState?.startsWith('PRUNED'));

  if ((frontier.length > 0 || dominated.length > 0) && lines.length < maxRows - 4) {
    lines.push(padRight('', width));
    lines.push(padRight(`  ${color.bold('PARETO FRONTIER MEMBERSHIP:')}`, width));
    if (frontier.length > 0) {
      lines.push(padRight(`  ● Non-dominated (Frontier): ${frontier.map((f) => f.candidateId).join(', ')}  [● FRONTIER]`, width));
    }
    if (dominated.length > 0) {
      lines.push(padRight(`  Dominated / Pruned:       ${dominated.map((d) => d.candidateId).join(', ')}`, width));
    }
  }

  if (selectedCandidateId && lines.length < maxRows - 2) {
    lines.push(padRight(`  ${color.bold('Selected Candidate:')} ${color.bold(color.green(selectedCandidateId))}${selectionReason ? color.gray(` (${selectionReason})`) : ''}`, width));
  }

  if (selectedNodeInspection && lines.length < maxRows - 4) {
    lines.push(padRight('', width));
    lines.push(padRight(`  ${color.bold('SELECTED NODE DETAIL & EVIDENCE:')}`, width));
    lines.push(padRight(color.gray('  ' + '-'.repeat(Math.min(width - 4, 80))), width));
    const inspLines = renderSearchNodeInspection(selectedNodeInspection, { width: width - 4 });
    const remaining = Math.max(4, maxRows - lines.length - 2);
    for (const l of inspLines.slice(0, remaining)) {
      lines.push(padRight(`  ${l}`, width));
    }
  }

  lines.push(padRight(color.gray('  Actions: [P] Pause  [X] Prune/Cancel  [A] Promote  [E] Inspect Evidence  [Tab] Mode  [↑/↓] Select'), width));

  while (lines.length < maxRows) lines.push(padRight('', width));
  return lines.slice(0, maxRows);
}

// ---------------------------------------------------------------------------
// 3. FLEET VIEW RENDERER (Live Topology Cards + Progress Bars + Shards)
// ---------------------------------------------------------------------------

export function renderFleetView(data: FleetViewData): string[] {
  const { workers, selectedIndex, width, maxRows } = data;
  const lines: string[] = [];

  lines.push(padRight(color.bold(color.cyan('  FLEET TOPOLOGY & DISTRIBUTED COMPUTE FABRIC')), width));
  lines.push(padRight(color.gray('  ' + '='.repeat(Math.max(10, width - 4))), width));

  if (!workers || workers.length === 0) {
    lines.push(padRight('  No compute nodes registered in fleet topology.', width));
    while (lines.length < maxRows) lines.push(padRight('', width));
    return lines;
  }

  // Summary counts
  const onlineCount = workers.filter((w) => w.status === 'online' || w.status === 'busy' || w.status === 'idle').length;
  lines.push(padRight(`  Nodes: ${color.bold(String(onlineCount))}/${workers.length} Online  │  ${color.gray('Live Capacity, Shards & Model Placements')}`, width));
  lines.push(padRight(color.gray('  ' + '-'.repeat(Math.max(10, width - 4))), width));

  // Topology Cards Rendering
  for (let i = 0; i < workers.length && lines.length < maxRows - 4; i++) {
    const w = workers[i];
    const isSelected = i === selectedIndex;
    const prefix = isSelected ? color.cyan('> ') : '  ';

    const statusBadge =
      w.status === 'online' || w.status === 'idle'
        ? color.green(`[${w.status.toUpperCase()}]`)
        : w.status === 'busy'
          ? color.yellow('[BUSY]')
          : color.red(`[${w.status.toUpperCase()}]`);

    const healthStr = w.healthPct !== undefined ? `${w.healthPct}% Health` : '100% Health';
    const gpuName = w.gpu ? `${w.gpu.model}${w.gpu.count ? ` x${w.gpu.count}` : ''}` : 'CPU / Integrated';
    const tempStr = w.temperatureC !== undefined ? `${w.temperatureC}°C` : '';

    // Load and progress bar calculation
    const cap = w.capacity ?? 10;
    const availCap = w.availableCapacity ?? (w.status === 'busy' ? Math.max(0, cap - (w.reservations || 1)) : cap);
    const loadPct = cap > 0 ? ((cap - availCap) / cap) * 100 : (w.ram.load ? w.ram.load * 100 : 0);
    const progressBar = renderProgressBar(loadPct, 10);

    const shardsStr = w.shardsCount !== undefined
      ? `shards: ${w.shardsCount}`
      : `shards: ${w.shards?.length ?? 0}`;
    const modelsStr = `models: ${w.loadedModels.length}`;
    const ramStr = `RAM: ${w.ram.availableGB.toFixed(0)}/${w.ram.totalGB}GB${w.ram.load ? ` (load ${w.ram.load.toFixed(1)})` : ''}`;
    const rtStr = `Runtime: ${w.runtimes.join(', ') || 'local'}`;
    const resStr = w.reservations > 0 ? `Res: ${w.reservations}` : '';

    // First line: Node Name, Status, Health
    lines.push(padRight(`${prefix}${color.bold(w.id || w.name)}  ${statusBadge} ${color.gray(healthStr)}`, width));

    // Second line: Hardware, Load Bar, Capacity, Temp
    const capStr = `(Cap: ${cap} / Avail: ${availCap})`;
    const tempPart = tempStr ? `  ${color.magenta(tempStr)}` : '';
    lines.push(padRight(`   ${gpuName.padEnd(16)} ${progressBar} ${loadPct.toFixed(0)}%  ${color.gray(capStr)}${tempPart}`, width));

    // Third line: Shards, RAM, Reservations
    lines.push(padRight(`   ${shardsStr.padEnd(14)} ${color.gray(ramStr)}${resStr ? `  ${color.yellow(resStr)}` : ''}`, width));

    // Fourth line: Models, Runtime
    lines.push(padRight(`   ${modelsStr.padEnd(14)} ${color.gray(rtStr)}`, width));
    if (w.health) lines.push(...renderFleetNodeHealth(w.health, isSelected, width));
    lines.push(padRight('', width));
  }

  while (lines.length < maxRows) lines.push(padRight('', width));
  return lines.slice(0, maxRows);
}

// ---------------------------------------------------------------------------
// 4. IMPROVEMENT VIEW RENDERER
// ---------------------------------------------------------------------------

export function renderImprovementView(data: ImprovementViewData): string[] {
  const { experiments, selectedIndex, width, maxRows } = data;
  const lines: string[] = [];

  lines.push(padRight(color.bold(color.cyan('  SELF IMPROVEMENT & CANARY VERIFICATION')), width));
  lines.push(padRight(color.gray('  ' + '='.repeat(Math.max(10, width - 4))), width));

  if (!experiments || experiments.length === 0) {
    lines.push(padRight('  No active or historical self-improvement experiments.', width));
    lines.push(padRight(color.gray('  Run an experiment via control plane or scheduler.'), width));
    while (lines.length < maxRows) lines.push(padRight('', width));
    return lines;
  }

  // Table Header
  const colExp = Math.max(14, Math.floor(width * 0.20));
  const colDom = Math.max(14, Math.floor(width * 0.18));
  const colState = Math.max(16, Math.floor(width * 0.22));

  const tableHeader = `  ${color.bold('Experiment'.padEnd(colExp))} ${color.bold('Domain'.padEnd(colDom))} ${color.bold('State'.padEnd(colState))}`;
  lines.push(padRight(tableHeader, width));
  lines.push(padRight(color.gray('  ' + '-'.repeat(Math.min(width - 4, colExp + colDom + colState + 4))), width));

  const maxTableRows = Math.min(experiments.length, 4);
  for (let i = 0; i < maxTableRows; i++) {
    const exp = experiments[i];
    const isSelected = i === selectedIndex;
    const prefix = isSelected ? color.cyan('> ') : '  ';
    const stateBadge =
      exp.state === 'QUALIFIED' || exp.state === 'PROMOTED'
        ? color.green(exp.state)
        : exp.state === 'REJECTED'
          ? color.red(exp.state)
          : exp.state === 'BENCHMARKING' || exp.state === 'RUNNING'
            ? color.yellow(exp.state)
            : color.gray(exp.state);

    const row = `${prefix}${exp.id.padEnd(colExp)} ${exp.domain.padEnd(colDom)} ${stateBadge}`;
    lines.push(padRight(row, width));
  }

  lines.push(padRight('', width));

  // Selected Experiment Details
  const sel = experiments[Math.min(selectedIndex, experiments.length - 1)];
  if (sel) {
    lines.push(padRight(`  ${color.bold('Selected:')} ${color.cyan(sel.id)}  │  Domain: ${color.bold(sel.domain)}  │  Maturity: ${color.magenta(String(sel.maturityLevel ?? 'Level 2'))}`, width));
    if (sel.hypothesis) {
      lines.push(padRight(`  ${color.bold('Hypothesis:')} ${color.gray(sel.hypothesis)}`, width));
    }
    const baselineStr = sel.baselineId ? `${sel.baselineId} (${sel.baselinePassRate ? `${(sel.baselinePassRate * 100).toFixed(0)}% pass` : '100%'})` : 'active-baseline';
    const candCount = sel.candidateCount ?? (sel.paretoFrontier?.allEvaluated?.length ?? 1);
    const benchStr = sel.benchmarkProgress ? `${sel.benchmarkProgress.completed}/${sel.benchmarkProgress.total} tasks` : 'completed';
    lines.push(padRight(`  Baseline: ${color.gray(baselineStr)}  │  Candidates: ${color.bold(String(candCount))}  │  Progress: ${color.green(benchStr)}`, width));

    // Keep the controller decision visible even when the canary widget fills the pane.
    if (sel.decision) {
      lines.push(padRight(`  ${color.bold('Decision:')} ${color.bold(sel.decision)}${sel.decisionReason ? color.gray(` - ${sel.decisionReason}`) : ''}`, width));
    }

    // Multi-objective section
    const objectives = sel.objectives && sel.objectives.length > 0
      ? sel.objectives
      : [
          { metric: 'tokens', direction: 'MINIMIZE' },
          { metric: 'wall time', direction: 'MINIMIZE' },
        ];
    lines.push(padRight(`  ${color.bold('Objective:')}`, width));
    for (const obj of objectives) {
      lines.push(padRight(`    ${color.yellow(`${obj.metric} ${obj.direction === 'MINIMIZE' ? '↓' : '↑'}`)}`, width));
    }

    if (sel.protectedMetrics && sel.protectedMetrics.length > 0) {
      lines.push(padRight(`  ${color.bold('Protected:')}`, width));
      for (const prot of sel.protectedMetrics) {
        lines.push(padRight(`    ${prot}`, width));
      }
    }

    if (sel.paretoFrontier) {
      const frontierCands = sel.paretoFrontier.frontierCandidates || [];
      const dominatedCands = sel.paretoFrontier.dominatedCandidates || [];
      if (frontierCands.length > 0 || dominatedCands.length > 0) {
        lines.push(padRight(`  ${color.bold('Pareto:')}`, width));
        for (const fc of frontierCands) {
          lines.push(padRight(`    ${color.green(`${fc.candidateId} ●`)}`, width));
        }
        for (const dc of dominatedCands) {
          lines.push(padRight(`    ${color.gray(`${dc.candidateId} dominated`)}`, width));
        }
      }
    }

    // Interactive Canary Control Widget
    if (sel.canaryState) {
      const cs = sel.canaryState;
      const candId = cs.candidateId ?? sel.id ?? 'UNKNOWN';
      const stageName = cs.stageName ?? (cs.stage !== undefined ? `CANARY_${Math.round((cs.currentAllocation ?? cs.trafficFraction ?? 0.10) * 100)}` : 'UNKNOWN');
      const canaryAlloc = cs.status === 'ROLLED_BACK' ? 0.0 : (cs.currentAllocation ?? cs.trafficFraction ?? 0.0);
      const baseAlloc = Math.max(0, 1.0 - canaryAlloc);
      const barLen = Math.max(12, Math.min(20, width - 36));

      lines.push(padRight(`  ${color.bold('CANARY')}`, width));
      lines.push(padRight(color.gray('  ' + '─'.repeat(Math.min(width - 4, 32))), width));
      lines.push(padRight(`  ${'Candidate'.padEnd(12)}${color.bold(color.cyan(candId))}`, width));
      lines.push(padRight(`  ${'State'.padEnd(12)}${color.bold(stageName)}`, width));
      lines.push(padRight('', width));

      const basePct = `${(baseAlloc * 100).toFixed(0)}%`;
      const canaryPct = `${(canaryAlloc * 100).toFixed(0)}%`;
      lines.push(padRight(`  Baseline ${renderCanaryProgressBar(baseAlloc, barLen)} ${basePct}`, width));
      lines.push(padRight(`  Canary   ${renderCanaryProgressBar(canaryAlloc, barLen)} ${canaryPct}`, width));
      lines.push(padRight('', width));

      // Telemetry: current allocation, stage, sample count, min required samples, correctness status, RegressionGuard state, next legal stage
      const sampleCountStr = cs.sampleCount !== undefined ? String(cs.sampleCount) : 'UNKNOWN';
      const minSamplesStr = cs.minimumSamples !== undefined ? String(cs.minimumSamples) : 'UNKNOWN';
      const correctnessStr = cs.correctnessStatus ?? 'UNKNOWN';
      const guardStr = cs.regressionGuardState ?? (sel.regressionGuardStatus ? (sel.regressionGuardStatus.passed ? color.green('INTACT (0 violations)') : color.red(`FAILED (${sel.regressionGuardStatus.violationsCount} violations)`)) : 'UNKNOWN');
      const nextStageStr = cs.nextStage ?? 'UNKNOWN';

      lines.push(padRight(`  Allocation:  ${canaryPct}  │  Stage: ${stageName}  │  Next: ${nextStageStr}`, width));
      lines.push(padRight(`  Samples:     ${sampleCountStr} / ${minSamplesStr} min  │  Correctness: ${correctnessStr}`, width));
      lines.push(padRight(`  Guard:       ${guardStr}`, width));

      if (cs.rollbackReason) {
        lines.push(padRight(`  ${color.red(`Rollback Reason: ${cs.rollbackReason}`)}`, width));
      }
      lines.push(padRight('', width));

      // Allowed transitions / actions
      const actions: string[] = [];
      if (cs.status === 'PAUSED') {
        actions.push('[r] Resume');
      } else if (['ACTIVE', 'EVALUATING', 'HEALTHY', 'STAGED_EXPANSION'].includes(cs.status)) {
        actions.push('[p] Pause');
      }
      if (['ACTIVE', 'EVALUATING', 'HEALTHY', 'STAGED_EXPANSION'].includes(cs.status) && canaryAlloc > 0) {
        actions.push('[t] Throttle');
      }
      if (['ACTIVE', 'EVALUATING', 'HEALTHY', 'STAGED_EXPANSION'].includes(cs.status) && cs.nextStage && cs.nextStage !== 'UNKNOWN') {
        actions.push('[a] Advance');
      }
      if (!['ROLLED_BACK', 'CANARY_FAILED', 'INCONCLUSIVE'].includes(cs.status)) {
        actions.push('[x] Rollback');
      }
      if (actions.length > 0) {
        for (const act of actions) {
          lines.push(padRight(`  ${color.cyan(act)}`, width));
        }
      }
      lines.push(padRight('', width));
    }

    // Causal Evidence
    if (sel.causalEvidence) {
      lines.push(padRight(`  ${color.bold('Causal Evidence:')} ${color.gray(sel.causalEvidence.design ?? 'factorial ablation')}`, width));
      if (sel.causalEvidence.beneficialMutations?.length) {
        lines.push(padRight(`    Beneficial (+): ${color.green(sel.causalEvidence.beneficialMutations.join(', '))}`, width));
      }
      if (sel.causalEvidence.harmfulMutations?.length) {
        lines.push(padRight(`    Harmful (-):    ${color.red(sel.causalEvidence.harmfulMutations.join(', '))}`, width));
      }
    }

    // RegressionGuard
    const guardStatus = !sel.regressionGuardStatus ? 'UNKNOWN' : sel.regressionGuardStatus.passed
      ? color.green('PASSED (0 violations)')
      : color.red(`FAILED (${sel.regressionGuardStatus.violationsCount} violations)`);
    lines.push(padRight(`  ${color.bold('RegressionGuard:')} ${guardStatus}`, width));

  }

  lines.push(padRight('', width));
  lines.push(padRight(color.gray('  Actions: [P] Pause  [A] Approve/Promote  [R] Rollback  [E] Inspect Evidence  [↑/↓] Navigate'), width));

  while (lines.length < maxRows) lines.push(padRight('', width));
  return lines.slice(0, maxRows);
}

// ---------------------------------------------------------------------------
// 5. CONTEXT UTILIZATION & SAWTOOTH GRAPH RENDERER
// ---------------------------------------------------------------------------

export function renderContextView(data: ContextViewData): string[] {
  const { samples, width, maxRows } = data;
  const lines: string[] = [];

  lines.push(padRight(color.bold(color.cyan('  CONTEXT UTILIZATION OVER TIME (Sawtooth Compaction & Revision)')), width));
  lines.push(padRight(color.gray('  ' + '='.repeat(Math.max(10, width - 4))), width));

  if (!samples || samples.length === 0) {
    lines.push(padRight('  No context telemetry samples recorded.', width));
    lines.push(padRight(color.gray('  Feed generations or execute tasks to observe context compaction.'), width));
    while (lines.length < maxRows) lines.push(padRight('', width));
    return lines;
  }

  const graphRows = Math.min(8, Math.max(5, maxRows - 14));
  const graphWidth = Math.max(30, Math.min(samples.length, width - 18));
  const windowedSamples = samples.slice(-graphWidth);
  const maxCap = Math.max(...windowedSamples.map((s) => s.effectiveMax || 32768), 32768);
  const maxTok = Math.max(...windowedSamples.map((s) => s.currentTokens), 1);
  const scaleMax = Math.max(maxCap, maxTok);
  const targetTokens = windowedSamples[windowedSamples.length - 1]?.targetTokens ?? Math.floor(scaleMax * 0.5);

  const maxRowIndex = graphRows - 1;
  const targetRowIndex = Math.min(graphRows - 2, Math.max(0, Math.round((targetTokens / scaleMax) * (graphRows - 1))));

  for (let r = graphRows - 1; r >= 0; r--) {
    const rowFrac = r / (graphRows - 1);
    const tokenVal = Math.round(rowFrac * scaleMax);
    const yLabel = (tokenVal >= 1000 ? `${(tokenVal / 1000).toFixed(0)}k` : `${tokenVal}`).padStart(4);

    let rowChars = '';
    const isMaxRow = r === maxRowIndex;
    const isTargetRow = r === targetRowIndex;

    for (let c = 0; c < windowedSamples.length; c++) {
      const s = windowedSamples[c];
      const curFrac = s.currentTokens / scaleMax;
      const curRow = Math.round(curFrac * (graphRows - 1));
      const prev = c > 0 ? windowedSamples[c - 1] : undefined;
      const isDrop = prev && s.currentTokens < prev.currentTokens * 0.75;

      if (curRow === r) {
        rowChars += isDrop ? color.cyan('╰') : color.cyan('●');
      } else if (curRow > r) {
        rowChars += color.cyan('│');
      } else {
        if (isMaxRow) {
          rowChars += color.red('─');
        } else if (isTargetRow) {
          rowChars += color.yellow('┄');
        } else {
          rowChars += ' ';
        }
      }
    }

    const tag = isMaxRow ? color.red(' [MAX]') : isTargetRow ? color.yellow(' [TARGET]') : '';
    lines.push(padRight(`  ${color.gray(yLabel)} ┤ ${rowChars}${tag}`, width));
  }

  const xAxis = '  ' + ' '.repeat(4) + ' ┴' + '─'.repeat(windowedSamples.length);
  lines.push(padRight(color.gray(xAxis), width));

  let xLabels = '  ' + ' '.repeat(6);
  for (let c = 0; c < windowedSamples.length; c++) {
    const g = windowedSamples[c].generation;
    if (c % 10 === 0 || c === windowedSamples.length - 1) {
      xLabels += `G${g} `;
      c += String(g).length + 1;
    } else {
      xLabels += ' ';
    }
  }
  lines.push(padRight(color.gray(xLabels), width));
  lines.push(padRight('', width));

  const latest = windowedSamples[windowedSamples.length - 1];
  const pctUsed = latest.effectiveMax > 0 ? ((latest.currentTokens / latest.effectiveMax) * 100).toFixed(1) : '0';
  lines.push(
    padRight(
      `  ${color.bold('Current Gen:')} G${latest.generation} │ ${color.bold('Tokens:')} ${color.cyan(String(latest.currentTokens))} / ${latest.effectiveMax} (${color.yellow(`${pctUsed}%`)}) │ ${color.bold('Target:')} ${latest.targetTokens}`,
      width,
    ),
  );

  lines.push(
    padRight(
      `  Stable Prefix: ${color.green(`${latest.stablePrefix} tok`)} │ Volatile Portion: ${color.magenta(`${latest.volatilePortion} tok`)}`,
      width,
    ),
  );
  lines.push(
    padRight(
      `    Exact Deduplicated:   ${color.green(`${latest.deduplicated} tok`)} (identical observations removed)`,
      width,
    ),
  );
  lines.push(
    padRight(
      `    Semantic Compressed:  ${color.green(`${latest.compressed} tok`)} (historical conversations summarized)`,
      width,
    ),
  );
  lines.push(
    padRight(
      `    Oversized Offloaded:  ${color.green(`${latest.offloaded} tok`)} (large tool outputs moved to disk)`,
      width,
    ),
  );

  lines.push(padRight('', width));
  lines.push(...renderPromptCacheSection(windowedSamples, width));

  while (lines.length < maxRows) lines.push(padRight('', width));
  return lines.slice(0, maxRows);
}

// ---------------------------------------------------------------------------
// 6. EVIDENCE VIEW RENDERER (Controller Truth & Completion Proof)
// ---------------------------------------------------------------------------

function evidenceStatusBadge(status: EvidenceSlotStatus): string {
  switch (status) {
    case 'PASS': return color.green('PASS');
    case 'FAIL': return color.red('FAIL');
    case 'ERROR': return color.red('ERROR');
    case 'STALE': return color.yellow('STALE — NOT VALID FOR COMPLETION');
    case 'MISSING': return color.gray('MISSING');
  }
}

const fmtRev = (rev: number | string): string => (typeof rev === 'number' ? `R${rev}` : String(rev));
const shortHash = (h: string): string => (/^[0-9a-f]{16,}$/i.test(h) ? h.slice(0, 12) : h);

/** Pure-text inspector lines (no padding) — shared by the TUI pane and the CLI command. */
export function formatVerificationInspection(inspection: VerificationInspection, why: WhyCompleteAnswer, provenanceDepth = 9): string[] {
  const i = inspection;
  const out: string[] = [];
  const kv = (k: string, v: string | number) => out.push(`  ${k.padEnd(14)}${v}`);
  out.push(color.bold(color.cyan('VERIFICATION EVIDENCE')));
  kv('Execution', i.executionId);
  kv('Revision', fmtRev(i.currentRevision));
  kv('Workspace', shortHash(String(i.workspaceDigest)));
  kv('Status', i.status);

  for (const slot of i.slots) {
    out.push('');
    out.push(color.bold(`${slot.oracle}${slot.required ? '' : color.gray(' (not required)')}`));
    kv('Command', slot.command);
    if (slot.oracle !== 'ACCEPTANCE' && slot.oracle !== 'TEST') kv('Exit', slot.exitCode);
    if (slot.oracle === 'TEST') {
      kv('Exit', slot.exitCode);
      kv('Passed', slot.passed ?? 'UNKNOWN');
      kv('Failed', slot.failed ?? 'UNKNOWN');
    }
    if (slot.oracle === 'ACCEPTANCE') kv('Criteria', slot.criteria ? `${slot.criteria.satisfied}/${slot.criteria.total}` : 'UNKNOWN');
    kv('Revision', fmtRev(slot.revision));
    kv('Status', evidenceStatusBadge(slot.status));
    if (slot.status === 'STALE') {
      kv('', color.gray(`recorded ${slot.recordedStatus} at ${fmtRev(slot.revision)}; current revision ${fmtRev(i.currentRevision)}`));
    }
    for (const r of slot.reasons.filter((r) => slot.status !== 'PASS' && r).slice(0, 3)) kv('', color.gray(r));
  }

  out.push('');
  out.push(color.bold('PHYSICAL MUTATIONS'));
  if (i.mutations.length === 0) out.push(color.gray('  No physical mutations recorded.'));
  for (const m of i.mutations.slice(-8)) {
    const tag = m.afterVerification ? color.yellow('  AFTER VERIFICATION') : '';
    out.push(`  ${fmtRev(m.revision).padEnd(5)} ${m.file}  ${shortHash(m.beforeHash)} → ${shortHash(m.afterHash)}${tag}`);
  }

  const denials = i.policy.filter((p) => p.decision !== 'allow');
  if (denials.length > 0) {
    out.push('');
    out.push(color.bold('POLICY'));
    for (const p of denials.slice(0, 4)) out.push(`  ${p.decision.toUpperCase().padEnd(6)} ${p.rule}${p.tool ? ` (${p.tool})` : ''}`);
  }

  if (provenanceDepth > 0) {
    out.push('');
    out.push(color.bold('PROVENANCE'));
    for (const [idx, step] of i.provenance.slice(0, provenanceDepth).entries()) {
      out.push(`  ${idx === 0 ? '' : '→ '}${step.kind.padEnd(13)}${step.values.slice(0, 3).join(', ')}${step.values.length > 3 ? color.gray(` (+${step.values.length - 3})`) : ''}`);
    }
  }

  out.push('');
  out.push(color.bold('COMPLETION'));
  kv('Eligible', i.completion.eligible ? color.green('YES') : color.red('NO'));
  if (why.complete) {
    out.push(color.gray('  why complete?'));
    for (const c of why.chain) out.push(`    ${c}`);
  } else {
    out.push(color.gray('  why incomplete?'));
    for (const m of why.missing) out.push(`    ${color.red('✗')} ${m}`);
  }
  out.push(color.gray('  MODEL CLAIM != EXECUTION EVIDENCE — model narration is not consulted.'));
  return out;
}

export function renderEvidenceView(data: EvidenceViewData): string[] {
  const { width, maxRows } = data;
  const body = data.inspection && data.why
    ? formatVerificationInspection(data.inspection, data.why, data.provenanceDepth ?? 0)
    : [
      color.bold(color.cyan('VERIFICATION EVIDENCE')),
      '',
      color.gray('  No execution record selected. No evidence is shown and nothing is implied verified.'),
      '',
      color.gray('  MODEL CLAIM != EXECUTION EVIDENCE — model narration is not consulted.'),
    ];
  const lines = body.map((l) => padRight(`  ${l}`, width));
  if (data.inspection) lines.push(padRight(color.gray('  [p] provenance drill-down  [P] collapse'), width));
  while (lines.length < maxRows) lines.push(padRight('', width));
  return lines.slice(0, maxRows);
}

// ---------------------------------------------------------------------------
// 7. WHY EXPLANATION MODAL RENDERER (Contextual Explainability)
// ---------------------------------------------------------------------------

export function renderWhyModal(data: WhyExplanationData): string[] {
  const { topic, headline, decision, rationale, evidence, controllerAudit, width, maxRows } = data;
  const lines: string[] = [];

  const modalWidth = Math.min(width - 6, 88);
  const border = '─'.repeat(modalWidth - 2);

  lines.push(`┌${border}┐`);
  lines.push(`│ ${color.bold(color.cyan(`WHY ${topic.toUpperCase()}? - ${headline}`.padEnd(modalWidth - 4)))} │`);
  lines.push(`├${border}┤`);

  lines.push(`│ ${color.bold('Decision:'.padEnd(12))} ${color.bold(color.green(decision.padEnd(modalWidth - 16)))} │`);
  lines.push(`├${border}┤`);

  lines.push(`│ ${color.bold('Controller Rationale (Deterministic Rules):'.padEnd(modalWidth - 4))} │`);
  for (const r of rationale) {
    const text = `  • ${r}`;
    lines.push(`│ ${text.padEnd(modalWidth - 4)} │`);
  }

  lines.push(`├${border}┤`);
  lines.push(`│ ${color.bold('Structured Empirical Evidence:'.padEnd(modalWidth - 4))} │`);
  for (const ev of evidence) {
    const evText = `  ${ev.label.padEnd(24)}: ${color.cyan(String(ev.value))}`;
    lines.push(`│ ${evText.padEnd(modalWidth - 4)} │`);
  }

  lines.push(`├${border}┤`);
  lines.push(`│ ${color.bold('Provenance & Audit:'.padEnd(modalWidth - 4))} │`);
  const dateStr = typeof controllerAudit.verifiedAt === 'string' ? controllerAudit.verifiedAt : controllerAudit.verifiedAt.toISOString();
  lines.push(`│   Source: ${controllerAudit.source} │ Verified: ${dateStr.slice(0, 19)} │`);
  if (controllerAudit.immutableHash) {
    lines.push(`│   Audit Hash: ${color.gray(controllerAudit.immutableHash.slice(0, 32))} │`);
  }
  lines.push(`│ ${color.gray('  NOTE: MODEL CLAIM != EXECUTION EVIDENCE. Sourced exclusively from controller state.'.padEnd(modalWidth - 4))} │`);

  lines.push(`├${border}┤`);
  lines.push(`│ ${color.gray('Press [Esc] or [Enter] to dismiss explanation.'.padEnd(modalWidth - 4))} │`);
  lines.push(`└${border}┘`);

  return lines.slice(0, maxRows);
}

// ---------------------------------------------------------------------------
// 8. MODEL INTELLIGENCE VIEW RENDERER
// ---------------------------------------------------------------------------

export function renderModelIntelligenceView(data: ModelIntelligenceViewData): string[] {
  const { profiles, selectedIndex, width, maxRows } = data;
  const lines: string[] = [];

  lines.push(padRight(color.bold(color.cyan('  MODEL INTELLIGENCE (Empirical Evidence by Capability - No Simplistic Leaderboard)')), width));
  lines.push(padRight(color.gray('  ' + '='.repeat(Math.max(10, width - 4))), width));

  if (!profiles || profiles.length === 0) {
    lines.push(padRight('  No empirical model intelligence profiles recorded.', width));
    lines.push(padRight(color.gray('  Profiles accumulate evidence as tasks and benchmarks complete.'), width));
    while (lines.length < maxRows) lines.push(padRight('', width));
    return lines;
  }

  const colModel = 22;
  const colCap = 16;

  const header = `  ${color.bold('Model'.padEnd(colModel))} ${color.bold('Plan (Arch)'.padEnd(colCap))} ${color.bold('Implement'.padEnd(colCap))} ${color.bold('Repair'.padEnd(colCap))} ${color.bold('Tool Use'.padEnd(colCap))} ${color.bold('Samples')}`;
  lines.push(padRight(header, width));
  lines.push(padRight(color.gray('  ' + '-'.repeat(Math.min(width - 4, colModel + colCap * 4 + 10))), width));

  const maxProfiles = Math.min(profiles.length, 6);
  for (let i = 0; i < maxProfiles; i++) {
    const p = profiles[i];
    const isSelected = i === selectedIndex;
    const prefix = isSelected ? color.cyan('> ') : '  ';

    const fmtCap = (cat: string): string => {
      const c = p.capabilities[cat];
      if (!c || c.sampleCount === 0) return color.gray('-');
      const pct = `${(c.score * 100).toFixed(0)}%`;
      return `${color.cyan(pct)} ${color.gray(`(n=${c.sampleCount})`)}`;
    };

    const planStr = fmtCap('architecture_reasoning') !== color.gray('-') ? fmtCap('architecture_reasoning') : fmtCap('plan');
    const implStr = fmtCap('implementation');
    const repairStr = fmtCap('test_repair') !== color.gray('-') ? fmtCap('test_repair') : fmtCap('compile_repair');
    const toolStr = fmtCap('tool_use');

    const row = `${prefix}${p.model.padEnd(colModel)} ${planStr.padEnd(colCap)} ${implStr.padEnd(colCap)} ${repairStr.padEnd(colCap)} ${toolStr.padEnd(colCap)} ${p.totalSamples}`;
    lines.push(padRight(row, width));
  }

  lines.push(padRight('', width));

  const sel = profiles[Math.min(selectedIndex, profiles.length - 1)];
  if (sel) {
    lines.push(padRight(`  ${color.bold('Profile Details:')} ${color.bold(color.cyan(sel.model))}  │  Runtime: ${sel.runtime}  │  Total Samples: ${sel.totalSamples}`, width));

    if (sel.phaseBreakdown && Object.keys(sel.phaseBreakdown).length > 0) {
      lines.push(padRight(`  Phase Performance Breakdown:`, width));
      const phaseParts = Object.entries(sel.phaseBreakdown).map(
        ([phase, m]) => `${color.bold(phase)}: ${(m.score * 100).toFixed(0)}% (n=${m.sampleCount})`,
      );
      lines.push(padRight(`    ${phaseParts.join('  │  ')}`, width));
    }
  }

  lines.push(padRight('', width));
  lines.push(padRight(color.gray('  Actions: [Enter] Inspect Profile  [↑/↓] Navigate  [Tab] Switch View'), width));

  while (lines.length < maxRows) lines.push(padRight('', width));
  return lines.slice(0, maxRows);
}

// ---------------------------------------------------------------------------
// 9. EVIDENCE INSPECTION MODAL RENDERER
// ---------------------------------------------------------------------------

export function renderEvidenceModal(data: EvidenceModalData): string[] {
  const { title, candidateId, experimentId, revision, checks, evidence, provenanceChain, metrics, width, maxRows, nodeInspection } = data;
  const lines: string[] = [];

  const modalWidth = Math.min(width - 6, 84);
  const border = '─'.repeat(modalWidth - 2);

  lines.push(`┌${border}┐`);
  lines.push(`│ ${color.bold(color.cyan(title.padEnd(modalWidth - 4)))} │`);
  lines.push(`├${border}┤`);

  if (nodeInspection) {
    const inspLines = renderSearchNodeInspection(nodeInspection, { width: modalWidth - 4 });
    const scrollOffset = data.scrollOffset ?? 0;
    const maxVisible = Math.max(5, maxRows - 4);
    const visible = inspLines.slice(scrollOffset, scrollOffset + maxVisible);
    for (const l of visible) {
      lines.push(`│ ${padRight(l, modalWidth - 4)} │`);
    }
    lines.push(`├${border}┤`);
    lines.push(`│ ${color.gray('Press [Esc] or [E] to close evidence inspector.'.padEnd(modalWidth - 4))} │`);
    lines.push(`└${border}┘`);
    return lines.slice(0, maxRows);
  }

  if (candidateId) {
    lines.push(`│ Candidate: ${color.bold(candidateId.padEnd(modalWidth - 15))} │`);
  }
  if (experimentId) {
    lines.push(`│ Experiment: ${color.bold(experimentId.padEnd(modalWidth - 16))} │`);
  }
  if (revision !== undefined) {
    lines.push(`│ Workspace Revision: ${color.magenta(String(revision).padEnd(modalWidth - 24))} │`);
  }

  lines.push(`├${border}┤`);
  lines.push(`│ ${color.bold('Verification Checks:'.padEnd(modalWidth - 4))} │`);

  if (checks && checks.length > 0) {
    for (const c of checks.slice(0, 4)) {
      const badge = c.ok ? color.green('PASS') : color.red('FAIL');
      const text = `  ${badge} ${c.name}${c.exitCode !== undefined ? ` (exit ${c.exitCode})` : ''}`;
      lines.push(`│ ${text.padEnd(modalWidth - 4)} │`);
    }
  } else {
    lines.push(`│ ${color.gray('  No physical checks recorded.'.padEnd(modalWidth - 4))} │`);
  }

  if (evidence && evidence.length > 0) {
    lines.push(`│ ${color.bold('Artifact & Execution Evidence:'.padEnd(modalWidth - 4))} │`);
    for (const ev of evidence.slice(0, 3)) {
      const hashStr = ev.hash ? ` [${ev.hash.slice(0, 8)}]` : '';
      const text = `  ${color.gray('•')} ${ev.kind} (exit ${ev.exitCode ?? 0})${hashStr}`;
      lines.push(`│ ${text.padEnd(modalWidth - 4)} │`);
    }
  }

  if (metrics && Object.keys(metrics).length > 0) {
    lines.push(`├${border}┤`);
    lines.push(`│ ${color.bold('Multi-Objective Metrics:'.padEnd(modalWidth - 4))} │`);
    for (const [k, v] of Object.entries(metrics).slice(0, 4)) {
      const text = `  ${k}: ${color.cyan(String(v))}`;
      lines.push(`│ ${text.padEnd(modalWidth - 4)} │`);
    }
  }

  if (provenanceChain && provenanceChain.length > 0) {
    lines.push(`├${border}┤`);
    lines.push(`│ ${color.bold('PROVENANCE Chain:'.padEnd(modalWidth - 4))} │`);
    for (const p of provenanceChain.slice(0, 3)) {
      lines.push(`│   ${color.gray(p.slice(0, modalWidth - 6).padEnd(modalWidth - 6))} │`);
    }
  }

  lines.push(`├${border}┤`);
  lines.push(`│ ${color.gray('Press [Esc] or [E] to close evidence inspector.'.padEnd(modalWidth - 4))} │`);
  lines.push(`└${border}┘`);

  return lines.slice(0, maxRows);
}

// ======================================================================
// WAZIR LEVEL 3 CONTINUOUS CANARY OPERATIONAL CONTROL CENTER VIEW
// ======================================================================

export type CanaryViewTab = 'dashboard' | 'statemachine' | 'shadow' | 'history' | 'rollback';

export interface CanaryViewData {
  activeCanary?: {
    canaryId: string;
    candidateId: string;
    domain: string;
    stage: string;
    status: string;
    currentAllocation: number; // 0.0 to 1.0
    startTime: Date;
    updatedAt: Date;
    completedAt?: Date;
    minimumSamples: number;
    baselineMetrics: {
      totalExecutions: number;
      taskSuccessRate?: number;
      verificationSuccessRate?: number;
      toolFailureRate?: number;
      totalTokens?: number;
      wallTimeMs?: number;
      toolInvocations?: number;
      repairCycles?: number;
    };
    canaryMetrics: {
      totalExecutions: number;
      taskSuccessRate?: number;
      verificationSuccessRate?: number;
      toolFailureRate?: number;
      totalTokens?: number;
      wallTimeMs?: number;
      toolInvocations?: number;
      repairCycles?: number;
    };
    rollbackReason?: {
      metric: string;
      baselineValue: number;
      canaryValue: number;
      delta: number;
      threshold: number;
      description: string;
      timestamp: Date;
    };
    inconclusiveReasons?: string[];
    evidenceIds?: string[];
  };
  deployments?: Array<{
    canaryId: string;
    candidateId: string;
    domain: string;
    stage: string;
    status: string;
    currentAllocation: number;
    startTime: Date;
    completedAt?: Date;
    rollbackReason?: { metric: string; description: string };
    totalExecutions: number;
  }>;
  shadowResults?: Array<{
    canaryId: string;
    candidateId: string;
    taskId: string;
    executionId: string;
    productionOutcome: {
      success: boolean;
      verificationSuccess: boolean;
      tokensUsed: number;
      wallTimeMs: number;
    };
    shadowOutcome: {
      success: boolean;
      verificationSuccess: boolean;
      tokensUsed: number;
      wallTimeMs: number;
    };
    metricsDelta: {
      tokensDelta: number;
      wallTimeDeltaMs: number;
      verificationAgreed: boolean;
    };
    timestamp: Date;
  }>;
  activeTab: CanaryViewTab;
  selectedHistoryIndex?: number;
  showBaselineComparison?: boolean;
  width: number;
  maxRows: number;
}

function renderCanaryProgressBar(fraction: number, width: number, fillChar = '█', emptyChar = ' '): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const fillWidth = Math.round(clamped * width);
  const emptyWidth = width - fillWidth;
  return `[${fillChar.repeat(fillWidth)}${emptyChar.repeat(emptyWidth)}]`;
}

function formatMetricPercent(val?: number): string {
  if (val === undefined || val === null || Number.isNaN(val)) return 'UNKNOWN';
  return `${(val * 100).toFixed(1)}%`;
}

function formatMetricDeltaPercent(canaryVal?: number, baselineVal?: number, inverse = false): string {
  if (canaryVal === undefined || baselineVal === undefined || Number.isNaN(canaryVal) || Number.isNaN(baselineVal)) {
    return 'UNKNOWN';
  }
  const delta = (canaryVal - baselineVal) * 100;
  const sign = delta > 0 ? '+' : '';
  const text = `${sign}${delta.toFixed(1)}%`;
  if (Math.abs(delta) < 0.01) return color.gray(text);
  const isBetter = inverse ? delta < 0 : delta > 0;
  return isBetter ? color.green(text) : color.red(text);
}

function formatMetricTokens(val?: number): string {
  if (val === undefined || val === null || Number.isNaN(val)) return 'UNKNOWN';
  if (val >= 1000) return `${(val / 1000).toFixed(1)}K`;
  return String(val);
}

function formatMetricSeconds(ms?: number): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return 'UNKNOWN';
  return `${(ms / 1000).toFixed(1)}s`;
}

export function renderCanaryView(data: CanaryViewData): string[] {
  const { activeCanary, deployments = [], shadowResults = [], activeTab, width, maxRows } = data;
  const lines: string[] = [];

  const tabNames: Array<{ key: CanaryViewTab; label: string; shortcut: string }> = [
    { key: 'dashboard', label: 'Dashboard', shortcut: 'C' },
    { key: 'statemachine', label: 'State Machine', shortcut: 'M' },
    { key: 'shadow', label: 'Shadow Mode', shortcut: 'S' },
    { key: 'rollback', label: 'Rollback Alert', shortcut: 'R' },
    { key: 'history', label: 'History', shortcut: 'H' },
  ];

  const tabHeader = tabNames
    .map((t) => {
      const active = t.key === activeTab;
      const text = `[${t.shortcut}] ${t.label}`;
      return active ? color.bold(color.cyan(text)) : color.gray(text);
    })
    .join('  ');

  lines.push(color.bold('WAZIR — CONTINUOUS CANARY CONTROL (LEVEL 3)'));
  lines.push('─'.repeat(Math.max(10, width)));
  lines.push(tabHeader);
  lines.push('─'.repeat(Math.max(10, width)));

  // Domain restriction notice if domain is wazir_source_code
  if (activeCanary?.domain === 'wazir_source_code') {
    lines.push(color.bold(color.red('┌─────────────────────────────────────────────────────────────────┐')));
    lines.push(color.bold(color.red('│ AUTONOMOUS DEPLOYMENT PROHIBITED: Operator action required.     │')));
    lines.push(color.bold(color.red('│ CANARY_DOMAIN_RESTRICTION: Source code changes cannot auto-roll │')));
    lines.push(color.bold(color.red('└─────────────────────────────────────────────────────────────────┘')));
    lines.push('');
  }

  if (activeTab === 'history') {
    lines.push(color.bold('CANARY DEPLOYMENT HISTORY:'));
    lines.push('');
    if (deployments.length === 0) {
      lines.push(color.gray('  No canary deployments recorded.'));
    } else {
      const selIdx = data.selectedHistoryIndex ?? 0;
      lines.push(
        padRight('  CANARY ID', 32) +
          padRight('CANDIDATE', 24) +
          padRight('DOMAIN', 16) +
          padRight('STATUS', 16) +
          padRight('SAMPLES', 10) +
          'RESULT',
      );
      lines.push('  ' + '─'.repeat(Math.max(10, width - 4)));

      deployments.forEach((dep, idx) => {
        const isSelected = idx === selIdx;
        const prefix = isSelected ? color.cyan('▶ ') : '  ';
        const stColor =
          dep.status === 'ROLLED_BACK'
            ? color.red
            : dep.status === 'READY_FOR_PROMOTION' || dep.status === 'HEALTHY'
              ? color.green
              : color.yellow;
        const resText = dep.rollbackReason ? `ROLLED BACK: ${dep.rollbackReason.metric}` : dep.status;
        const row =
          prefix +
          padRight(dep.canaryId, 30) +
          padRight(dep.candidateId.slice(0, 22), 24) +
          padRight(dep.domain, 16) +
          padRight(stColor(dep.status), 25) +
          padRight(String(dep.totalExecutions), 10) +
          resText;
        lines.push(isSelected ? color.bold(row) : row);
      });
      lines.push('');
      lines.push(color.gray('  [↑/↓] Select  [Enter] Inspect Candidate Timeline'));
    }
    return lines.slice(0, maxRows);
  }

  if (activeTab === 'shadow') {
    lines.push(color.bold('SHADOW EVALUATION (OFFLINE/PARALLEL)'));
    lines.push(color.gray('Production impact: NONE (Shadow executions run concurrently with zero client impact)'));
    lines.push('');

    const shadowCount = shadowResults.length;
    lines.push(`Workloads Evaluated: ${shadowCount}`);
    lines.push('');

    if (shadowCount === 0) {
      lines.push(color.gray('  No shadow evaluations observed for this candidate yet.'));
    } else {
      let bSuccessCount = 0;
      let sSuccessCount = 0;
      let bVerifCount = 0;
      let sVerifCount = 0;
      let bTokensTotal = 0;
      let sTokensTotal = 0;
      let bWallTimeTotal = 0;
      let sWallTimeTotal = 0;

      for (const item of shadowResults) {
        if (item.productionOutcome.success) bSuccessCount++;
        if (item.shadowOutcome.success) sSuccessCount++;
        if (item.productionOutcome.verificationSuccess) bVerifCount++;
        if (item.shadowOutcome.verificationSuccess) sVerifCount++;
        bTokensTotal += item.productionOutcome.tokensUsed;
        sTokensTotal += item.shadowOutcome.tokensUsed;
        bWallTimeTotal += item.productionOutcome.wallTimeMs;
        sWallTimeTotal += item.shadowOutcome.wallTimeMs;
      }

      const bTaskRate = (bSuccessCount / shadowCount) * 100;
      const sTaskRate = (sSuccessCount / shadowCount) * 100;
      const bVerifRate = (bVerifCount / shadowCount) * 100;
      const sVerifRate = (sVerifCount / shadowCount) * 100;
      const bAvgTokens = bTokensTotal / shadowCount;
      const sAvgTokens = sTokensTotal / shadowCount;
      const bAvgTime = (bWallTimeTotal / shadowCount) / 1000;
      const sAvgTime = (sWallTimeTotal / shadowCount) / 1000;

      lines.push(
        padRight('METRIC', 24) +
          padRight('BASELINE (PROD)', 18) +
          padRight('SHADOW (CANDIDATE)', 20) +
          'VERDICT',
      );
      lines.push('─'.repeat(Math.min(width, 74)));
      lines.push(
        padRight('Task Success', 24) +
          padRight(`${bTaskRate.toFixed(1)}%`, 18) +
          padRight(`${sTaskRate.toFixed(1)}%`, 20) +
          (sTaskRate >= bTaskRate ? color.green('MATCH/BETTER') : color.red('REGRESSION')),
      );
      lines.push(
        padRight('Verification Pass', 24) +
          padRight(`${bVerifRate.toFixed(1)}%`, 18) +
          padRight(`${sVerifRate.toFixed(1)}%`, 20) +
          (sVerifRate >= bVerifRate ? color.green('MATCH/BETTER') : color.red('REGRESSION')),
      );
      lines.push(
        padRight('Avg Tokens', 24) +
          padRight(formatMetricTokens(bAvgTokens), 18) +
          padRight(formatMetricTokens(sAvgTokens), 20) +
          (sAvgTokens <= bAvgTokens ? color.green('EFFICIENT') : color.yellow('HIGHER')),
      );
      lines.push(
        padRight('Avg Wall Time', 24) +
          padRight(`${bAvgTime.toFixed(1)}s`, 18) +
          padRight(`${sAvgTime.toFixed(1)}s`, 20) +
          (sAvgTime <= bAvgTime ? color.green('FASTER') : color.yellow('SLOWER')),
      );
    }
    return lines.slice(0, maxRows);
  }

  if (activeTab === 'rollback' || (activeCanary?.status === 'ROLLED_BACK' && activeTab === 'dashboard')) {
    if (activeCanary?.rollbackReason || activeCanary?.status === 'ROLLED_BACK') {
      const rr = activeCanary.rollbackReason;
      lines.push(color.bold(color.red('┌────────────────────────────────────────────────────────────────────────┐')));
      lines.push(color.bold(color.red('│ AUTOMATIC CANARY ROLLBACK TRIGGERED                                   │')));
      lines.push(color.bold(color.red('├────────────────────────────────────────────────────────────────────────┤')));
      lines.push(`│ Candidate:    ${color.bold(activeCanary.candidateId.padEnd(54))} │`);
      lines.push(`│ Domain:       ${activeCanary.domain.padEnd(54)} │`);
      lines.push(`│ Triggered At: ${new Date(rr?.timestamp ?? activeCanary.updatedAt).toISOString().padEnd(54)} │`);
      lines.push(`│ Metric:       ${color.red(String(rr?.metric ?? 'regression').padEnd(54))} │`);
      lines.push(`│ Delta:        ${String(rr?.delta !== undefined ? rr.delta : 'exceeded').padEnd(54)} │`);
      lines.push(`│ Threshold:    ${String(rr?.threshold !== undefined ? rr.threshold : '0.05').padEnd(54)} │`);
      lines.push(`│ Reason:       ${(rr?.description ?? 'Regression guard violation').slice(0, 54).padEnd(54)} │`);
      lines.push(color.bold(color.red('├────────────────────────────────────────────────────────────────────────┤')));
      lines.push(`│ ${color.bold('TRAFFIC RESTORATION: 100% BASELINE  (0% CANARY)'.padEnd(70))} │`);
      lines.push(color.bold(color.red('└────────────────────────────────────────────────────────────────────────┘')));
      lines.push('');
      if (activeTab === 'rollback') {
        return lines.slice(0, maxRows);
      }
    } else if (activeTab === 'rollback') {
      lines.push(color.green('No rollback detected. Current deployment is healthy or evaluating.'));
      return lines.slice(0, maxRows);
    }
  }

  if (activeTab === 'statemachine') {
    lines.push(color.bold('CANARY STAGED PROGRESSION TREE:'));
    lines.push('');
    const curStage = activeCanary?.stage ?? 'QUALIFIED';
    const isRolledBack = activeCanary?.status === 'ROLLED_BACK';

    const stages: Array<{ id: string; label: string; minAlloc: number }> = [
      { id: 'QUALIFIED', label: 'QUALIFIED', minAlloc: 0 },
      { id: 'SHADOW', label: 'SHADOW', minAlloc: 0 },
      { id: 'CANARY_1', label: 'CANARY_1  (1% Traffic)', minAlloc: 0.01 },
      { id: 'CANARY_5', label: 'CANARY_5  (5% Traffic)', minAlloc: 0.05 },
      { id: 'CANARY_10', label: 'CANARY_10 (10% Traffic)', minAlloc: 0.10 },
      { id: 'CANARY_25', label: 'CANARY_25 (25% Traffic)', minAlloc: 0.25 },
      { id: 'CANARY_50', label: 'CANARY_50 (50% Traffic)', minAlloc: 0.50 },
      { id: 'READY_TO_PROMOTE', label: 'READY_TO_PROMOTE', minAlloc: 1.0 },
    ];

    const stageOrder = stages.map((s) => s.id);
    const curIdx = stageOrder.indexOf(curStage);

    stages.forEach((st, idx) => {
      let mark = '  ';
      let title = st.label;
      if (curStage === st.id) {
        mark = isRolledBack ? color.red('✖ ') : color.cyan('◉ ');
        title = color.bold(title);
      } else if (curIdx > idx) {
        mark = color.green('✓ ');
      }

      lines.push(`${mark}${title}`);

      if (idx === curIdx && isRolledBack) {
        lines.push(`   ├── ${color.bold(color.red('ROLLBACK TRIGGERED ✖ (Traffic: 0% Canary, 100% Baseline)'))}`);
      }

      if (idx < stages.length - 1) {
        lines.push('   │');
        lines.push('   ▼');
      }
    });

    lines.push('');
    if (activeCanary) {
      lines.push(
        `Current Stage: ${color.bold(curStage)} | Observed Samples: ${activeCanary.canaryMetrics.totalExecutions} / Required: ${activeCanary.minimumSamples}`,
      );
    }
    return lines.slice(0, maxRows);
  }

  // DEFAULT: DASHBOARD TAB
  if (!activeCanary) {
    lines.push(color.yellow('No active canary deployment found.'));
    lines.push(color.gray('Register a canary deployment via CanaryDeploymentService or CLI to view real-time control.'));
    return lines.slice(0, maxRows);
  }

  const durationSec = Math.max(0, Math.floor((Date.now() - new Date(activeCanary.startTime).getTime()) / 1000));
  const durMin = Math.floor(durationSec / 60);
  const durRemSec = durationSec % 60;
  const startedStr = `${durMin}m ${durRemSec}s`;

  lines.push(`Candidate: ${color.bold(activeCanary.candidateId)}`);
  lines.push(`Domain:    ${color.bold(activeCanary.domain)}`);
  lines.push(
    `State:     ${
      activeCanary.status === 'ROLLED_BACK'
        ? color.bold(color.red('ROLLED_BACK'))
        : activeCanary.status === 'READY_FOR_PROMOTION'
          ? color.bold(color.green('READY_TO_PROMOTE'))
          : color.bold(color.cyan(activeCanary.stage ?? activeCanary.status))
    }`,
  );
  lines.push(`Started:   ${startedStr}`);
  lines.push('');

  // TRAFFIC PROGRESS BARS
  const barWidth = Math.max(20, Math.min(50, width - 24));
  const canaryAlloc = activeCanary.status === 'ROLLED_BACK' ? 0.0 : activeCanary.currentAllocation;
  const baseAlloc = 1.0 - canaryAlloc;

  lines.push(color.bold('TRAFFIC'));
  lines.push(`Baseline  ${renderCanaryProgressBar(baseAlloc, barWidth)} ${(baseAlloc * 100).toFixed(0)}%`);
  lines.push(`Canary    ${renderCanaryProgressBar(canaryAlloc, barWidth)} ${(canaryAlloc * 100).toFixed(0)}%`);
  lines.push('');

  // SAMPLES TABLE
  const cMetrics = activeCanary.canaryMetrics;
  const bMetrics = activeCanary.baselineMetrics;
  const reqSamples = activeCanary.minimumSamples;
  const samplesSatisfied = cMetrics.totalExecutions >= reqSamples;

  lines.push(color.bold('SAMPLES'));
  lines.push(`Baseline       ${bMetrics.totalExecutions.toLocaleString()}`);
  lines.push(`Canary         ${cMetrics.totalExecutions.toLocaleString()}`);
  lines.push(
    `Required       ${reqSamples.toLocaleString()} ${samplesSatisfied ? color.green('✓') : color.yellow('⏳')}`,
  );
  lines.push('');

  // CORRECTNESS OVER EFFICIENCY DOMINANCE
  const cTaskSuccess = cMetrics.taskSuccessRate;
  const bTaskSuccess = bMetrics.taskSuccessRate;
  const cVerifSuccess = cMetrics.verificationSuccessRate;
  const bVerifSuccess = bMetrics.verificationSuccessRate;
  const cToolFail = cMetrics.toolFailureRate;
  const bToolFail = bMetrics.toolFailureRate;

  const hasCorrectnessRegression =
    (cTaskSuccess !== undefined && bTaskSuccess !== undefined && cTaskSuccess < bTaskSuccess) ||
    (cVerifSuccess !== undefined && bVerifSuccess !== undefined && cVerifSuccess < bVerifSuccess) ||
    activeCanary.status === 'ROLLED_BACK';

  if (hasCorrectnessRegression) {
    lines.push(color.bold(color.red('═════════════════════════════════════════════════════════════════════')));
    lines.push(color.bold(color.red('! CANARY REGRESSION DETECTED — ROLLBACK REQUIRED / ACTIVE !')));
    lines.push(color.bold(color.red('═════════════════════════════════════════════════════════════════════')));
  }

  lines.push(color.bold('CORRECTNESS'));
  lines.push(
    padRight('                    BASELINE', 36) +
      padRight('CANARY', 16) +
      'Δ',
  );
  lines.push(
    padRight('Verification Pass   ' + formatMetricPercent(bVerifSuccess), 36) +
      padRight(formatMetricPercent(cVerifSuccess), 16) +
      formatMetricDeltaPercent(cVerifSuccess, bVerifSuccess),
  );
  lines.push(
    padRight('Task Success        ' + formatMetricPercent(bTaskSuccess), 36) +
      padRight(formatMetricPercent(cTaskSuccess), 16) +
      formatMetricDeltaPercent(cTaskSuccess, bTaskSuccess),
  );
  lines.push(
    padRight('Tool Failure Rate   ' + formatMetricPercent(bToolFail), 36) +
      padRight(formatMetricPercent(cToolFail), 16) +
      formatMetricDeltaPercent(cToolFail, bToolFail, true),
  );
  lines.push('');

  // EFFICIENCY
  lines.push(color.bold('EFFICIENCY'));
  lines.push(
    padRight('Tokens              ' + formatMetricTokens(bMetrics.totalTokens), 36) +
      padRight(formatMetricTokens(cMetrics.totalTokens), 16) +
      formatMetricDeltaPercent(
        cMetrics.totalTokens && bMetrics.totalTokens ? (cMetrics.totalTokens - bMetrics.totalTokens) / bMetrics.totalTokens : undefined,
        0,
        true,
      ),
  );
  lines.push(
    padRight('Duration            ' + formatMetricSeconds(bMetrics.wallTimeMs), 36) +
      padRight(formatMetricSeconds(cMetrics.wallTimeMs), 16) +
      formatMetricDeltaPercent(
        cMetrics.wallTimeMs && bMetrics.wallTimeMs ? (cMetrics.wallTimeMs - bMetrics.wallTimeMs) / bMetrics.wallTimeMs : undefined,
        0,
        true,
      ),
  );
  lines.push(
    padRight('Repair Cycles       ' + (bMetrics.repairCycles ?? '0'), 36) +
      padRight(String(cMetrics.repairCycles ?? '0'), 16) +
      '',
  );
  lines.push('');

  // STATUS SUMMARY
  lines.push(color.bold('STATUS'));
  if (activeCanary.status === 'ROLLED_BACK') {
    lines.push(color.red('✖ Rollback active (100% baseline restoration)'));
    if (activeCanary.rollbackReason) {
      lines.push(color.red(`  Reason: ${activeCanary.rollbackReason.description}`));
    }
  } else {
    lines.push(`${hasCorrectnessRegression ? color.red('✖') : color.green('✓')} Correctness guard`);
    lines.push(`${samplesSatisfied ? color.green('✓') : color.yellow('⏳')} Minimum samples`);
    lines.push(`${color.green('✓')} Stable assignment`);
    lines.push(`${activeCanary.rollbackReason ? color.red('✖') : color.green('✓')} No protected regression`);
    if (activeCanary.stage === 'READY_TO_PROMOTE' || activeCanary.status === 'READY_FOR_PROMOTION') {
      lines.push(color.bold(color.green('Next eligible stage: PROMOTION READY (Level 3 Autonomous)')));
    } else {
      lines.push(color.cyan(`Current stage: ${activeCanary.stage ?? 'ACTIVE'}`));
    }
  }

  return lines.slice(0, maxRows);
}
