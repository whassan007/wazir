import type { ModelSelectionMode, ReasoningEffortLevel } from '@wazir/core';
import { buildModalBox } from './fleetTuiPanes.js';
import { color } from '../colors.js';
import { stripAnsiStr, truncateAnsiStr } from './fleetTuiTypes.js';

export interface ModelSelectorItem {
  modelId: string;
  name: string;
  provider: string;
  costTier: 'T1' | 'T2' | 'T3' | 'T4';
  available: boolean;
  loaded: boolean;
  local: boolean;
  eligible: boolean;
  ineligibleReason?: string;
  memoryGB?: number;
  contextMax?: number;
  deviceLabel?: string;
}

export type ModelSelectorAction =
  | { type: 'select'; scope: 'default' | 'session'; mode: ModelSelectionMode; modelId?: string; reasoningEffort: ReasoningEffortLevel }
  | { type: 'rejected'; modelId: string; reason?: string }
  | { type: 'cancel' }
  | { type: 'none' };

export class ModelSelectorController {
  public isOpen = true;
  public view: 'modes' | 'custom' = 'modes';
  public selectedIndex = 0;
  public currentMode: ModelSelectionMode = 'auto';
  public currentModelId?: string;
  public reasoningEffort: ReasoningEffortLevel = 'medium';
  public searchQuery = '';
  public providerFilter = 'all';
  public costTierFilter: 'any' | 'T1' | 'T2' | 'T3' | 'T4' = 'any';
  public isSearching = false;
  public models: ModelSelectorItem[] = [];
  public warningMessage?: string;

  constructor(options?: {
    initialMode?: ModelSelectionMode;
    initialModelId?: string;
    initialEffort?: ReasoningEffortLevel;
    models?: ModelSelectorItem[];
  }) {
    if (options?.initialMode) this.currentMode = options.initialMode;
    if (options?.initialModelId) this.currentModelId = options.initialModelId;
    if (options?.initialEffort) this.reasoningEffort = options.initialEffort;
    if (options?.models) this.models = options.models;
  }

  public getFilteredModels(): ModelSelectorItem[] {
    return this.models.filter(m => {
      const matchesSearch = !this.searchQuery ||
        m.modelId.toLowerCase().includes(this.searchQuery.toLowerCase()) ||
        m.name.toLowerCase().includes(this.searchQuery.toLowerCase()) ||
        m.provider.toLowerCase().includes(this.searchQuery.toLowerCase());

      const matchesProvider = this.providerFilter === 'all' ||
        m.provider.toLowerCase() === this.providerFilter.toLowerCase();

      const matchesCost = this.costTierFilter === 'any' ||
        m.costTier === this.costTierFilter;

      return matchesSearch && matchesProvider && matchesCost;
    });
  }

  public handleKey(key: string): ModelSelectorAction {
    this.warningMessage = undefined;

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
      if (key === '\r' || key === 'enter') {
        if (this.selectedIndex === 5) {
          this.view = 'custom';
          this.selectedIndex = 0;
          return { type: 'none' };
        }
        const modes: ModelSelectionMode[] = ['auto', 'fast', 'balanced', 'powerful', 'local', 'custom'];
        const mode = modes[this.selectedIndex] ?? 'auto';
        this.currentMode = mode;
        this.isOpen = false;
        return { type: 'select', scope: 'default', mode, reasoningEffort: this.reasoningEffort };
      }
      if (key === 's' || key === 'S') {
        if (this.selectedIndex === 5) {
          this.view = 'custom';
          this.selectedIndex = 0;
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
        // Cycle provider filter
        const providers = ['all', ...Array.from(new Set(this.models.map(m => m.provider)))];
        const pIdx = providers.indexOf(this.providerFilter);
        this.providerFilter = providers[(pIdx + 1) % providers.length] ?? 'all';
        this.selectedIndex = 0;
        return { type: 'none' };
      }
      if (key === '\x14' || key === 'Ctrl+T' || (!this.isSearching && (key === 't' || key === 'T'))) {
        // Cycle cost tier filter
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
      if (key === '\r' || key === 'enter') {
        if (this.isSearching) {
          this.isSearching = false;
          return { type: 'none' };
        }
        const selectedItem = filtered[this.selectedIndex];
        if (!selectedItem) return { type: 'none' };
        if (selectedItem.eligible === false) {
          this.warningMessage = `Ineligible: ${selectedItem.ineligibleReason ?? 'insufficient hardware or memory'}`;
          return { type: 'rejected', modelId: selectedItem.modelId, reason: selectedItem.ineligibleReason };
        }
        this.currentMode = 'custom';
        this.currentModelId = selectedItem.modelId;
        this.isOpen = false;
        return { type: 'select', scope: 'default', mode: 'custom', modelId: selectedItem.modelId, reasoningEffort: this.reasoningEffort };
      }
      if (key === 's' || key === 'S') {
        if (this.isSearching) {
          this.searchQuery += key;
          this.selectedIndex = 0;
          return { type: 'none' };
        }
        const selectedItem = filtered[this.selectedIndex];
        if (!selectedItem) return { type: 'none' };
        if (selectedItem.eligible === false) {
          this.warningMessage = `Ineligible: ${selectedItem.ineligibleReason ?? 'insufficient hardware or memory'}`;
          return { type: 'rejected', modelId: selectedItem.modelId, reason: selectedItem.ineligibleReason };
        }
        this.currentMode = 'custom';
        this.currentModelId = selectedItem.modelId;
        this.isOpen = false;
        return { type: 'select', scope: 'session', mode: 'custom', modelId: selectedItem.modelId, reasoningEffort: this.reasoningEffort };
      }
      if (key === '\x1b' || key === 'escape') {
        if (this.isSearching) {
          this.isSearching = false;
          return { type: 'none' };
        }
        this.view = 'modes';
        this.selectedIndex = 5; // Highlight Custom
        this.searchQuery = '';
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
  const modalWidth = Math.min(cols - 4, 80);
  const title = ' WAZIR — Select Model ';
  const body: string[] = [];

  if (state.view === 'modes') {
    const options = [
      { label: 'Auto (recommended)', desc: 'Select the best eligible model per task' },
      { label: 'Fast', desc: 'Low latency and low cost' },
      { label: 'Balanced', desc: 'Quality, speed, and cost' },
      { label: 'Powerful', desc: 'Advanced coding and reasoning' },
      { label: 'Local', desc: 'Prefer models on local hardware' },
      { label: 'Custom', desc: 'Browse individual models' },
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
    const currentLabel = state.currentModelId ? `${state.currentMode} (${state.currentModelId})` : (state.currentMode.charAt(0).toUpperCase() + state.currentMode.slice(1));
    body.push(`Current: ${color.cyan(currentLabel)}`);
    body.push(`Reasoning effort: ${color.bold(state.reasoningEffort.charAt(0).toUpperCase() + state.reasoningEffort.slice(1))}`);

    const actions = `${color.bold('↑↓')} Navigate   ${color.bold('←→')} Effort   ${color.bold('Enter')} Set default   ${color.bold('S')} Session only   ${color.bold('Esc')} Cancel`;
    return buildModalBox(title, body, actions, modalWidth, 'yellow');
  } else {
    // Custom view
    body.push(`Search: ${color.cyan(state.searchQuery || '(type to filter...)')}  Filter: [Provider: ${color.yellow(state.providerFilter)}] [Cost: ${color.yellow(state.costTierFilter)}]`);
    body.push(color.gray('-'.repeat(modalWidth - 8)));

    const filtered = state.getFilteredModels();
    if (filtered.length === 0) {
      body.push(color.yellow('  No models match current filter / search.'));
      body.push('');
    } else {
      const maxVisible = 6;
      const startIdx = Math.max(0, Math.min(state.selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible));
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
    body.push(`Reasoning effort: ${color.bold(state.reasoningEffort.charAt(0).toUpperCase() + state.reasoningEffort.slice(1))}`);

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
  return `Model selection updated [${targetStr}]: ${modelStr} | Reasoning effort: ${selection.reasoningEffort}`;
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
