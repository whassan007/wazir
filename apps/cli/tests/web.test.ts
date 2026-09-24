import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ExecutionEngine, PolicyEngine, MCPRegistry, ContextCompiler } from '@wazir/core';
import { ToolRegistry } from '@wazir/tools';
import { createConfiguredWeb, recordWebContext, registerWebCommands } from '../src/web.js';

describe('web CLI and execution history', () => {
  it('search and fetch JSON use the same service and persist provenance', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wazir-web-cli-'));
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/search')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ results: [{ title: 'Fixture result', url: 'https://example.com/', snippet: 'Search evidence' }] })); }
      else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<main><h1>Fixture</h1><p>Retrieved evidence</p><script>evil()</script></main>'); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ networkAllowed: true, web: { enabled: true, policy: { allowInternal: true }, search: { endpoint: base + '/search' } } }));
    vi.stubEnv('WAZIR_HOME', dir); vi.stubEnv('WAZIR_SECRETS_BACKEND', 'encrypted-file');
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const run = async (args: string[]) => {
        const program = new Command(); registerWebCommands(program);
        await program.parseAsync(['node', 'wa', 'web', ...args, '--json']);
        const output = logs.mock.calls.at(-1)![0]; expect(output).not.toMatch(/\x1b/); return JSON.parse(output);
      };
      const search = await run(['search', 'current release']); expect(search.ok).toBe(true); expect(search.results).toHaveLength(1); expect(search.provider).toBe('json-search');
      const fetch = await run(['fetch', base + '/page']); expect(fetch.ok).toBe(true); expect(fetch.content).toContain('# Fixture'); expect(fetch.content).not.toContain('<script>');
      const events = (await readFile(path.join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
      expect(events.some(e => e.details?.event === 'web.search.completed')).toBe(true);
      expect(events.some(e => e.details?.event === 'web.evidence')).toBe(true);
    } finally { logs.mockRestore(); vi.unstubAllEnvs(); server.close(); await once(server, 'close'); await rm(dir, { recursive: true, force: true }); }
  });
  it('records only retrieved citations and actual context in existing execution history', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wazir-web-history-'));
    const executions = new ExecutionEngine();
    const record = await executions.create({ task: { id: 't', type: 'coding', input: 'Research', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() }, modelId: 'model', runtimeId: 'runtime' });
    const policy = new PolicyEngine({ projectRoot: dir, networkAllowed: true });
    const mcp = new MCPRegistry({ directory: dir, policy, tools: new ToolRegistry([]), secrets: { getCredential: async () => undefined, putCredential: async () => {}, deleteCredential: async () => false }, autoConnect: false });
    try {
      const service = createConfiguredWeb({ enabled: true }, policy, mcp, dir, executions);
      service.options.providers.register({ metadata: { id: 'fixture', type: 'native', capabilities: ['search'], authentication: 'none', available: true, priority: 20, health: 'unknown' }, search: async () => ({ results: [{ title: 'Evidence', url: 'https://example.com/', snippet: 'Facts' }] }) });
      const result = await service.search({ query: 'facts' }, { projectRoot: dir, executionId: record.execution.id });
      const part = new ContextCompiler().grounded(result);
      const prepared = await recordWebContext(executions, record.execution.id, [{ role: 'assistant', content: 'According to https://invented.example' }, { role: 'user', content: part.content }], 1000);
      const history = await executions.events(record.execution.id);
      expect(history.some(e => e.type === 'web.search.completed')).toBe(true);
      const context = history.find(e => e.type === 'web.context')!.data as any;
      expect(context.parts[0].citationIds).toEqual([result.results[0].citation.citationId]);
      expect(context.parts[0].content).toContain('Facts'); expect(context.parts[0].tokensEstimated).toBeLessThanOrEqual(1000);
      expect(prepared.at(-1)!.content).toContain(context.parts[0].content); expect(JSON.stringify(context)).not.toContain('invented');
    } finally { await mcp.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
