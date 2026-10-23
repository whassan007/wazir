import type { ModelSelectionMode, ReasoningEffortLevel } from '@wazir/core';

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
  installed?: boolean;
  runtimeHealth?: 'healthy' | 'degraded' | 'unavailable';
  runtimeName?: string;
  endpoint?: string;
  statusLabel?: 'Loaded' | 'Installed' | 'Unavailable';
  readinessLabel?: string;
}

export type ModelSelectorAction =
  | { type: 'select'; scope: 'default' | 'session'; mode: ModelSelectionMode; modelId?: string; reasoningEffort: ReasoningEffortLevel; requiresLoad?: boolean }
  | { type: 'navigate'; view: 'modes' | 'local' | 'custom' }
  | { type: 'rejected'; modelId: string; reason?: string }
  | { type: 'cancel' }
  | { type: 'none' };

export class ModelSelectorController {
  public isOpen = true;
  public view: 'modes' | 'local' | 'custom' = 'modes';
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
  public transitionCount = 0;

  private lastKeySignature = '';
  private lastKeyTimestamp = 0;

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

  public getLocalModels(): ModelSelectorItem[] {
    return this.models.filter(m => m.local === true);
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

  public dedupeKey(key: string, seqId?: number): boolean {
    const now = Date.now();
    const sig = `${key}:${seqId ?? ''}`;
    if (sig === this.lastKeySignature && now - this.lastKeyTimestamp < 50) {
      return true; // duplicate
    }
    this.lastKeySignature = sig;
    this.lastKeyTimestamp = now;
    return false;
  }

  public handleKey(key: string, seqId?: number): ModelSelectorAction {
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
          // Local
          this.view = 'local';
          this.selectedIndex = 0;
          this.searchQuery = '';
          this.isSearching = false;
          return { type: 'navigate', view: 'local' };
        }
        if (this.selectedIndex === 5) {
          // Custom
          this.view = 'custom';
          this.selectedIndex = 0;
          this.searchQuery = '';
          this.isSearching = false;
          return { type: 'navigate', view: 'custom' };
        }
        const modes: ModelSelectionMode[] = ['auto', 'fast', 'balanced', 'powerful', 'local', 'custom'];
        const mode = modes[this.selectedIndex] ?? 'auto';
        this.currentMode = mode;
        this.isOpen = false;
        return { type: 'select', scope: 'default', mode, reasoningEffort: this.reasoningEffort };
      }
      if (key === 's' || key === 'S') {
        if (this.selectedIndex === 4) {
          this.view = 'local';
          this.selectedIndex = 0;
          this.searchQuery = '';
          this.isSearching = false;
          return { type: 'navigate', view: 'local' };
        }
        if (this.selectedIndex === 5) {
          this.view = 'custom';
          this.selectedIndex = 0;
          this.searchQuery = '';
          this.isSearching = false;
          return { type: 'navigate', view: 'custom' };
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
      const localModels = this.getLocalModels();
      const totalRows = 1 + localModels.length; // Row 0 is Auto Local Routing

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
      if (!this.isSearching && (key === 'a' || key === 'A')) {
        // Shortcut for Auto Local Routing
        this.currentMode = 'local';
        this.currentModelId = undefined;
        this.isOpen = false;
        return { type: 'select', scope: 'default', mode: 'local', modelId: undefined, reasoningEffort: this.reasoningEffort };
      }
      if (key === '\r' || key === 'enter' || key === 'return' || key === 's' || key === 'S') {
        const scope = (key === 's' || key === 'S') ? 'session' : 'default';
        if (this.selectedIndex === 0) {
          // Auto Local Routing
          this.currentMode = 'local';
          this.currentModelId = undefined;
          this.isOpen = false;
          return { type: 'select', scope, mode: 'local', modelId: undefined, reasoningEffort: this.reasoningEffort };
        } else {
          const item = localModels[this.selectedIndex - 1];
          if (!item) return { type: 'none' };

          if (!item.available || item.runtimeHealth === 'unavailable' || item.eligible === false) {
            this.warningMessage = `Cannot select ${item.modelId}: ${item.ineligibleReason || 'runtime offline or insufficient memory'}`;
            return { type: 'rejected', modelId: item.modelId, reason: this.warningMessage };
          }

          // Compatible & eligible
          this.currentMode = 'local';
          this.currentModelId = item.modelId;
          this.isOpen = false;
          return {
            type: 'select',
            scope,
            mode: 'local',
            modelId: item.modelId,
            reasoningEffort: this.reasoningEffort,
            requiresLoad: !item.loaded
          };
        }
      }
      if (key === '\x1b' || key === 'escape') {
        if (this.isSearching) {
          this.isSearching = false;
          this.searchQuery = '';
          return { type: 'none' };
        }
        this.view = 'modes';
        this.selectedIndex = 4; // Local
        this.searchQuery = '';
        this.warningMessage = undefined;
        return { type: 'navigate', view: 'modes' };
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
        const providers = ['all', ...Array.from(new Set(this.models.map(m => m.provider)))];
        const pIdx = providers.indexOf(this.providerFilter);
        this.providerFilter = providers[(pIdx + 1) % providers.length] ?? 'all';
        this.selectedIndex = 0;
        return { type: 'none' };
      }
      if ((!this.isSearching && (key === 't' || key === 'T'))) {
        const tiers: Array<'any' | 'T1' | 'T2' | 'T3' | 'T4'> = ['any', 'T1', 'T2', 'T3', 'T4'];
        const tIdx = tiers.indexOf(this.costTierFilter);
        this.costTierFilter = tiers[(tIdx + 1) % tiers.length] ?? 'any';
        this.selectedIndex = 0;
        return { type: 'none' };
      }
      if (key === '\r' || key === 'enter' || key === 'return' || key === 's' || key === 'S') {
        const scope = (key === 's' || key === 'S') ? 'session' : 'default';
        const item = filtered[this.selectedIndex];
        if (!item) return { type: 'none' };

        if (!item.available || item.eligible === false) {
          this.warningMessage = `Cannot select ${item.modelId}: ${item.ineligibleReason || 'model unavailable or ineligible'}`;
          return { type: 'rejected', modelId: item.modelId, reason: this.warningMessage };
        }

        this.currentMode = item.local ? 'local' : 'balanced';
        this.currentModelId = item.modelId;
        this.isOpen = false;
        return {
          type: 'select',
          scope,
          mode: this.currentMode,
          modelId: item.modelId,
          reasoningEffort: this.reasoningEffort,
          requiresLoad: item.local ? !item.loaded : undefined
        };
      }
      if (key === '\x1b' || key === 'escape') {
        if (this.isSearching) {
          this.isSearching = false;
          this.searchQuery = '';
          return { type: 'none' };
        }
        this.view = 'modes';
        this.selectedIndex = 5; // Custom
        this.searchQuery = '';
        this.warningMessage = undefined;
        return { type: 'navigate', view: 'modes' };
      }
    }

    return { type: 'none' };
  }
}
