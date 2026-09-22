export type ToolPermission =
  | 'filesystem_read'
  | 'filesystem_write'
  | 'shell_execute'
  | 'git_execute'
  | 'test_run'
  | 'build_run'
  | 'network_access'
  | 'mcp';

export type ToolRiskLevel = 'low' | 'medium' | 'high';
export type ToolEnvironment = 'local' | 'worker';

export interface ToolDescriptor {
  provenance?: { source: 'mcp'; serverId: string; tool: string; trust: 'untrusted' };
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
  ok: boolean;
  output: string;
  error?: string;
  durationMs: number;
  metadata?: Record<string, unknown>;
  fileMutations?: FileMutationResult[];
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
  requester?: string;
  agentId?: string;
  projectRoot: string;
  executionId?: string;
  env?: Record<string, string>;
  /** Policy's network decision for this execution; the OS sandbox enforces it. */
  networkAllowed?: boolean;
}

export interface Tool {
  descriptor: ToolDescriptor;
  execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult>;
}
