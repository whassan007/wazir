import type { Tool, ToolDescriptor } from './tool.js';
import type { PolicyEngine } from '../services/policyEngine.js';
import type { RuntimeCapabilities } from '@wazir/runtimes-interfaces';

export type ExecutionPhase =
  | 'plan'
  | 'inspect'
  | 'implement'
  | 'repair'
  | 'debug'
  | 'verify'
  | 'test'
  | 'complete'
  | string;

export interface ToolSurfaceRequest {
  agentId?: string;
  agentRole?: 'planner' | 'coder' | 'reviewer' | 'debugger' | 'verifier' | string;
  task?: string;
  taskDescription?: string;
  phase: ExecutionPhase;
  runtimeCapabilities?: Partial<RuntimeCapabilities>;
  repositoryCapabilities?: string[];
  availableCodeIntelligence?: boolean;
  availableCodeMode?: boolean;
  connectedMCPCapabilities?: string[];
  policy?: PolicyEngine;
  projectRoot?: string;
  executionState?: Record<string, unknown>;
  allowedToolNames?: readonly string[];
  disabledToolNames?: readonly string[];
  maxSchemaTokens?: number;
}

export type ToolSourceKind =
  | 'builtin'
  | 'code_intelligence'
  | 'code_mode'
  | 'mcp'
  | 'custom';

export interface ToolSurfaceItem {
  name: string;
  tool: Tool;
  descriptor: ToolDescriptor;
  serializedSchema: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  reasonIncluded: string;
  estimatedTokens: number;
  source: ToolSourceKind;
}

export interface ToolSurfaceOmission {
  name: string;
  reason: string;
  phase: string;
}

export type ProtocolSelection =
  | 'native_tool_call'
  | 'structured_output'
  | 'legacy_text';

export interface ToolSurface {
  phase: string;
  tools: Tool[];
  descriptors: ToolDescriptor[];
  surfaceItems: ToolSurfaceItem[];
  omissions: ToolSurfaceOmission[];
  serializedSchemas: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  totalSchemaTokens: number;
  totalSchemaBytes: number;
  totalToolsAvailable: number;
  totalToolsExposed: number;
  reductionRatio: number;
  selectedProtocol: ProtocolSelection;
  protocolSelectionReason: string;
}
