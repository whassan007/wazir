import type { ToolResult } from './tool.js';

export interface CodeModeLimits {
  /** Maximum number of tool calls allowed within a single script execution (default 50). */
  maxCalls?: number;
  /** Maximum wall-clock execution time in milliseconds (default 30,000ms). */
  timeoutMs?: number;
  /** Maximum output size in characters / bytes (default 500,000). */
  maxOutputChars?: number;
  /** Maximum concurrent in-flight tool operations (default 10). */
  maxConcurrency?: number;
}

export interface CodeModeSubCallRecord {
  callId: string;
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  output?: string;
  error?: string;
  durationMs: number;
  timestamp: Date;
  provenance?: Record<string, unknown>;
}

export interface CodeModeResult {
  ok: boolean;
  returnValue?: unknown;
  output: string;
  error?: string;
  failureClass?: import('@wazir/shared').FailureClass | string;
  durationMs: number;
  toolCallsExecuted: number;
  subCalls: CodeModeSubCallRecord[];
  roundTripReduction: {
    equivalentTurnCount: number;
    actualTurnCount: number;
    roundTripsSaved: number;
  };
}

export interface WazirCodeModeSdk {
  read(filePath: string): Promise<string>;
  write(filePath: string, content: string): Promise<ToolResult>;
  edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<ToolResult>;
  search(options: { query: string; paths?: string[]; glob?: string }): Promise<string>;
  glob(pattern: string): Promise<string[]>;
  goToDefinition(file: string, line: number, character: number): Promise<unknown>;
  references(file: string, line: number, character: number): Promise<unknown>;
  callers(symbol: string): Promise<unknown>;
  callees(symbol: string): Promise<unknown>;
  symbols(file: string): Promise<unknown>;
  workspaceSymbols(query: string): Promise<unknown>;
  relatedTests(file: string): Promise<string[]>;
  git(command: string): Promise<string>;
  test(command?: string): Promise<ToolResult>;
  build(command?: string): Promise<ToolResult>;
  call(toolName: string, input: Record<string, unknown>): Promise<ToolResult>;
}
