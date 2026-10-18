import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MCPRegistry } from '../../src/services/mcpRegistry.js';
import { PolicyEngine } from '../../src/services/policyEngine.js';
import type { MCPServerDefinition } from '../../src/types/mcp.js';
import { ToolRegistry, executeTool } from '../../../tools/src/registry.js';
import { httpFixture } from '../fixtures/mcp.mjs';

describe('LIVE-CODE-04: MCP Structured Tool Execution (Release Gate G4)', () => {
  const cleanups: Array<() => Promise<unknown>> = [];

  afterEach(async () => {
    for (const fn of cleanups.reverse()) {
      await fn();
    }
    cleanups.length = 0;
  });

  function createSecretsBroker() {
    const data = new Map<string, string>();
    return {
      getCredential: async (k: string) => data.get(k),
      putCredential: async (k: string, v: string) => {
        data.set(k, v);
      },
      deleteCredential: async (k: string) => data.delete(k),
    };
  }

  async function createHarness(approve = true) {
    const directory = await mkdtemp(path.join(tmpdir(), 'wazir-live04-mcp-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const tools = new ToolRegistry([]);
    const approval = vi.fn(async () => approve);
    const policy = new PolicyEngine({ projectRoot: directory, approveCallback: approval });
    const secrets = createSecretsBroker();
    const registry = new MCPRegistry({ directory, tools, policy, secrets, autoConnect: false });
    cleanups.push(() => registry.close());
    await registry.initialize();
    return { directory, tools, policy, registry, approval };
  }

  it('discovers MCP tool schemas, validates typed parameters, and rejects invalid parameter types prior to invocation', async () => {
    let serverInvocations = 0;
    const fixture = await httpFixture(undefined, () => {
      serverInvocations += 1;
    });
    cleanups.push(fixture.close);

    const harness = await createHarness(true);
    const serverDef: MCPServerDefinition = {
      id: 'structured-srv',
      name: 'structured-srv',
      enabled: true,
      transport: 'http',
      url: fixture.url,
      timeout: { connectionMs: 3000, toolMs: 2000 },
      reconnect: { attempts: 0 },
      auth: { type: 'none' },
    };

    await harness.registry.register(serverDef);
    await harness.registry.connect('structured-srv');

    const registeredTools = harness.tools.forModel();
    const getRecordsTool = registeredTools.find((t) => t.name === 'mcp.structured-srv.get_records');
    const createRecordTool = registeredTools.find((t) => t.name === 'mcp.structured-srv.create_record');
    expect(getRecordsTool).toBeDefined();
    expect(createRecordTool).toBeDefined();

    // 1. Valid typed parameter call succeeds and returns untrusted structured output
    const validRes = await executeTool(
      harness.tools,
      'mcp.structured-srv.get_records',
      { query: 'structured-check' },
      { projectRoot: harness.directory, executionId: 'exec-live-04' },
    );
    expect(validRes.ok).toBe(true);
    expect(validRes.output).toContain('structured-check');
    expect(validRes.metadata?.trust).toBe('untrusted');
    expect(serverInvocations).toBe(1);

    // 2. Invalid typed parameter (number instead of required string) is rejected by schema validation before server call
    const invalidRes = await executeTool(
      harness.tools,
      'mcp.structured-srv.create_record',
      { query: 42 },
      { projectRoot: harness.directory, executionId: 'exec-live-04' },
    );
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.error).toBe('MCP_TOOL_SCHEMA_INVALID');
    expect(serverInvocations).toBe(1);
    expect(harness.approval).not.toHaveBeenCalled();
  });
});
