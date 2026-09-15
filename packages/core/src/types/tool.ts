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
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  permissions: ToolPermission[];
  riskLevel: ToolRiskLevel;
  environment: ToolEnvironment;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
  durationMs: number;
  metadata?: Record<string, unknown>;
}

export interface ToolExecutionContext {
  projectRoot: string;
  executionId?: string;
  env?: Record<string, string>;
}

export interface Tool {
  descriptor: ToolDescriptor;
  execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult>;
}
