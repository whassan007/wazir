/**
 * Editor / Agent Protocol & MCP Integration Types
 *
 * Supports the Agent Protocol (ACP) standard (https://agentprotocol.ai)
 * and the Model Context Protocol (MCP) server endpoints for editor integrations
 * (VS Code, JetBrains, Cursor, Windsurf, Claude Desktop, etc.).
 */

export type AgentProtocolTaskStatus = 'created' | 'running' | 'completed' | 'failed' | 'paused';
export type AgentProtocolStepStatus = 'created' | 'running' | 'completed' | 'failed';

export interface AgentProtocolArtifact {
  artifact_id: string;
  agent_task_id: string;
  file_name: string;
  relative_path?: string;
  created_at: string;
  modified_at?: string;
  content?: string;
}

export interface AgentProtocolStep {
  task_id: string;
  step_id: string;
  name?: string;
  status: AgentProtocolStepStatus;
  output?: string;
  additional_output?: Record<string, unknown>;
  is_last: boolean;
  artifacts: AgentProtocolArtifact[];
  created_at: string;
  completed_at?: string;
}

export interface AgentProtocolTask {
  task_id: string;
  input: string;
  additional_input?: Record<string, unknown>;
  artifacts: AgentProtocolArtifact[];
  steps: AgentProtocolStep[];
  created_at: string;
  status: AgentProtocolTaskStatus;
  /** Evidence-backed summary: VERIFIED only when the final step carried passing verification. */
  additional_output?: {
    outcome?: 'IN_PROGRESS' | 'UNVERIFIED' | 'VERIFIED' | 'FAILED';
    last_step_id?: string;
    failed_step_id?: string;
  };
}

export interface CreateTaskRequestBody {
  input: string;
  additional_input?: Record<string, unknown>;
}

export interface ExecuteStepRequestBody {
  input?: string;
  additional_input?: Record<string, unknown>;
}

export interface TaskListResponse {
  tasks: AgentProtocolTask[];
  pagination?: {
    total: number;
    pages: number;
    current: number;
    page_size: number;
  };
}

export interface StepListResponse {
  steps: AgentProtocolStep[];
  pagination?: {
    total: number;
    pages: number;
    current: number;
    page_size: number;
  };
}

// Model Context Protocol (MCP) Server Types (JSON-RPC 2.0)

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpServerCapabilities {
  tools?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  prompts?: {
    listChanged?: boolean;
  };
}

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptDescriptor {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

// ---------------------------------------------------------------------------
// Authorization and controlled execution
// ---------------------------------------------------------------------------

/** Scopes a control-plane credential carries. Only the server assigns them. */
export type ProtocolScope = 'read' | 'mutate' | 'execute';

/**
 * The authenticated caller, resolved by the transport from its credential.
 * Never read from a request body or tool arguments.
 */
export interface ProtocolPrincipal {
  kind: 'operator' | 'viewer' | 'local-dev';
  id: string;
  scopes: readonly ProtocolScope[];
}

export interface ProtocolRequestContext {
  principal?: ProtocolPrincipal;
  signal?: AbortSignal;
}

export interface ControlledToolRequest {
  name: string;
  input: Record<string, unknown>;
  principal: ProtocolPrincipal;
  executionId: string;
  source: 'mcp' | 'agent-protocol' | 'verification';
  taskId?: string;
  stepId?: string;
  signal?: AbortSignal;
}

/** Outcome of one controlled tool call, with the policy decision that admitted or refused it. */
export interface ControlledToolResult {
  ok: boolean;
  output: string;
  error?: string;
  failureClass?: string;
  durationMs: number;
  callId: string;
  policy?: { decision: 'allow' | 'ask' | 'deny'; rule: string; reasons: string[] };
  workspaceBeforeHash?: string;
  workspaceAfterHash?: string;
  fileMutations?: unknown[];
}

/**
 * The single policy-enforced execution boundary (authorization, PolicyEngine,
 * approval, schema, tool surface, oracle protection, timeout, cancellation,
 * audit). Injected by the host so core never dispatches a tool directly.
 */
export type ControlledToolExecutor = (request: ControlledToolRequest) => Promise<ControlledToolResult>;

export type StepVerificationStatus = 'PASS' | 'FAIL' | 'ERROR' | 'UNAVAILABLE';

export interface StepVerificationCheck {
  name: string;
  status: 'PASS' | 'FAIL' | 'ERROR';
  callId?: string;
  failureClass?: string;
  error?: string;
  output?: string;
  durationMs: number;
  startedAt: string;
  completedAt: string;
  workspaceAfterHash?: string;
}

/** Evidence produced by independently executed checks; PASS needs at least one check and all passing. */
export interface StepVerificationReport {
  status: StepVerificationStatus;
  executionId: string;
  taskId: string;
  stepId: string;
  checks: StepVerificationCheck[];
  workspaceRevision?: string;
  startedAt: string;
  completedAt: string;
  reasons: string[];
}

export type StepVerifier = (request: {
  checks: string[];
  principal: ProtocolPrincipal;
  executionId: string;
  taskId: string;
  stepId: string;
  signal?: AbortSignal;
}) => Promise<StepVerificationReport>;

/**
 * What a step actually did. RECORDED means text was stored and nothing was
 * executed; only VERIFIED carries independent evidence of correctness.
 */
export type AgentProtocolStepOutcome =
  | 'RECORDED'
  | 'TOOL_SUCCEEDED'
  | 'TOOL_FAILED'
  | 'POLICY_DENIED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'OUTCOME_UNKNOWN'
  | 'EXECUTION_UNAVAILABLE'
  | 'VERIFIED'
  | 'VERIFICATION_FAILED'
  | 'VERIFICATION_UNAVAILABLE';
