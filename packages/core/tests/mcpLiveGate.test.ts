import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MCPRegistry } from '../src/services/mcpRegistry.js';
import { ToolRegistry } from '../../tools/src/registry.js';
import { PolicyEngine } from '../src/services/policyEngine.js';
import { CodeModeService } from '../src/services/codeModeService.js';
import type { MCPServerDefinition } from '../src/types/mcp.js';
import type { ToolExecutionContext } from '../src/types/tool.js';

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function mockBroker() {
  const data = new Map<string, string>();
  return {
    getCredential: async (k: string) => data.get(k),
    putCredential: async (k: string, v: string) => { data.set(k, v); },
    deleteCredential: async (k: string) => data.delete(k),
  };
}

describe('Gate 18: Dynamic MCP Runtime Integration & Normalization', () => {
  it('discovers, normalizes into CanonicalToolDescriptors, exposes to Code Mode, and tracks availability lifecycle', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wazir-mcp-g18-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));

    const toolRegistry = new ToolRegistry([]);
    const policy = new PolicyEngine({ projectRoot: directory, approveCallback: async () => true });
    const secrets = mockBroker();

    const mcpRegistry = new MCPRegistry({
      directory,
      tools: toolRegistry,
      policy,
      secrets,
      autoConnect: false,
    });
    cleanups.push(() => mcpRegistry.close());
    await mcpRegistry.initialize();

    const serverDef: MCPServerDefinition = {
      id: 'fixture-server',
      name: 'Fixture Test Server',
      enabled: true,
      transport: 'stdio',
      command: process.execPath,
      args: [path.resolve('packages/core/tests/fixtures/mcp.mjs'), 'stdio'],
      timeout: { connectionMs: 5000, toolMs: 2000 },
      reconnect: { attempts: 0 },
      auth: { type: 'none' },
      metadata: { capabilities: 'fixture.records fixture.search' },
    };

    await mcpRegistry.register(serverDef);
    await mcpRegistry.connect('fixture-server');

    // 1. Tool discovery and canonical normalization
    const descriptors = mcpRegistry.getCanonicalDescriptors('fixture-server');
    expect(descriptors.length).toBeGreaterThan(0);

    const getRecordsDesc = descriptors.find((d) => d.originalName === 'get_records');
    expect(getRecordsDesc).toBeDefined();
    expect(getRecordsDesc?.name).toBe('mcp.fixture-server.get_records');
    expect(getRecordsDesc?.namespace).toBe('mcp.fixture-server');
    expect(getRecordsDesc?.transport).toBe('stdio');
    expect(getRecordsDesc?.availability).toBe('CONNECTED');
    expect(getRecordsDesc?.risk).toBe('READ_ONLY');
    expect(getRecordsDesc?.sideEffectClass).toBe('READ_ONLY');
    expect(getRecordsDesc?.capabilities).toEqual(['fixture.records', 'fixture.search']);
    expect(getRecordsDesc?.inputSchema).toBeDefined();

    // 2. Model/tool visibility through ToolRegistry
    const registeredTool = toolRegistry.get('mcp.fixture-server.get_records');
    expect(registeredTool).toBeDefined();
    expect(registeredTool?.descriptor.provenance).toMatchObject({
      source: 'mcp',
      serverId: 'fixture-server',
      tool: 'get_records',
      trust: 'untrusted',
    });

    // 3. Code Mode dynamic invocation
    const codeMode = new CodeModeService({
      toolExecutor: async (toolName, input, ctx) => {
        const tool = toolRegistry.get(toolName);
        if (!tool) throw new Error(`Tool not found: ${toolName}`);
        return tool.execute(input, ctx);
      },
    });

    const script = `
      const result = await wazir.mcp['fixture-server'].get_records({ query: 'hello' });
      return JSON.parse(result.output);
    `;

    const cmResult = await codeMode.executeScript(script, {
      projectRoot: directory,
      executionId: 'exec-g18-mcp',
    });

    expect(cmResult.ok).toBe(true);
    const outputData = cmResult.returnValue as any;
    expect(outputData.trust).toBe('untrusted');
    expect(outputData.source.serverId).toBe('fixture-server');

    // 4. Connection lifecycle: disconnect marks tool availability as DISCONNECTED
    await mcpRegistry.disconnect('fixture-server');
    expect(mcpRegistry.get('fixture-server').state).toBe('DISCONNECTED');

    const disconnectedDescriptors = mcpRegistry.getCanonicalDescriptors('fixture-server');
    expect(disconnectedDescriptors.every((d) => d.availability === 'DISCONNECTED')).toBe(true);
  });
});
