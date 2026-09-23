import type { Tool, ToolDescriptor, ToolResult } from '@wazir/core';
import { editTool, readTool, writeTool } from './filesystem.js';
import { globTool, searchTool } from './search.js';
import { buildTool, gitTool, lintTool, shellTool, testTool, typecheckTool } from './process-tools.js';
import { terminalCloseTool, terminalOpenTool, terminalSendTool } from './terminalTools.js';
import { lspTools } from '@wazir/lsp/src/tools.js';
export const dispatchSubagentTool: Tool = {
  descriptor: {
    name: 'dispatch_subagent',
    description:
      'Delegate a self-contained subtask to a fresh agent with no memory of this conversation. ' +
      'Use for isolated exploration or a well-scoped subproblem whose full transcript you do not ' +
      'need. Returns only a condensed summary, not the raw transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'The subtask, written so it is understandable with no other context',
        },
        expectedArtifacts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional expected artifacts or files created by the subtask',
        },
      },
      required: ['description'],
    },
    permissions: ['subagent'],
    riskLevel: 'medium',
    environment: 'local',
    provenance: { source: 'subagent' },
  },
  async execute(): Promise<ToolResult> {
    throw new Error('dispatch_subagent must be executed via the runtime harness, not directly');
  },
};

export const defaultTools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  searchTool,
  globTool,
  shellTool,
  gitTool,
  testTool,
  lintTool,
  typecheckTool,
  buildTool,
  dispatchSubagentTool,
  terminalOpenTool,
  terminalSendTool,
  terminalCloseTool,
  // LSP tools for code intelligence
  ...lspTools,
];

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[] = defaultTools) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: Tool): void {
    this.tools.set(tool.descriptor.name, tool);
  }

  unregister(name: string): void { this.tools.delete(name); }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values()).sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name));
  }

  descriptors(): ToolDescriptor[] {
    return this.list().map((t) => t.descriptor);
  }

  /** Schemas as presented to a model. */
  forModel(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return this.list().map((t) => ({
      name: t.descriptor.name,
      description: t.descriptor.description,
      inputSchema: t.descriptor.inputSchema,
    }));
  }

  requiredTools(names: string[]): string[] {
    return names.filter((name) => !this.tools.has(name));
  }
}

export async function executeTool(
  registry: ToolRegistry,
  name: string,
  input: Record<string, unknown>,
  ctx: Parameters<Tool['execute']>[1],
): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) {
    return {
      ok: false,
      output: '',
      error: `unknown tool '${name}'`,
      durationMs: 0,
    };
  }
  return tool.execute(input, ctx);
}
