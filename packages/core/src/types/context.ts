export type ContextPartKind =
  | 'system'
  | 'task'
  | 'conversation'
  | 'repository'
  | 'retrieved'
  | 'tools'
  | 'mcp'
  | 'memory';

export type ContextPartPriority = 'critical' | 'important' | 'optional';

export interface ContextPart {
  kind: ContextPartKind;
  label: string;
  content: string;
  priority: ContextPartPriority;
  /** Pre-computed token count. Estimated with the deterministic estimator when absent. */
  tokens?: number;
}

export interface ContextBudget {
  parts: ContextPart[];
  inputTokens: number;
  outputReserveTokens: number;
  requiredTokens: number;
}

export interface ContextAvailability {
  tokens: number;
  source: 'configured' | 'discovered' | 'default';
}

export interface ContextCompaction {
  part: string;
  action: 'dropped' | 'trimmed';
  savedTokens: number;
  reason: string;
}

export interface ContextDecision {
  budget: ContextBudget;
  available: ContextAvailability;
  fits: boolean;
  /** Parts that must actually be sent, in order (after compaction). */
  finalParts: ContextPart[];
  finalInputTokens: number;
  finalRequiredTokens: number;
  compactions: ContextCompaction[];
  reasons: string[];
}

export class ContextBudgetError extends Error {
  readonly requiredTokens: number;
  readonly availableTokens: number;

  constructor(requiredTokens: number, availableTokens: number, details?: string[]) {
    super(
      `Context budget exceeded: required ${requiredTokens} tokens (incl. output reserve) but only ${availableTokens} are available. ` +
        (details && details.length > 0 ? `(${details.join('; ')})` : 'Refusing to silently truncate.'),
    );
    this.name = 'ContextBudgetError';
    this.requiredTokens = requiredTokens;
    this.availableTokens = availableTokens;
  }
}
