import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { compileToolSchema } from './toolValidation.js';
import { Client, type Tool as RemoteTool, type Resource, type Prompt, type ServerCapabilities } from '@modelcontextprotocol/client';
import { appendAuditEvent } from '@wazir/shared';
import { createHTTPTransport, createStdioTransport, type MCPTransport } from './mcpTransport.js';
import { MCPAuthProvider, type MCPSecrets } from './mcpAuth.js';
import { PolicyEngine } from './policyEngine.js';
import { MCPError, defaultMCPProfiles, type MCPServerDefinition, type MCPState, type MCPRisk } from '../types/mcp.js';
import type { Tool, ToolExecutionContext, ToolResult } from '../types/tool.js';

export interface MCPToolRegistry { register(tool: Tool): void; unregister(name: string): void; get(name: string): Tool | undefined }
export interface MCPRegistryOptions {
  directory: string; tools: MCPToolRegistry; policy: PolicyEngine; secrets: MCPSecrets;
  autoConnect?: boolean;
  transportFactory?: (server: MCPServerDefinition, resolved: Awaited<ReturnType<MCPAuthProvider['resolve']>>) => MCPTransport;
  onAuthRequired?: (serverId: string, context: ToolExecutionContext) => Promise<void>;
}
export interface MCPConnection {
  definition: MCPServerDefinition; state: MCPState; client?: Client; pending?: Promise<void>;
  tools: RemoteTool[]; resources: Resource[]; prompts: Prompt[]; capabilities: ServerCapabilities;
  failures: number; circuitUntil: number; lastError?: string; discoveredAt?: string;
}
const defaults = { READ_ONLY: 'allow', WRITE: 'ask', DESTRUCTIVE: 'ask', ADMIN: 'ask', UNKNOWN: 'ask' } as const;
const liveRegistries = new Set<MCPRegistry>();
let exitHookInstalled = false;
export function classifyMCPTool(tool: RemoteTool): MCPRisk {
  const name = tool.name.toLowerCase();
  if (/(^|_)(admin|permission|credential|role|organization|node_pool)(_|$)/.test(name) && !/^(get|list|read|search)_/.test(name)) return 'ADMIN';
  if (/(delete|remove|destroy|merge|force|rerun|restart|revoke)/.test(name)) return 'DESTRUCTIVE';
  if (/(^|_)(create|update|write|push|submit|set|add|manage|cancel|stop|enable|disable)(_|$)/.test(name)) return 'WRITE';
  // MCP annotations and descriptions come from the external server. Never let
  // their readOnlyHint grant the default allow policy; only recognizable,
  // host-classified retrieval verbs receive READ_ONLY. All others need review.
  if (/^(get|list|read|search|find|show|describe|inspect|status|lookup|fetch)(_|$)/.test(name)) return 'READ_ONLY';
  return 'UNKNOWN';
}
export function mcpToolName(serverId: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(serverId) || !/^[A-Za-z0-9_.-]{1,128}$/.test(name)) throw new MCPError('MCP_PROTOCOL_FAILED', serverId);
  return `mcp.${serverId}.${name}`;
}
export function validateMCPDefinition(server: MCPServerDefinition): void {
  mcpToolName(server.id, 'validation');
  if (!server.name || typeof server.enabled !== 'boolean' || !['http', 'stdio'].includes(server.transport)) throw new MCPError('MCP_PROTOCOL_FAILED', server.id);
  if (server.transport === 'stdio' && !server.command) throw new MCPError('MCP_PROTOCOL_FAILED', server.id);
  if (server.url) {
    const url = new URL(server.url);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new MCPError('MCP_PROTOCOL_FAILED', server.id);
  }
  for (const [key, value] of [...Object.entries(server.headers ?? {}), ...Object.entries(server.env ?? {})]) {
    if (typeof value === 'string' && /authorization|cookie|token|secret|password|api.?key/i.test(key)) throw new MCPError('MCP_AUTH_FAILED', server.id);
    if (typeof value !== 'string' && (!value || !/^(env:)?[A-Za-z0-9_.-]{1,160}$/.test(value.secretRef))) throw new MCPError('MCP_AUTH_FAILED', server.id);
  }
  if (server.args?.some(arg => /(?:token|secret|password|api[_-]?key)=|gh[pousr]_[A-Za-z0-9]+/i.test(arg))) throw new MCPError('MCP_AUTH_FAILED', server.id);
  for (const effect of Object.values(server.policy ?? {})) if (!['allow', 'ask', 'deny'].includes(effect)) throw new MCPError('MCP_PROTOCOL_FAILED', server.id);
  for (const n of [...Object.values(server.timeout ?? {}), ...Object.values(server.reconnect ?? {})]) if (!Number.isFinite(n) || n < 0 || n > 300_000) throw new MCPError('MCP_PROTOCOL_FAILED', server.id);
}
function normalize(error: unknown, id: string, tool = false, signal?: AbortSignal): MCPError {
  if (error instanceof MCPError) return error;
  if (signal?.aborted) return new MCPError('MCP_CANCELLED', id);
  const e = error as any;
  if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR' || /abort/i.test(e?.message ?? '')) return new MCPError('MCP_CANCELLED', id);
  if (e?.name === 'UnauthorizedError' || e?.code === 401 || e?.status === 401) return new MCPError('MCP_AUTH_REQUIRED', id);
  if (/timeout|timed out/i.test(e?.message ?? '')) return new MCPError(tool ? 'MCP_TOOL_TIMEOUT' : 'MCP_CONNECTION_FAILED', id);
  return new MCPError(tool ? 'MCP_TOOL_EXECUTION_FAILED' : 'MCP_CONNECTION_FAILED', id);
}

export class MCPRegistry extends EventEmitter {
  readonly auth: MCPAuthProvider;
  private readonly servers = new Map<string, MCPConnection>();
  private closing = false;
  constructor(readonly options: MCPRegistryOptions) {
    super(); this.auth = new MCPAuthProvider(options.secrets);
    liveRegistries.add(this);
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.once('exit', () => {
        // SDK STDIO transport.close() kills its child synchronously before its promise settles.
        for (const registry of liveRegistries) for (const connection of registry.servers.values()) void connection.client?.close().catch(() => undefined);
      });
    }
  }
  async initialize(): Promise<void> {
    let definitions: MCPServerDefinition[];
    try { definitions = JSON.parse(await fs.readFile(path.join(this.options.directory, 'mcp.json'), 'utf8')).servers; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; definitions = defaultMCPProfiles(); }
    for (const definition of definitions) await this.register(definition, false);
    await this.save();
    // Cached descriptors permit task-time recovery without claiming a live connection.
    for (const s of this.list()) {
      try {
        const cached = JSON.parse(await fs.readFile(path.join(this.options.directory, 'mcp-' + s.definition.id + '.discovery.json'), 'utf8'));
        if (cached.endpoint !== (s.definition.url ?? s.definition.command)) continue;
        for (const tool of cached.tools ?? []) {
          const adapter = new MCPToolAdapter(this, s.definition.id, tool);
          this.options.tools.register(adapter); this.track(s.definition.id, adapter.descriptor.name);
          this.options.policy.registerMCPTool(adapter.descriptor.name, adapter.risk, s.definition.policy?.[adapter.risk] ?? defaults[adapter.risk]);
        }
      } catch { /* corrupt/missing cache never prevents startup */ }
    }
    if (this.options.autoConnect !== false) await Promise.allSettled(this.list().filter(s => s.definition.enabled).map(async s => {
      if (await this.readiness(s.definition.id)) await this.connect(s.definition.id);
    }));
  }
  list(): MCPConnection[] { return [...this.servers.values()]; }
  get(id: string): MCPConnection { const s = this.servers.get(id); if (!s) throw new MCPError('MCP_SERVER_UNAVAILABLE', id); return s; }
  async register(definition: MCPServerDefinition, persist = true): Promise<void> {
    validateMCPDefinition(definition);
    if (this.servers.has(definition.id)) throw new MCPError('MCP_PROTOCOL_FAILED', definition.id);
    this.servers.set(definition.id, { definition: structuredClone(definition), state: definition.enabled ? 'CONFIGURED' : 'DISABLED', tools: [], resources: [], prompts: [], capabilities: {}, failures: 0, circuitUntil: 0 });
    await this.event('MCP_SERVER_REGISTERED', definition.id);
    await this.readiness(definition.id);
    if (persist) await this.save();
  }
  async save(): Promise<void> {
    await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const filename = path.join(this.options.directory, 'mcp.json'), temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ servers: this.list().map(s => s.definition) }, null, 2), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
  }
  async readiness(id: string): Promise<boolean> {
    const s = this.get(id);
    if (!s.definition.enabled) { s.state = 'DISABLED'; return false; }
    if (s.definition.transport === 'http' && !s.definition.url) { s.state = 'CONFIGURED'; return false; }
    try { await this.auth.resolve(s.definition); return true; }
    catch { s.state = 'AUTH_REQUIRED'; return false; }
  }
  async connect(id: string, signal?: AbortSignal): Promise<void> {
    const s = this.get(id);
    if (signal?.aborted) throw new MCPError('MCP_CANCELLED', id);
    if (s.pending) return s.pending;
    if (s.state === 'CONNECTED' && s.circuitUntil <= Date.now()) return;
    if (this.closing || !s.definition.enabled || s.circuitUntil > Date.now()) throw new MCPError('MCP_SERVER_UNAVAILABLE', id);
    s.pending = this.open(s, signal).finally(() => { s.pending = undefined; });
    return s.pending;
  }
  private async open(s: MCPConnection, signal?: AbortSignal): Promise<void> {
    const d = s.definition;
    const attempts = Math.min(d.reconnect?.attempts ?? 1, 3);
    for (let attempt = 0; attempt <= attempts; attempt++) {
      let client: Client | undefined;
      try {
        if (signal?.aborted) throw new MCPError('MCP_CANCELLED', d.id);
        if (!await this.readiness(d.id)) throw new MCPError(s.state === 'AUTH_REQUIRED' ? 'MCP_AUTH_REQUIRED' : 'MCP_SERVER_UNAVAILABLE', d.id);
        const previous = s.client; s.client = undefined; await previous?.close().catch(() => undefined);
        s.state = 'CONNECTING'; await this.event('MCP_CONNECTING', d.id);
        const resolved = await this.auth.resolve(d);
        const transport = this.options.transportFactory?.(d, resolved) ?? (d.transport === 'stdio' ? createStdioTransport({ command: d.command!, args: d.args, env: resolved.env }) : createHTTPTransport({ url: d.url!, ...resolved }));
        client = new Client({ name: 'wazir', version: '0.1.37' }, { capabilities: {} });
        const controller = new AbortController();
        const timeout = Math.max(1, d.timeout?.connectionMs ?? 10_000);
        const timer = setTimeout(() => controller.abort(), timeout);
        const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
        try {
          await client.connect(transport, { timeout, signal: requestSignal });
          s.capabilities = client.getServerCapabilities() ?? {};
          const options = { timeout, signal: requestSignal };
          s.tools = s.capabilities.tools ? await this.pages(cursor => client!.listTools({ cursor }, options), 'tools') : [];
          s.resources = s.capabilities.resources ? await this.pages(cursor => client!.listResources({ cursor }, options), 'resources') : [];
          s.prompts = s.capabilities.prompts ? await this.pages(cursor => client!.listPrompts({ cursor }, options), 'prompts') : [];
        } finally { clearTimeout(timer); }
        // Validate every descriptor before replacing any live registrations.
        const adapters = s.tools.map(tool => new MCPToolAdapter(this, d.id, JSON.parse(this.auth.redact(tool))));
        const names = new Set(adapters.map(a => a.descriptor.name));
        if (names.size !== adapters.length || adapters.some(a => this.options.tools.get(a.descriptor.name) && this.options.tools.get(a.descriptor.name)?.descriptor.provenance?.serverId !== d.id)) throw new MCPError('MCP_PROTOCOL_FAILED', d.id);
        this.unregisterTools(d.id);
        for (const adapter of adapters) {
          this.options.tools.register(adapter);
          this.track(d.id, adapter.descriptor.name);
          this.options.policy.registerMCPTool(adapter.descriptor.name, adapter.risk, d.policy?.[adapter.risk] ?? defaults[adapter.risk]);
          await this.event('MCP_TOOL_DISCOVERED', d.id, { tool: adapter.descriptor.name });
        }
        s.client = client; s.state = 'CONNECTED'; s.failures = 0; s.circuitUntil = 0; s.lastError = undefined; s.discoveredAt = new Date().toISOString();
        client.onclose = () => { if (s.client === client) { s.client = undefined; s.state = 'DISCONNECTED'; void this.event('MCP_DISCONNECTED', d.id); } };
        client.onerror = () => { if (s.client === client) s.state = 'DEGRADED'; };
        await fs.writeFile(path.join(this.options.directory, 'mcp-' + d.id + '.discovery.json'), this.auth.redact(JSON.stringify({ endpoint: d.url ?? d.command, tools: s.tools, discoveredAt: s.discoveredAt })), { mode: 0o600 });
        await this.event('MCP_CONNECTED', d.id);
        return;
      } catch (error) {
        await client?.close().catch(() => undefined);
        const e = normalize(error, d.id); s.lastError = e.code;
        s.state = e.code === 'MCP_AUTH_REQUIRED' ? 'AUTH_REQUIRED' : e.code === 'MCP_CANCELLED' ? 'DISCONNECTED' : 'FAILED';
        await this.event(s.state === 'AUTH_REQUIRED' ? 'MCP_AUTH_REQUIRED' : e.code === 'MCP_CANCELLED' ? 'MCP_DISCONNECTED' : 'MCP_CONNECTION_FAILED', d.id, { status: e.code });
        if (e.code === 'MCP_CANCELLED' || s.state === 'AUTH_REQUIRED' || attempt === attempts) { if (e.code !== 'MCP_CANCELLED') this.failure(s); throw e; }
        await new Promise(resolve => setTimeout(resolve, Math.min((d.reconnect?.backoffMs ?? 100) * 2 ** attempt, 5000)));
      }
    }
  }
  private async pages<T>(load: (cursor?: string) => Promise<any>, key: string): Promise<T[]> {
    const result: T[] = []; let cursor: string | undefined; const seen = new Set<string>();
    do { const page = await load(cursor); result.push(...page[key]); cursor = page.nextCursor; if (result.length > 2000 || (cursor && seen.has(cursor))) throw new MCPError('MCP_PROTOCOL_FAILED'); if (cursor) seen.add(cursor); } while (cursor);
    return result;
  }
  failure(s: MCPConnection): void {
    s.failures++;
    if (s.failures >= (s.definition.reconnect?.failureThreshold ?? 3)) { s.state = 'DEGRADED'; s.circuitUntil = Date.now() + (s.definition.reconnect?.cooldownMs ?? 30_000); }
  }
  private unregisterTools(id: string): void {
    for (const name of this.registeredNames.get(id) ?? []) { this.options.tools.unregister(name); this.options.policy.unregisterMCPTool(name); }
    this.registeredNames.delete(id);
  }
  private readonly registeredNames = new Map<string, Set<string>>();
  track(id: string, name: string): void { const names = this.registeredNames.get(id) ?? new Set(); names.add(name); this.registeredNames.set(id, names); }
  async disconnect(id: string): Promise<void> {
    const s = this.get(id); if (s.pending) await s.pending.catch(() => undefined);
    const client = s.client; s.client = undefined;
    await client?.close().catch(() => undefined); s.state = s.definition.enabled ? 'DISCONNECTED' : 'DISABLED';
    await this.event('MCP_DISCONNECTED', id);
  }
  async remove(id: string): Promise<void> { await this.disconnect(id); this.unregisterTools(id); this.servers.delete(id); await fs.unlink(path.join(this.options.directory, 'mcp-' + id + '.discovery.json')).catch(() => undefined); await this.save(); }
  async update(definition: MCPServerDefinition): Promise<void> {
    validateMCPDefinition(definition);
    await this.disconnect(definition.id); this.unregisterTools(definition.id); this.servers.delete(definition.id);
    await this.register(definition);
  }
  async readResource(id: string, uri: string, ctx: ToolExecutionContext): Promise<import('../types/context.js').ContextPart> {
    await this.recover(id, ctx);
    const tool = `mcp.${id}.__read_resource`;
    this.options.policy.registerMCPTool(tool, 'READ_ONLY', this.get(id).definition.policy?.READ_ONLY ?? 'allow');
    const decision = await this.options.policy.authorize({ tool, input: {}, executionId: ctx.executionId, projectRoot: ctx.projectRoot });
    if (decision.decision !== 'allow') throw new MCPError('MCP_POLICY_DENIED', id);
    const result = await this.get(id).client!.readResource({ uri }, { signal: ctx.signal, timeout: this.get(id).definition.timeout?.toolMs ?? 30_000 });
    const provenance = { server: id, uri, retrievedAt: new Date().toISOString(), contentTypes: result.contents.map(c => c.mimeType ?? 'application/octet-stream') };
    await this.event('MCP_RESOURCE_READ', id, { executionId: ctx.executionId, decision: decision.decision });
    return { kind: 'mcp', label: `MCP resource ${id}`, content: JSON.stringify({ trust: 'untrusted', provenance, data: JSON.parse(this.auth.redact(result)) }), priority: 'optional' };
  }
  async getPrompt(id: string, name: string, args: Record<string, string>, ctx: ToolExecutionContext): Promise<import('../types/context.js').ContextPart> {
    await this.recover(id, ctx);
    const tool = `mcp.${id}.__get_prompt`;
    this.options.policy.registerMCPTool(tool, 'UNKNOWN', this.get(id).definition.policy?.UNKNOWN ?? 'ask');
    const decision = await this.options.policy.authorize({ tool, input: {}, executionId: ctx.executionId, projectRoot: ctx.projectRoot });
    if (decision.decision !== 'allow') throw new MCPError('MCP_POLICY_DENIED', id);
    const result = await this.get(id).client!.getPrompt({ name, arguments: args }, { signal: ctx.signal, timeout: this.get(id).definition.timeout?.toolMs ?? 30_000 });
    await this.event('MCP_PROMPT_READ', id, { executionId: ctx.executionId, decision: decision.decision });
    return { kind: 'mcp', label: `MCP template ${id}`, content: JSON.stringify({ trust: 'untrusted', server: id, retrievedAt: new Date().toISOString(), data: JSON.parse(this.auth.redact(result)) }), priority: 'optional' };
  }
  async enable(id: string, enabled: boolean): Promise<void> { const s = this.get(id); s.definition.enabled = enabled; if (!enabled) await this.disconnect(id); else s.state = 'CONFIGURED'; await this.save(); }
  async close(): Promise<void> { this.closing = true; await Promise.allSettled(this.list().map(s => this.disconnect(s.definition.id))); liveRegistries.delete(this); }
  async recover(id: string, ctx: ToolExecutionContext): Promise<void> {
    try { await this.connect(id, ctx.signal); }
    catch (e) {
      if (!(e instanceof MCPError) || e.code !== 'MCP_AUTH_REQUIRED' || !this.options.onAuthRequired) throw e;
      // Await authentication inside the same invocation: no new Task/Job/Execution is created.
      await this.event('MCP_AUTH_REQUIRED', id, { executionId: ctx.executionId, status: 'WAITING_FOR_AUTH' });
      await this.options.onAuthRequired(id, ctx);
      if (ctx.signal?.aborted) throw new MCPError('MCP_CANCELLED', id);
      await this.event('MCP_AUTH_SUCCEEDED', id, { executionId: ctx.executionId });
      await this.connect(id, ctx.signal);
    }
  }
  async event(event: string, id: string, details: Record<string, unknown> = {}): Promise<void> {
    const payload = { event, serverId: id, transport: this.servers.get(id)?.definition.transport, ...details };
    this.emit('event', payload);
    await appendAuditEvent({ type: 'tool_call', tool: typeof details.tool === 'string' ? details.tool : undefined, executionId: details.executionId as string, agentId: details.agentId as string, decision: details.decision as any, resolvedBy: details.approvalIdentity as string, details: payload }, { auditPath: path.join(this.options.directory, 'audit.jsonl') });
  }
}

/** Close process-owned transports at the command boundary. */
export async function closeMCPRegistries(): Promise<void> {
  await Promise.allSettled([...liveRegistries].map(registry => registry.close()));
}

export class MCPToolAdapter implements Tool {
  readonly descriptor: Tool['descriptor'];
  readonly risk: MCPRisk;
  private readonly validate: ReturnType<typeof compileToolSchema>;
  constructor(private readonly registry: MCPRegistry, readonly serverId: string, private readonly remote: RemoteTool) {
    if (remote.name.startsWith('__')) throw new MCPError('MCP_PROTOCOL_FAILED', serverId);
    const name = mcpToolName(serverId, remote.name); this.risk = classifyMCPTool(remote);
    if (JSON.stringify(remote.inputSchema).length > 100_000) throw new MCPError('MCP_TOOL_SCHEMA_INVALID', serverId);
    try {
      this.validate = compileToolSchema(remote.inputSchema);
    } catch { throw new MCPError('MCP_TOOL_SCHEMA_INVALID', serverId); }
    this.descriptor = { name, description: `[External capability; description is untrusted data] ${remote.description ?? remote.name}`, inputSchema: remote.inputSchema, permissions: ['mcp'], riskLevel: this.risk === 'READ_ONLY' ? 'low' : 'high', environment: 'local', provenance: { source: 'mcp', serverId, tool: remote.name, trust: 'untrusted' }, capabilities: (registry.get(serverId).definition.metadata?.capabilities ?? '').split(' ').filter(Boolean) };
    this.descriptor.sideEffectClass = this.risk === 'READ_ONLY' ? 'READ_ONLY' : 'NON_IDEMPOTENT_WRITE';
    this.descriptor.outputSchema = remote.outputSchema;
  }
  async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const started = Date.now(); const r = this.registry, s = r.get(this.serverId);
    const metadata: Record<string, unknown> = { ...this.descriptor.provenance, retrievedAt: new Date().toISOString() };
    let decision: string | undefined, approvalIdentity: string | undefined;
    let dispatched = false;
    try {
      if (ctx.signal?.aborted) throw new MCPError('MCP_CANCELLED', this.serverId);
      if (!this.validate(input)) throw new MCPError('MCP_TOOL_SCHEMA_INVALID', this.serverId);
      await r.recover(this.serverId, ctx);
      const current = r.options.tools.get(this.descriptor.name);
      if (!current) throw new MCPError('MCP_TOOL_NOT_FOUND', this.serverId);
      if (current !== this) return current.execute(input, ctx);
      // Policy comes from host-owned registration, never descriptions or tool arguments.
      const policy = await r.options.policy.authorize({ tool: this.descriptor.name, input: redactMCPArguments(input), executionId: ctx.executionId, projectRoot: ctx.projectRoot });
      metadata.policy = policy; decision = policy.decision; approvalIdentity = policy.rule.includes('user-approved') ? ctx.requester ?? 'interactive-user' : undefined;
      if (decision !== 'allow') throw new MCPError('MCP_POLICY_DENIED', this.serverId);
      if (s.definition.id === 'nvidia-runai' && this.risk !== 'READ_ONLY' && s.definition.metadata?.allowWriteTools !== 'true') throw new MCPError('MCP_POLICY_DENIED', this.serverId);
      if (ctx.signal?.aborted) throw new MCPError('MCP_CANCELLED', this.serverId);
      await r.event('MCP_TOOL_CALL_STARTED', this.serverId, { tool: this.descriptor.name, executionId: ctx.executionId, agentId: ctx.agentId, requester: ctx.requester, decision, approvalIdentity });
      await ctx.checkpoint?.();
      dispatched = true;
      const result = await s.client!.callTool({ name: this.remote.name, arguments: input }, { timeout: Math.max(1, s.definition.timeout?.toolMs ?? 30_000), signal: ctx.signal });
      if (JSON.stringify(result).length > 4 * 1024 * 1024) throw new MCPError('MCP_PROTOCOL_FAILED', this.serverId);
      if (result.isError) throw new MCPError('MCP_TOOL_EXECUTION_FAILED', this.serverId);
      s.failures = 0;
      await r.event('MCP_TOOL_CALL_COMPLETED', this.serverId, { tool: this.descriptor.name, executionId: ctx.executionId, agentId: ctx.agentId, decision, approvalIdentity, duration: Date.now() - started, status: 'success' });
      return { ok: true, output: JSON.stringify({ trust: 'untrusted', source: metadata, content: JSON.parse(r.auth.redact(result)) }), structuredOutput: result.structuredContent === undefined ? undefined : JSON.parse(r.auth.redact(result.structuredContent)), durationMs: Date.now() - started, metadata };
    } catch (error) {
      const e = normalize(error, this.serverId, true, ctx.signal);
      if (['MCP_TOOL_TIMEOUT', 'MCP_TOOL_EXECUTION_FAILED', 'MCP_CONNECTION_FAILED'].includes(e.code)) r.failure(s);
      await r.event('MCP_TOOL_CALL_FAILED', this.serverId, { tool: this.descriptor.name, executionId: ctx.executionId, agentId: ctx.agentId, decision, approvalIdentity, duration: Date.now() - started, status: e.code });
      const uncertain = dispatched && this.risk !== 'READ_ONLY' && ['MCP_TOOL_TIMEOUT', 'MCP_CONNECTION_FAILED', 'MCP_CANCELLED', 'MCP_PROTOCOL_FAILED'].includes(e.code);
      return { ok: false, output: '', error: e.code, failureClass: uncertain ? 'TOOL_OUTCOME_UNKNOWN' : e.code === 'MCP_POLICY_DENIED' ? 'POLICY_DENIED' : e.code === 'MCP_TOOL_SCHEMA_INVALID' ? 'TOOL_VALIDATION_FAILED' : e.code === 'MCP_TOOL_TIMEOUT' ? 'TOOL_TIMEOUT' : 'TOOL_EXECUTION_FAILED', durationMs: Date.now() - started, metadata };
    }
  }
}
export function redactMCPArguments(input: Record<string, unknown>): Record<string, unknown> {
  // Arbitrary schemas can hide credentials under any name. Audit presence, never values.
  return Object.fromEntries(Object.keys(input).map(key => [key, '[REDACTED]']));
}
