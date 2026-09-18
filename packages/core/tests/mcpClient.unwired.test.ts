import { describe, it, expect } from 'vitest';
import { MCPClient, type MCPTransport } from '../src/services/mcpClient.js';
import { PolicyEngine } from '../src/services/policyEngine.js';
import type { Request, Response } from '@wazir/shared';

describe('Section 14: MCP Tests — Isolated & Unwired Contract Tests', () => {
  describe('Policy Gate (What is actually wired today)', () => {
    it('PolicyEngine denies MCP server not listed in allowedMcpServers', () => {
      const policy = new PolicyEngine({
        projectRoot: '/tmp',
        allowedMcpServers: ['approved-mcp-server'],
      });

      // Allowed server
      const allowedDecision = policy.classify({
        action: 'tool_call',
        tool: 'mcp:approved-mcp-server:fetchDocs',
      });
      expect(allowedDecision.decision).toBe('allow');

      // Disallowed server
      const deniedDecision = policy.classify({
        action: 'tool_call',
        tool: 'mcp:untrusted-external-mcp:fetchDocs',
      });
      expect(deniedDecision.decision).toBe('deny');
      expect(deniedDecision.reasons[0]).toContain('not in the allowed MCP list');
    });

    it('PolicyEngine with empty allowedMcpServers denies all MCP servers by default', () => {
      const policy = new PolicyEngine({
        projectRoot: '/tmp',
        allowedMcpServers: [],
      });

      const decision = policy.classify({
        action: 'tool_call',
        tool: 'mcp:any-server:tool',
      });
      expect(decision.decision).toBe('deny');
    });
  });

  describe('MCPClient Unwired Unit Contract (Testing the unwired component in isolation)', () => {
    class MockTransport implements MCPTransport {
      public sent: Request[] = [];
      private responses: Array<Response> = [];

      queueResponse(res: Response) {
        this.responses.push(res);
      }

      async open(): Promise<void> {}
      async close(): Promise<void> {}

      async send(request: Request): Promise<void> {
        this.sent.push(request);
      }

      async receive(): Promise<Response | null> {
        return this.responses.shift() ?? null;
      }
    }

    it('initializes handshake with protocolVersion and clientInfo', async () => {
      const transport = new MockTransport();
      transport.queueResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mock-mcp-server', version: '1.0' },
        },
      });

      const client = new MCPClient({ transport, timeoutMs: 1000 });
      const initResult = await client.initialize();

      expect(initResult).toBeDefined();
      expect(initResult.serverInfo?.name).toBe('mock-mcp-server');
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0].method).toBe('initialize');
      expect((transport.sent[0].params as any)?.clientInfo?.name).toBe('wazir');
    });

    it('lists available tools from initialized MCP server', async () => {
      const transport = new MockTransport();
      transport.queueResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { capabilities: { tools: {} } },
      });
      transport.queueResponse({
        jsonrpc: '2.0',
        id: 2,
        result: [
          {
            name: 'fetch_docs',
            description: 'Fetches documentation',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      });

      const client = new MCPClient({ transport, timeoutMs: 1000 });
      await client.initialize();
      const tools = await client.listTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('fetch_docs');
      expect(transport.sent[1].method).toBe('tools/list');
    });

    it('calls an MCP tool and returns tool output content', async () => {
      const transport = new MockTransport();
      transport.queueResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { capabilities: { tools: {} } },
      });
      transport.queueResponse({
        jsonrpc: '2.0',
        id: 2,
        result: {
          content: [{ type: 'text', text: 'Document contents found: Wazir Architecture' }],
        },
      });

      const client = new MCPClient({ transport, timeoutMs: 1000 });
      await client.initialize();

      const result = await client.callTool('fetch_docs', { query: 'architecture' });
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain('Wazir Architecture');
    });

    it('times out when transport does not receive response within timeoutMs', async () => {
      const transport = new MockTransport();
      // No response queued
      const client = new MCPClient({ transport, timeoutMs: 100 });

      await expect(client.initialize()).rejects.toThrow(/Failed to initialize MCP client/);
    });
  });
});
