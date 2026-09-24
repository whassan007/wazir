export type ToolPermission =
  | 'filesystem_read'
  | 'filesystem_write'
  | 'shell_execute'
  | 'git_execute'
  | 'test_run'
  | 'build_run'
  | 'network_access'
  | 'mcp'
  | 'subagent';

export type ToolRiskLevel = 'low' | 'medium' | 'high';
export type ToolEnvironment = 'local' | 'worker';
export type ToolSideEffectClass = 'READ_ONLY' | 'IDEMPOTENT_WRITE' | 'NON_IDEMPOTENT_WRITE';

export interface ToolDescriptor {
  sideEffectClass?: ToolSideEffectClass;
  timeoutMs?: number;
  /**
   * Contract: on an abort of ctx.signal, execute() settles only after every process it
   * started has exited. A timed-out call to such a tool has a determined outcome
   * (TOOL_TIMEOUT, with its observed file mutations) instead of TOOL_OUTCOME_UNKNOWN.
   */
  terminatesOnAbort?: boolean;
  concurrencySafety?: 'parallel' | 'exclusive';
  provenance?:
    | { source: 'mcp'; serverId: string; tool: string; trust: 'untrusted' }
    | { source: 'subagent'; [key: string]: unknown }
    | Record<string, unknown>;
  capabilities?: string[];
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  permissions: ToolPermission[];
  riskLevel: ToolRiskLevel;
  environment: ToolEnvironment;
}

export interface FileMutationResult {
  path: string;
  attempted: boolean;
  succeeded: boolean;
  existedBefore: boolean;
  existsAfter: boolean;
  beforeHash?: string;
  afterHash?: string;
  changed: boolean;
}

export interface ToolResult {
  failureClass?: import('@wazir/shared').FailureClass;
  /** The value checked against descriptor.outputSchema, when provided. */
  structuredOutput?: unknown;
  ok: boolean;
  output: string;
  error?: string;
  durationMs: number;
  metadata?: Record<string, unknown>;
  fileMutations?: FileMutationResult[];
}

export interface ToolExecutionContext {
  callId?: string;
  allowedTools?: readonly string[];
  /** Must resolve durably before executor dispatch. A rejection prevents execution. */
  checkpoint?: () => Promise<void>;
  /** Controller opts in to before/after physical workspace observation. */
  verifyWorkspace?: boolean;
  /**
   * The task explicitly authorizes changing verification assets (tests, fixtures,
   * golden outputs). Unset, a write/edit that weakens the oracle is refused before
   * dispatch — see `detectOracleWeakening`.
   */
  allowVerificationChanges?: boolean;
  signal?: AbortSignal;
  requester?: string;
  agentId?: string;
  projectRoot: string;
  executionId?: string;
  jobId?: string;
  agentCapabilities?: readonly string[];
  env?: Record<string, string>;
  /** Policy's network decision for this execution; the OS sandbox enforces it. */
  networkAllowed?: boolean;
  /** Context compaction service for autonomous compact_memory tool requests. */
  compactor?: import('./context.js').AgentContextCompressor;
}

export interface Tool {
  descriptor: ToolDescriptor;
  execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult>;
}
