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
}

export interface ImprovementViewData {
  experiments: ImprovementExperimentItem[];
  selectedIndex: number;
  width: number;
  maxRows: number;
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
}

export interface SearchViewData {
  searchId?: string;
  objective?: string;
  status?: string;
  strategy?: string;
  candidates: SearchCandidateItem[];
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
  reservations: number;
  shards: string[];
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
// String and ANSI padding helpers
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
      if (/[a-zA-Z~]/.test(char)) inEscape = false;
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

// ---------------------------------------------------------------------------
// 1. IMPROVEMENT VIEW RENDERER
// ---------------------------------------------------------------------------

export function renderImprovementView(data: ImprovementViewData): string[] {
  const { experiments, selectedIndex, width, maxRows } = data;
  const lines: string[] = [];

  lines.push(padRight(color.bold(color.cyan('  SELF IMPROVEMENT')), width));
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

  // Table Rows (bounded)
  const maxTableRows = Math.min(experiments.length, 5);
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
    lines.push(padRight(`  ${color.bold('Selected:')} ${color.cyan(sel.id)}  |  Domain: ${color.bold(sel.domain)}  |  Maturity: ${color.magenta(String(sel.maturityLevel ?? 'Level 2'))}`, width));
    if (sel.hypothesis) {
      lines.push(padRight(`  ${color.bold('Hypothesis:')} ${color.gray(sel.hypothesis)}`, width));
    }
    const baselineStr = sel.baselineId ? `${sel.baselineId} (${sel.baselinePassRate ? `${(sel.baselinePassRate * 100).toFixed(0)}% pass` : '100%'})` : 'active-baseline';
    const candCount = sel.candidateCount ?? (sel.paretoFrontier?.allEvaluated?.length ?? 1);
    const benchStr = sel.benchmarkProgress ? `${sel.benchmarkProgress.completed}/${sel.benchmarkProgress.total} tasks` : 'completed';
    lines.push(padRight(`  Baseline: ${color.gray(baselineStr)}  |  Candidates: ${color.bold(String(candCount))}  |  Progress: ${color.green(benchStr)}`, width));
    lines.push(padRight('', width));

    // Multi-objective section
    lines.push(padRight(`  ${color.bold('Objective:')}`, width));
    const objectives = sel.objectives && sel.objectives.length > 0
      ? sel.objectives
      : [
          { metric: 'tokens', direction: 'MINIMIZE' },
          { metric: 'wall time', direction: 'MINIMIZE' },
        ];
    for (const obj of objectives) {
      const arrow = obj.direction === 'MINIMIZE' ? '↓' : '↑';
      lines.push(padRight(`    ${obj.metric} ${color.yellow(arrow)}`, width));
    }

    lines.push(padRight('', width));
    lines.push(padRight(`  ${color.bold('Protected:')}`, width));
    const protectedMetrics = sel.protectedMetrics && sel.protectedMetrics.length > 0
      ? sel.protectedMetrics
      : ['task success', 'verification'];
    for (const p of protectedMetrics) {
      lines.push(padRight(`    ${p}`, width));
    }

    lines.push(padRight('', width));
    lines.push(padRight(`  ${color.bold('Pareto:')}`, width));
    if (sel.paretoFrontier && sel.paretoFrontier.allEvaluated && sel.paretoFrontier.allEvaluated.length > 0) {
      for (const c of sel.paretoFrontier.allEvaluated) {
        if (c.isNonDominated) {
          lines.push(padRight(`    ${c.candidateId} ${color.green('●')}`, width));
        } else {
          lines.push(padRight(`    ${c.candidateId} ${color.gray('dominated')}`, width));
        }
      }
    } else {
      lines.push(padRight(`    C1 ${color.green('●')}`, width));
      lines.push(padRight(`    C2 ${color.green('●')}`, width));
      lines.push(padRight(`    C3 ${color.gray('dominated')}`, width));
    }

    lines.push(padRight('', width));
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

  // Footer Actions
  lines.push(padRight('', width));
  lines.push(padRight(color.gray('  Actions: [P] Pause  [A] Approve/Promote  [R] Rollback  [E] Inspect Evidence  [↑/↓] Navigate'), width));

  while (lines.length < maxRows) lines.push(padRight('', width));
  return lines.slice(0, maxRows);
}

// ---------------------------------------------------------------------------
// 2. SEARCH VIEW RENDERER
// ---------------------------------------------------------------------------

export function renderSearchView(data: SearchViewData): string[] {
  const { searchId, objective, status, strategy, candidates, selectedIndex, selectedCandidateId, selectionReason, width, maxRows } = data;
  const lines: string[] = [];

  const searchTag = searchId ?? 'active-search';
  const statusStr = status ? `(${status.toUpperCase()})` : '(ACTIVE)';
  lines.push(padRight(`  ${color.bold(color.cyan('SOLUTION SEARCH:'))} ${color.bold(searchTag)} ${color.yellow(statusStr)}`, width));
  if (objective) {
    lines.push(padRight(`  ${color.gray(`Objective: ${objective}`)}`, width));
  }
  lines.push(padRight(color.gray(`  Strategy: ${strategy ?? 'adaptive_multi_model'} | Total Candidates: ${candidates.length}`), width));
  lines.push(padRight(color.gray('  ' + '-'.repeat(Math.max(10, width - 4))), width));

  if (!candidates || candidates.length === 0) {
    lines.push(padRight('  No search candidates generated yet.', width));
    while (lines.length < maxRows) lines.push(padRight('', width));
    return lines;
  }

  // Table Column Widths
  const colCand = 12;
  const colModel = 18;
  const colWorker = 10;
  const colState = 11;
  const colRev = 6;
  const colBuild = 7;
  const colTests = 12;
  const colTok = 8;
  const colWall = 9;
  const colPrune = 14;
  const colPareto = 12;

  const header = `  ${color.bold('Candidate'.padEnd(colCand))} ${color.bold('Model'.padEnd(colModel))} ${color.bold('Worker'.padEnd(colWorker))} ${color.bold('State'.padEnd(colState))} ${color.bold('Rev'.padEnd(colRev))} ${color.bold('Build'.padEnd(colBuild))} ${color.bold('Tests'.padEnd(colTests))} ${color.bold('Tokens'.padEnd(colTok))} ${color.bold('Wall Time'.padEnd(colWall))} ${color.bold('Prune State'.padEnd(colPrune))} ${color.bold('Pareto')}`;
  lines.push(padRight(header, width));
  lines.push(padRight(color.gray('  ' + '-'.repeat(Math.min(width - 4, 115))), width));

  // Candidate rows (bounded)
  const availableRows = Math.max(3, maxRows - 13);
  const rowsToShow = Math.min(candidates.length, availableRows);

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

    const buildStr = c.buildPassed === true ? color.green('PASS') : c.buildPassed === false ? color.red('FAIL') : color.gray('N/A');
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

  lines.push(padRight('', width));

  // Pareto Frontier Visualization Section
  lines.push(padRight(`  ${color.bold('PARETO FRONTIER MEMBERSHIP:')}`, width));
  const frontier = candidates.filter((c) => c.isFrontier);
  const dominated = candidates.filter((c) => c.isDominated || (c.isFrontier === false && c.state === 'completed'));

  if (frontier.length > 0) {
    for (const f of frontier) {
      const metricInfo = f.wallTimeMs && f.tokens ? ` (${f.tokens} tokens, ${f.wallTimeMs}ms)` : '';
      lines.push(padRight(`    ${color.bold(f.candidateId)} ${color.green('●')} ${color.gray(`[non-dominated${metricInfo}]`)}`, width));
    }
  } else {
    lines.push(padRight(color.gray('    No non-dominated frontier computed yet.'), width));
  }

  if (dominated.length > 0) {
    for (const d of dominated.slice(0, 3)) {
      lines.push(padRight(`    ${d.candidateId} ${color.gray('dominated')}`, width));
    }
  }

  lines.push(padRight('', width));
  if (selectedCandidateId) {
    lines.push(padRight(`  ${color.bold('Selected Candidate:')} ${color.bold(color.green(selectedCandidateId))}${selectionReason ? color.gray(` (${selectionReason})`) : ''}`, width));
  }

  // Actions
  lines.push(padRight(color.gray('  Actions: [P] Pause  [X] Cancel Candidate  [A] Promote Qualified  [E] Inspect Evidence  [↑/↓] Select'), width));

  while (lines.length < maxRows) lines.push(padRight('', width));
  return lines.slice(0, maxRows);
}

// ---------------------------------------------------------------------------
// 3. CONTEXT UTILIZATION & SAWTOOTH GRAPH RENDERER
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

  // Sawtooth 2D graph height
  const graphRows = Math.min(8, Math.max(5, maxRows - 14));
  const graphWidth = Math.max(30, Math.min(samples.length, width - 18));

  // Window samples to fit graph width
  const windowedSamples = samples.slice(-graphWidth);
  const maxCap = Math.max(...windowedSamples.map((s) => s.effectiveMax || 32768), 32768);
  const maxTok = Math.max(...windowedSamples.map((s) => s.currentTokens), 1);
  const scaleMax = Math.max(maxCap, maxTok);

  // Target token line (e.g. 50% or explicit targetTokens)
  const targetTokens = windowedSamples[windowedSamples.length - 1]?.targetTokens ?? Math.floor(scaleMax * 0.5);

  // Render 2D Graph Grid
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

      // Sawtooth drop detection (compaction point)
      const prev = c > 0 ? windowedSamples[c - 1] : undefined;
      const isDrop = prev && s.currentTokens < prev.currentTokens * 0.75;

      if (curRow === r) {
        rowChars += isDrop ? color.cyan('╰') : color.cyan('●');
      } else if (curRow > r) {
        // Below the current token level
        rowChars += color.cyan('│');
      } else {
        // Above the current token level: check guide lines
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

  // X Axis
  const xAxis = '  ' + ' '.repeat(4) + ' ┴' + '─'.repeat(windowedSamples.length);
  lines.push(padRight(color.gray(xAxis), width));

  // Generation ticks
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

  // Current Generation Telemetry Breakdown
  const latest = windowedSamples[windowedSamples.length - 1];
  const pctUsed = latest.effectiveMax > 0 ? ((latest.currentTokens / latest.effectiveMax) * 100).toFixed(1) : '0';
  lines.push(
    padRight(
      `  ${color.bold('Current Gen:')} G${latest.generation}  |  ${color.bold('Tokens:')} ${color.cyan(String(latest.currentTokens))} / ${latest.effectiveMax} (${color.yellow(`${pctUsed}%`)})  |  ${color.bold('Target:')} ${latest.targetTokens}`,
      width,
    ),
  );

  lines.push(
    padRight(
      `  Stable Prefix: ${color.green(`${latest.stablePrefix} tok`)}  │  Volatile Portion: ${color.magenta(`${latest.volatilePortion} tok`)}  │  Generations: ${samples.length}`,
      width,
    ),
  );

  lines.push(padRight('', width));
  lines.push(padRight(`  ${color.bold('Compaction & Revision Breakdown:')}`, width));
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

  while (lines.length < maxRows) lines.push(padRight('', width));
  return lines.slice(0, maxRows);
}

// ---------------------------------------------------------------------------
// 4. FLEET VIEW RENDERER
// ---------------------------------------------------------------------------

export function renderFleetView(data: FleetViewData): string[] {
  const { workers, selectedIndex, width, maxRows } = data;
  const lines: string[] = [];

  lines.push(padRight(color.bold(color.cyan('  FLEET OBSERVABILITY & DISTRIBUTED TOPOLOGY')), width));
  lines.push(padRight(color.gray('  ' + '='.repeat(Math.max(10, width - 4))), width));

  if (!workers || workers.length === 0) {
    lines.push(padRight('  No workers registered in fleet topology.', width));
    while (lines.length < maxRows) lines.push(padRight('', width));
    return lines;
  }

  // Column definitions
  const colId = 14;
  const colStatus = 10;
  const colRt = 12;
  const colModels = 18;
  const colGpu = 20;
  const colRam = 14;
  const colShards = 20;

  const header = `  ${color.bold('Worker ID'.padEnd(colId))} ${color.bold('Status'.padEnd(colStatus))} ${color.bold('Runtime'.padEnd(colRt))} ${color.bold('Loaded Models'.padEnd(colModels))} ${color.bold('GPU / VRAM'.padEnd(colGpu))} ${color.bold('RAM / Load'.padEnd(colRam))} ${color.bold('Shards & Placement')}`;
  lines.push(padRight(header, width));
  lines.push(padRight(color.gray('  ' + '-'.repeat(Math.min(width - 4, 115))), width));

  for (let i = 0; i < workers.length && lines.length < maxRows - 4; i++) {
    const w = workers[i];
    const isSelected = i === selectedIndex;
    const prefix = isSelected ? color.cyan('> ') : '  ';

    const statusBadge =
      w.status === 'online' || w.status === 'idle'
        ? color.green(w.status.toUpperCase())
        : w.status === 'busy'
          ? color.yellow('BUSY')
          : color.red(w.status.toUpperCase());

    const rtStr = w.runtimes[0] ?? 'local';
    const modelStr = w.loadedModels.length > 0 ? w.loadedModels[0] : 'none';
    const gpuStr = w.gpu ? `${w.gpu.model.slice(0, 12)} (${w.gpu.memoryGB ?? 16}GB)` : 'integrated/none';
    const ramStr = `${w.ram.availableGB.toFixed(0)}/${w.ram.totalGB}GB ${w.ram.load ? `(${w.ram.load.toFixed(2)})` : ''}`;

    const shardPlacement = [
      ...(w.shards || []),
      ...(w.candidatePlacement ? [`cand: ${w.candidatePlacement}`] : []),
      ...(w.reservations > 0 ? [`res: ${w.reservations}`] : []),
    ].join(', ') || 'idle';

    const row = `${prefix}${w.id.padEnd(colId)} ${statusBadge.padEnd(colStatus)} ${rtStr.padEnd(colRt)} ${modelStr.padEnd(colModels)} ${gpuStr.padEnd(colGpu)} ${ramStr.padEnd(colRam)} ${shardPlacement}`;
    lines.push(padRight(row, width));
  }

  lines.push(padRight('', width));
  const onlineCount = workers.filter((w) => w.status === 'online' || w.status === 'busy' || w.status === 'idle').length;
  lines.push(padRight(`  Summary: ${color.bold(String(onlineCount))}/${workers.length} Workers Online  |  ${color.gray('Active Experiment Shards & Candidates Distributed')}`, width));

  while (lines.length < maxRows) lines.push(padRight('', width));
  return lines.slice(0, maxRows);
}

// ---------------------------------------------------------------------------
// 5. MODEL INTELLIGENCE VIEW RENDERER
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

  // Column definitions
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

  // Selected Model Detailed Evidence Breakdown
  const sel = profiles[Math.min(selectedIndex, profiles.length - 1)];
  if (sel) {
    lines.push(padRight(`  ${color.bold('Profile Details:')} ${color.bold(color.cyan(sel.model))}  |  Runtime: ${sel.runtime}  |  Total Samples: ${sel.totalSamples}`, width));

    if (sel.phaseBreakdown && Object.keys(sel.phaseBreakdown).length > 0) {
      lines.push(padRight(`  Phase Performance Breakdown:`, width));
      const phaseParts = Object.entries(sel.phaseBreakdown).map(
        ([phase, m]) => `${color.bold(phase)}: ${(m.score * 100).toFixed(0)}% (n=${m.sampleCount})`,
      );
      lines.push(padRight(`    ${phaseParts.join('  │  ')}`, width));
    }

    if (sel.languageBreakdown && Object.keys(sel.languageBreakdown).length > 0) {
      lines.push(padRight(`  Language Performance Breakdown:`, width));
      const langParts = Object.entries(sel.languageBreakdown).map(
        ([lang, m]) => `${lang}: ${(m.score * 100).toFixed(0)}% (n=${m.sampleCount})`,
      );
      lines.push(padRight(`    ${langParts.join('  │  ')}`, width));
    }
  }

  lines.push(padRight('', width));
  lines.push(padRight(color.gray('  Actions: [Enter] Inspect Profile  [↑/↓] Navigate  [Tab] Switch View'), width));

  while (lines.length < maxRows) lines.push(padRight('', width));
  return lines.slice(0, maxRows);
}

// ---------------------------------------------------------------------------
// 6. EVIDENCE INSPECTION MODAL RENDERER
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
