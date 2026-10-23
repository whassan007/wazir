import type { ModelSelectionMode, ReasoningEffortLevel } from '@wazir/core';
import { buildModalBox } from './fleetTuiPanes.js';
import { color } from '../colors.js';
import { stripAnsiStr, truncateAnsiStr } from './fleetTuiTypes.js';
import {
  ModelSelectorController as StateModelSelectorController,
  type ModelSelectorItem,
  type ModelSelectorAction,
} from './modelSelectorState.js';

export type { ModelSelectorItem, ModelSelectorAction };

export interface ModelSelectorControllerOptions {
  initialMode?: ModelSelectionMode;
  initialModelId?: string;
  initialEffort?: ReasoningEffortLevel;
  models?: ModelSelectorItem[];
  deviceSummary?: string;
  runtimeSummary?: string;
}

export class ModelSelectorController extends StateModelSelectorController {
  public deviceSummary?: string;
  public runtimeSummary?: string;

  constructor(options?: ModelSelectorControllerOptions) {
    super(options);
    if (options?.deviceSummary) this.deviceSummary = options.deviceSummary;
    if (options?.runtimeSummary) this.runtimeSummary = options.runtimeSummary;
  }

  public getFilteredLocalModels(): ModelSelectorItem[] {
    const local = this.getLocalModels();
    if (!this.searchQuery) return local;
    const q = this.searchQuery.toLowerCase();
    return local.filter(
      (m) =>
        m.modelId.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q)
    );
  }

  public override handleKey(key: string, seqId?: number): ModelSelectorAction {
    if (this.dedupeKey(key, seqId)) {
      return { type: 'none' };
    }

    this.warningMessage = undefined;
    this.transitionCount++;

    // Left / Right always cycle reasoning effort
    if (key === '\x1b[D' || key === 'left') {
      const sequence: ReasoningEffortLevel[] = ['high', 'medium', 'low'];
      const idx = sequence.indexOf(this.reasoningEffort);
      this.reasoningEffort = sequence[(idx + 1) % sequence.length];
      return { type: 'none' };
    }
    if (key === '\x1b[C' || key === 'right') {
      const sequence: ReasoningEffortLevel[] = ['low', 'medium', 'high'];
      const idx = sequence.indexOf(this.reasoningEffort);
      this.reasoningEffort = sequence[(idx + 1) % sequence.length];
      return { type: 'none' };
    }

    if (this.view === 'modes') {
      const modeCount = 6; // Auto, Fast, Balanced, Powerful, Local, Custom
      if (key === 'up' || key === '\x1b[A' || key === 'k') {
        this.selectedIndex = (this.selectedIndex - 1 + modeCount) % modeCount;
        return { type: 'none' };
      }
      if (key === 'down' || key === '\x1b[B' || key === 'j') {
        this.selectedIndex = (this.selectedIndex + 1) % modeCount;
        return { type: 'none' };
      }
      if (key === '\r' || key === 'enter' || key === 'return') {
        if (this.selectedIndex === 4) {
          // Local view
          this.view = 'local';
          this.selectedIndex = 0;
          this.searchQuery = '';
          this.isSearching = false;
          return { type: 'navigate', view: 'local' };
        }
        if (this.selectedIndex === 5) {
          // Custom view
          this.view = 'custom';
          this.selectedIndex = 0;
          this.searchQuery = '';
          this.isSearching = false;
          return { type: 'none' };
        }
        const modes: ModelSelectionMode[] = ['auto', 'fast', 'balanced', 'powerful', 'local', 'custom'];
        const mode = modes[this.selectedIndex] ?? 'auto';
        this.currentMode = mode;
        this.isOpen = false;
        return { type: 'select', scope: 'default', mode, reasoningEffort: this.reasoningEffort };
      }
      if (key === 's' || key === 'S') {
        if (this.selectedIndex === 4) {
          // Local view
          this.view = 'local';
          this.selectedIndex = 0;
          this.searchQuery = '';
          this.isSearching = false;
          return { type: 'navigate', view: 'local' };
        }
        if (this.selectedIndex === 5) {
          // Custom view
          this.view = 'custom';
          this.selectedIndex = 0;
          this.searchQuery = '';
          this.isSearching = false;
          return { type: 'none' };
        }
        const modes: ModelSelectionMode[] = ['auto', 'fast', 'balanced', 'powerful', 'local', 'custom'];
        const mode = modes[this.selectedIndex] ?? 'auto';
        this.currentMode = mode;
        this.isOpen = false;
        return { type: 'select', scope: 'session', mode, reasoningEffort: this.reasoningEffort };
      }
      if (key === '\x1b' || key === 'escape') {
        this.isOpen = false;
        return { type: 'cancel' };
      }
    } else if (this.view === 'local') {
      const filteredLocal = this.getFilteredLocalModels();
      const totalRows = 1 + filteredLocal.length; // Row 0 is Auto Local Routing

      if (key === 'up' || key === '\x1b[A' || key === 'k') {
        if (totalRows > 0) {
          this.selectedIndex = (this.selectedIndex - 1 + totalRows) % totalRows;
        }
        return { type: 'none' };
      }
      if (key === 'down' || key === '\x1b[B' || key === 'j') {
        if (totalRows > 0) {
          this.selectedIndex = (this.selectedIndex + 1) % totalRows;
        }
        return { type: 'none' };
      }

      if (key === '/' && !this.isSearching) {
        this.isSearching = true;
        this.searchQuery = '';
        this.selectedIndex = 0;
        return { type: 'none' };
      }

      if (this.isSearching) {
        if (key === '\r' || key === 'enter' || key === 'return') {
          this.isSearching = false;
          return { type: 'none' };
        }
        if (key === '\x7f' || key === '\b' || key === 'backspace') {
          if (this.searchQuery.length > 0) {
            this.searchQuery = this.searchQuery.slice(0, -1);
            this.selectedIndex = 0;
          }
          return { type: 'none' };
        }
        if (key === '\x1b' || key === 'escape') {
          this.isSearching = false;
          this.searchQuery = '';
          this.selectedIndex = 0;
          return { type: 'none' };
        }
        if (key.length === 1 && key >= ' ' && key <= '~') {
          this.searchQuery += key;
          this.selectedIndex = 0;
          return { type: 'none' };
        }
      } else {
        if (key === 'a' || key === 'A') {
          // Shortcut for Auto Local Routing
          this.currentMode = 'local';
          this.currentModelId = undefined;
          this.isOpen = false;
          return {
            type: 'select',
            scope: 'default',
            mode: 'local',
            modelId: undefined,
            reasoningEffort: this.reasoningEffort,
          };
        }
        if (key === '\r' || key === 'enter' || key === 'return' || key === 's' || key === 'S') {
          const scope = key === 's' || key === 'S' ? 'session' : 'default';
          if (this.selectedIndex === 0) {
            // Auto Local Routing
            this.currentMode = 'local';
            this.currentModelId = undefined;
            this.isOpen = false;
            return {
              type: 'select',
              scope,
              mode: 'local',
              modelId: undefined,
              reasoningEffort: this.reasoningEffort,
            };
          } else {
            const item = filteredLocal[this.selectedIndex - 1];
            if (!item) return { type: 'none' };

            if (!item.available || item.runtimeHealth === 'unavailable' || item.eligible === false) {
              this.warningMessage = `Cannot select ${item.modelId}: ${item.ineligibleReason || 'runtime offline or insufficient memory'}`;
              return { type: 'rejected', modelId: item.modelId, reason: this.warningMessage };
            }

            this.currentMode = 'local';
            this.currentModelId = item.modelId;
            this.isOpen = false;
            return {
              type: 'select',
              scope,
              mode: 'local',
              modelId: item.modelId,
              reasoningEffort: this.reasoningEffort,
              requiresLoad: !item.loaded,
            };
          }
        }
        if (key === '\x1b' || key === 'escape') {
          this.view = 'modes';
          this.selectedIndex = 4; // Local
          this.searchQuery = '';
          this.warningMessage = undefined;
          return { type: 'navigate', view: 'modes' };
        }
      }
    } else {
      // Custom view
      const filtered = this.getFilteredModels();
      if (key === 'up' || key === '\x1b[A' || key === 'k') {
        if (filtered.length > 0) {
          this.selectedIndex = (this.selectedIndex - 1 + filtered.length) % filtered.length;
        }
        return { type: 'none' };
      }
      if (key === 'down' || key === '\x1b[B' || key === 'j') {
        if (filtered.length > 0) {
          this.selectedIndex = (this.selectedIndex + 1) % filtered.length;
        }
        return { type: 'none' };
      }
      if (key === '\t' || (!this.isSearching && (key === 'f' || key === 'F'))) {
        const providers = ['all', ...Array.from(new Set(this.models.map((m) => m.provider)))];
        const pIdx = providers.indexOf(this.providerFilter);
        this.providerFilter = providers[(pIdx + 1) % providers.length] ?? 'all';
        this.selectedIndex = 0;
        return { type: 'none' };
      }
      if (key === '\x14' || key === 'Ctrl+T' || (!this.isSearching && (key === 't' || key === 'T'))) {
        const tiers: Array<'any' | 'T1' | 'T2' | 'T3' | 'T4'> = ['any', 'T1', 'T2', 'T3', 'T4'];
        const tIdx = tiers.indexOf(this.costTierFilter);
        this.costTierFilter = tiers[(tIdx + 1) % tiers.length] ?? 'any';
        this.selectedIndex = 0;
        return { type: 'none' };
      }
      if (key === '/' && !this.isSearching) {
        this.isSearching = true;
        this.searchQuery = '';
        this.selectedIndex = 0;
        return { type: 'none' };
      }
      if (key === '\x7f' || key === '\b' || key === 'backspace') {
        if (this.searchQuery.length > 0) {
          this.searchQuery = this.searchQuery.slice(0, -1);
          this.selectedIndex = 0;
        }
        return { type: 'none' };
      }
      if (key === '\r' || key === 'enter' || key === 'return') {
        if (this.isSearching) {
          this.isSearching = false;
          return { type: 'none' };
        }
        const selectedItem = filtered[this.selectedIndex];
        if (!selectedItem) return { type: 'none' };
        if (selectedItem.eligible === false || !selectedItem.available) {
          const reason = selectedItem.ineligibleReason ?? 'insufficient hardware or memory';
          this.warningMessage = `Ineligible: ${reason}`;
          return { type: 'rejected', modelId: selectedItem.modelId, reason };
        }
        this.currentMode = 'custom';
        this.currentModelId = selectedItem.modelId;
        this.isOpen = false;
        return {
          type: 'select',
          scope: 'default',
          mode: 'custom',
          modelId: selectedItem.modelId,
          reasoningEffort: this.reasoningEffort,
          requiresLoad: selectedItem.local ? !selectedItem.loaded : undefined,
        };
      }
      if (key === 's' || key === 'S') {
        if (this.isSearching) {
          this.searchQuery += key;
          this.selectedIndex = 0;
          return { type: 'none' };
        }
        const selectedItem = filtered[this.selectedIndex];
        if (!selectedItem) return { type: 'none' };
        if (selectedItem.eligible === false || !selectedItem.available) {
          const reason = selectedItem.ineligibleReason ?? 'insufficient hardware or memory';
          this.warningMessage = `Ineligible: ${reason}`;
          return { type: 'rejected', modelId: selectedItem.modelId, reason };
        }
        this.currentMode = 'custom';
        this.currentModelId = selectedItem.modelId;
        this.isOpen = false;
        return {
          type: 'select',
          scope: 'session',
          mode: 'custom',
          modelId: selectedItem.modelId,
          reasoningEffort: this.reasoningEffort,
          requiresLoad: selectedItem.local ? !selectedItem.loaded : undefined,
        };
      }
      if (key === '\x1b' || key === 'escape') {
        if (this.isSearching) {
          this.isSearching = false;
          return { type: 'none' };
        }
        this.view = 'modes';
        this.selectedIndex = 5; // Custom
        this.searchQuery = '';
        this.warningMessage = undefined;
        return { type: 'none' };
      }
      if (key.length === 1 && key >= ' ' && key <= '~') {
        this.searchQuery += key;
        this.selectedIndex = 0;
        return { type: 'none' };
      }
    }

    return { type: 'none' };
  }
}

export function renderModelSelectorModal(state: ModelSelectorController, cols: number): string[] {
  const modalWidth = Math.min(cols, 88);
  const body: string[] = [];

  if (state.view === 'modes') {
    const title = ' WAZIR — Select Model ';
    const options = [
      { label: 'Auto (recommended)', desc: 'Select the best eligible model per task' },
      { label: 'Fast', desc: 'Low latency and low cost' },
      { label: 'Balanced', desc: 'Quality, speed, and cost' },
      { label: 'Powerful', desc: 'Advanced coding and reasoning' },
      { label: 'Local', desc: 'Browse local models' },
      { label: 'Custom', desc: 'Browse all models' },
    ];

    const modes: ModelSelectionMode[] = ['auto', 'fast', 'balanced', 'powerful', 'local', 'custom'];

    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const isSel = i === state.selectedIndex;
      const isCurrent = state.currentMode === modes[i];
      const cursor = isSel ? color.blue('> ') : '  ';
      const indicator = isCurrent ? color.green('● ') : '  ';
      const labelText = isSel ? color.blue(color.bold(opt.label)) : color.bold(opt.label);
      body.push(`${cursor}${indicator}${labelText.padEnd(24)} ${color.gray(opt.desc)}`);
    }

    body.push('');
    const currentLabel = state.currentModelId
      ? `${state.currentMode} (${state.currentModelId})`
      : state.currentMode.charAt(0).toUpperCase() + state.currentMode.slice(1);
    body.push(`Current: ${color.cyan(currentLabel)}`);
    body.push(
      `Reasoning effort: ${color.bold(state.reasoningEffort.charAt(0).toUpperCase() + state.reasoningEffort.slice(1))}`
    );

    const actions = `${color.bold('↑↓')} Navigate   ${color.bold('←→')} Effort   ${color.bold('Enter')} Set default   ${color.bold('S')} Session only   ${color.bold('Esc')} Cancel`;
    return buildModalBox(title, body, actions, modalWidth, 'yellow');
  } else if (state.view === 'local') {
    const title = ' WAZIR — Local Models ';

    const detectedDevice =
      state.deviceSummary ||
      state.models.find((m) => m.local && m.deviceLabel)?.deviceLabel ||
      state.models.find((m) => m.deviceLabel)?.deviceLabel ||
      'Local Hardware';

    const detectedRuntime =
      state.runtimeSummary ||
      state.models.find((m) => m.local && m.runtimeName)?.runtimeName ||
      (() => {
        const local = state.getLocalModels();
        if (local.length > 0) {
          const providers = Array.from(new Set(local.map((m) => m.provider)));
          return providers.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(', ');
        }
        return undefined;
      })() ||
      'No active local runtime';

    body.push(`Device:  ${color.cyan(detectedDevice)}`);
    body.push(`Runtime: ${color.cyan(detectedRuntime)}`);

    if (state.isSearching || state.searchQuery) {
      body.push(`Search:  ${color.cyan(state.searchQuery || '(type to filter...)')}`);
    }
    body.push(color.gray('-'.repeat(modalWidth - 8)));

    // Row 0: Auto Local Routing
    const isAutoSel = state.selectedIndex === 0;
    const isAutoCurrent = state.currentMode === 'local' && !state.currentModelId;
    const autoCursor = isAutoSel ? color.blue('> ') : '  ';
    const autoIndicator = isAutoCurrent ? color.green('● ') : '  ';
    const autoLabel = isAutoSel ? color.blue(color.bold('Auto Local Routing')) : color.bold('Auto Local Routing');
    body.push(
      `${autoCursor}${autoIndicator}${autoLabel.padEnd(24)} ${color.gray('Automatically route among eligible local models')}`
    );

    const allLocal = state.getLocalModels();
    const filteredLocal = state.getFilteredLocalModels();

    if (allLocal.length === 0) {
      body.push('');
      body.push(color.yellow('  No local models discovered.'));
      body.push(color.gray('  Start Ollama or LM Studio (or run /launch lmstudio) to browse local models.'));
      body.push('');
    } else if (filteredLocal.length === 0) {
      body.push('');
      body.push(color.yellow(`  No local models match '${state.searchQuery}'.`));
      body.push('');
    } else {
      const maxVisible = 5;
      const activeIdx = Math.max(0, state.selectedIndex - 1);
      const startIdx = Math.max(
        0,
        Math.min(activeIdx - Math.floor(maxVisible / 2), Math.max(0, filteredLocal.length - maxVisible))
      );
      const visible = filteredLocal.slice(startIdx, startIdx + maxVisible);

      for (let i = 0; i < visible.length; i++) {
        const m = visible[i];
        const actualIdx = startIdx + i;
        const isSel = state.selectedIndex === actualIdx + 1;
        const isCurrent = state.currentMode === 'local' && state.currentModelId === m.modelId;
        const cursor = isSel ? color.blue('> ') : '  ';
        const indicator = isCurrent ? color.green('● ') : '  ';

        let statusBadge: string;
        let readiness: string;

        if (m.loaded) {
          statusBadge = color.green('● Loaded');
          readiness = color.green('Ready');
        } else if (!m.available || m.runtimeHealth === 'unavailable') {
          statusBadge = color.red('Unavailable');
          readiness = color.red('Runtime offline');
        } else if (!m.eligible) {
          statusBadge = color.yellow('× Installed');
          const reason = m.ineligibleReason ? ` (${m.ineligibleReason})` : '';
          readiness = color.yellow(`Insufficient memory${reason}`);
        } else {
          statusBadge = color.cyan('○ Installed');
          readiness = color.cyan('Can load');
        }

        const modelText = isSel ? color.blue(color.bold(m.modelId)) : color.bold(m.modelId);
        body.push(`${cursor}${indicator}${modelText} [${statusBadge}] ${readiness}`);

        const memStr = m.memoryGB ? `~${m.memoryGB.toFixed(1).replace(/\.0$/, '')}GB` : '';
        const ctxStr = m.contextMax ? `${Math.round(m.contextMax / 1024)}K ctx` : '';
        const detailsParts = [m.provider, m.deviceLabel ?? 'Local Hardware', memStr, ctxStr].filter(Boolean);
        body.push(color.gray(`       ${detailsParts.join(' | ')}`));
      }
    }

    if (state.warningMessage) {
      body.push('');
      body.push(color.red(`⚠ ${state.warningMessage}`));
    }

    body.push('');
    body.push(
      `Reasoning effort: ${color.bold(state.reasoningEffort.charAt(0).toUpperCase() + state.reasoningEffort.slice(1))}`
    );

    const actions = `${color.bold('↑↓')} Navigate   ${color.bold('Enter')} Select   ${color.bold('A')} Auto local routing   ${color.bold('S')} Session only   ${color.bold('Esc')} Back`;
    return buildModalBox(title, body, actions, modalWidth, 'cyan');
  } else {
    // Custom view
    const title = ' WAZIR — Select Model ';
    body.push(
      `Search: ${color.cyan(state.searchQuery || '(type to filter...)')}  Filter: [Provider: ${color.yellow(state.providerFilter)}] [Cost: ${color.yellow(state.costTierFilter)}]`
    );
    body.push(color.gray('-'.repeat(modalWidth - 8)));

    const filtered = state.getFilteredModels();
    if (filtered.length === 0) {
      body.push(color.yellow('  No models match current filter / search.'));
      body.push('');
    } else {
      const maxVisible = 6;
      const startIdx = Math.max(
        0,
        Math.min(state.selectedIndex - Math.floor(maxVisible / 2), Math.max(0, filtered.length - maxVisible))
      );
      const visible = filtered.slice(startIdx, startIdx + maxVisible);

      for (let i = 0; i < visible.length; i++) {
        const m = visible[i];
        const actualIdx = startIdx + i;
        const isSel = actualIdx === state.selectedIndex;
        const cursor = isSel ? color.blue('> ') : '  ';

        let availSymbol = color.gray('○ AVAILABLE');
        if (m.loaded) availSymbol = color.green('● LOADED');
        else if (!m.eligible) availSymbol = color.red(`✗ INELIGIBLE (${m.ineligibleReason ?? 'memory'})`);

        const costBadge = color.cyan(`[${m.costTier}]`);
        const nameText = isSel ? color.blue(color.bold(m.modelId)) : color.bold(m.modelId);

        body.push(`${cursor}${nameText} ${costBadge} ${availSymbol}`);
        const details = `       ${m.provider} | ${m.deviceLabel ?? (m.local ? 'Local Hardware' : 'Hosted')} | ${m.memoryGB ? `~${m.memoryGB}GB` : ''} | ${m.contextMax ? `${Math.round(m.contextMax / 1024)}K ctx` : ''}`;
        body.push(color.gray(details));
      }
    }

    if (state.warningMessage) {
      body.push('');
      body.push(color.red(`⚠ ${state.warningMessage}`));
    }

    body.push('');
    body.push(
      `Reasoning effort: ${color.bold(state.reasoningEffort.charAt(0).toUpperCase() + state.reasoningEffort.slice(1))}`
    );

    const actions = `${color.bold('↑↓')} Nav  ${color.bold('←→')} Effort  ${color.bold('/')} Search  ${color.bold('f')} Provider  ${color.bold('t')} Cost  ${color.bold('Enter')} Set default  ${color.bold('Esc')} Back`;
    return buildModalBox(title, body, actions, modalWidth, 'cyan');
  }
}

export function renderModelSelectionConfirmation(selection: {
  scope: 'default' | 'session';
  mode: ModelSelectionMode;
  modelId?: string;
  reasoningEffort: ReasoningEffortLevel;
}): string {
  const targetStr = selection.scope === 'default' ? 'Persistent Default' : 'Session Only';
  const modelStr = selection.modelId ? `${selection.mode} (${selection.modelId})` : selection.mode;
  const header = `Model selection updated [${targetStr}]: ${modelStr} | Reasoning effort: ${selection.reasoningEffort}`;
  const modeLabel = selection.mode.charAt(0).toUpperCase() + selection.mode.slice(1);
  const resolvedModel = selection.modelId ?? (selection.mode === 'local' ? 'Auto Local' : 'Auto');
  const scopeLabel = selection.scope === 'default' ? 'Default' : 'Session';
  const structured = `Mode: ${modeLabel} · Model: ${resolvedModel} · Scope: ${scopeLabel}`;
  return `${header}\n${structured}`;
}

export function formatSelectionDetails(details: {
  modelId: string;
  device?: string;
  contextTokens?: number;
  reason?: string;
}): string {
  return [
    `Selected: ${details.modelId}`,
    `Device: ${details.device ?? 'Local Hardware / Default'}`,
    `Context: ${details.contextTokens ? `${details.contextTokens.toLocaleString()} tokens` : 'Standard'}`,
    `Reason: ${details.reason ?? 'User selected via interactive model selector'}`,
  ].join('\n');
}
