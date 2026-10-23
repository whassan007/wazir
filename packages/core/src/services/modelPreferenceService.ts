import * as fs from 'node:fs';
import * as path from 'node:path';

export type ModelSelectionMode = 'auto' | 'fast' | 'balanced' | 'powerful' | 'local' | 'custom';
export type ReasoningEffortLevel = 'low' | 'medium' | 'high';

export interface ModelPreferenceRecord {
  mode: ModelSelectionMode;
  modelId?: string;
  strict?: boolean;
  reasoningEffort: ReasoningEffortLevel;
  providerFilter?: string;
  costTierFilter?: 'T1' | 'T2' | 'T3' | 'T4' | 'any';
  updatedAt: string;
}

export interface EffectiveModelPreference {
  mode: ModelSelectionMode;
  modelId?: string;
  strict: boolean;
  reasoningEffort: ReasoningEffortLevel;
  source: 'cli-override' | 'session' | 'persistent' | 'default';
  displayLabel: string;
}

export interface KeyValueStore {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string): Promise<void> | void;
}

export class ModelPreferenceService {
  private persistentPreference: ModelPreferenceRecord;
  private sessionPreference?: ModelPreferenceRecord;
  private cliOverride?: ModelPreferenceRecord;
  private configFilePath?: string;
  private kvStore?: KeyValueStore;
  private kvKey: string;

  constructor(options?: {
    configFilePath?: string;
    kvStore?: KeyValueStore;
    kvKey?: string;
    initialPersistent?: Partial<ModelPreferenceRecord>;
  }) {
    this.configFilePath = options?.configFilePath;
    this.kvStore = options?.kvStore;
    this.kvKey = options?.kvKey ?? 'models/preferences';

    const defaultRecord: ModelPreferenceRecord = {
      mode: 'auto',
      reasoningEffort: 'medium',
      updatedAt: new Date().toISOString(),
      ...options?.initialPersistent,
    };

    this.persistentPreference = defaultRecord;
    this.loadFromStorage();
  }

  private loadFromStorage(): void {
    try {
      if (this.configFilePath && fs.existsSync(this.configFilePath)) {
        const raw = fs.readFileSync(this.configFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.persistentPreference = this.migrateLegacyConfig(parsed as Record<string, unknown>);
        }
      }
    } catch {
      // Ignore load errors, fallback to default
    }
  }

  private saveToStorage(): void {
    try {
      if (this.configFilePath) {
        const dir = path.dirname(this.configFilePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.configFilePath, JSON.stringify(this.persistentPreference, null, 2), 'utf8');
      }
      if (this.kvStore) {
        const val = JSON.stringify(this.persistentPreference);
        const res = this.kvStore.set(this.kvKey, val);
        if (res instanceof Promise) {
          res.catch(() => {});
        }
      }
    } catch {
      // Ignore save errors
    }
  }

  public migrateLegacyConfig(rawConfig: Record<string, unknown>): ModelPreferenceRecord {
    const routing = (rawConfig.routing as Record<string, unknown>) ?? {};
    const modeRaw = (rawConfig.mode ?? routing.mode ?? 'auto') as string;
    
    let mode: ModelSelectionMode = 'auto';
    if (['auto', 'fast', 'balanced', 'powerful', 'local', 'custom'].includes(modeRaw)) {
      mode = modeRaw as ModelSelectionMode;
    }

    const modelId = (rawConfig.modelId ?? rawConfig.selectedModelId ?? routing.defaultModel) as string | undefined;
    const strict = (rawConfig.strict ?? (modelId ? true : false)) as boolean;
    
    const effortRaw = (rawConfig.reasoningEffort ?? rawConfig.effort ?? 'medium') as string;
    const reasoningEffort: ReasoningEffortLevel = ['low', 'medium', 'high'].includes(effortRaw)
      ? (effortRaw as ReasoningEffortLevel)
      : 'medium';

    const providerFilter = (rawConfig.providerFilter ?? routing.provider) as string | undefined;
    const costTierFilter = (rawConfig.costTierFilter ?? routing.costTier) as 'T1' | 'T2' | 'T3' | 'T4' | 'any' | undefined;
    const updatedAt = (rawConfig.updatedAt ?? new Date().toISOString()) as string;

    return {
      mode,
      modelId,
      strict,
      reasoningEffort,
      providerFilter,
      costTierFilter,
      updatedAt,
    };
  }

  public setSessionPreference(pref: Partial<ModelPreferenceRecord>): void {
    const current = this.sessionPreference ?? { ...this.persistentPreference };
    this.sessionPreference = {
      ...current,
      ...pref,
      updatedAt: new Date().toISOString(),
    };
  }

  public setDefaultPreference(pref: Partial<ModelPreferenceRecord>): void {
    this.persistentPreference = {
      ...this.persistentPreference,
      ...pref,
      updatedAt: new Date().toISOString(),
    };
    this.saveToStorage();
  }

  public setCliOverride(pref: Partial<ModelPreferenceRecord>): void {
    const current = this.cliOverride ?? { ...this.persistentPreference };
    this.cliOverride = {
      ...current,
      ...pref,
      updatedAt: new Date().toISOString(),
    };
  }

  public clearCliOverride(): void {
    this.cliOverride = undefined;
  }

  public clearSessionPreference(): void {
    this.sessionPreference = undefined;
  }

  public setReasoningEffort(effort: ReasoningEffortLevel, scope: 'session' | 'default'): void {
    if (scope === 'session') {
      const current = this.sessionPreference ?? { ...this.persistentPreference };
      this.sessionPreference = {
        ...current,
        reasoningEffort: effort,
        updatedAt: new Date().toISOString(),
      };
    } else {
      this.persistentPreference = {
        ...this.persistentPreference,
        reasoningEffort: effort,
        updatedAt: new Date().toISOString(),
      };
      this.saveToStorage();
    }
  }

  public cycleReasoningEffort(direction: 'prev' | 'next', scope?: 'session' | 'default'): ReasoningEffortLevel {
    const targetScope = scope ?? (this.sessionPreference ? 'session' : 'default');
    const currentEffort = targetScope === 'session' && this.sessionPreference 
      ? this.sessionPreference.reasoningEffort 
      : this.persistentPreference.reasoningEffort;

    const sequence: ReasoningEffortLevel[] = ['low', 'medium', 'high'];
    const idx = sequence.indexOf(currentEffort);
    const nextIdx = direction === 'next'
      ? (idx + 1) % sequence.length
      : (idx - 1 + sequence.length) % sequence.length;
    
    const newEffort = sequence[nextIdx];
    this.setReasoningEffort(newEffort, targetScope);
    return newEffort;
  }

  public getEffectivePreference(): EffectiveModelPreference {
    if (this.cliOverride) {
      return this.toEffective(this.cliOverride, 'cli-override');
    }
    if (this.sessionPreference) {
      return this.toEffective(this.sessionPreference, 'session');
    }
    if (this.persistentPreference) {
      return this.toEffective(this.persistentPreference, 'persistent');
    }
    return {
      mode: 'auto',
      strict: false,
      reasoningEffort: 'medium',
      source: 'default',
      displayLabel: 'Auto',
    };
  }

  private toEffective(record: ModelPreferenceRecord, source: EffectiveModelPreference['source']): EffectiveModelPreference {
    let displayLabel = 'Auto';
    if (record.modelId) {
      if (record.mode === 'local') {
        displayLabel = `Local (${record.modelId})`;
      } else {
        displayLabel = record.modelId;
      }
    } else {
      switch (record.mode) {
        case 'fast': displayLabel = 'Fast'; break;
        case 'balanced': displayLabel = 'Balanced'; break;
        case 'powerful': displayLabel = 'Powerful'; break;
        case 'local': displayLabel = 'Local (Auto Local)'; break;
        case 'custom': displayLabel = record.modelId ?? 'Custom'; break;
        case 'auto': default: displayLabel = 'Auto'; break;
      }
    }

    const strict = record.strict ?? (record.modelId !== undefined || (record.mode === 'local' && record.modelId !== undefined));

    return {
      mode: record.mode,
      modelId: record.modelId,
      strict,
      reasoningEffort: record.reasoningEffort,
      source,
      displayLabel,
    };
  }
}
