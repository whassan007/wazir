import type { Computer } from '../types/computer.js';
import type { ModelRecord, ModelInstance } from '../types/model.js';
import { HardwareEligibilityService, type DeviceEligibilityResult } from './hardwareEligibilityService.js';
import { ContextMemoryEstimator, type ContextAllocationPlan } from './contextMemoryEstimator.js';

export type IntelligentRoutingMode =
  | 'AUTO'
  | 'FAST'
  | 'BALANCED'
  | 'POWERFUL'
  | 'LOCAL_FIRST'
  | 'LOADED_ONLY'
  | 'STRICT_MODEL';

export interface RankedModelCandidate {
  model: ModelRecord;
  instance?: ModelInstance;
  deviceEligibility: DeviceEligibilityResult;
  contextPlan: ContextAllocationPlan;
  eligible: boolean;
  score: number;
  costTier: 'T1' | 'T2' | 'T3' | 'T4';
  alreadyLoaded: boolean;
  selectionRationale: string;
  rejectionReasons: string[];
}

export interface ModelRankingOptions {
  mode: IntelligentRoutingMode;
  targetModelId?: string;
  allowHostedProviders?: boolean;
  allowedModels?: string[];
  localOnly?: boolean;
  estimatedInputTokens?: number;
  requiredMinimumContext?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  taskCapabilities?: string[];
  requiresToolCalling?: boolean;
  requiresVision?: boolean;
  requiresReasoning?: boolean;
  requiresCoding?: boolean;
}

export interface ModelSelectionResult {
  selected?: RankedModelCandidate;
  alternatives: RankedModelCandidate[];
  mode: IntelligentRoutingMode;
  success: boolean;
  reason: string;
}

export class IntelligentModelRanker {
  private hardwareService: HardwareEligibilityService;
  private contextEstimator: ContextMemoryEstimator;

  constructor(
    hardwareService?: HardwareEligibilityService,
    contextEstimator?: ContextMemoryEstimator,
  ) {
    this.hardwareService = hardwareService ?? new HardwareEligibilityService();
    this.contextEstimator = contextEstimator ?? new ContextMemoryEstimator();
  }

  /**
   * Determines the cost tier ('T1' to 'T4') for a model.
   */
  public determineCostTier(model: ModelRecord): 'T1' | 'T2' | 'T3' | 'T4' | 'any' {
    if (model.local) {
      return 'T1'; // Local execution is effectively free (T1)
    }
    const id = model.id.toLowerCase();
    const family = (model.family ?? '').toLowerCase();

    if (
      id.includes('flash-lite') ||
      id.includes('haiku') ||
      id.includes('gpt-4o-mini') ||
      id.includes('llama-3-8b') ||
      family.includes('flash') ||
      family.includes('haiku')
    ) {
      return 'T2';
    }
    if (
      id.includes('pro') ||
      id.includes('sonnet') ||
      id.includes('gpt-4o') ||
      id.includes('deepseek-chat')
    ) {
      return 'T3';
    }
    if (
      id.includes('ultra') ||
      id.includes('opus') ||
      id.includes('reasoner') ||
      id.includes('o1') ||
      id.includes('o3') ||
      id.includes('deepseek-reasoner')
    ) {
      return 'T4';
    }
    return 'T2';
  }

  /**
   * Ranks all candidate models for a given computer and task options.
   */
  public rankModels(
    models: ModelRecord[],
    computer?: Computer,
    instances?: ModelInstance[],
    options: ModelRankingOptions = { mode: 'AUTO' },
  ): RankedModelCandidate[] {
    const candidates: RankedModelCandidate[] = [];
    const mode = options.mode ?? 'AUTO';

    for (const model of models) {
      const rejectionReasons: string[] = [];

      // Check allowed models filter if specified
      if (options.allowedModels && options.allowedModels.length > 0) {
        if (!options.allowedModels.includes(model.id) && !options.allowedModels.includes(model.name ?? '')) {
          rejectionReasons.push(`Model ${model.id} is not in the allowed models list`);
        }
      }

      // Check localOnly policy
      if (options.localOnly && model.local === false) {
        rejectionReasons.push(`Model ${model.id} is hosted/cloud, but localOnly mode is enforced`);
      }

      // Check hosted providers allowance
      if (model.local === false && options.allowHostedProviders === false) {
        rejectionReasons.push(`Model ${model.id} is hosted, but allowHostedProviders is false`);
      }

      // Task capability matching
      if (options.requiresToolCalling && !model.toolCalling) {
        rejectionReasons.push(`Model ${model.id} does not support required tool calling`);
      }
      if (options.requiresVision && !model.vision) {
        rejectionReasons.push(`Model ${model.id} does not support required vision capabilities`);
      }
      if (options.requiresReasoning && !model.reasoning && !model.id.includes('reasoner') && !model.id.includes('o1') && !model.id.includes('o3')) {
        rejectionReasons.push(`Model ${model.id} does not support required advanced reasoning`);
      }

      // Find matching instance if any
      const matchingInstance = instances?.find(
        (inst) => inst.modelId === model.id || inst.id === model.id,
      );

      // Assess hardware eligibility via HardwareEligibilityService
      const deviceEligibility = this.hardwareService.assessDeviceForModel({
        model,
        computer,
        instance: matchingInstance,
      });

      if (!deviceEligibility.eligible) {
        rejectionReasons.push(...deviceEligibility.rejectionReasons);
      }

      // Assess context allocation via ContextMemoryEstimator
      const contextPlan = this.contextEstimator.planContextAllocation({
        model,
        estimatedInputTokens: options.estimatedInputTokens ?? 4096,
        requiredMinimumContext: options.requiredMinimumContext ?? 2048,
        reasoningEffort: options.reasoningEffort ?? 'medium',
        alreadyLoaded: deviceEligibility.alreadyLoaded,
      });

      if (!contextPlan.eligible) {
        rejectionReasons.push(contextPlan.reason);
      }

      const alreadyLoaded = deviceEligibility.alreadyLoaded;

      // LOADED_ONLY mode constraint
      if (mode === 'LOADED_ONLY' && !alreadyLoaded) {
        rejectionReasons.push(`Model ${model.id} is not currently loaded in runtime memory (LOADED_ONLY mode)`);
      }

      const eligible = rejectionReasons.length === 0;
      const costTier = this.determineCostTier(model) as 'T1' | 'T2' | 'T3' | 'T4';

      // Compute scoring
      let score = 50;

      if (eligible) {
        // Loaded bonus (strong preference for already loaded models)
        if (alreadyLoaded) {
          score += 40;
        }

        // Mode-specific scoring adjustments
        if (mode === 'FAST') {
          if (costTier === 'T1' || costTier === 'T2') {
            score += 25;
          }
          if (alreadyLoaded) {
            score += 20;
          }
        } else if (mode === 'POWERFUL') {
          if (costTier === 'T3' || costTier === 'T4' || model.reasoning) {
            score += 30;
          }
        } else if (mode === 'LOCAL_FIRST') {
          if (model.local) {
            score += 35;
          }
        } else if (mode === 'BALANCED') {
          if (costTier === 'T1' || costTier === 'T2') {
            score += 15;
          }
          if (alreadyLoaded) {
            score += 15;
          }
        } else if (mode === 'AUTO') {
          if (alreadyLoaded) {
            score += 25;
          }
          if (model.local) {
            score += 15;
          }
        }

        // Performance history bonus if available
        const perf = model.performance;
        if (perf) {
          const profiles = Object.values(perf);
          for (const p of profiles) {
            if (p && typeof p.verifiedSuccessRate === 'number') {
              score += p.verifiedSuccessRate * 10;
            }
          }
        }
      } else {
        score = -1000;
      }

      const selectionRationale = eligible
        ? `Eligible candidate (score: ${score.toFixed(1)}, loaded: ${alreadyLoaded}, costTier: ${costTier})`
        : `Ineligible: ${rejectionReasons.join('; ')}`;

      candidates.push({
        model,
        instance: matchingInstance,
        deviceEligibility,
        contextPlan,
        eligible,
        score,
        costTier,
        alreadyLoaded,
        selectionRationale,
        rejectionReasons,
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }

  /**
   * Selects the best model according to the routing mode and options.
   */
  public selectModel(
    models: ModelRecord[],
    computer?: Computer,
    instances?: ModelInstance[],
    options: ModelRankingOptions = { mode: 'AUTO' },
  ): ModelSelectionResult {
    const mode = options.mode ?? 'AUTO';
    const ranked = this.rankModels(models, computer, instances, options);

    if (mode === 'STRICT_MODEL') {
      const targetId = options.targetModelId;
      if (!targetId) {
        return {
          selected: undefined,
          alternatives: ranked.filter((c) => c.eligible),
          mode,
          success: false,
          reason: `STRICT_MODEL mode specified but no targetModelId provided.`,
        };
      }

      const targetCandidate = ranked.find(
        (c) => c.model.id === targetId || c.model.name === targetId,
      );

      if (!targetCandidate) {
        return {
          selected: undefined,
          alternatives: ranked.filter((c) => c.eligible),
          mode,
          success: false,
          reason: `Strict target model '${targetId}' was not found in model registry.`,
        };
      }

      if (!targetCandidate.eligible) {
        return {
          selected: undefined,
          alternatives: ranked.filter((c) => c.eligible),
          mode,
          success: false,
          reason: `Strict target model '${targetId}' is ineligible: ${targetCandidate.rejectionReasons.join('; ')}. STRICT_MODEL never silently overrides.`,
        };
      }

      return {
        selected: targetCandidate,
        alternatives: ranked.filter((c) => c.eligible && c.model.id !== targetCandidate.model.id),
        mode,
        success: true,
        reason: `Successfully selected pinned strict model '${targetId}'.`,
      };
    }

    const bestEligible = ranked.find((c) => c.eligible);

    if (!bestEligible) {
      return {
        selected: undefined,
        alternatives: [],
        mode,
        success: false,
        reason: `No eligible models found for mode '${mode}'. All candidates failed eligibility or policy checks.`,
      };
    }

    return {
      selected: bestEligible,
      alternatives: ranked.filter((c) => c.eligible && c.model.id !== bestEligible.model.id),
      mode,
      success: true,
      reason: `Successfully selected best model '${bestEligible.model.id}' under mode '${mode}'.`,
    };
  }

  /**
   * Formats a selection banner for CLI or logs.
   */
  public formatSelectionBanner(candidate: RankedModelCandidate): string {
    return [
      `Selected: ${candidate.model.id}`,
      `Device: ${candidate.deviceEligibility.deviceId} (${candidate.deviceEligibility.deviceKind})`,
      `Context: ${candidate.contextPlan.allocatedContextTokens} tokens`,
      `Reason: ${candidate.selectionRationale}`,
    ].join('\n');
  }
}
