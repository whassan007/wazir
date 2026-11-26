import {
  effectiveContextTokens,
  type ModelCapability,
  type ModelRecord,
} from '@wazir/core';

export interface ModelRouteInput {
  capabilities?: ModelCapability[];
  toolCalling?: boolean;
  reasoning?: 'low' | 'medium' | 'high';
  vision?: boolean;
  minimumContext?: number;
  localOnly?: boolean;
  isSensitive?: boolean;
  allowedModels?: string[];
  allowedProviders?: string[];
  provider?: string;
  excludeModelIds?: string[];
}

export interface ModelRouteDecision {
  modelId: string;
  score: number;
  reasons: string[];
}

/**
 * @wazir/models — model routing facade over the core model registry.
 * Deterministic: highest capability/context score wins, ties break by id.
 * Strictly enforces privacy (localOnly/isSensitive), authorization (allowedModels),
 * approved providers (provider/allowedProviders), context, and capability constraints
 * during primary route selection and failure-driven fallback.
 */
export class ModelRouter {
  constructor(private readonly models: ModelRecord[]) {}

  route(input: ModelRouteInput): ModelRouteDecision | null {
    const eligible: Array<ModelRecord & { score: number; reasons: string[] }> = [];

    for (const model of this.models) {
      const reasons: string[] = [];
      let ok = true;

      // Exclude models already tried by prior attempts in failure escalation
      if (input.excludeModelIds && input.excludeModelIds.includes(model.id)) {
        continue;
      }

      // Privacy / Locality Constraint: localOnly or sensitive tasks MUST NOT route to remote/hosted models
      if ((input.localOnly || input.isSensitive) && model.local === false) {
        continue;
      }

      // Authorization Constraint: task allowedModels allowlist
      if (input.allowedModels && !input.allowedModels.includes(model.id)) {
        continue;
      }

      // Provider Constraints: approved provider or explicit provider lock
      if (input.provider && model.provider !== input.provider) {
        continue;
      }
      if (input.allowedProviders && !input.allowedProviders.includes(model.provider)) {
        continue;
      }

      for (const capability of input.capabilities ?? []) {
        if (model.capabilities.includes(capability)) {
          reasons.push(`${capability}: present`);
        } else {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      if (input.toolCalling && !model.toolCalling) continue;
      if (input.vision && !model.vision) continue;
      if (input.reasoning === 'high' && !model.reasoning) continue;

      const context = effectiveContextTokens(model);
      if (input.minimumContext && context < input.minimumContext) continue;
      if (input.minimumContext) {
        reasons.push(`context ${context} >= required ${input.minimumContext}`);
      }

      let score = 0;
      score += (input.capabilities?.length ?? 0) * 2;
      if (model.toolCalling) score += 1;
      if (input.minimumContext && context >= input.minimumContext * 2) score += 1;

      eligible.push({ ...model, score, reasons });
    }

    if (eligible.length === 0) {
      return null;
    }

    eligible.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const best = eligible[0];
    return { modelId: best.id, score: best.score, reasons: best.reasons };
  }

  /**
   * Selects a fallback model after one or more models experienced provider failure,
   * strictly preserving all original task constraints (privacy, authorization,
   * capabilities, context, and provider bounds).
   */
  routeFallback(input: ModelRouteInput, failedModelIds: string | string[]): ModelRouteDecision | null {
    const failedList = Array.isArray(failedModelIds) ? failedModelIds : [failedModelIds];
    const excluded = Array.from(new Set([...(input.excludeModelIds ?? []), ...failedList]));
    return this.route({ ...input, excludeModelIds: excluded });
  }

  list(): ModelRecord[] {
    return [...this.models].sort((a, b) => a.id.localeCompare(b.id));
  }
}

export function createModelRouter(models: ModelRecord[]): ModelRouter {
  return new ModelRouter(models);
}

export * from './engineProfiles.js';
