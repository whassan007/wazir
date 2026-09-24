/**
 * Canonical Action Envelope and Model-to-Control-Plane Action Architecture.
 *
 * All provider/runtime responses (native OpenAI tool_calls, Anthropic tool_use,
 * structured JSON output, or legacy text-parsed actions) are normalized into
 * this common canonical representation before validation, policy evaluation,
 * and tool dispatch.
 *
 * INVARIANTS:
 * 1. CodingAgent never interacts with provider-specific wire schemas.
 * 2. Native tool calls and legacy parsed actions converge into ActionEnvelope before ToolRegistry execution.
 * 3. PolicyEngine and ExecutionEngine receive identically structured invocations regardless of source.
 */

export type ActionSource =
  | 'native_tool_call'
  | 'structured_output'
  | 'legacy_text';

export interface ActionEnvelope {
  /** Unique ID for this action instance (preserves tool_call_id if provided by runtime). */
  id: string;

  /** Tool name or meta-action name (e.g. 'shell', 'write', 'plan', 'done'). */
  name: string;

  /** Normalized arguments passed to the tool or action. */
  arguments: Record<string, unknown>;

  /** Which protocol/mechanism generated this action. */
  source: ActionSource;

  /** Runtime that served the model request (e.g. 'lmstudio', 'ollama', 'openai'). */
  runtimeId: string;

  /** Model identifier that produced the action. */
  modelId: string;

  /** Raw textual or JSON payload reference before parsing/normalization. */
  rawReference?: string;

  /** Timestamp when action was received and envelope was created. */
  timestamp?: Date;

  /** Optional phase during which this action was produced (e.g. 'plan', 'implement', 'verify'). */
  phase?: string;

  /** Metadata for tracing, observability, and provenance. */
  metadata?: Record<string, unknown>;
}

export type ActionValidationErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'SEMANTIC_VALIDATION_FAILED'
  | 'PHASE_POLICY_VIOLATION'
  | 'MALFORMED_ARGUMENTS';

export interface ActionValidationError {
  code: ActionValidationErrorCode;
  message: string;
  actionName: string;
  details?: unknown;
}

export interface ActionValidationResult {
  valid: boolean;
  envelope?: ActionEnvelope;
  error?: ActionValidationError;
}
