import { FailureObservation, FailureIntelligence } from '../types/failureIntelligence.js';

export interface CompactRepairContext {
  currentFailure: SimplifiedFailure;
  previousFailure?: SimplifiedFailure;
  progressStatus: string;
  workspaceRevision: number;
  lastPhysicalMutation?: string; // Path of the last changed file
  relevantToolEvidence?: string[]; // IDs or summaries of relevant tool outputs
}

export interface SimplifiedFailure {
  category: string;
  signature?: string;
  messageSummary: string;
}

/** Bounds that keep the repair context token-efficient regardless of history size. */
export const REPAIR_CONTEXT_LIMITS = { maxEvidenceItems: 8, maxEvidenceChars: 400 } as const;

export class RepairContextBuilder {
  /**
   * Constructs a compact, token-efficient context for the CodingAgent's repair turns.
   * Avoids sending full execution history to minimize input tokens.
   */
  static build(
    intelligence: FailureIntelligence,
    lastMutationPath?: string,
    evidenceSummaries?: string[]
  ): CompactRepairContext {
    const current = intelligence.current;
    const evidence = evidenceSummaries
      ?.filter((item) => typeof item === 'string' && item.length > 0)
      .slice(0, REPAIR_CONTEXT_LIMITS.maxEvidenceItems)
      .map((item) => item.length > REPAIR_CONTEXT_LIMITS.maxEvidenceChars ? `${item.slice(0, REPAIR_CONTEXT_LIMITS.maxEvidenceChars)}…` : item);

    return {
      currentFailure: this.simplify(current),
      previousFailure: intelligence.history.length > 0 ? this.simplify(intelligence.history[intelligence.history.length - 1]) : undefined,
      progressStatus: intelligence.progressStatus,
      workspaceRevision: current.workspaceRevision ?? 0,
      lastPhysicalMutation: lastMutationPath,
      relevantToolEvidence: evidence,
    };
  }

  private static simplify(obs: FailureObservation): SimplifiedFailure {
    const where = obs.tool ? ` in tool ${obs.tool}` : '';
    return {
      category: obs.category,
      signature: obs.repeatedSignature,
      messageSummary: `Observed ${obs.category} during ${obs.phase}${where} at revision ${obs.workspaceRevision ?? 'unknown'}`,
    };
  }
}
