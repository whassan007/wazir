import type {
  ContextAvailability,
  ContextBudget,
  ContextCompaction,
  ContextDecision,
  ContextPart,
  PromptBreakdown,
} from '../types/context.js';

/**
 * Deterministic token estimator: 1 token per 4 characters.
 * Conservative enough to keep Wazir within llama.cpp `n_ctx` limits;
 * never silently truncates — it only feeds the budget calculation.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function tokensForPart(part: ContextPart): number {
  return part.tokens ?? estimateTokens(part.content);
}

/**
 * Computes prompt token breakdown across categories (System, Tools, Task, Plan, History, Repository)
 * to diagnose prompt growth and context usage.
 */
export function computePromptBreakdown(parts: ContextPart[]): PromptBreakdown {
  const breakdown: PromptBreakdown = {
    system: 0,
    tools: 0,
    task: 0,
    plan: 0,
    history: 0,
    repository: 0,
  };
  for (const part of parts) {
    const tokens = tokensForPart(part);
    if (part.kind === 'system') {
      breakdown.system += tokens;
    } else if (part.kind === 'tools') {
      breakdown.tools += tokens;
    } else if (part.kind === 'task') {
      breakdown.task += tokens;
    } else if (part.kind === 'conversation') {
      breakdown.history += tokens;
    } else if (part.kind === 'repository') {
      breakdown.repository += tokens;
    } else if (part.label?.toLowerCase().includes('plan')) {
      breakdown.plan += tokens;
    } else {
      breakdown[part.kind] = (breakdown[part.kind] ?? 0) + tokens;
    }
  }
  return breakdown;
}

const COMPACT_PRIORITY: Array<ContextPart['kind']> = [
  'retrieved',
  'mcp',
  'memory',
  'conversation',
  'repository',
];

export interface ContextCompilerOptions {
  /** Fraction of an important part to keep when trimming (default 0.5). */
  trimFraction?: number;
}

export class ContextCompiler {
  private readonly trimFraction: number;

  constructor(options: ContextCompilerOptions = {}) {
    this.trimFraction = options.trimFraction ?? 0.5;
  }

  budget(parts: ContextPart[], outputReserveTokens: number): ContextBudget {
    const inputTokens = parts.reduce((sum, part) => sum + tokensForPart(part), 0);
    return {
      parts,
      inputTokens,
      outputReserveTokens,
      requiredTokens: inputTokens + outputReserveTokens,
      breakdown: computePromptBreakdown(parts),
    };
  }

  /**
   * Compare the requirement against the model's available context.
   * If it does not fit, compacts deterministically:
   *   1. drop optional parts (retrieved, mcp, memory)
   *   2. trim optional/important parts down to trimFraction
   *   3. still failing → fits=false (caller must pick a larger model or error)
   * Critical parts (system, task) are NEVER compacted.
   */
  compile(
    parts: ContextPart[],
    availability: ContextAvailability,
    outputReserveTokens: number,
  ): ContextDecision {
    const reasons: string[] = [];
    const compactions: ContextCompaction[] = [];

    let active = parts.map((p) => ({ ...p }));
    let inputTokens = active.reduce((sum, part) => sum + tokensForPart(part), 0);
    let required = inputTokens + outputReserveTokens;

    reasons.push(
      `required ${required} tokens = ${inputTokens} input + ${outputReserveTokens} output reserve`,
    );
    reasons.push(`available ${availability.tokens} tokens (source: ${availability.source})`);

    if (required <= availability.tokens) {
      const breakdown = computePromptBreakdown(parts);
      return {
        budget: { parts, inputTokens, outputReserveTokens, requiredTokens: required, breakdown },
        available: availability,
        fits: true,
        finalParts: parts,
        finalInputTokens: inputTokens,
        finalRequiredTokens: required,
        compactions: [],
        reasons,
        breakdown,
      };
    }

    for (const kind of COMPACT_PRIORITY) {
      if (required <= availability.tokens) break;
      const idx = active.findIndex((p) => p.kind === kind && p.priority !== 'critical');
      if (idx === -1) continue;
      const part = active[idx];
      const saved = tokensForPart(part);
      active.splice(idx, 1);
      inputTokens -= saved;
      required = inputTokens + outputReserveTokens;
      compactions.push({
        part: part.label,
        action: 'dropped',
        savedTokens: saved,
        reason: `dropped '${part.kind}' part to fit context budget`,
      });
      reasons.push(`compaction: dropped '${part.label}' (${saved} tokens)`);
    }

    if (required > availability.tokens) {
      for (let i = active.length - 1; i >= 0; i--) {
        if (required <= availability.tokens) break;
        const part = active[i];
        if (part.priority === 'critical') continue;
        const current = tokensForPart(part);
        const target = Math.floor(current * this.trimFraction);
        if (target >= current) continue;
        const saved = current - target;
        active[i] = {
          ...part,
          content: part.content.slice(0, Math.floor(part.content.length * this.trimFraction)),
          tokens: target,
        };
        inputTokens -= saved;
        required = inputTokens + outputReserveTokens;
        compactions.push({
          part: part.label,
          action: 'trimmed',
          savedTokens: saved,
          reason: `trimmed to ${Math.round(this.trimFraction * 100)}% to fit context budget`,
        });
        reasons.push(`compaction: trimmed '${part.label}' by ${saved} tokens`);
      }
    }

    const fits = required <= availability.tokens;
    if (!fits) {
      reasons.push(
        `still over budget after compaction: required ${required} > available ${availability.tokens}; ` +
          'select a model with a larger context window',
      );
    }

    const breakdown = computePromptBreakdown(active);
    return {
      budget: { parts, inputTokens, outputReserveTokens, requiredTokens: required, breakdown },
      available: availability,
      fits,
      finalParts: active,
      finalInputTokens: inputTokens,
      finalRequiredTokens: required,
      compactions,
      reasons,
      breakdown,
    };
  }
}
