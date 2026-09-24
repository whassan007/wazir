import type { Tool, ToolResult } from '@wazir/core';
import { CodeModeService } from '@wazir/core';
import { executeTool, type ToolRegistry } from './registry.js';

let sharedRegistry: ToolRegistry | undefined;

export function setCodeModeToolRegistry(registry: ToolRegistry): void {
  sharedRegistry = registry;
}

export function createCodeModeTool(registry: ToolRegistry): Tool {
  const service = new CodeModeService({
    toolExecutor: async (name, input, ctx) => {
      return executeTool(registry, name, input, ctx);
    },
  });

  return {
    descriptor: {
      name: 'code_mode',
      description:
        'Execute a bounded JavaScript program against the typed Wazir SDK to batch multiple tool operations into a single turn. ' +
        'Exposes `wazir.read(path)`, `wazir.write(path, content)`, `wazir.edit(path, old, new)`, `wazir.search({query})`, ' +
        '`wazir.glob(pattern)`, `wazir.symbols(file)`, `wazir.references(file, line, col)`, `wazir.callers(symbol)`, ' +
        '`wazir.callees(symbol)`, `wazir.relatedTests(file)`, `wazir.test()`, `wazir.build()`.',
      inputSchema: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: 'JavaScript async code body using the wazir SDK. E.g. const [a, b] = await Promise.all([wazir.read("f1"), wazir.read("f2")]); return { a, b };',
          },
        },
        required: ['script'],
      },
      permissions: ['filesystem_read'],
      riskLevel: 'medium',
      environment: 'local',
      timeoutMs: 60_000,
    },
    async execute(input, ctx): Promise<ToolResult> {
      const { script } = input as { script: string };
      const result = await service.executeScript(script, ctx);
      return {
        ok: result.ok,
        output: result.output,
        error: result.error,
        failureClass: result.failureClass as any,
        durationMs: result.durationMs,
        metadata: {
          toolCallsExecuted: result.toolCallsExecuted,
          roundTripReduction: result.roundTripReduction,
          subCalls: result.subCalls.map((c) => ({
            tool: c.tool,
            callId: c.callId,
            ok: c.ok,
            durationMs: c.durationMs,
          })),
        },
      };
    },
  };
}

export const codeModeTool: Tool = {
  descriptor: {
    name: 'code_mode',
    description:
      'Execute a bounded JavaScript program against the typed Wazir SDK to batch multiple tool operations into a single turn.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'JavaScript code body using wazir SDK' },
      },
      required: ['script'],
    },
    permissions: ['filesystem_read'],
    riskLevel: 'medium',
    environment: 'local',
    timeoutMs: 60_000,
  },
  async execute(input, ctx): Promise<ToolResult> {
    if (!sharedRegistry) {
      throw new Error('CodeModeTool requires an active ToolRegistry configured via setCodeModeToolRegistry');
    }
    const instance = createCodeModeTool(sharedRegistry);
    return instance.execute(input, ctx);
  },
};
