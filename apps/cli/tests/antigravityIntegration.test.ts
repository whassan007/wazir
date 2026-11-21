import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ExternalAgentAdapter } from '@wazir/agents';
import { parseAntigravityModelCatalog } from '../src/agentPreflight.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WA_BIN = path.join(REPO_ROOT, 'bin/wa.js');

describe('Antigravity CLI 1.5+ & Wazir MCP host integration', () => {
  it('parses both agy 1.3 tab rows and agy 1.5+ spinner/space-aligned model catalogs safely', () => {
    const agy15Output = [
      '\r⠋ Fetching available models...\r⠙ Fetching available models...\rgemini-4-carbon-medium         Gemini 4 Carbon (Medium)',
      'gemini-4-carbon-high           Gemini 4 Carbon (High)',
      'gemini-pro-orchestrator        Orchestrator (Carbon)',
      'claude-opus-5-5-high           Claude Opus 5.5 (High)',
      'gpt-oss-120b-medium            GPT-OSS 120B (Medium)',
      'api-secret-token               Should Be Redacted',
      'legacy-tab-model\tLegacy 1.3 Label',
    ].join('\n');

    const parsed = parseAntigravityModelCatalog(agy15Output);
    expect(parsed.map((m) => m.id)).toEqual([
      'gemini-4-carbon-medium',
      'gemini-4-carbon-high',
      'gemini-pro-orchestrator',
      'claude-opus-5-5-high',
      'gpt-oss-120b-medium',
      'legacy-tab-model',
    ]);
    expect(parsed.every((m) => m.status === 'AVAILABLE' && m.source === 'agy models')).toBe(true);
  });

  it('forwards explicit --model selections to ExternalAgentAdapter when modelFlag is configured', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'wazir-agy-stub-'));
    const stubPath = path.join(tmpDir, 'fake-agy.mjs');
    writeFileSync(stubPath, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`);
    chmodSync(stubPath, 0o755);

    try {
      const adapter = new ExternalAgentAdapter({
        name: 'antigravity',
        version: 'external',
        description: 'Antigravity CLI test stub',
        command: stubPath,
        args: ['--sandbox', '--mode', 'accept-edits', '--output-format', 'text', '-p'],
        modelFlag: '--model',
        taskTypes: [],
        capabilities: ['coding'],
      });

      const collectArgs = async (modelId: string) => {
        const messages: string[] = [];
        for await (const turn of adapter.run(
          {
            modelId,
            taskType: 'coding',
            taskDescription: 'Reply OK',
            projectRoot: os.tmpdir(),
          } as any,
          {} as any,
        )) {
          if (turn.kind === 'message' && turn.content) messages.push(turn.content);
        }
        return JSON.parse(messages.join('')) as string[];
      };

      const withExplicitModel = await collectArgs('gemini-4-carbon-high');
      expect(withExplicitModel.slice(0, 2)).toEqual(['--model', 'gemini-4-carbon-high']);
      expect(withExplicitModel.at(-1)).toBe('Reply OK');

      const withDefaultExternal = await collectArgs('external');
      expect(withDefaultExternal).not.toContain('--model');
      expect(withDefaultExternal.at(-1)).toBe('Reply OK');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exposes Wazir fleet, model, and agent tools over MCP stdio (`wa mcp host`)', async () => {
    const isolatedHome = mkdtempSync(path.join(os.tmpdir(), 'wazir-mcp-host-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [WA_BIN, 'mcp', 'host'],
      env: {
        ...process.env,
        WAZIR_HOME: isolatedHome,
        WAZIR_FLEET_HOSTS: '[]',
        WAZIR_IN_MEMORY: '1',
      } as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'antigravity-test-client', version: '1.5.9' });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toEqual([
        'wazir_fleet_status',
        'wazir_models_list',
        'wazir_agents_status',
        'wazir_ask',
        'wazir_exec',
      ]);

      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri)).toEqual(['wazir://fleet/status', 'wazir://agents/status']);

      const statusRes = await client.callTool({ name: 'wazir_fleet_status', arguments: {} });
      const textBlock = (statusRes.content as Array<{ type: string; text?: string }>)[0];
      expect(textBlock?.type).toBe('text');
      const parsed = JSON.parse(textBlock?.text ?? '{}');
      expect(parsed.summary.version).toBe('0.3.2');
      expect(Array.isArray(parsed.computers)).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 20_000);
});
