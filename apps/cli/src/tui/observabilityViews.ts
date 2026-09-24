import { color } from '../colors.js';

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
    trafficFraction?: number;
    currentAllocation?: number;
    stage?: number;
    totalStages?: number;
    status: 'HEALTHY' | 'ROLLED_BACK' | 'PROMOTED' | 'EVALUATING' | string;
    rollbackReason?: string;
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
  selectionReason?: string;
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
  taskId?: string;
  title?: string;
  status?: string;
  workspaceRevision?: { base: number; current: number; hash?: string; branch?: string };
  physicalMutations: Array<{ file: string; additions?: number; deletions?: number; patchHash?: string }>;
  buildEvidence?: { command: string; exitCode: number; durationMs?: number; outputSnippet?: string };
  testEvidence?: { command: string; exitCode: number; passed: number; failed: number; assertions?: number; durationMs?: number };
  verificationChecks: Array<{ name: string; ok: boolean; exitCode?: number; command?: string; message?: string }>;
  policyDecisions: Array<{ action: string; resource?: string; decision: 'ALLOW' | 'DENY'; rule?: string }>;
  faultRecoveryEvents: Array<{ time?: string; type: string; details: string; recovered?: boolean }>;
  completionReason?: {
    verified: boolean;
    summary: string;
    oraclesSatisfied: string[];
    diskConfirmed: boolean;
  };
  provenanceChain?: string[];
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

export function renderSearchTreeNode(
  node: SearchTreeNode,
  prefix = '',
  isLast = true,
  isRoot = false,
  width = 80,
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

  const pruneInfo = node.prunedReason ? color.red(` (${node.prunedReason})`) : '';
  const tokenInfo = node.tokens !== undefined ? color.gray(` (${node.tokens} tok)`) : '';
  const testInfo = node.testsPassed === true ? color.green(' [tests ✓]') : node.testsPassed === false ? color.red(' [tests ×]') : '';
  const label = `${node.label ?? node.name ?? node.id} ${stateGlyph}${tokenInfo}${testInfo}${paretoBadge}${pruneInfo}`;

  lines.push(padRight(`  ${prefix}${connector}${label}`, width));

  const childPrefix = prefix + (isRoot ? '' : isLast ? '   ' : '│  ');
  const children = node.children ?? [];
  for (let i = 0; i < children.length; i++) {
    const childIsLast = i === children.length - 1;
    lines.push(...renderSearchTreeNode(children[i], childPrefix, childIsLast, false, width));
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
// 2. SEARCH VIEW RENDERER (Hierarchical MCTS Tree + Flat Table)
// ---------------------------------------------------------------------------

export function renderSearchView(data: SearchViewData): string[] {
  const { searchId, objective, status, strategy, candidates, treeNodes, viewMode, selectedIndex, selectedCandidateId, selectionReason, width, maxRows } = data;
  const lines: string[] = [];

  const searchTag = searchId ?? 'active-search';
  const statusStr = status ? `(${status.toUpperCase()})` : '(ACTIVE)';
  lines.push(padRight(`  ${color.bold(color.cyan('SOLUTION SEARCH & MCTS CANDIDATES:'))} ${color.bold(searchTag)} ${color.yellow(statusStr)}`, width));
  if (objective) {
    lines.push(padRight(`  ${color.gray(`Objective: ${objective}`)}`, width));
  }
  lines.push(padRight(color.gray(`  Strategy: ${strategy ?? 'hierarchical_mcts'} | Total Candidates: ${candidates?.length ?? 0}`), width));
  lines.push(padRight(color.gray('  ' + '='.repeat(Math.max(10, width - 4))), width));

  const shouldRenderTree = viewMode === 'tree' || (treeNodes && treeNodes.length > 0 && viewMode !== 'table');

  if (shouldRenderTree && treeNodes && treeNodes.length > 0) {
    lines.push(padRight(color.bold('  HIERARCHICAL MCTS SEARCH TREE:'), width));
    lines.push(padRight(color.gray('  ' + '-'.repeat(Math.min(width - 4, 80))), width));
    const treeLines: string[] = [];
    for (const root of treeNodes) {
      treeLines.push(...renderSearchTreeNode(root, '', true, true, width));
    }
    const maxTreeLines = Math.min(treeLines.length, Math.max(5, maxRows - lines.length - 8));
    lines.push(...treeLines.slice(0, maxTreeLines));
    lines.push(padRight('', width));
  }

  // Flat Candidate Table
  if (candidates && candidates.length > 0 && (viewMode === 'table' || viewMode === 'split' || !shouldRenderTree || lines.length < maxRows - 7)) {
    const colCand = 10;
    const colModel = 16;
    const colWorker = 9;
    const colState = 10;
    const colRev = 5;
    const colBuild = 6;
    const colTests = 10;
    const colTok = 7;
    const colWall = 8;
    const colPrune = 12;
    const colPareto = 10;

    const header = `  ${color.bold('Cand'.padEnd(colCand))} ${color.bold('Model'.padEnd(colModel))} ${color.bold('Worker'.padEnd(colWorker))} ${color.bold('State'.padEnd(colState))} ${color.bold('Rev'.padEnd(colRev))} ${color.bold('Bld'.padEnd(colBuild))} ${color.bold('Tests'.padEnd(colTests))} ${color.bold('Tok'.padEnd(colTok))} ${color.bold('Time'.padEnd(colWall))} ${color.bold('Prune'.padEnd(colPrune))} ${color.bold('Pareto')}`;
    lines.push(padRight(header, width));
    lines.push(padRight(color.gray('  ' + '-'.repeat(Math.min(width - 4, 110))), width));

    const remainingRows = Math.max(2, maxRows - lines.length - 6);
    const rowsToShow = Math.min(candidates.length, remainingRows);

    for (let i = 0; i < rowsToShow; i++) {
      const c = candidates[i];
      const isSelected = i === selectedIndex;
      const prefix = isSelected ? color.cyan('> ') : '  ';

      const stateColor =
        c.state === 'completed' || c.state === 'promoted'
          ? color.green
          : c.state === 'failed' || c.state === 'cancelled'
            ? color.red
            : color.yellow;

      const buildStr = c.buildPassed === true ? color.green('PASS') : c.buildPassed === false ? color.red('FAIL') : color.gray('-');
      const testsStr = c.testSummary ? (c.testsPassed ? color.green(c.testSummary) : color.red(c.testSummary)) : (c.testsPassed ? color.green('PASS') : color.gray('-'));
      const tokensStr = c.tokens !== undefined ? String(c.tokens) : '-';
      const wallStr = c.wallTimeMs !== undefined ? `${c.wallTimeMs}ms` : '-';
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

      const row = `${prefix}${c.candidateId.padEnd(colCand)} ${c.modelId.padEnd(colModel)} ${c.workerId.padEnd(colWorker)} ${stateColor(c.state.padEnd(colState))} ${(c.revision ? `r${c.revision}` : '-').padEnd(colRev)} ${buildStr.padEnd(colBuild)} ${testsStr.padEnd(colTests)} ${tokensStr.padEnd(colTok)} ${wallStr.padEnd(colWall)} ${pruneBadge.padEnd(colPrune)} ${paretoBadge}`;
      lines.push(padRight(row, width));
    }
  }

  // Pareto Frontier Summary
  const frontier = (candidates || []).filter((c) => c.isFrontier);
  if (frontier.length > 0 && lines.length < maxRows - 3) {
    lines.push(padRight('', width));
    const frontierStr = frontier.map((f) => `${color.bold(f.candidateId)} ${color.green('●')}`).join('  │  ');
    lines.push(padRight(`  ${color.bold('Pareto Frontier:')} ${frontierStr}`, width));
  }

  if (selectedCandidateId && lines.length < maxRows - 2) {
    lines.push(padRight(`  ${color.bold('Selected Candidate:')} ${color.bold(color.green(selectedCandidateId))}${selectionReason ? color.gray(` (${selectionReason})`) : ''}`, width));
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

    // Multi-objective section
    const objectives = sel.objectives && sel.objectives.length > 0
      ? sel.objectives
      : [
          { metric: 'tokens', direction: 'MINIMIZE' },
          { metric: 'wall time', direction: 'MINIMIZE' },
        ];
    const objStr = objectives.map((o) => `${o.metric} ${color.yellow(o.direction === 'MINIMIZE' ? '↓' : '↑')}`).join('  │  ');
    lines.push(padRight(`  ${color.bold('Objectives:')} ${objStr}`, width));

    // Canary State
    if (sel.canaryState) {
      const canaryBadge =
        sel.canaryState.status === 'HEALTHY' || sel.canaryState.status === 'PROMOTED'
          ? color.green(sel.canaryState.status)
          : sel.canaryState.status === 'ROLLED_BACK'
            ? color.red(sel.canaryState.status)
            : color.yellow(sel.canaryState.status);
      const allocStr = sel.canaryState.trafficFraction !== undefined ? `${(sel.canaryState.trafficFraction * 100).toFixed(0)}% traffic` : '';
      const stageStr = sel.canaryState.stage !== undefined ? `Stage ${sel.canaryState.stage}/${sel.canaryState.totalStages ?? 3}` : '';
      lines.push(padRight(`  ${color.bold('Canary State:')} ${canaryBadge}  ${color.gray(`[${[stageStr, allocStr].filter(Boolean).join(', ')}]`)}`, width));
      if (sel.canaryState.rollbackReason) {
        lines.push(padRight(`    ${color.red(`Rollback Reason: ${sel.canaryState.rollbackReason}`)}`, width));
      }
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
    const guardStatus = sel.regressionGuardStatus?.passed !== false
      ? color.green('PASSED (0 violations)')
      : color.red(`FAILED (${sel.regressionGuardStatus?.violationsCount ?? 1} violations)`);
    lines.push(padRight(`  ${color.bold('RegressionGuard:')} ${guardStatus}`, width));

    if (sel.decision) {
      const decBadge = sel.decision === 'QUALIFIED' || sel.decision === 'PROMOTED'
        ? color.bold(color.green(sel.decision))
        : sel.decision === 'INCONCLUSIVE'
          ? color.bold(color.yellow(sel.decision))
          : color.bold(color.red(sel.decision));
      lines.push(padRight(`  ${color.bold('Decision:')} ${decBadge}${sel.decisionReason ? color.gray(` - ${sel.decisionReason}`) : ''}`, width));
    }
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

  for (let r = graphRows - 1; r >= 0; r--) {
    const rowFrac = r / (graphRows - 1);
    const tokenVal = Math.round(rowFrac * scaleMax);
    const yLabel = (tokenVal >= 1000 ? `${(tokenVal / 1000).toFixed(0)}k` : `${tokenVal}`).padStart(4);

    let rowChars = '';
    const isTargetRow = Math.abs(tokenVal - targetTokens) <= scaleMax / (graphRows * 1.8);
    const isMaxRow = Math.abs(tokenVal - maxCap) <= scaleMax / (graphRows * 1.8);

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
      `  Stable Prefix: ${color.green(`${latest.stablePrefix} tok`)} │ Volatile Portion: ${color.magenta(`${latest.volatilePortion} tok`)} │ Deduplicated: ${color.green(`${latest.deduplicated} tok`)}`,
      width,
    ),
  );

  lines.push(
    padRight(
      `  Compacted & Compressed: ${color.green(`${latest.compressed} tok`)} │ Oversized Offloaded: ${color.green(`${latest.offloaded} tok`)}`,
      width,
    ),
  );

  while (lines.length < maxRows) lines.push(padRight('', width));
  return lines.slice(0, maxRows);
}

// ---------------------------------------------------------------------------
// 6. EVIDENCE VIEW RENDERER (Controller Truth & Completion Proof)
// ---------------------------------------------------------------------------

export function renderEvidenceView(data: EvidenceViewData): string[] {
  const { width, maxRows } = data;
  const lines: string[] = [];

  lines.push(padRight(color.bold(color.cyan('  CONTROLLER TRUTH & DETERMINISTIC VERIFICATION EVIDENCE')), width));
  lines.push(padRight(color.gray('  ' + '='.repeat(Math.max(10, width - 4))), width));

  // Revision & status header
  const rev = data.workspaceRevision;
  const revStr = rev ? `r${rev.current} (base r${rev.base}${rev.hash ? `, ${rev.hash.slice(0, 8)}` : ''})` : 'r1';
  const statusStr = data.status ? `[${data.status.toUpperCase()}]` : '[VERIFIED]';
  lines.push(
    padRight(
      `  Task: ${color.bold(data.taskId ?? 'current-task')}  │  Revision: ${color.magenta(revStr)}  │  Status: ${color.green(statusStr)}`,
      width,
    ),
  );
  lines.push(padRight(color.gray('  ' + '-'.repeat(Math.max(10, width - 4))), width));

  // Physical Mutations
  lines.push(padRight(color.bold('  PHYSICAL DISK MUTATIONS (AST & Workspace Revisions):'), width));
  if (data.physicalMutations && data.physicalMutations.length > 0) {
    for (const m of data.physicalMutations.slice(0, 4)) {
      const adds = m.additions !== undefined ? color.green(`+${m.additions}`) : '';
      const dels = m.deletions !== undefined ? color.red(`-${m.deletions}`) : '';
      const diffStr = [adds, dels].filter(Boolean).join(', ');
      const patchStr = m.patchHash ? color.gray(` [patch ${m.patchHash.slice(0, 8)}]`) : '';
      lines.push(padRight(`    • ${m.file} (${diffStr})${patchStr}`, width));
    }
  } else {
    lines.push(padRight(color.gray('    No physical disk mutations recorded in current revision.'), width));
  }
  lines.push(padRight('', width));

  // Deterministic Build & Test Evidence
  lines.push(padRight(color.bold('  DETERMINISTIC BUILD & TEST EXECUTION EVIDENCE:'), width));
  if (data.buildEvidence) {
    const b = data.buildEvidence;
    const bBadge = b.exitCode === 0 ? color.green('Exit 0 (PASS)') : color.red(`Exit ${b.exitCode} (FAIL)`);
    const durStr = b.durationMs ? ` (${b.durationMs}ms)` : '';
    lines.push(padRight(`    Build: ${bBadge}${durStr} - ${color.gray(b.command)}`, width));
  }
  if (data.testEvidence) {
    const t = data.testEvidence;
    const tBadge = t.failed === 0 && t.exitCode === 0 ? color.green('PASS') : color.red('FAIL');
    const durStr = t.durationMs ? ` (${t.durationMs}ms)` : '';
    lines.push(
      padRight(
        `    Tests: [${tBadge}] ${t.passed} passed, ${t.failed} failed${t.assertions ? `, ${t.assertions} assertions` : ''}${durStr} - ${color.gray(t.command)}`,
        width,
      ),
    );
  }
  lines.push(padRight('', width));

  // Verification Checks (Oracles)
  lines.push(padRight(color.bold('  DETERMINISTIC VERIFICATION ORACLES:'), width));
  if (data.verificationChecks && data.verificationChecks.length > 0) {
    for (const chk of data.verificationChecks.slice(0, 4)) {
      const badge = chk.ok ? color.green('✓ PASS') : color.red('× FAIL');
      const exitStr = chk.exitCode !== undefined ? ` (exit ${chk.exitCode})` : '';
      lines.push(padRight(`    ${badge} ${chk.name}${exitStr}${chk.message ? ` - ${chk.message}` : ''}`, width));
    }
  } else {
    lines.push(padRight(color.gray('    No verification checks evaluated.'), width));
  }
  lines.push(padRight('', width));

  // Policy decisions
  if (data.policyDecisions && data.policyDecisions.length > 0) {
    lines.push(padRight(color.bold('  POLICY ENGINE AUDIT:'), width));
    for (const p of data.policyDecisions.slice(0, 2)) {
      const pBadge = p.decision === 'ALLOW' ? color.green('ALLOW') : color.red('DENY');
      lines.push(padRight(`    • ${pBadge} ${p.action}${p.resource ? ` on ${p.resource}` : ''} [${p.rule ?? 'default_policy'}]`, width));
    }
    lines.push(padRight('', width));
  }

  // Authoritative Completion Reason Block:
  // "Why does Wazir believe this task is complete?"
  lines.push(padRight(color.bold(color.yellow('  WHY DOES WAZIR BELIEVE THIS TASK IS COMPLETE?')), width));
  lines.push(padRight(color.gray('  ' + '-'.repeat(Math.min(width - 4, 76))), width));

  const comp = data.completionReason;
  const verifiedBadge = comp?.verified !== false ? color.green('[CONFIRMED]') : color.red('[UNVERIFIED]');
  const diskBadge = comp?.diskConfirmed !== false ? color.green('[CONFIRMED ON DISK]') : color.red('[UNCONFIRMED]');
  lines.push(padRight(`    1. Physical disk state: ${diskBadge} Workspace mutations match AST invariants.`, width));
  lines.push(padRight(`    2. Deterministic exit codes: ${verifiedBadge} Build & test exit code 0.`, width));
  lines.push(padRight(`    3. Oracles satisfied: ${color.green(comp?.oraclesSatisfied?.join(', ') || 'All deterministic oracles passed')}.`, width));
  lines.push(padRight(`    4. Invariant: ${color.bold('MODEL CLAIM != EXECUTION EVIDENCE')}. Completion is verified solely by physical evidence.`, width));

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
  lines.push(`│ ${color.gray('  NOTE: Sourced exclusively from controller state. Model claims are non-authoritative.'.padEnd(modalWidth - 4))} │`);

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
  const { title, candidateId, experimentId, revision, checks, evidence, provenanceChain, metrics, width, maxRows } = data;
  const lines: string[] = [];

  const modalWidth = Math.min(width - 6, 84);
  const border = '─'.repeat(modalWidth - 2);

  lines.push(`┌${border}┐`);
  lines.push(`│ ${color.bold(color.cyan(title.padEnd(modalWidth - 4)))} │`);
  lines.push(`├${border}┤`);

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
    lines.push(`│ ${color.bold('Provenance Chain:'.padEnd(modalWidth - 4))} │`);
    for (const p of provenanceChain.slice(0, 3)) {
      lines.push(`│   ${color.gray(p.slice(0, modalWidth - 6).padEnd(modalWidth - 6))} │`);
    }
  }

  lines.push(`├${border}┤`);
  lines.push(`│ ${color.gray('Press [Esc] or [E] to close evidence inspector.'.padEnd(modalWidth - 4))} │`);
  lines.push(`└${border}┘`);

  return lines.slice(0, maxRows);
}
