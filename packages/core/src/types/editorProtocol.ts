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
