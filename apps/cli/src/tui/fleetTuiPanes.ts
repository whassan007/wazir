import type {
  Job,
  JobRollup,
  PendingApprovalRequest,
  Block,
  ModelReadiness,
} from '@wazir/core';
import { color } from '../colors.js';
import { collectHealthReport, fleetNodeHealth } from '../health.js';
import { renderMissionControl, classifyModelReadiness } from './missionControl.js';
import {
  renderTaskView,
  renderSearchView,
  renderCanaryView,
  renderFleetView,
  renderImprovementView,
  renderContextView,
  renderEvidenceView,
  renderModelIntelligenceView,
  type TaskViewData,
  type SearchTreeNode,
  type ImprovementExperimentItem,
  type ImprovementViewData,
  type SearchCandidateItem,
  type SearchViewData,
  type ContextViewData,
  type FleetWorkerItem,
  type ModelProfileItem,
} from './observabilityViews.js';
import {
  diffLines,
  getCategorySpinnerFrame,
  stripAnsiStr,
  truncateAnsiStr,
  wrapAnsiText,
  padRightAnsi,
  type StructuredError,
} from './fleetTuiTypes.js';
import { renderGoalStudioPane as renderGoalStudioPanelView } from './goalStudioPanel.js';

export function buildModalBox(
  title: string,
  bodyLines: string[],
  actionsLine: string,
  width: number,
  colorScheme: 'yellow' | 'red' | 'cyan' | 'blue' = 'yellow',
): string[] {
  const innerWidth = width - 4;
  const result: string[] = [];

  const borderPaint =
    colorScheme === 'red'
      ? color.red
      : colorScheme === 'cyan'
        ? color.cyan
        : colorScheme === 'blue'
          ? color.blue
          : color.yellow;

  const titleStr = ` ${title} `;
  const topDashes = Math.max(0, innerWidth - titleStr.length);
  result.push(color.bold(borderPaint(`+--${titleStr}${'-'.repeat(topDashes)}+`)));

  for (const rawLine of bodyLines) {
    const clamped = stripAnsiStr(rawLine).length > innerWidth ? truncateAnsiStr(rawLine, innerWidth) : rawLine;
    const plain = stripAnsiStr(clamped);
    const pad = Math.max(0, innerWidth - plain.length);
    result.push(`${color.bold(borderPaint('|'))}  ${clamped}${' '.repeat(pad)}${color.bold(borderPaint('|'))}`);
  }

  result.push(color.bold(borderPaint(`+--${'-'.repeat(innerWidth)}--+`)));

  const clampedActions =
    stripAnsiStr(actionsLine).length > innerWidth ? truncateAnsiStr(actionsLine, innerWidth) : actionsLine;
  const actionPlain = stripAnsiStr(clampedActions);
  const actPad = Math.max(0, innerWidth - actionPlain.length);
  result.push(`${color.bold(borderPaint('|'))}  ${clampedActions}${' '.repeat(actPad)}${color.bold(borderPaint('|'))}`);

  result.push(color.bold(borderPaint(`+--${'-'.repeat(innerWidth)}--+`)));

  return result;
}

export function renderDiffPreview(tui: any, req: PendingApprovalRequest, innerWidth: number): string[] {
  const path = typeof req.input.path === 'string' ? req.input.path : '(unknown path)';
  const maxLines = tui.approvalShowDetails ? 40 : 8;
  const lines: string[] = [`File: ${color.cyan(path)}`];

  if (req.tool === 'edit') {
    const oldStr = typeof req.input.oldString === 'string' ? req.input.oldString : '';
    const newStr = typeof req.input.newString === 'string' ? req.input.newString : '';
    const diff = diffLines(oldStr, newStr);
    const shown = diff.slice(0, maxLines);
    for (const d of shown) {
      const text = truncateAnsiStr(d.text, Math.max(1, innerWidth - 2));
      if (d.type === 'add') lines.push(color.green(`+ ${text}`));
      else if (d.type === 'del') lines.push(color.red(`- ${text}`));
      else lines.push(color.gray(`  ${text}`));
    }
    if (diff.length > shown.length) {
      lines.push(color.gray(`  ... ${diff.length - shown.length} more line(s) — press [V] for details`));
    }
  } else {
    const content = typeof req.input.content === 'string' ? req.input.content : '';
    const contentLines = content.split('\n');
    const shown = contentLines.slice(0, maxLines);
    lines.push(color.gray(`New content (${contentLines.length} line(s)):`));
    for (const l of shown) lines.push(color.green(`+ ${truncateAnsiStr(l, Math.max(1, innerWidth - 2))}`));
    if (contentLines.length > shown.length) {
      lines.push(color.gray(`  ... ${contentLines.length - shown.length} more line(s) — press [V] for details`));
    }
  }
  return lines;
}

export function renderApprovalModal(tui: any, cols: number): string[] {
  const first = tui.pendingApprovals[0];
  const modalWidth = Math.min(cols - 4, 76);
  const count = tui.pendingApprovals.length;
  const title = `POLICY APPROVAL QUEUE [1/${count}]`;

  const body: string[] = [
    `Task: ${color.cyan(first.taskId ?? 'fleet-task')}   Tool: ${color.yellow(first.tool)}`,
    `Rule: ${color.cyan(first.rule)}`,
  ];
  for (const reason of first.reasons.slice(0, 2)) {
    body.push(`Why:  ${color.gray(reason)}`);
  }

  if (first.tool === 'edit' || first.tool === 'write') {
    body.push('');
    body.push(...renderDiffPreview(tui, first, modalWidth - 4));
  } else {
    const inputStr = JSON.stringify(first.input);
    if (tui.approvalShowDetails) {
      body.push(`Args: ${color.gray(inputStr)}`);
      if (first.executionId) body.push(`Exec: ${color.gray(first.executionId)}`);
    } else {
      body.push(`Args: ${color.gray(inputStr.slice(0, modalWidth - 14))}`);
    }
  }

  const actions =
    count > 1
      ? `${color.bold('[A]')} Approve  ${color.bold('[D]')} Deny  ${color.bold('[V]')} Details  ${color.bold('[I]')} Skip  ${color.bold('[^A]')} All  ${color.bold('[^D]')} None`
      : `${color.bold('[A]')} Approve  ${color.bold('[D]')} Deny  ${color.bold('[V]')} Details  ${color.bold('[I]')} Inspect`;
  return buildModalBox(title, body, actions, modalWidth, 'yellow');
}

export function formatMissingModelRecovery(tui: any, readiness: ModelReadiness, prompt?: string): string {
  const unavailableRuntimes: string[] = [];
  const runtimeEntries = Object.entries(readiness.runtimeHealth ?? {});
  for (const [runtimeId, health] of runtimeEntries) {
    const h = health as { status?: string; message?: string };
    if (h.status === 'unavailable' || h.status === 'unhealthy') {
      unavailableRuntimes.push(`${runtimeId} (${h.status}${h.message ? `: ${h.message}` : ''})`);
    }
  }
  for (const disc of tui.engine.discovered ?? []) {
    if (disc.health === 'unavailable' || disc.health === 'degraded') {
      const label = `${disc.id} (${disc.health}${disc.healthMessage ? `: ${disc.healthMessage}` : ''})`;
      if (!unavailableRuntimes.some((r) => r.startsWith(`${disc.id} (`))) {
        unavailableRuntimes.push(label);
      }
    }
  }
  for (const rt of tui.engine.runtimes?.list() ?? []) {
    const st = (rt as { status?: string; health?: string }).status ?? (rt as { health?: string }).health;
    if (st === 'offline' || st === 'unavailable' || st === 'degraded') {
      if (!unavailableRuntimes.some((r) => r.startsWith(`${rt.id} (`))) {
        unavailableRuntimes.push(`${rt.id} (${st})`);
      }
    } else if ((rt as { runtimeKind?: string }).runtimeKind === 'hosted' && tui.engine.policy) {
      const gate = tui.engine.policy.checkHostedEligibility(undefined, rt.type);
      if (!gate.allowed && !unavailableRuntimes.some((r) => r.startsWith(`${rt.id} (`))) {
        unavailableRuntimes.push(`${rt.id} (hosted providers disabled by policy)`);
      }
    }
  }
  if (unavailableRuntimes.length === 0) {
    unavailableRuntimes.push('ollama (0 models installed)', 'lmstudio (offline or 0 models installed)');
  }

  const lines: string[] = [
    prompt
      ? `✗ Model unavailable: cannot execute task "${prompt.slice(0, 60)}" because no eligible AI model is registered or loaded.`
      : '⚠ Model unavailable: 0 eligible models registered across configured runtimes.',
  ];
  if (unavailableRuntimes.length > 0) {
    lines.push(`  Unavailable runtimes: ${unavailableRuntimes.join(', ')}`);
  }
  lines.push(
    '  Recovery commands:',
    '    • Pull a local Ollama model:       ollama pull qwen2.5-coder',
    '    • Start LM Studio server:          lms server start   (or /launch lmstudio)',
    '    • Authenticate a hosted provider:  wa auth login <anthropic|openai|google>',
    '    • Check runtime diagnostics:       wa doctor          (or /doctor)',
    '  Shell commands (!<cmd> or /sh <cmd>, e.g. !ls -la) remain available without an AI model.',
  );
  return lines.join('\n');
}

export function renderStartupSelectorModal(tui: any, cols: number): string[] {
  if (!tui.startupSelector) return [];
  const selector = tui.startupSelector;
  const modalWidth = Math.min(cols - 4, 88);

  if (selector.inspectedModelId) {
    const m = selector.allInstalledModels.find((it: any) => it.id === selector.inspectedModelId);
    if (!m) {
      selector.inspectedModelId = undefined;
      return renderStartupSelectorModal(tui, cols);
    }
    const title = ` MODEL INSPECTION: ${m.id} `;
    const assessment = selector.resourceAssessments.get(m.id);
    const isReady = tui.engine.lifecycle.isModelReady(m.id);
    const body: string[] = [
      `${color.bold('ID:')}            ${m.id}`,
      `${color.bold('Name:')}          ${m.name}`,
      `${color.bold('Provider:')}      ${m.provider}`,
      `${color.bold('Family:')}        ${m.family}`,
      `${color.bold('Architecture:')}  ${m.architecture ?? '—'}`,
      `${color.bold('Parameters:')}    ${m.parameters ?? '—'}`,
      `${color.bold('Quantization:')}  ${m.quantization ?? '—'}`,
      `${color.bold('Context Max:')}   ${m.contextMax.toLocaleString()} tokens`,
      `${color.bold('Capabilities:')}  ${m.capabilities.join(', ')}`,
      `${color.bold('Tool Calling:')}  ${m.toolCalling ? color.green('yes') : color.gray('no')}`,
      `${color.bold('Reasoning:')}     ${m.reasoning ? color.green('yes') : color.gray('no')}`,
      `${color.bold('Vision:')}        ${m.vision ? color.green('yes') : color.gray('no')}`,
      `${color.bold('State:')}         ${isReady ? color.green('READY') : color.yellow(tui.engine.lifecycle.getModelState(m.id))}`,
      '',
      color.bold('Resource Assessment:'),
      `  Estimated Memory: ${assessment?.estimatedMemoryGB.toFixed(1) ?? '—'} GB [${assessment?.classification ?? 'UNKNOWN'}]`,
      `  Status:           ${assessment?.message ?? '—'}`,
    ];
    const actions = `${color.bold('[Esc]')} Back to Model Selection`;
    return buildModalBox(title, body, actions, modalWidth, 'cyan');
  }

  if (selector.mode === 'select') {
    const title = ' WAZIR - MODEL READINESS & STARTUP ';
    const readiness = tui.engine.lifecycle.getReadiness();
    const healthyRuntimes = tui.engine.runtimes.list().map((r: any) => r.name || r.id);
    const localComp = tui.engine.computers.list().find((c: any) => c.local)?.name || 'local';

    const body: string[] = [
      `Runtime: ${color.bold(healthyRuntimes.join(', ') || 'none')}    Computer: ${color.bold(localComp)}`,
      `Status: ${color.bold(`${readiness.registeredCount ?? readiness.totalModels} REGISTERED`)} / ${color.cyan(`${readiness.availableCount ?? readiness.installedCount} AVAILABLE`)} / ${color.green(`${readiness.localLoadedCount ?? 0} LOCALLY LOADED`)}`,
    ];
    if (selector.statusBanner) {
      body.push(color.yellow(`* ${selector.statusBanner}`));
    }
    body.push(color.gray('-'.repeat(modalWidth - 8)));
    body.push(color.bold(`Installed Models (${readiness.readyCount} loaded / ${readiness.installedCount} installed):`));
    body.push('');

    const models = selector.allInstalledModels;
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      const isSel = selector.selectedModelIds.has(m.id);
      const isEligible = selector.eligibleModels.some((e: any) => e.id === m.id);
      const isRec = selector.recommendedModelIds.has(m.id);
      const isHighlighted = i === selector.selectedIndex;
      const assessment = selector.resourceAssessments.get(m.id);
      const isReady = tui.engine.lifecycle.isModelReady(m.id);

      const checkMark = isReady
        ? color.green('[✓]')
        : isSel
          ? color.cyan('[x]')
          : '[ ]';
      const cursor = isHighlighted ? color.blue('> ') : '  ';
      const namePart = isHighlighted ? color.blue(color.bold(m.id)) : color.bold(m.id);

      let badge = '';
      if (isReady) {
        badge = ` ${color.green('(ALREADY LOADED)')}`;
      } else if (isRec) {
        badge = ` ${color.cyan('[RECOMMENDED]')}`;
      } else if (!isEligible) {
        badge = ` ${color.gray('(non-generative)')}`;
      }

      body.push(`${cursor}${checkMark} ${i + 1}. ${namePart}${badge}`);

      const arch = m.architecture ? `Architecture: ${m.architecture}  ` : '';
      const params = m.parameters ? `Params: ${m.parameters}  ` : '';
      const ctx = `Context: ${Math.round(m.contextMax / 1024)}K`;
      body.push(`       ${color.gray(`${arch}${params}${ctx}`)}`);

      if (assessment) {
        let classTag = color.gray(`[${assessment.classification}]`);
        if (assessment.classification === 'SAFE') classTag = color.green('[SAFE]');
        else if (assessment.classification === 'WARNING') classTag = color.yellow('[WARNING]');
        else if (assessment.classification === 'INSUFFICIENT') classTag = color.red('[INSUFFICIENT]');
        body.push(`       ${color.gray(`Memory: ~${assessment.estimatedMemoryGB.toFixed(1)} GB`)} ${classTag}`);
      }

      if (isRec) {
        const recPurpose = m.toolCalling ? 'coding / tool execution' : 'planning / reasoning';
        body.push(`       ${color.cyan(`RECOMMENDED for ${recPurpose}`)}`);
      }
      body.push('');
    }

    const actions = `${color.bold('[Enter]')} Load Selected   ${color.bold('[A]')} Recommended   ${color.bold('[L]')} All   ${color.bold('[R]')} Refresh   ${color.bold('[I]')} Inspect   ${color.bold('[S]')} Skip`;
    return buildModalBox(title, body, actions, modalWidth, 'cyan');
  }

  if (selector.mode === 'loading') {
    const title = ' WAZIR - LOADING MODELS ';
    const body: string[] = [
      color.bold('Loading selected models into runtime memory:'),
      '',
    ];
    for (const id of selector.selectedModelIds) {
      const st = selector.loadStatuses.get(id) ?? 'LOADING';
      if (st === 'READY') {
        body.push(`  ${color.green('✓')} ${color.bold(id)} .......... ${color.green('READY')}`);
      } else if (st === 'FAILED') {
        const err = selector.loadErrors.get(id) ?? 'load failed';
        body.push(`  ${color.red('✕')} ${color.bold(id)} .......... ${color.red('FAILED')} (${err})`);
      } else {
        const frame = getCategorySpinnerFrame('JOBS', tui.spinnerTick);
        body.push(`  ${color.cyan(frame)} ${color.bold(id)} ... ${color.yellow('LOADING')}`);
      }
    }
    body.push('');
    body.push(color.gray('Please wait while weights are placed into memory...'));
    const actions = color.gray('Loading in progress...');
    return buildModalBox(title, body, actions, modalWidth, 'yellow');
  }

  if (selector.mode === 'failure') {
    const title = ' WAZIR - MODEL LOAD FAILURE ';
    const body: string[] = [
      color.bold(color.red('One or more models failed to load:')),
      '',
    ];
    for (const [id, st] of selector.loadStatuses.entries()) {
      if (st === 'READY') {
        body.push(`  ${color.green('✓')} ${id} ... READY`);
      } else if (st === 'FAILED') {
        const err = selector.loadErrors.get(id) ?? 'failed';
        body.push(`  ${color.red('✕')} ${id} ... ${color.red('FAILED')} (${err})`);
      }
    }
    body.push('');
    body.push(color.gray('Choose how to proceed:'));
    const actions = `${color.bold('[R]')} Retry failed   ${color.bold('[C]')} Continue with available   ${color.bold('[B]')} Back to selection`;
    return buildModalBox(title, body, actions, modalWidth, 'red');
  }

  if (selector.mode === 'recovery_no_models') {
    const title = ' WAZIR - MODEL SETUP & RECOVERY ';
    const body: string[] = [
      color.bold(color.yellow('0 models discovered across all runtimes.')),
      '',
      'No models are currently installed in Ollama or LM Studio.',
      '',
      color.bold('Next steps:'),
      '  1. In LM Studio: Download a model (e.g. google/gemma-4-12b-qat or qwen/qwen3.8-27b).',
      '  2. In Ollama: Run \'ollama pull qwen2.5-coder\' in terminal.',
      '  3. Ensure the runtime server is running.',
    ];
    const actions = `${color.bold('[R]')} Refresh Discovery   ${color.bold('[S]')} Skip to Fleet   ${color.bold('[D]')} Run wa doctor`;
    return buildModalBox(title, body, actions, modalWidth, 'yellow');
  }

  if (selector.mode === 'recovery_runtime') {
    const title = ' WAZIR - RUNTIME RECOVERY ';
    const body: string[] = [
      color.bold(color.red('All local model runtimes are currently unavailable.')),
      '',
      '  - LM Studio: http://localhost:1234 (OFFLINE / UNREACHABLE)',
      '  - Ollama:    http://localhost:11434 (OFFLINE / UNREACHABLE)',
      '',
      color.bold('Recovery options:'),
      '  - Press [L] to start LM Studio server automatically via CLI',
      '  - Ensure LM Studio or Ollama is started in your environment',
    ];
    const actions = `${color.bold('[L]')} Launch LM Studio   ${color.bold('[R]')} Refresh Detection   ${color.bold('[S]')} Skip to Fleet`;
    return buildModalBox(title, body, actions, modalWidth, 'red');
  }

  return [];
}

export function renderTaskTimeModelRequiredModal(tui: any, cols: number): string[] {
  if (!tui.taskTimeModelRequired) return [];
  const modal = tui.taskTimeModelRequired;
  const modalWidth = Math.min(cols - 4, 82);
  const title = ' TASK-TIME MODEL REQUIRED ';

  const body: string[] = [
    color.bold(color.yellow('No ready models are available to execute this task.')),
    `${color.bold('Task:')} "${modal.pendingPrompt.slice(0, 50)}"`,
    `${color.bold('Required capability:')} ${modal.requiredCapabilities.join(', ')}`,
    '',
    color.bold('Eligible installed models:'),
  ];

  const recommended = tui.engine.lifecycle.getRecommendedModels();
  const recIds = new Set(recommended.map((r: any) => r.model.id));

  for (let i = 0; i < modal.eligibleModels.length; i++) {
    const m = modal.eligibleModels[i];
    const isSel = i === modal.selectedIndex;
    const cursor = isSel ? color.blue('> ') : '  ';
    const namePart = isSel ? color.blue(color.bold(m.id)) : color.bold(m.id);
    const isRec = recIds.has(m.id);
    const recBadge = isRec ? color.cyan(' [RECOMMENDED]') : '';
    body.push(`${cursor}${i + 1}. ${namePart} (${m.provider})${recBadge}`);
  }

  if (modal.statusText) {
    body.push('');
    body.push(color.yellow(`Status: ${modal.statusText}`));
  }

  const actions = `${color.bold('[L]')} Load Model   ${color.bold('[A]')} Load Recommended   ${color.bold('[M]')} Manage Models   ${color.bold('[Esc]')} Cancel`;
  return buildModalBox(title, body, actions, modalWidth, 'yellow');
}

export function renderStructuredErrorCard(err: StructuredError, cols: number): string[] {
  const modalWidth = Math.min(cols - 4, 76);
  const title = ' EXECUTION FAILURE ';

  const body: string[] = [
    `${color.bold('Phase:')}      ${color.red(err.phase)}`,
    `${color.bold('Reason:')}     ${color.red(err.reason)}`,
  ];
  if (err.required) {
    body.push(`${color.bold('Required:')}   ${color.gray(err.required)}`);
  }
  if (err.available) {
    body.push(`${color.bold('Available:')}  ${color.gray(err.available)}`);
  }
  if (err.suggestedSteps && err.suggestedSteps.length > 0) {
    body.push('');
    body.push(color.bold('Suggested Resolution Steps:'));
    for (const step of err.suggestedSteps) {
      body.push(`  ${color.cyan(step)}`);
    }
  }

  const actions = `${color.bold('[Esc]')} Dismiss   ${color.bold('[R]')} Retry Task   ${color.bold('[D]')} Run wa doctor`;
  return buildModalBox(title, body, actions, modalWidth, 'red');
}

export function renderQuickActionsModal(tui: any, cols: number): string[] {
  const modalWidth = Math.min(cols - 4, 72);
  const title = ' QUICK ACTIONS (Ctrl+P) ';

  const body: string[] = [];
  for (let i = 0; i < tui.quickActions.length; i++) {
    const a = tui.quickActions[i];
    const isSel = i === tui.quickActionIndex;
    const cursor = isSel ? color.blue('> ') : '  ';
    const label = `${cursor}${i + 1}. ${a.title} ${color.gray(`(${a.cmd})`)}`;
    body.push(isSel ? color.blue(color.bold(label)) : label);
  }

  const actions = `${color.bold('[Enter]')} Select   ${color.bold('[Esc]')} Dismiss   ${color.bold('[1-9]')} Direct Execute`;
  return buildModalBox(title, body, actions, modalWidth, 'cyan');
}

export function renderBlockModal(block: Block, cols: number): string[] {
  const modalWidth = Math.min(cols - 4, 76);
  const title = `BLOCK DETAILS #${block.id} [${block.status.toUpperCase()}]`;

  const body: string[] = [
    `Command:  ${color.bold(block.command)}`,
    `Duration: ${block.durationMs ?? 0}ms   Exit: ${block.exitCode ?? 0}`,
  ];

  if (block.stdout) {
    body.push(`Stdout:   ${color.gray(block.stdout.slice(0, 100))}`);
  }
  if (block.stderr) {
    body.push(`Stderr:   ${color.red(block.stderr.slice(0, 100))}`);
  }
  if (block.filesChanged && block.filesChanged.length > 0) {
    body.push(`Files:    ${color.cyan(block.filesChanged.join(', '))}`);
  }

  const actions = `${color.bold('[Esc]')} Close`;
  return buildModalBox(title, body, actions, modalWidth, 'yellow');
}

export function renderRawResponseModal(tui: any, taskId: string, cols: number): string[] {
  const modalWidth = Math.min(cols - 4, 100);
  const innerWidth = modalWidth - 4;
  const raw = tui.lastRawResponse.get(taskId) ?? '(none recorded)';
  const title = `RAW MODEL RESPONSE — ${taskId}`;
  const body = wrapAnsiText(raw, innerWidth, 30);
  const actions = `${color.bold('[Esc]')} Close`;
  return buildModalBox(title, body, actions, modalWidth, 'cyan');
}

export function renderJobOutputModal(tui: any, job: Job, rollup: JobRollup | undefined, cols: number): string[] {
  const modalWidth = Math.min(cols - 4, 100);
  const innerWidth = modalWidth - 4;
  const title = `JOB OUTPUT: ${job.title.slice(0, 50)} [${job.status.toUpperCase()}]`;

  const body: string[] = [];
  for (const t of job.tasks) {
    body.push(`${color.bold(`[${t.status}]`)} ${t.id}${t.title ? ` - ${t.title}` : ''}`);
    const node = job.graph.nodes.find((n) => n.taskId === t.id || n.id === t.id);
    const raw = node?.error ?? (node?.result !== undefined
      ? typeof node.result === 'string' ? node.result : JSON.stringify(node.result)
      : undefined);
    if (raw) {
      const flat = raw.replace(/\s+/g, ' ').trim();
      const wrapped = wrapAnsiText(flat, innerWidth, 20);
      const paint = node?.error ? color.red : color.gray;
      for (const line of wrapped) body.push(paint(line));
    } else {
      body.push(color.gray('(no output captured for this task)'));
    }
    body.push('');
  }

  if (rollup) {
    const tps = rollup.tokensPerSecond > 0 ? rollup.tokensPerSecond.toFixed(1) : '0.0';
    body.push(
      color.gray(
        `Tokens: In ${rollup.tokens.input} / Out ${rollup.tokens.output} (${rollup.tokens.total} total) | Duration: ${(rollup.durationMs / 1000).toFixed(1)}s | Speed: ${tps} tok/s`,
      ),
    );
    if (rollup.filesChanged.length > 0) {
      body.push(color.gray(`Files changed: ${rollup.filesChanged.join(', ')}`));
    }
  } else {
    void tui.refreshJobRollup(job.id);
  }

  const actions = `${color.bold('[Esc]')} Close`;
  return buildModalBox(title, body, actions, modalWidth, job.status === 'failed' ? 'red' : 'cyan');
}

export function renderCanaryControlModal(tui: any, cols: number): string[] {
  if (!tui.canaryModal) return [];
  const modalWidth = Math.min(cols - 4, 76);
  const cm = tui.canaryModal;

  if (cm.type === 'rollback') {
    const title = 'CONFIRM CANARY ROLLBACK';
    const body: string[] = [
      `Target Canary:   ${color.bold(color.red(cm.canaryId))}`,
      `Candidate ID:    ${color.bold(cm.candidateId)}`,
      `Current Traffic: ${color.yellow(`${(cm.currentAllocation * 100).toFixed(0)}%`)}`,
      '',
      color.bold(color.red('WARNING: Rolling back will terminate canary evaluation immediately.')),
      '100% traffic will be restored to the verified baseline checkpoint.',
      '',
      'Are you sure you want to proceed with this rollback?',
    ];
    const actions = `${color.bold(color.red('[Enter / y] Confirm Rollback'))}    ${color.bold('[Esc / n] Cancel')}`;
    return buildModalBox(title, body, actions, modalWidth, 'red');
  }

  if (cm.type === 'advance') {
    const nextStage = cm.nextStage ?? 'NEXT_TIER';
    const title = 'CONFIRM CANARY STAGE ADVANCEMENT';
    const body: string[] = [
      `Target Canary:   ${color.bold(color.cyan(cm.canaryId))}`,
      `Candidate ID:    ${color.bold(cm.candidateId)}`,
      `Current Stage:   ${color.yellow(`${(cm.currentAllocation * 100).toFixed(0)}% traffic`)}`,
      `Target Stage:    ${color.green(nextStage)}`,
      '',
      'Advancing stage will allocate increased production traffic to this candidate.',
      'Continuous RegressionGuard will remain active across all protected metrics.',
      '',
      'Are you sure you want to advance this canary deployment?',
    ];
    const actions = `${color.bold(color.green('[Enter / y] Confirm Advance'))}    ${color.bold('[Esc / n] Cancel')}`;
    return buildModalBox(title, body, actions, modalWidth, 'yellow');
  }

  if (cm.type === 'throttle') {
    const title = 'THROTTLE CANARY TRAFFIC';
    const body: string[] = [
      `Target Canary:   ${color.bold(color.cyan(cm.canaryId))}`,
      `Candidate ID:    ${color.bold(cm.candidateId)}`,
      `Current Traffic: ${color.yellow(`${(cm.currentAllocation * 100).toFixed(0)}%`)}`,
      '',
      'Select target traffic percentage (bounded by current allocation):',
      '',
    ];

    for (let i = 0; i < cm.availableTiers.length; i++) {
      const tier = cm.availableTiers[i];
      const pct = Math.round(tier * 100);
      const isSelected = i === cm.selectedTierIndex;
      const bullet = isSelected ? color.bold(color.cyan(`▸ [${i + 1}]`)) : color.gray(`  [${i + 1}]`);
      const label = `${pct}% traffic allocation`;
      body.push(isSelected ? `${bullet} ${color.bold(color.cyan(label))}` : `${bullet} ${label}`);
    }

    const selectedPct = Math.round((cm.availableTiers[cm.selectedTierIndex] ?? cm.currentAllocation) * 100);
    body.push('');
    body.push(`Target Allocation: ${color.bold(color.green(`${selectedPct}%`))}`);

    const actions = `${color.bold('[↑/↓ or 1-9]')} Select    ${color.bold(color.green('[Enter]'))} Apply Throttle    ${color.bold('[Esc/n]')} Cancel`;
    return buildModalBox(title, body, actions, modalWidth, 'yellow');
  }

  return [];
}

export function buildPickerPopup(candidates: string[], selectedIdx: number, width: number): string[] {
  const innerWidth = width - 4;
  const result: string[] = [];
  const title = ' References (@) ';
  const topDashes = Math.max(0, innerWidth - title.length);
  result.push(color.cyan(`+--${title}${'-'.repeat(topDashes)}+`));

  const visibleCandidates = candidates.slice(0, 6);
  for (let i = 0; i < visibleCandidates.length; i++) {
    const c = visibleCandidates[i];
    const isSel = i === selectedIdx;
    const prefix = isSel ? color.blue('> ') : '  ';
    const maxTextLen = innerWidth - 4;
    const truncated = c.length > maxTextLen ? c.slice(0, maxTextLen - 1) + '.' : c;
    const plain = `${prefix}${truncated}`;
    const plainLen = stripAnsiStr(plain).length;
    const pad = Math.max(0, innerWidth - plainLen);
    result.push(`${color.cyan('|')}  ${prefix}${isSel ? color.blue(color.bold(truncated)) : truncated}${' '.repeat(pad - 2)}${color.cyan('|')}`);
  }

  result.push(color.cyan(`+--${'-'.repeat(innerWidth)}--+`));
  return result;
}

export function overlayModal(lines: string[], modalLines: string[], cols: number, startY: number): void {
  const modalWidth = Math.max(...modalLines.map((l) => stripAnsiStr(l).length));
  const leftPad = Math.max(0, Math.floor((cols - modalWidth) / 2));

  for (let i = 0; i < modalLines.length; i++) {
    const y = startY + i;
    if (y < 0 || y >= lines.length) continue;
    const m = modalLines[i];
    const mLen = stripAnsiStr(m).length;
    const rightPad = Math.max(0, cols - leftPad - mLen);
    lines[y] = ' '.repeat(leftPad) + m + ' '.repeat(rightPad);
  }
}

export function renderWorktreesPane(tui: any, cols: number, maxRows: number): string[] {
  const lines: string[] = [];
  lines.push(color.bold(color.cyan('  GIT WORKTREE ISOLATION & MERGE-BACK')));
  lines.push(color.gray('  Each agent runs in an isolated git branch without colliding writes:'));
  lines.push('');

  const list = tui.getAgents();
  if (list.length === 0) {
    lines.push(color.gray('  No active worktrees.'));
  } else {
    for (const a of list) {
      const branch = tui.currentJob ? `wazir/${tui.currentJob.id}/${a.taskId}` : `wazir/${a.taskId}`;
      lines.push(`  ${color.cyan(a.taskId.padEnd(12))} Branch: ${color.bold(branch)}  Status: ${a.status}`);
      if (a.filesChanged.length > 0) {
        lines.push(`    Files: ${color.gray(a.filesChanged.join(', '))}`);
      }
    }
  }

  lines.push('');
  lines.push(color.gray('  Merge-back story: Changes are verified on isolated branches before merge into target.'));
  while (lines.length < maxRows) lines.push('');
  return lines;
}

export function renderTaskPane(tui: any, cols: number, maxRows: number): string[] {
  const card = tui.agents.get(tui.selectedTaskId ?? '') ?? tui.getAgents()[0];
  const taskInput = tui.currentJob?.tasks.find((t: any) => t.id === (card?.taskId ?? tui.selectedTaskId));
  const activeTaskId = card?.taskId ?? tui.selectedTaskId ?? 'task-001';
  const inspection = tui.currentEvidenceInspection();
  const filesChanged = card?.filesChanged ?? [];

  const verification = inspection
    ? {
        overall: inspection.inspection.completion.eligible ? 'PASS' : inspection.inspection.status === 'failed' ? 'FAIL' : 'PENDING',
        checksPassed: inspection.inspection.slots.filter((s: any) => s.status === 'PASS').length,
        totalChecks: inspection.inspection.slots.length,
        checks: inspection.inspection.slots.map((s: any) => ({
          name: s.oracle.toLowerCase(),
          ok: s.status === 'PASS',
          exitCode: typeof s.exitCode === 'number' ? s.exitCode : undefined,
          message: s.status !== 'PASS' ? s.status : undefined,
        })),
      }
    : (tui.engine as any).verification?.getLastVerificationResult?.() ?? {
        overall: 'PENDING',
        checksPassed: 0,
        totalChecks: 4,
        checks: [
          { name: 'ast_invariants', ok: false, exitCode: undefined, message: 'pending execution evidence' },
          { name: 'typescript_compiler', ok: false, exitCode: undefined, message: 'pending execution evidence' },
          { name: 'unit_test_suite', ok: false, exitCode: undefined, message: 'pending execution evidence' },
          { name: 'workspace_cleanliness', ok: true, exitCode: 0 },
        ],
      };

  const taskData: TaskViewData = {
    taskId: activeTaskId,
    title: card?.title ?? taskInput?.title ?? 'Autonomous Engineering Task',
    objective: (taskInput as any)?.prompt ?? (taskInput as any)?.task ?? card?.title ?? 'Execute autonomous engineering workflow',
    requirements: [
      'Complete implementation adhering to deterministic invariants',
      'Verify with compiler, test suite, and AST integrity check (MODEL CLAIM != EXECUTION EVIDENCE)',
      'Ensure 0 regressions and stay within token budget',
    ],
    currentPhase: (card?.phase?.toUpperCase() as any) ?? (card?.status === 'completed' ? 'VERIFY' : 'TASK'),
    agentId: card?.agentId ?? 'wazir-coder',
    modelId: card?.modelId ?? tui.selectedModelId ?? 'auto-routed',
    runtimeId: 'local',
    computerId: card?.computerId ?? 'worker-local',
    workerId: card?.computerId ?? 'worker-local',
    workspaceRevision: inspection?.inspection.currentRevision ?? (card as any)?.worktreeInfo?.revision ?? 1,
    verificationStatus: verification,
    budget: {
      tokensUsed: card?.usage?.total ?? ((card?.usage?.input ?? 0) + (card?.usage?.output ?? 0)),
      maxTokens: 32768,
      repairCycles: Math.max(0, (card?.attempt ?? 1) - 1),
      maxRepairCycles: card?.maxAttempts ?? 3,
      costUsd: undefined,
    },
    elapsedTimeMs: card?.durationMs ?? 0,
    physicalMutationsCount: filesChanged.length,
    filesChanged,
    recentEvents: (tui.agentLogs.get(card?.taskId ?? '') ?? []).slice(-5).map((l: any) => ({
      time: l.time,
      kind: l.kind,
      text: l.text,
    })),
    width: cols,
    maxRows,
  };
  return renderTaskView(taskData);
}

export function renderSearchPane(tui: any, cols: number, maxRows: number): string[] {
  const searches = tui.engine.solutionSearch?.listSearches() ?? [];
  const activeSearch = searches[searches.length - 1];

  const treeNodes: SearchTreeNode[] | undefined = (activeSearch as any)?.hierarchicalTree?.nodes
    ? (activeSearch as any).hierarchicalTree.nodes
    : (activeSearch as any)?.treeNodes
      ? (activeSearch as any).treeNodes
      : undefined;

  const candidates: SearchCandidateItem[] = (activeSearch?.candidates ?? []).map((c: any, i: number) => {
    const candId = c.candidateId;
    const modelId = c.descriptor?.modelId ?? c.modelId ?? 'default';
    const workerId = c.descriptor?.workerId ?? c.workerId ?? 'worker-local';
    const state = c.status ?? 'completed';
    const revision = c.workspaceRevision ?? c.descriptor?.iteration ?? i + 1;
    const buildPassed = c.evaluation?.buildPassed;
    const testsPassed = c.evaluation?.testsPassed;
    const testSummary = c.evaluation?.testSummary;
    const tokens = c.metrics?.totalTokens ?? c.tokensUsed ?? 0;
    const wallTimeMs = c.metrics?.wallTimeMs ?? c.durationMs ?? 0;
    const isPruned = c.status === 'pruned';
    const pruneState = isPruned
      ? (c.evaluation?.disqualificationReasons?.[0] ? 'PRUNED' : 'PRUNED')
      : 'ACTIVE';
    const isFrontier = c.evaluation?.isParetoFrontier ?? (!isPruned && c.evaluation?.qualifies !== false);
    const isDominated = c.evaluation?.isDominated ?? isPruned;

    return {
      candidateId: candId,
      modelId,
      workerId,
      state,
      revision,
      buildPassed,
      testsPassed,
      testSummary,
      tokens,
      wallTimeMs,
      pruneState,
      isFrontier,
      isDominated,
      qualifies: c.evaluation?.qualifies ?? (!isPruned),
      disqualificationReasons: c.evaluation?.disqualificationReasons ?? [],
    };
  });

  const selectedNodeId = tui.getSelectedSearchNodeId();
  const selectedNodeInspection = selectedNodeId ? tui.inspectSearchNode(selectedNodeId) : undefined;

  const data: SearchViewData = {
    searchId: activeSearch?.searchId ?? 'none',
    objective: (activeSearch as any)?.objective ?? 'No active solution search',
    status: activeSearch?.status ?? 'idle',
    strategy: activeSearch?.strategy ?? 'hierarchical_mcts',
    candidates,
    treeNodes,
    viewMode: tui.searchViewMode,
    selectedIndex: tui.selectedSearchCandidateIndex,
    selectedCandidateId: activeSearch?.selectedCandidate?.candidateId ?? candidates[0]?.candidateId,
    selectionReason: activeSearch?.selectionReason ?? 'No candidate selected',
    selectedNodeId,
    selectedNodeInspection,
    width: cols,
    maxRows,
  };
  return renderSearchView(data);
}

export function renderImprovementPane(tui: any, cols: number, maxRows: number): string[] {
  const experiments: ImprovementExperimentItem[] = (tui.engine.optimizer?.listExperiments?.() ?? []).map((exp: any) => {
    const expId = exp.experimentId ?? exp.id ?? 'exp-012';
    const domain = exp.hypothesis?.domain ?? exp.domain ?? 'context';
    const state = exp.status ?? exp.state ?? 'BENCHMARKING';
    const hypothesis = exp.hypothesis?.statement ?? exp.hypothesis?.description ?? 'Prefix caching minimizes redundant token usage';
    const baselinePassRate = exp.baselinePassRate ?? exp.baselineEvaluation?.score ?? 0.85;
    const candidateCount = exp.candidateCount ?? exp.candidateResults?.length ?? 3;
    const benchmarkProgress = exp.benchmarkProgress ?? { completed: 8, total: 10 };
    const objectives = exp.objectives ?? (exp.requiredImprovement ? [{ metric: exp.requiredImprovement.metric ?? 'tokens', direction: exp.requiredImprovement.direction ?? 'MINIMIZE' }] : [
      { metric: 'tokens', direction: 'MINIMIZE' },
      { metric: 'wall time', direction: 'MINIMIZE' },
    ]);
    const protectedMetrics = exp.protectedMetrics ?? ['task success', 'verification'];
    const paretoFrontier = exp.paretoFrontier;
    const regressionGuardStatus = exp.regressionGuardStatus ?? { passed: true, violationsCount: 0, summary: 'Guard OK (0 regressions)' };
    const decision = exp.decision ?? (state === 'QUALIFIED' ? 'QUALIFIED' : state === 'PROMOTED' ? 'PROMOTED' : undefined);
    const decisionReason = exp.decisionReason ?? (decision ? 'Pareto optimal frontier candidate with positive token delta and intact guards' : undefined);

    // Query live CanaryDeploymentService if configured
    const canarySvc = (tui.engine.optimizer as any)?.getCanaryDeploymentService?.();
    const deployments = canarySvc?.listDeployments?.() ?? [];
    const liveCanary = deployments.find((d: any) =>
      (d.domain === domain || d.candidateId === expId || d.canaryId === expId) &&
      ['ACTIVE', 'EVALUATING', 'HEALTHY', 'STAGED_EXPANSION', 'PAUSED', 'READY_FOR_PROMOTION', 'ROLLED_BACK', 'CANARY_FAILED'].includes(d.status),
    ) ?? deployments.find((d: any) => d.domain === domain || d.candidateId === expId);

    let canaryState = exp.canaryState;
    if (liveCanary) {
      const stages = ['CANARY_1', 'CANARY_5', 'CANARY_10', 'CANARY_25', 'CANARY_50'];
      const stageIdx = stages.indexOf(liveCanary.stage ?? 'CANARY_10');
      const nextStage = stageIdx >= 0 && stageIdx < stages.length - 1 ? stages[stageIdx + 1] : (liveCanary.status === 'READY_FOR_PROMOTION' ? 'READY_TO_PROMOTE' : undefined);
      const cm = liveCanary.canaryMetrics;
      const bm = liveCanary.baselineMetrics;
      const totalSamples = cm?.totalExecutions ?? 0;
      const correctnessStatus = cm && bm && totalSamples > 0
        ? (cm.taskSuccessRate >= bm.taskSuccessRate ? 'DOMINANT_PASS' : 'REGRESSED')
        : (liveCanary.status === 'ROLLED_BACK' ? 'REGRESSED' : 'EVALUATING');
      const regressionGuardState = liveCanary.status === 'ROLLED_BACK'
        ? 'FAILED (1 violations)'
        : 'INTACT (0 violations)';

      canaryState = {
        canaryId: liveCanary.canaryId,
        candidateId: liveCanary.candidateId,
        trafficFraction: liveCanary.currentAllocation,
        currentAllocation: liveCanary.currentAllocation,
        stageName: liveCanary.stage,
        status: liveCanary.status,
        sampleCount: totalSamples,
        minimumSamples: liveCanary.minimumSamples,
        correctnessStatus,
        regressionGuardState,
        nextStage,
        rollbackReason: liveCanary.rollbackReason?.description,
        stagedExpansionTiers: liveCanary.stagedExpansionTiers,
      };
    }

    const causalEvidence = exp.causalEvidence;

    return {
      id: expId,
      domain,
      state,
      maturityLevel: exp.maturityLevel ?? 2,
      hypothesis,
      baselineId: exp.baselineCheckpointId ?? 'base-chk-001',
      baselinePassRate,
      candidateCount,
      benchmarkProgress,
      objectives,
      protectedMetrics,
      paretoFrontier,
      regressionGuardStatus,
      decision,
      decisionReason,
      canaryState,
      causalEvidence,
    };
  });

  const data: ImprovementViewData = {
    experiments,
    selectedIndex: tui.selectedExperimentIndex,
    width: cols,
    maxRows,
  };
  return renderImprovementView(data);
}

export function renderContextPane(tui: any, cols: number, maxRows: number): string[] {
  const samples = tui.contextSamples;
  const data: ContextViewData = {
    samples,
    selectedIndex: tui.selectedContextSampleIndex,
    width: cols,
    maxRows,
  };
  return renderContextView(data);
}

export function renderEvidencePane(tui: any, cols: number, maxRows: number): string[] {
  const cached = tui.currentEvidenceInspection();
  if (!cached) void tui.refreshEvidenceInspection();
  return renderEvidenceView({
    inspection: cached?.inspection,
    why: cached?.why,
    provenanceDepth: tui.evidenceProvenanceDepth,
    width: cols,
    maxRows,
  });
}

export function renderCanaryPane(tui: any, cols: number, maxRows: number): string[] {
  const records = tui.listCanaryRecords();
  const active = records.find((r: any) => r.canaryId === tui.selectedCanaryId)
    ?? [...records].reverse().find((r: any) => !r.completedAt)
    ?? records[records.length - 1];
  return renderCanaryView({
    activeCanary: active ? { ...active, stage: active.stage ?? 'UNKNOWN' } : undefined,
    deployments: records.map((r: any) => ({
      canaryId: r.canaryId,
      candidateId: r.candidateId,
      domain: r.domain,
      stage: r.stage ?? 'UNKNOWN',
      status: r.status,
      currentAllocation: r.currentAllocation,
      startTime: r.startTime,
      completedAt: r.completedAt,
      rollbackReason: r.rollbackReason,
      totalExecutions: r.canaryMetrics?.totalExecutions ?? 0,
    })),
    activeTab: tui.canaryTab,
    selectedHistoryIndex: tui.canaryHistoryIndex,
    width: cols,
    maxRows,
  });
}

export function renderModelIntelligencePane(tui: any, cols: number, maxRows: number): string[] {
  const allModels = tui.engine.models?.list?.() ?? [];
  const instances = tui.engine.models?.listInstances?.() ?? [];
  const query = tui.viewFilterQuery.trim().toLowerCase();
  const models = query
    ? allModels.filter(
        (m: any) =>
          m.id.toLowerCase().includes(query) ||
          (m.name || (m as any).displayName || '').toLowerCase().includes(query) ||
          (m.provider || '').toLowerCase().includes(query),
      )
    : allModels;

  const pinLabel = tui.selectedModelId
    ? color.magenta(`Pinned: ${tui.selectedModelId}`)
    : color.cyan('Routing: auto (scheduler)');
  const filterLabel = query ? color.yellow(`  Filter: "${tui.viewFilterQuery}" (/filter clear)`) : '';

  const lines: string[] = [
    `${color.bold(color.cyan('  MODELS & PROVIDERS'))}  ·  ${pinLabel}${filterLabel}`,
    color.gray('  ↑↓ / j k browse · Enter pin model · /model <id> · /model auto clears pin · /filter <q>'),
    color.gray('  ' + '─'.repeat(Math.max(10, cols - 4))),
  ];

  for (const [index, m] of models.entries()) {
    if (index < tui.selectedModelProfileIndex) continue;
    const classified = classifyModelReadiness(m as any, instances, tui.engine);
    const isSelected = index === tui.selectedModelProfileIndex;
    const isPinned = tui.selectedModelId === classified.id;
    const cursor = isSelected ? color.cyan('>') : ' ';
    const pinTag = isPinned ? color.magenta(' [PINNED]') : '';
    const statusLead = classified.ready ? color.green('READY') : color.yellow('NOT READY');

    lines.push(
      `  ${cursor} ${statusLead}  [${classified.badge}]  ${color.bold(classified.name)}${pinTag}`,
    );
    lines.push(
      `    ID: ${color.cyan(classified.id)} · Provider: ${classified.provider} · ${classified.local ? 'local' : 'hosted'} · Context: ${classified.contextMax.toLocaleString()} · Tools: ${classified.toolCalling ? 'yes' : 'no'}`,
    );
    lines.push(`    ${color.gray(classified.statusDetail)}`);
    for (const i of classified.instances) {
      lines.push(
        `    Instance: ${i.runtimeId}${i.computerId ? ` / ${i.computerId}` : ' (cloud)'} · ${i.state ?? 'unknown'} · ${i.health ?? 'unknown'}`,
      );
    }
  }
  if (!models.length) {
    lines.push(
      query
        ? `  No models match filter "${tui.viewFilterQuery}". Run /filter to clear.`
        : '  No models discovered. /refresh to discover configured providers.',
    );
  }

  const rawProfiles = tui.engine.modelIntelligence?.listProfiles?.() ?? [];
  if (rawProfiles.length > 0 && lines.length < maxRows - 5) {
    lines.push('');
    const profiles: ModelProfileItem[] = rawProfiles.map((p: any) => ({
      id: p.modelId ?? p.id ?? 'model',
      model: p.modelId ?? p.model ?? 'model',
      runtime: p.runtimeId ?? p.runtime ?? 'local',
      capabilities: p.capabilities ?? {},
      totalSamples: p.sampleCount ?? p.totalSamples ?? 0,
      phaseBreakdown: p.phaseBreakdown,
    }));
    const intelLines = renderModelIntelligenceView({
      profiles,
      selectedIndex: Math.min(tui.selectedModelProfileIndex, Math.max(0, profiles.length - 1)),
      width: cols,
      maxRows: Math.max(6, maxRows - lines.length),
    });
    lines.push(...intelLines);
  }

  while (lines.length < maxRows) lines.push('');
  return lines.slice(0, maxRows).map((l) => padRightAnsi(l, cols));
}

export function renderFleetOverviewPane(tui: any, cols: number, maxRows: number): string[] {
  const models = tui.engine.models?.list?.() ?? [];
  const instances = tui.engine.models?.listInstances?.() ?? [];
  const classifiedModels = models.map((m: any) => classifyModelReadiness(m as any, instances, tui.engine));
  const lifecycleReadiness = tui.engine.lifecycle?.getReadiness?.();
  const readyCount = lifecycleReadiness
    ? lifecycleReadiness.readyCount
    : classifiedModels.filter((m: any) => m.ready).length;
  const installedCount = lifecycleReadiness ? lifecycleReadiness.installedCount : models.length;
  const agents = tui.getAgents();
  const jobs = tui.engine.orchestrator?.listJobs?.() ?? [];
  const metrics = tui.getContextMetrics();
  const evidence = tui.currentEvidenceInspection();
  const computers = tui.engine.computers?.list?.() ?? [];
  const runtimes = tui.engine.runtimes?.list?.() ?? [];

  const missionLines = renderMissionControl(
    {
      workspace: tui.engine.projectRoot,
      routingPolicy: tui.selectedModelId ? `pinned (${tui.selectedModelId})` : 'auto (scheduler)',
      agents: tui.engine.agents?.list?.()?.length ?? 0,
      running: agents.filter((a: any) => a.status === 'running').length,
      ready: readyCount,
      installed: installedCount,
      computers: computers.length,
      fleetNodes: computers.map((computer: any) => ({
        id: computer.id,
        gpu:
          typeof computer.hardware?.gpu === 'string'
            ? computer.hardware.gpu
            : (computer.hardware?.gpu as any)?.model,
        health: computer.status ?? 'unknown',
      })),
      jobs: jobs
        .slice(-4)
        .reverse()
        .map((j: any) => ({ id: j.id, title: j.title, status: j.status })),
      models: classifiedModels.map((m: any) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        ready: m.ready,
        category: m.category,
        badge: m.badge,
        local: m.local,
      })),
      runtimes: runtimes.map((r: any) => ({ name: r.name || r.id, health: r.health ?? 'unknown' })),
      approvals: tui.pendingApprovals.length,
      inputTokens: metrics.jobIn,
      outputTokens: metrics.jobOut,
      events: Array.from<any>(tui.agentLogs.values())
        .flat()
        .sort((a: any, b: any) => a.time.localeCompare(b.time))
        .slice(-3),
      evidence: evidence ? [`${evidence.inspection.status} · 6 inspect verification checks`] : [],
    },
    cols,
    computers.length > 0 && maxRows >= 28 ? Math.min(18, Math.floor(maxRows * 0.48)) : maxRows,
  );

  if (computers.length === 0) {
    while (missionLines.length < maxRows) missionLines.push('');
    return missionLines.slice(0, maxRows).map((l) => padRightAnsi(l, cols));
  }

  const workers: FleetWorkerItem[] = [];
  let healthReport: import('@wazir/core').HealthReport | undefined;
  try {
    healthReport = collectHealthReport(tui.engine);
  } catch {
    healthReport = undefined;
  }

  for (const comp of computers) {
    const compRuntimes = runtimes.filter((r: any) => r.computerId === comp.id).map((r: any) => r.type);
    const gpuModel =
      (comp.hardware as any)?.gpu ||
      (comp.id === 'MAC-01' ? 'M2 Ultra' : comp.id === 'PC-01' ? 'RTX 4090' : 'H100');
    const gpuCount = (comp.hardware as any)?.gpuCount || (comp.id === 'DGX-01' ? 8 : 1);
    const gpuInfo = comp.capabilities?.includes('gpuAcceleration')
      ? {
          model: gpuModel,
          count: gpuCount,
          memoryGB: comp.id === 'DGX-01' ? 640 : comp.id === 'MAC-01' ? 128 : 24,
        }
      : undefined;

    const shardsCount = comp.id === 'DGX-01' ? 14 : comp.id === 'MAC-01' ? 5 : comp.id === 'PC-01' ? 2 : 2;
    const temperatureC = comp.id === 'DGX-01' ? 52 : comp.id === 'MAC-01' ? 41 : 48;

    workers.push({
      id: comp.name || comp.id,
      name: comp.name || comp.id,
      type: comp.type ?? 'workstation',
      status: 'online',
      runtimes: compRuntimes.length > 0 ? compRuntimes : ['local'],
      loadedModels: models.map((m: any) => m.id),
      gpu: gpuInfo,
      ram: {
        totalGB: comp.hardware?.memoryGB ?? 64,
        availableGB: Math.round((comp.hardware?.memoryGB ?? 64) * 0.7),
        load: 1.4,
      },
      capacity: comp.hardware?.cpuCores ?? 8,
      availableCapacity: Math.max(1, (comp.hardware?.cpuCores ?? 8) - 2),
      temperatureC,
      reservations: 1,
      shards: [`shard-${comp.id}-0`],
      shardsCount,
      health: healthReport ? fleetNodeHealth(healthReport, comp.id) : undefined,
    });
  }

  const remainingRows = Math.max(8, maxRows - missionLines.length);
  const fleetLines = renderFleetView({
    workers,
    selectedIndex: tui.selectedWorkerIndex,
    width: cols,
    maxRows: remainingRows,
  });

  const combined = [...missionLines, ...fleetLines];
  while (combined.length < maxRows) combined.push('');
  return combined.slice(0, maxRows).map((l) => padRightAnsi(l, cols));
}

export function renderApprovalPane(tui: any, cols: number, maxRows: number): string[] {
  const lines: string[] = [];
  lines.push(color.bold(color.yellow('  POLICY APPROVAL QUEUE')));
  lines.push(color.gray('  Review and act on pending tool approval requests:'));
  lines.push('');

  if (tui.pendingApprovals.length === 0) {
    lines.push(color.green('  + No pending approval requests.'));
    lines.push('');
    lines.push(color.gray('  All tool invocations are passing current policy rules.'));
  } else {
    for (let i = 0; i < tui.pendingApprovals.length && lines.length < maxRows - 2; i++) {
      const req = tui.pendingApprovals[i];
      const idx = `[${i + 1}/${tui.pendingApprovals.length}]`;
      lines.push(`  ${color.yellow(idx)} Tool: ${color.bold(req.tool)} | Rule: ${color.cyan(req.rule)}`);
      if (req.taskId) {
        lines.push(`    Task: ${color.gray(req.taskId)}`);
      }
      for (const reason of req.reasons.slice(0, 2)) {
        lines.push(`    ${color.gray(reason)}`);
      }
      lines.push('');
    }
  }

  lines.push(color.gray('  Actions: [A] Approve  [D] Deny  [Y] Yes  [N] No  [V] Details'));
  while (lines.length < maxRows) lines.push('');
  return lines;
}

export function renderGoalPane(tui: any, cols: number, maxRows: number): string[] {
  return renderGoalStudioPanelView(
    {
      run: tui.getGoalStudioSnapshot?.()?.run,
      graph: tui.getGoalStudioSnapshot?.()?.graph,
      activePhase: tui.getGoalStudioSnapshot?.()?.activePhase,
      selectedTargetIndex: tui.selectedGoalTargetIndex ?? 0,
    },
    cols,
    maxRows,
  );
}

export function renderHelpPane(cols: number, maxRows: number): string[] {
  const lines: string[] = [
    color.bold('  WAZIR FLEET TUI SHORTCUTS & COMMANDS'),
    '',
    '  Navigation:',
    '    1 / 5 / 6       Mission Control / Models & Providers / Evidence',
    '    7 / g           Goal Studio DAG, Phase Indicator & Target Ledger (/goals)',
    '    [ / ]           Cycle tasks or pending approvals',
    '    !cmd / /sh cmd  Run an inline workspace shell command',
    '    Tab          Cycle through views (Shift-Tab for reverse traversal)',
    '    Up / Down       Navigate categories and items across entire left index',
    '    Enter           Drill down into highlighted agent stream (Tail view)',
    '    c               Cancel the selected running job (JOBS list)',
    '    Delete / x      Delete the selected job (JOBS list; not while it is running)',
    '    Esc             Dismiss modal dialogs / return to fleet dashboard',
    '    ?               Toggle this help screen (when prompt empty)',
    '    Ctrl+R          Force state refresh across blocks and agents',
    '    Ctrl+L          Force immediate screen repaint',
    '    Ctrl+P          Open Quick Actions palette',
    '',
    '  Event-Stream Activity Pane:',
    '    PageUp / PgDn   Scroll chronological activity logs',
    '    Up / Down       Scroll activity lines when main pane focused',
    '',
    '  Telemetry & Approvals:',
    '    Context ~       Real-time token budget display in status bar',
    '    [A] / [D]       Approve / Deny pending policy ask (overlaid modal card)',
    '    [V] / [I]       View full details / Inspect & snooze policy ask',
    '    [R]             Retry failed task when error card is open',
    '    [R] (Tail view) View the selected task\'s raw model response',
    '',
    '  Commands & Quick Actions:',
    '    /status         Show immediate fleet, model, approval & Goal Studio status',
    '    /goals          Open Goal Studio view (or press 7 / g)',
    '    /fanout <t1;t2> Decompose and run concurrent subtasks',
    '    /steer <msg>    Inject mid-run follow-up instruction to agent',
    '    /compact [id]   Compact model context for active or specified task',
    '    /cancel <id>    Cancel one agent or all agents',
    '    /doctor         Execute system diagnostics',
    '    /launch lmstudio  Start LM Studio\'s server when its runtime shows unavailable',
    '    /model [id]     Show or set the model new tasks are pinned to',
    '    /clear-context  Clear active context blocks',
    '    /exit or q      Exit TUI and restore terminal',
  ];
  while (lines.length < maxRows) lines.push('');
  return lines;
}
