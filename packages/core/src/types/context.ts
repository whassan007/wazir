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

/**
 * Compaction category for a context part.
 * PINNED   — system instructions, task requirements, policy, acceptance criteria. Never compacted.
 * ACTIVE   — current error, current diff, current verification state.
 * COMPRESSIBLE — old reasoning, old tool interactions, resolved errors, historical decisions.
 * OFFLOADABLE  — huge raw shell output, huge test output, large file reads, generated logs.
 */
export type ContextCategory = 'PINNED' | 'ACTIVE' | 'COMPRESSIBLE' | 'OFFLOADABLE';

/** Whether a token count is exact (from the model's tokenizer) or estimated (chars/4). */
export type TokenCountKind = 'EXACT' | 'ESTIMATED';

export interface TokenCount {
  value: number;
  kind: TokenCountKind;
}

/** An item in the model-visible context (alias for ContextPart). */
export type ContextItem = ContextPart;

export interface ContextPart {
  citationIds?: string[];
  evidenceHash?: string;
  /** Citation envelope preserved verbatim when the excerpt is compacted. */
  evidenceHeader?: string;
  kind: ContextPartKind;
  label: string;
  content: string;
  priority: ContextPartPriority;
  /** Pre-computed token count. Estimated with the deterministic estimator when absent. */
  tokens?: number;
  /** Compaction category. Used by ContextCompactionService to decide what is safe to compress. */
  category?: ContextCategory;
}

export interface PromptBreakdown {
  system: number;
  tools: number;
  task: number;
  plan: number;
  history: number;
  repository: number;
  [key: string]: number;
}

/**
 * Reserves to subtract from effective context before computing usable input budget.
 * Prevents the compaction system from blindly consuming the full context window.
 */
export interface ContextReserve {
  /** Tokens reserved for model output (completion). */
  outputTokens: number;
  /** Tokens reserved for tool schema definitions injected into every request. */
  toolSchemaTokens: number;
  /** Safety buffer against estimation error. */
  safetyTokens: number;
}

export interface ContextBudget {
  parts: ContextPart[];
  inputTokens: number;
  outputReserveTokens: number;
  requiredTokens: number;
  breakdown?: PromptBreakdown;
  /** Explicit reserves breakdown (output + toolSchema + safety). */
  reserve?: ContextReserve;
  /** Context utilization as fraction [0..1] of the usable input budget. */
  utilization?: number;
}

export interface ContextAvailability {
  tokens: number;
  source: 'configured' | 'discovered' | 'default';
  /**
   * The actual tokens the model was loaded with (runtimeLoaded <= tokens).
   * Important for Ollama/LM Studio where the runtime may report a loaded
   * context smaller than the model's theoretical maximum. Compaction threshold
   * decisions should use runtimeLoaded when available, not model maximum.
   */
  runtimeLoaded?: number;
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
  breakdown?: PromptBreakdown;
}

// ============================================================
// OFFLOAD ARTIFACT — metadata for a tool result moved to disk
// ============================================================

/**
 * Metadata for a tool result that was too large to fit in model context
 * and was offloaded to disk. The full content remains available for retrieval.
 * The model sees a compact replacement with this metadata embedded.
 */
export interface OffloadedArtifact {
  artifactId: string;
  executionId: string;
  toolCallId: string;
  toolName: string;
  /** SHA-256 hex digest of the original content. */
  sha256: string;
  /** Original token count (estimated). */
  originalTokens: number;
  /** Original byte size. */
  originalBytes: number;
  /** Relative path within the workspace (e.g. `.wazir/offload/<execId>/tool_result_xxx.txt`). */
  offloadPath: string;
  createdAt: Date;
  contentType: 'tool_result';
}

// ============================================================
// CONTEXT SNAPSHOT — immutable compiled context at a point in time
// ============================================================

/**
 * An immutable snapshot of the model-visible context at a given generation.
 * Compaction creates a new snapshot; the previous snapshot is preserved.
 * In-flight model requests are bound to the snapshot generation they started with.
 */
export interface ContextSnapshot {
  id: string;
  executionId: string;
  /** Monotonically increasing generation counter. */
  generation: number;
  modelId: string;
  /** The actual context window the model is serving with (runtimeLoaded, not theoretical max). */
  effectiveContextWindow: number;
  /** Estimated total input tokens for this snapshot. */
  estimatedTokens: number;
  createdAt: Date;

  /** System, task, policy — never compacted. */
  pinned: ContextPart[];
  /** Current error, diff, verification state. */
  active: ContextPart[];
  /** Old reasoning, old tool interactions, historical decisions (compressible). */
  compressible: ContextPart[];
  /** Compressed summary parts, if compaction has run. */
  compressed?: ContextPart[];
  /** Recent N turns (always preserved verbatim). */
  tail: ContextPart[];

  /** Event index range from ExecutionEngine this snapshot was compiled from. */
  sourceEventRange?: { from: number; to: number };
  /** Artifacts offloaded from model context during this snapshot's compilation. */
  artifactReferences: OffloadedArtifact[];
  /** Metrics from the compaction that produced this snapshot (absent for the initial snapshot). */
  compactionMetrics?: CompactionMetrics;
}

// ============================================================
// COMPACTION METRICS AND REQUEST/RESULT
// ============================================================

export interface CompactionMetrics {
  trigger: 'AUTO' | 'USER' | 'AGENT' | 'CONTROLLER';
  reason?: string;
  beforeTokens: number;
  afterTokens: number;
  tokensSaved: number;
  messagesBefore: number;
  messagesAfter: number;
  offloadedArtifacts: number;
  offloadedBytes: number;
  compressionDurationMs: number;
  compressionModel?: string;
  deduplicatedCount: number;
}

export interface CompactionRequest {
  executionId: string;
  trigger: CompactionMetrics['trigger'];
  reason?: string;
  /** Force compaction even if below the auto threshold. */
  force?: boolean;
}

export type CompactionErrorCode =
  | 'CONTEXT_COMPACTION_FAILED'
  | 'CONTEXT_SUMMARY_INVALID'
  | 'CONTEXT_OFFLOAD_FAILED'
  | 'CONTEXT_GENERATION_CONFLICT'
  | 'CONTEXT_BUDGET_EXCEEDED';

export interface CompactionResult {
  status: 'compacted' | 'skipped' | 'failed';
  snapshotId?: string;
  metrics?: CompactionMetrics;
  error?: string;
  errorCode?: CompactionErrorCode;
}

/**
 * Structured summary produced by AgentContextCompressor for historical context.
 * Adheres to a strict JSON Schema validated at runtime.
 */
export interface StructuredCompactionSummary {
  objective: string;
  requirements: string[];
  decisions: string[];
  files: {
    read: string[];
    modified: string[];
    created: string[];
  };
  currentState: string;
  workspaceRevision: number;
  verification: {
    build: string;
    tests: string;
    revision: number;
  };
  errors: Array<{
    fingerprint: string;
    status: 'resolved' | 'active';
    summary: string;
  }>;
  importantSymbols: string[];
  toolArtifacts: string[];
  remainingWork: string[];
  constraints: string[];
  provenance: {
    compactedRange: string;
    createdAt: string;
  };
}

/**
 * Interface for tool-aware result pruning and summarization.
 */
export interface ToolResultCompactor {
  compact(toolName: string, content: string, budgetChars: number): string;
}

/**
 * Interface for semantic compression of historical context.
 */
export interface AgentContextCompressor {
  compact(request: CompactionRequest): Promise<CompactionResult>;
}

// ============================================================
// CONTEXT CONFIGURATION (mirrors WazirConfig shape)
// ============================================================

export interface ContextCompactionConfig {
  /** Enable automatic threshold-based compaction. Default: true. */
  enabled?: boolean;
  /** Utilization fraction [0..1] at which automatic compaction triggers. Default: 0.75. */
  autoThreshold?: number;
  /** Target utilization after compaction. Default: 0.45. */
  targetUtilization?: number;
  /** Fraction of conversation turns to preserve as the tail. Default: 0.50. */
  preserveRecentTailRatio?: number;
  /** Minimum tokens that must be reclaimed for compaction to be worthwhile. Default: 4000. */
  minimumTokensToReclaim?: number;
}

export interface ContextOffloadConfig {
  /** Enable offloading oversized tool results to disk. Default: true. */
  enabled?: boolean;
  /** Directory for offloaded artifacts (relative to workspace). Default: '.wazir/offload'. */
  directory?: string;
  /** Retention scope. Default: 'execution'. */
  retention?: 'execution' | 'session' | 'permanent';
}

export interface ContextConfig {
  /** Maximum tokens to include for any single tool result in model context. Default: 2000. */
  toolResultMaxTokens?: number;
  /** Maximum tokens for the compact preview when a tool result is offloaded. Default: 500. */
  toolResultPreviewTokens?: number;
  compaction?: ContextCompactionConfig;
  reserve?: Partial<ContextReserve>;
  offload?: ContextOffloadConfig;
}

// ============================================================
// BACKWARD-COMPATIBLE EXPORT
// ============================================================

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
