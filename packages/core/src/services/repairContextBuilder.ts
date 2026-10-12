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

    return {
      currentFailure: this.simplify(current),
      previousFailure: intelligence.history.length > 0 ? this.simplify(intelligence.history[intelligence.history.length - 1]) : undefined,
      progressStatus: intelligence.progressStatus,
      workspaceRevision: current.workspaceRevision ?? 0,
      lastPhysicalMutation: lastMutationPath,
      relevantToolEvidence: evidenceSummaries,
    };
  }

  private static simplify(obs: FailureObservation): SimplifiedFailure {
    return {
      category: obs.category,
      signature: obs.repeatedSignature,
      messageSummary: `Observed ${obs.category} at revision ${obs.workspaceRevision ?? 'unknown'}`
    };
  }
}
