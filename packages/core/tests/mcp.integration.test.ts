import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MCPRegistry, classifyMCPTool, mcpToolName, validateMCPDefinition } from '../src/services/mcpRegistry.js';
import { MCPAuthProvider } from '../src/services/mcpAuth.js';
import { PolicyEngine } from '../src/services/policyEngine.js';
import { defaultMCPProfiles, type MCPServerDefinition } from '../src/types/mcp.js';
import { ToolRegistry, executeTool } from '../../tools/src/registry.js';
import { httpFixture } from './fixtures/mcp.mjs';

const cleanups: Array<() => Promise<any>> = [];
afterEach(async () => { for (const f of cleanups.reverse()) await f(); cleanups.length = 0; });
function broker() {
  const data = new Map<string, string>();
  return { getCredential: async (key: string) => data.get(key), putCredential: async (key: string, value: string) => { data.set(key, value); }, deleteCredential: async (key: string) => data.delete(key), data };
}
async function setup(approve = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'wazir-mcp-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const tools = new ToolRegistry([]);
  const approval = vi.fn(async () => approve);
  const policy = new PolicyEngine({ projectRoot: directory, approveCallback: approval });
  const secrets = broker();
  const registry = new MCPRegistry({ directory, tools, policy, secrets, autoConnect: false });
  cleanups.push(() => registry.close());
  await registry.initialize();
  return { registry, tools, policy, secrets, directory, approval };
}
function stdio(id = 'third-party'): MCPServerDefinition {
  return { id, name: id, enabled: true, transport: 'stdio', command: process.execPath, args: [path.resolve('packages/core/tests/fixtures/mcp.mjs'), 'stdio'], timeout: { connectionMs: 3000, toolMs: 1000 }, reconnect: { attempts: 0 }, auth: { type: 'none' } };
}
async function call(s: Awaited<ReturnType<typeof setup>>, name = 'get_records', input: any = { query: 'hello' }, signal?: AbortSignal) {
  return executeTool(s.tools, 'mcp.third-party.' + name, input, { projectRoot: s.directory, executionId: 'same-execution', signal });
}

describe('production MCP protocol integration', () => {
  it('bootstraps GitHub and NVIDIA profiles without credentials or connectivity', async () => {
    const s = await setup();
    expect(s.registry.list().map(c => c.definition.id)).toEqual(['github', 'nvidia-runai']);
    expect(s.registry.get('github').state).toBe('AUTH_REQUIRED');
    expect(s.registry.get('nvidia-runai').definition.env?.RUNAI_ALLOW_WRITE_TOOLS).toBe('false');
    expect(s.registry.list().every(c => c.state !== 'CONNECTED')).toBe(true);
  });
  it('initializes real STDIO, discovers tools/resources/prompts and invokes a generic server', async () => {
    const s = await setup();
    await s.registry.register(stdio()); await s.registry.connect('third-party');
    expect(s.registry.get('third-party').state).toBe('CONNECTED');
    expect(s.registry.get('third-party').capabilities.tools).toBeDefined();
    expect(s.registry.get('third-party').resources).toHaveLength(1);
    expect(s.registry.get('third-party').prompts).toHaveLength(1);
    expect(s.tools.forModel().map(t => t.name)).toContain('mcp.third-party.get_records');
    const result = await call(s);
    expect(result.ok).toBe(true); expect(result.output).toContain('hello');
    expect(result.metadata?.trust).toBe('untrusted');
    expect(s.approval).not.toHaveBeenCalled();
    const audit = await readFile(path.join(s.directory, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('MCP_TOOL_CALL_COMPLETED'); expect(audit).toContain('same-execution');
  });
  it('connects Streamable HTTP and injects bearer credentials without logging them', async () => {
    const token = 'fixture-token-not-for-models';
    const fixture = await httpFixture(token); cleanups.push(fixture.close);
    const s = await setup(); await s.secrets.putCredential('http_token', token);
    await s.registry.register({ ...stdio(), transport: 'http', url: fixture.url, auth: { type: 'bearer', secretRef: 'http_token' } });
    await s.registry.connect('third-party');
    expect((await call(s, 'get_records', { query: token })).output).not.toContain(token);
    expect(await readFile(path.join(s.directory, 'audit.jsonl'), 'utf8')).not.toContain(token);
    expect(await readFile(path.join(s.directory, 'mcp.json'), 'utf8')).not.toContain(token);
  });
  it('validates arguments before policy approval or invocation', async () => {
    let calls = 0; const fixture = await httpFixture(undefined, () => calls++); cleanups.push(fixture.close);
    const s = await setup(true);
    await s.registry.register({ ...stdio(), transport: 'http', url: fixture.url });
    await s.registry.connect('third-party');
    expect((await call(s, 'create_record', { query: 7 })).error).toBe('MCP_TOOL_SCHEMA_INVALID');
    expect(s.approval).not.toHaveBeenCalled(); expect(calls).toBe(0);
  });
  it('requires write approval and prevents destructive calls before policy authorization', async () => {
    let calls = 0; const fixture = await httpFixture(undefined, () => calls++); cleanups.push(fixture.close);
    const s = await setup();
    await s.registry.register({ ...stdio(), transport: 'http', url: fixture.url, policy: { DESTRUCTIVE: 'deny' } });
    await s.registry.connect('third-party');
    expect((await call(s, 'create_record')).error).toBe('MCP_POLICY_DENIED');
    expect(s.approval).toHaveBeenCalledTimes(1);
    expect((await call(s, 'delete_record')).error).toBe('MCP_POLICY_DENIED');
    expect(calls).toBe(0);
    expect((await call(s, 'mystery')).error).toBe('MCP_POLICY_DENIED');
    expect(s.approval).toHaveBeenCalledTimes(2);
  });
  it('permits explicitly approved writes through existing PolicyEngine', async () => {
    const s = await setup(true); await s.registry.register(stdio()); await s.registry.connect('third-party');
    expect((await call(s, 'create_record')).ok).toBe(true); expect(s.approval).toHaveBeenCalledOnce();
  });
  it('reconnects at task time, keeping the same execution identity', async () => {
    const s = await setup(); await s.registry.register(stdio()); await s.registry.connect('third-party');
    await s.registry.disconnect('third-party');
    expect(s.registry.get('third-party').state).toBe('DISCONNECTED');
    expect((await call(s)).ok).toBe(true);
    expect(s.registry.get('third-party').state).toBe('CONNECTED');
  });
  it('enforces tool timeout and opens a circuit after repeated failures', async () => {
    const s = await setup(); await s.registry.register({ ...stdio(), timeout: { connectionMs: 3000, toolMs: 20 }, reconnect: { attempts: 0, failureThreshold: 2, cooldownMs: 10000 } });
    await s.registry.connect('third-party');
    expect((await call(s, 'get_slow', {})).error).toBe('MCP_TOOL_TIMEOUT');
    expect((await call(s, 'get_slow', {})).error).toBe('MCP_TOOL_TIMEOUT');
    expect(s.registry.get('third-party').state).toBe('DEGRADED');
    expect((await call(s)).error).toBe('MCP_SERVER_UNAVAILABLE');
  });
  it('cancels a request without waiting for tool timeout', async () => {
    const s = await setup(); await s.registry.register(stdio()); await s.registry.connect('third-party');
    const controller = new AbortController(); const pending = call(s, 'get_slow', {}, controller.signal);
    setTimeout(() => controller.abort(), 10);
    expect((await pending).error).toBe('MCP_CANCELLED');
  });
  it('bounds initialization timeout and isolates a broken server', async () => {
    const s = await setup();
    await s.registry.register({ ...stdio('broken'), args: ['-e', 'setTimeout(() => {}, 10000)'], timeout: { connectionMs: 30 } });
    await s.registry.register(stdio());
    const results = await Promise.allSettled([s.registry.connect('broken'), s.registry.connect('third-party')]);
    expect(results[0].status).toBe('rejected'); expect(results[1].status).toBe('fulfilled');
    expect((await call(s)).ok).toBe(true);
  });
  it('passes only explicit environment credentials and redacts echoed values', async () => {
    const s = await setup(); await s.secrets.putCredential('fixture_secret', 'hidden-value-123');
    await s.registry.register({ ...stdio(), env: { FIXTURE_SECRET: { secretRef: 'fixture_secret' } }, auth: { type: 'env' } });
    await s.registry.connect('third-party');
    const result = await call(s, 'get_records', { query: 'env' });
    expect(result.ok).toBe(true); expect(result.output).toContain('[REDACTED]'); expect(result.output).not.toContain('hidden-value-123');
  });
  it('marks resources and prompts untrusted and cannot change policy from server content', async () => {
    const s = await setup(true); await s.registry.register({ ...stdio(), policy: { DESTRUCTIVE: 'deny' } }); await s.registry.connect('third-party');
    const part = await s.registry.readResource('third-party', 'fixture://data', { projectRoot: s.directory });
    expect(part.kind).toBe('mcp'); expect(part.priority).toBe('optional'); expect(part.content).toContain('untrusted');
    expect(part.content).toContain('text/plain');
    const prompt = await s.registry.getPrompt('third-party', 'sample', { topic: 'test' }, { projectRoot: s.directory });
    expect(prompt.kind).toBe('mcp'); expect(prompt.content).toContain('untrusted');
    expect((await call(s, 'delete_record')).error).toBe('MCP_POLICY_DENIED');
  });
  it('recovers authentication within one invocation and never creates a duplicate execution', async () => {
    const fixture = await httpFixture('restored-token'); cleanups.push(fixture.close);
    const s = await setup();
    await s.secrets.putCredential('http_token', 'restored-token');
    await s.registry.register({ ...stdio(), transport: 'http', url: fixture.url, auth: { type: 'bearer', secretRef: 'http_token' } });
    await s.registry.connect('third-party'); await s.registry.disconnect('third-party');
    await s.secrets.deleteCredential('http_token');
    const recovery = vi.fn(async (_id, ctx) => { expect(ctx.executionId).toBe('same-execution'); await s.secrets.putCredential('http_token', 'restored-token'); });
    s.registry.options.onAuthRequired = recovery;
    expect((await call(s)).ok).toBe(true); expect(recovery).toHaveBeenCalledOnce();
    const audit = await readFile(path.join(s.directory, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('WAITING_FOR_AUTH');
    expect(audit.match(/MCP_TOOL_CALL_COMPLETED/g)).toHaveLength(1);
  });
  it('never auto-enables NVIDIA writes even with permissive Wazir policy', async () => {
    const s = await setup(true);
    await s.registry.remove('nvidia-runai');
    await s.registry.register({ ...stdio('nvidia-runai'), policy: { WRITE: 'allow' } }); await s.registry.connect('nvidia-runai');
    const result = await executeTool(s.tools, 'mcp.nvidia-runai.create_record', { query: 'no' }, { projectRoot: s.directory });
    expect(result.error).toBe('MCP_POLICY_DENIED');
  });
  it('keeps namespaces collision-free and rejects dotted server IDs', () => {
    expect(mcpToolName('one', 'get')).not.toBe(mcpToolName('two', 'get'));
    expect(() => mcpToolName('one.two', 'get')).toThrow();
  });
  it('rejects literal credentials and insecure HTTP endpoints', () => {
    expect(() => validateMCPDefinition({ ...stdio(), headers: { Authorization: 'secret' } })).toThrow();
    expect(() => validateMCPDefinition({ ...stdio(), transport: 'http', url: 'http://example.com/mcp' })).toThrow();
  });
  it('classifies suspicious names conservatively despite misleading read-only hints', () => {
    expect(classifyMCPTool({ name: 'delete_repository', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } })).toBe('DESTRUCTIVE');
    expect(classifyMCPTool({ name: 'mystery', inputSchema: { type: 'object' } })).toBe('UNKNOWN');
  });
  it('uses broker-backed OAuth tokens bound to endpoint and client identity', async () => {
    const secrets = broker(); const auth = new MCPAuthProvider(secrets);
    const d = { ...defaultMCPProfiles()[0], auth: { type: 'oauth' as const, oauthConfig: { clientId: 'registered-app' } } };
    const provider = auth.oauth(d);
    expect((await provider.clientInformation())?.client_id).toBe('registered-app');
    provider.saveCodeVerifier('verifier'); expect(provider.codeVerifier()).toBe('verifier');
    await provider.saveTokens({ access_token: 'oauth-secret', token_type: 'Bearer' });
    expect((await auth.resolve(d)).authProvider).toBeDefined();
    expect(auth.redact('oauth-secret')).toBe('[REDACTED]');
    expect(await auth.oauth({ ...d, url: 'https://different.example/mcp' }).tokens()).toBeUndefined();
    await provider.invalidateCredentials('tokens'); expect(await provider.tokens()).toBeUndefined();
  });
});
