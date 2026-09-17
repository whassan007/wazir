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
}

export interface ModelRouteDecision {
  modelId: string;
  score: number;
  reasons: string[];
}

/**
 * @wazir/models — model routing facade over the core model registry.
 * Deterministic: highest capability/context score wins, ties break by id.
 */
export class ModelRouter {
  constructor(private readonly models: ModelRecord[]) {}

  route(input: ModelRouteInput): ModelRouteDecision | null {
    const eligible: Array<ModelRecord & { score: number; reasons: string[] }> = [];

    for (const model of this.models) {
      const reasons: string[] = [];
      let ok = true;

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

  list(): ModelRecord[] {
    return [...this.models].sort((a, b) => a.id.localeCompare(b.id));
  }
}

export function createModelRouter(models: ModelRecord[]): ModelRouter {
  return new ModelRouter(models);
}
