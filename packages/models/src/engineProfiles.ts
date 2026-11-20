import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelCapability, ModelRecord } from '@wazir/core';
import { ModelRouter, type ModelRouteInput } from './index.js';

export type WazirOsEngineFamily = 'liquid' | 'gemma4' | 'qwen' | 'super-nemo' | 'custom';

export type WazirOsJobKind =
  | 'quick-chat'
  | 'spotlight-ai'
  | 'coding'
  | 'code-review'
  | 'reasoning'
  | 'vision'
  | 'autonomous-goal'
  | 'offline-edge';

export type LatencyTier = 'ultra-fast' | 'balanced' | 'deep';

export interface EngineProfile {
  id: string;
  family: WazirOsEngineFamily;
  displayName: string;
  description: string;
  /** Ordered substring/prefix patterns (case-insensitive) matched against ModelRecord.id */
  preferredModelPatterns: string[];
  supportedJobs: WazirOsJobKind[];
  capabilities: ModelCapability[];
  toolCalling: boolean;
  vision: boolean;
  reasoning: 'low' | 'medium' | 'high';
  localOnly: boolean;
  latencyTier: LatencyTier;
  /** Optional explicit modelId pinned by operator */
  pinnedModelId?: string;
}

export interface OsEngineConfig {
  /** 'auto' selects profile per job; any profile id replaces the main Wazir OS engine */
  activeEngineId: string;
  jobOverrides: Partial<Record<WazirOsJobKind, string>>;
  customProfiles: EngineProfile[];
}

export interface EngineResolutionInput {
  jobKind?: WazirOsJobKind;
  prompt?: string;
  explicitEngineId?: string;
  localOnly?: boolean;
  isSensitive?: boolean;
  vision?: boolean;
  minimumContext?: number;
  allowedProviders?: string[];
}

export interface EngineResolutionResult {
  jobKind: WazirOsJobKind;
  profile: EngineProfile;
  modelId: string | null;
  matchedBy: 'explicit' | 'job-override' | 'active-engine' | 'auto-job' | 'fallback';
  reasons: string[];
}

export const BUILTIN_ENGINE_PROFILES: readonly EngineProfile[] = [
  {
    id: 'liquid-light',
    family: 'liquid',
    displayName: 'Liquid AI (Light / Edge)',
    description: 'Ultra-fast, low-memory local/edge engine for instant Spotlight, shell hints, and offline tasks.',
    preferredModelPatterns: ['lfm2', 'lfm-', 'liquid', 'qwen3.5-4b', 'gemma4:e2b', 'nemotron-3.5-bolt'],
    supportedJobs: ['offline-edge', 'quick-chat', 'spotlight-ai'],
    capabilities: ['generalChat'],
    toolCalling: false,
    vision: false,
    reasoning: 'low',
    localOnly: true,
    latencyTier: 'ultra-fast',
  },
  {
    id: 'gemma4-generic',
    family: 'gemma4',
    displayName: 'Gemma 4 (Generic / Balanced)',
    description: 'General-purpose balanced engine for multimodal inspection, summarization, and everyday desktop AI.',
    preferredModelPatterns: ['gemma4:26b', 'gemma4', 'gemma-4', 'gemma'],
    supportedJobs: ['quick-chat', 'spotlight-ai', 'vision', 'code-review'],
    capabilities: ['generalChat'],
    toolCalling: true,
    vision: true,
    reasoning: 'medium',
    localOnly: false,
    latencyTier: 'balanced',
  },
  {
    id: 'qwen-coder',
    family: 'qwen',
    displayName: 'Qwen (Coding & Agentic)',
    description: 'Code-specialized engine for repository edits, tool calling, tests, and multi-file refactoring.',
    preferredModelPatterns: ['qwen3-coder:30b', 'qwen3.6', 'qwen3-30b', 'qwen2.5-coder', 'qwen3', 'qwen'],
    supportedJobs: ['coding', 'code-review', 'autonomous-goal'],
    capabilities: ['coding'],
    toolCalling: true,
    vision: false,
    reasoning: 'medium',
    localOnly: false,
    latencyTier: 'balanced',
  },
  {
    id: 'super-nemo',
    family: 'super-nemo',
    displayName: 'Super Nemo (Deep Reasoning)',
    description: 'High-capacity Nemotron Super engine for complex architecture, formal verification, and autonomous goals.',
    preferredModelPatterns: ['nemotron-3.5-super', 'super-nemo', 'nvidia/nemotron', 'nemotron'],
    supportedJobs: ['reasoning', 'autonomous-goal', 'code-review'],
    capabilities: ['coding'],
    toolCalling: true,
    vision: false,
    reasoning: 'high',
    localOnly: false,
    latencyTier: 'deep',
  },
];

const DEFAULT_JOB_TO_PROFILE: Record<WazirOsJobKind, string> = {
  'offline-edge': 'liquid-light',
  'quick-chat': 'liquid-light',
  'spotlight-ai': 'gemma4-generic',
  vision: 'gemma4-generic',
  coding: 'qwen-coder',
  'code-review': 'qwen-coder',
  reasoning: 'super-nemo',
  'autonomous-goal': 'super-nemo',
};

export function defaultOsEngineConfigPath(): string {
  const wazirHome = process.env.WAZIR_HOME?.trim() || path.join(os.homedir(), '.wazir');
  return path.join(wazirHome, 'os-engine.json');
}

export function createDefaultOsEngineConfig(): OsEngineConfig {
  return {
    activeEngineId: process.env.WAZIR_OS_ENGINE?.trim() || 'auto',
    jobOverrides: {},
    customProfiles: [],
  };
}

export function loadOsEngineConfig(configPath = defaultOsEngineConfigPath()): OsEngineConfig {
  const base = createDefaultOsEngineConfig();
  try {
    if (!fs.existsSync(configPath)) return base;
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<OsEngineConfig>;
    return {
      activeEngineId: process.env.WAZIR_OS_ENGINE?.trim() || raw.activeEngineId || 'auto',
      jobOverrides: raw.jobOverrides && typeof raw.jobOverrides === 'object' ? raw.jobOverrides : {},
      customProfiles: Array.isArray(raw.customProfiles) ? raw.customProfiles : [],
    };
  } catch {
    return base;
  }
}

export function saveOsEngineConfig(
  config: OsEngineConfig,
  configPath = defaultOsEngineConfigPath(),
): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/** Deterministic job classifier (no LLM required). */
export function inferJobKind(prompt = '', explicit?: WazirOsJobKind): WazirOsJobKind {
  if (explicit) return explicit;
  const p = prompt.toLowerCase();
  if (/\b(offline|edge|light|quick|fast|tldr|one-liner)\b/.test(p)) return 'offline-edge';
  if (/\b(screenshot|image|diagram|ui|visual|vision|ocr)\b/.test(p)) return 'vision';
  if (/\b(formal|prove|alloy|z3|dafny|architecture|deep|plan|autonomous|goal|orchestrate)\b/.test(p)) {
    return 'reasoning';
  }
  if (/\b(review|audit|diff|security|lint)\b/.test(p)) return 'code-review';
  if (/\b(code|implement|fix|refactor|test|build|bug|typescript|rust|python|function|patch)\b/.test(p)) {
    return 'coding';
  }
  if (p.length > 0 && p.length <= 60) return 'quick-chat';
  return 'spotlight-ai';
}

function matchModelToProfile(
  profile: EngineProfile,
  models: ModelRecord[],
  input: EngineResolutionInput,
): string | null {
  const effectiveLocalOnly = Boolean(input.localOnly || input.isSensitive || profile.localOnly);
  const router = new ModelRouter(models);

  const baseConstraints: ModelRouteInput = {
    localOnly: effectiveLocalOnly,
    isSensitive: input.isSensitive,
    vision: input.vision,
    minimumContext: input.minimumContext,
    allowedProviders: input.allowedProviders,
  };

  if (profile.pinnedModelId) {
    const pinned = router.route({ ...baseConstraints, allowedModels: [profile.pinnedModelId] });
    if (pinned) return pinned.modelId;
  }

  // Match preferred patterns in priority order
  for (const pattern of profile.preferredModelPatterns) {
    const pat = pattern.toLowerCase();
    const candidates = models
      .filter((m) => m.id.toLowerCase().includes(pat))
      .map((m) => m.id);
    if (candidates.length > 0) {
      const hit = router.route({ ...baseConstraints, allowedModels: candidates });
      if (hit) return hit.modelId;
    }
  }

  // Fallback to capability-compatible model via ModelRouter
  const fallback = router.route({
    ...baseConstraints,
    capabilities: profile.capabilities,
    toolCalling: profile.toolCalling || undefined,
    reasoning: profile.reasoning === 'high' ? 'high' : undefined,
  });
  return fallback?.modelId ?? null;
}

/**
 * Pluggable Wazir OS Engine Registry & Job-Based Resolver.
 * Allows replacing the main OS engine globally or per job across Liquid AI,
 * Gemma 4, Qwen, Super Nemo, and custom operator-defined profiles.
 */
export class WazirOsEngineRegistry {
  private config: OsEngineConfig;

  constructor(config?: OsEngineConfig) {
    this.config = config ?? createDefaultOsEngineConfig();
  }

  getConfig(): OsEngineConfig {
    return {
      activeEngineId: this.config.activeEngineId,
      jobOverrides: { ...this.config.jobOverrides },
      customProfiles: [...this.config.customProfiles],
    };
  }

  listProfiles(): EngineProfile[] {
    const map = new Map<string, EngineProfile>();
    for (const p of BUILTIN_ENGINE_PROFILES) map.set(p.id, p);
    for (const p of this.config.customProfiles) map.set(p.id, p);
    return Array.from(map.values());
  }

  getProfile(id: string): EngineProfile | undefined {
    return this.listProfiles().find((p) => p.id === id);
  }

  /** Replace the main Wazir OS engine globally ('auto' restores per-job selection). */
  setActiveEngine(engineId: string): void {
    if (engineId !== 'auto' && !this.getProfile(engineId)) {
      throw new Error(`Unknown Wazir OS engine profile: ${engineId}`);
    }
    this.config.activeEngineId = engineId;
  }

  /** Register or update a custom engine profile (e.g. a fine-tuned local model). */
  registerCustomProfile(profile: EngineProfile): void {
    const idx = this.config.customProfiles.findIndex((p) => p.id === profile.id);
    if (idx >= 0) {
      this.config.customProfiles[idx] = profile;
    } else {
      this.config.customProfiles.push(profile);
    }
  }

  /** Override the engine used for a specific job kind (pass null to clear). */
  setJobOverride(jobKind: WazirOsJobKind, engineId: string | null): void {
    if (engineId === null) {
      delete this.config.jobOverrides[jobKind];
      return;
    }
    if (!this.getProfile(engineId)) {
      throw new Error(`Unknown Wazir OS engine profile: ${engineId}`);
    }
    this.config.jobOverrides[jobKind] = engineId;
  }

  resolveForJob(
    input: EngineResolutionInput,
    availableModels: ModelRecord[],
  ): EngineResolutionResult {
    const jobKind = inferJobKind(input.prompt, input.jobKind);
    const reasons: string[] = [];

    let chosenProfile: EngineProfile | undefined;
    let matchedBy: EngineResolutionResult['matchedBy'] = 'auto-job';

    if (input.explicitEngineId) {
      chosenProfile = this.getProfile(input.explicitEngineId);
      if (chosenProfile) {
        matchedBy = 'explicit';
        reasons.push(`explicit engine '${chosenProfile.id}' requested`);
      }
    }

    if (!chosenProfile && this.config.jobOverrides[jobKind]) {
      chosenProfile = this.getProfile(this.config.jobOverrides[jobKind]!);
      if (chosenProfile) {
        matchedBy = 'job-override';
        reasons.push(`job override '${chosenProfile.id}' for '${jobKind}'`);
      }
    }

    if (!chosenProfile && this.config.activeEngineId !== 'auto') {
      chosenProfile = this.getProfile(this.config.activeEngineId);
      if (chosenProfile) {
        matchedBy = 'active-engine';
        reasons.push(`active OS engine '${chosenProfile.id}'`);
      }
    }

    if (!chosenProfile) {
      const autoId = DEFAULT_JOB_TO_PROFILE[jobKind] ?? 'gemma4-generic';
      chosenProfile = this.getProfile(autoId) ?? BUILTIN_ENGINE_PROFILES[1];
      matchedBy = 'auto-job';
      reasons.push(`auto-selected '${chosenProfile.id}' for job '${jobKind}'`);
    }

    let modelId = matchModelToProfile(chosenProfile, availableModels, input);

    // If preferred engine has no eligible live model, fall back across other profiles
    if (!modelId) {
      for (const candidate of this.listProfiles()) {
        if (candidate.id === chosenProfile.id) continue;
        const altModel = matchModelToProfile(candidate, availableModels, input);
        if (altModel) {
          reasons.push(`no model matched '${chosenProfile.id}'; fell back to '${candidate.id}'`);
          chosenProfile = candidate;
          modelId = altModel;
          matchedBy = 'fallback';
          break;
        }
      }
    } else {
      reasons.push(`matched model '${modelId}'`);
    }

    return {
      jobKind,
      profile: chosenProfile,
      modelId,
      matchedBy,
      reasons,
    };
  }
}
