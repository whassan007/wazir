import type { PolicyEffect } from './policy.js';

export type MCPRisk = 'READ_ONLY' | 'WRITE' | 'DESTRUCTIVE' | 'ADMIN' | 'UNKNOWN';
export type MCPState = 'DISABLED' | 'CONFIGURED' | 'AUTH_REQUIRED' | 'CONNECTING' | 'CONNECTED' | 'DEGRADED' | 'FAILED' | 'DISCONNECTED';
export interface SecretReference { secretRef: string; prefix?: string }
export type MCPConfigValue = string | SecretReference;
export interface MCPServerDefinition {
  id: string;
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, MCPConfigValue>;
  env?: Record<string, MCPConfigValue>;
  auth?: {
    type: 'none' | 'bearer' | 'oauth' | 'env' | 'headers';
    secretRef?: string;
    oauthConfig?: { clientId?: string; clientSecretRef?: string; redirectUrl?: string; scope?: string };
  };
  timeout?: { connectionMs?: number; toolMs?: number };
  reconnect?: { attempts?: number; backoffMs?: number; failureThreshold?: number; cooldownMs?: number };
  policy?: Partial<Record<MCPRisk, PolicyEffect>>;
  metadata?: Record<string, string>;
}

export type MCPFailureCode =
  | 'MCP_CONNECTION_FAILED' | 'MCP_AUTH_REQUIRED' | 'MCP_AUTH_FAILED'
  | 'MCP_PROTOCOL_FAILED' | 'MCP_TOOL_NOT_FOUND' | 'MCP_TOOL_SCHEMA_INVALID'
  | 'MCP_TOOL_TIMEOUT' | 'MCP_TOOL_EXECUTION_FAILED' | 'MCP_POLICY_DENIED'
  | 'MCP_SERVER_UNAVAILABLE' | 'MCP_CANCELLED';

export interface CanonicalMCPToolDescriptor {
  name: string;
  namespace: string;
  originalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  serverId: string;
  transport: 'stdio' | 'http';
  availability: MCPState;
  risk: MCPRisk;
  sideEffectClass: import('./tool.js').ToolSideEffectClass;
  permissions: string[];
  capabilities: string[];
}

/** Deliberately does not include remote error messages, headers, or arguments. */
export class MCPError extends Error {
  constructor(readonly code: MCPFailureCode, readonly serverId?: string) {
    super(code);
    this.name = 'MCPError';
  }
}

export function defaultMCPProfiles(): MCPServerDefinition[] {
  return [{
    id: 'github', name: 'GitHub', enabled: true, transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: { type: 'bearer', secretRef: 'github_mcp_token' },
    policy: { READ_ONLY: 'allow', WRITE: 'ask', DESTRUCTIVE: 'deny', ADMIN: 'ask', UNKNOWN: 'ask' },
    metadata: { capabilities: 'github.repository github.issues github.pull_requests github.actions' },
  }, {
    id: 'nvidia-runai', name: 'NVIDIA Run:ai', enabled: true, transport: 'stdio', command: 'docker',
    args: ['run', '--rm', '-i', '-e', 'RUNAI_BASE_URL', '-e', 'RUNAI_CLIENT_ID', '-e', 'RUNAI_CLIENT_SECRET', '-e', 'RUNAI_ALLOW_WRITE_TOOLS', 'nvcr.io/nvidia/runai/runai-mcp-server'],
    env: { RUNAI_BASE_URL: { secretRef: 'runai_base_url' }, RUNAI_CLIENT_ID: { secretRef: 'runai_client_id' }, RUNAI_CLIENT_SECRET: { secretRef: 'runai_client_secret' }, RUNAI_ALLOW_WRITE_TOOLS: 'false' },
    auth: { type: 'env' },
    policy: { READ_ONLY: 'allow', WRITE: 'ask', DESTRUCTIVE: 'ask', ADMIN: 'ask', UNKNOWN: 'ask' },
    metadata: { capabilities: 'runai.workloads runai.cluster runai.metrics' },
  }];
}
