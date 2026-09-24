export type PolicyEffect = 'allow' | 'ask' | 'deny';

export interface PolicyActionRequest {
  tool: string;
  input: Record<string, unknown>;
  executionId?: string;
  projectRoot?: string;
}

export interface PolicyDecision {
  decision: PolicyEffect;
  rule: string;
  tool?: string;
  command?: string;
  reasons: string[];
}

export interface PolicyRule {
  id: string;
  scope?: string;
  pattern?: string;
  description: string;
  effect: PolicyEffect;
}

export interface PolicyEngineOptions {
  web?: import('./web.js').WebPolicy;
  modelLifecycle?: {
    allowedRuntimes?: string[];
    prohibitedComputers?: string[];
    maximumMemoryBytes?: number;
    maximumContext?: number;
    autoLoad?: boolean;
    eviction?: boolean;
    protectedModels?: string[];
    allowUnknownEstimate?: boolean;
    unknownReservationBytes?: number;
  };
  projectRoot: string;
  networkAllowed?: boolean;
  /** Extra shell command prefixes that are always allowed. */
  allowCommands?: string[];
  /** Extra shell command prefixes that are always denied. */
  denyCommands?: string[];
  allowedMcpServers?: string[];
  /**
   * Whether executable artifacts inside the project root (e.g. ./main, ./build/app)
   * can be executed without requiring interactive approval. Defaults to true.
   */
  allowWorkspaceArtifactExecution?: boolean;
  /**
   * Approves 'ask' decisions interactively. When absent, 'ask' is
   * escalated to 'deny' — Wazir never silently allows.
   */
  /** Resolves true/false for a human's answer, or 'unavailable' when no human could be
   *  asked (non-interactive session) — recorded as such, never as a user denial. */
  approveCallback?: (request: PolicyActionRequest, decision: PolicyDecision) => Promise<boolean | 'unavailable'>;
  /** Non-blocking approval queue for multi-agent execution. */
  approvalQueue?: {
    enqueue: (request: PolicyActionRequest, decision: PolicyDecision) => Promise<boolean>;
    /** When false, 'ask' falls through to `approveCallback` (if any) instead of waiting on the queue. */
    hasSubscribers?: boolean;
  };
  /** Engine-wide default for `PolicyRequirements.allowHostedProviders` when a
   *  task omits it. Defaults to `false` — hosted routing is opt-in. */
  allowHostedProvidersDefault?: boolean;
}
