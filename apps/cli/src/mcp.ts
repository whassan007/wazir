import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import readline from 'node:readline/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { auth } from '@modelcontextprotocol/client';
import { MCPRegistry, MCPError, PolicyEngine, defaultMCPProfiles, hashToolArguments, redactMCPArguments, type MCPServerDefinition, type ToolExecutionContext, type ToolResult } from '@wazir/core';
import { ToolRegistry, executeTool } from '@wazir/tools';
import { createSecretBroker } from '@wazir/secrets';
import { generateId } from '@wazir/shared';
import { configDir } from './config.js';
import { promptSecret } from './secretPrompt.js';
import { createApprover } from './approve.js';
import type { RookEngine } from './engine.js';

async function question(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Interactive input requires a terminal; use wa mcp import <file>.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(label)).trim(); } finally { rl.close(); }
}
export async function authenticateMCP(registry: MCPRegistry, id: string): Promise<void> {
  const server = registry.get(id).definition;
  if (server.auth?.type === 'oauth') {
    if (!server.url) throw new MCPError('MCP_SERVER_UNAVAILABLE', id);
    if (id === 'github' && !server.auth.oauthConfig?.clientId) throw new Error('GitHub OAuth requires your registered OAuth/GitHub App client ID. Configure oauth-client-id or explicitly select PAT mode.');
    let resolveCallback: (value: { code: string; iss?: string }) => void;
    const callback = new Promise<{ code: string; iss?: string }>(resolve => { resolveCallback = resolve; });
    const provider = registry.auth.oauth(server, url => {
      console.log('Open this authorization URL in your browser:\n' + url.toString());
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? undefined : 'xdg-open';
      if (command) { const child = spawn(command, [url.toString()], { stdio: 'ignore' }); child.on('error', () => undefined); child.unref(); }
    });
    const redirect = new URL(provider.redirectUrl);
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1') throw new Error('OAuth callback must use http://127.0.0.1:<port>/callback.');
    const listener = createServer((req, res) => {
      const url = new URL(req.url ?? '/', redirect);
      if (url.pathname !== redirect.pathname || url.searchParams.get('state') !== provider.state() || !url.searchParams.get('code')) { res.writeHead(400).end('Invalid OAuth callback'); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('You may return to Wazir.');
      resolveCallback({ code: url.searchParams.get('code')!, iss: url.searchParams.get('iss') ?? undefined });
    });
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(Number(redirect.port), '127.0.0.1', resolve); });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    const fetchFn: typeof fetch = (url, init) => fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
    try {
      const result = await auth(provider, { serverUrl: server.url, fetchFn });
      if (result !== 'AUTHORIZED') {
        const received = await Promise.race([callback, new Promise<never>((_, reject) => {
          if (controller.signal.aborted) reject(new MCPError('MCP_AUTH_FAILED', id));
          else controller.signal.addEventListener('abort', () => reject(new MCPError('MCP_AUTH_FAILED', id)), { once: true });
        })]);
        if (await auth(provider, { serverUrl: server.url, authorizationCode: received.code, iss: received.iss, fetchFn }) !== 'AUTHORIZED') throw new MCPError('MCP_AUTH_FAILED', id);
      }
    } finally { clearTimeout(timer); process.off('SIGINT', stop); listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); }
  } else {
    const refs = new Set<string>();
    if (server.auth?.secretRef) refs.add(server.auth.secretRef);
    for (const value of [...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})]) if (typeof value !== 'string') refs.add(value.secretRef);
    if (!refs.size) throw new Error('This profile has no secret references. Configure authentication first.');
    for (const ref of refs) {
      if (ref.startsWith('env:')) { if (!await registry.auth.secret(ref)) throw new MCPError('MCP_AUTH_REQUIRED', id); continue; }
      const value = await promptSecret(`Value for ${ref} (hidden): `);
      if (!value) throw new MCPError('MCP_AUTH_FAILED', id);
      await registry.auth.secrets.putCredential(ref, value);
    }
  }
  await registry.event('MCP_AUTH_SUCCEEDED', id);
  await registry.readiness(id);
}

export async function executeMCPForAgent(engine: RookEngine, name: string, input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
  const safeInput = redactMCPArguments(input);
  const execution = ctx.executionId ? await engine.executions.get(ctx.executionId) : undefined;
  ctx.agentId ??= execution?.execution.agentId;
  ctx.requester ??= 'agent';
  const callId = generateId('call-');
  const result = await executeTool(engine.tools, name, input, {
    ...ctx, callId, verifyWorkspace: true,
    checkpoint: async () => { await engine.executions.recordToolStart(ctx.executionId!, name, safeInput, { callId, argumentsHash: hashToolArguments(input), sideEffectClass: engine.tools.get(name)?.descriptor.sideEffectClass }); },
  });
  if (result.metadata?.policy) await engine.executions.recordPolicy(ctx.executionId!, result.metadata.policy as any);
  await engine.executions.recordToolCall(ctx.executionId!, {
    id: callId, failureClass: result.failureClass, tool: name, input: safeInput, output: result.output, ok: result.ok, error: result.error,
    policyEffect: (result.metadata?.policy as any)?.decision ?? 'deny', policyRule: 'mcp-risk-policy', durationMs: result.durationMs, at: new Date(),
    provenance: result.metadata,
  });
  if (result.fileMutations) await engine.executions.recordFileMutations(ctx.executionId!, result.fileMutations);
  return result;
}

export async function importMCPConfig(registry: MCPRegistry, raw: any): Promise<void> {
  const servers = raw.mcpServers ?? raw.mcp?.servers ?? raw.servers ?? raw.mcp_servers;
  if (!servers || typeof servers !== 'object') throw new Error('Expected mcpServers, servers, mcp.servers, or mcp_servers.');
  const entries: Array<[string, any]> = Array.isArray(servers) ? servers.map(s => [s.id, s]) : Object.entries(servers);
  for (const [rawId, value] of entries) {
    const id = String(rawId ?? value?.id ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!id) throw new Error('Imported MCP server has no valid ID.');
    if (registry.list().some(s => s.definition.id === id)) throw new Error('Duplicate MCP server ID: ' + id);
    const server: MCPServerDefinition = {
      id, name: value.name ?? id, enabled: value.enabled ?? true, transport: value.transport ?? (value.command ? 'stdio' : 'http'),
      command: value.command, args: value.args, url: value.url, auth: value.auth ?? { type: 'none' },
      env: {}, headers: {}, timeout: value.timeout, reconnect: value.reconnect, policy: value.policy,
    };
    for (const section of ['env', 'headers'] as const) {
      for (const [key, v] of Object.entries(value[section] ?? value[section === 'headers' ? 'http_headers' : 'env'] ?? {})) {
        if (typeof v !== 'string') { server[section]![key] = v as any; continue; }
        const env = v.match(/^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
        if (env) { server[section]![key] = { secretRef: 'env:' + env[1] }; continue; }
        if (/\$\{/.test(v)) throw new Error('Unresolved input reference: configure a Secret Broker reference before importing.');
        // All imported values are secret-backed, regardless of their field name.
        const ref = `mcp.${id}.${section}.${key.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
        await registry.auth.secrets.putCredential(ref, v);
        server[section]![key] = { secretRef: ref };
      }
    }
    if (value.bearer_token_env_var) server.auth = { type: 'bearer', secretRef: 'env:' + value.bearer_token_env_var };
    await registry.register(server);
  }
}

interface MCPDaemonState { pid: number; nonce: string; state: string; tools: number; resources: number; prompts: number; error?: string; updatedAt: string }
function daemonFile(id: string): string { return `${configDir()}/mcp-${id}.daemon.json`; }
async function writeDaemonState(id: string, state: MCPDaemonState): Promise<void> {
  const file = daemonFile(id), temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, file);
}
async function readDaemonState(id: string): Promise<MCPDaemonState | undefined> {
  try {
    const state = JSON.parse(await fs.readFile(daemonFile(id), 'utf8')) as MCPDaemonState;
    if (Date.now() - Date.parse(state.updatedAt) > 10_000) throw new Error('stale daemon heartbeat');
    process.kill(state.pid, 0);
    return state;
  } catch { await fs.unlink(daemonFile(id)).catch(() => undefined); return undefined; }
}
async function stopDaemon(id: string, lockHeld = false): Promise<void> {
  const unlock = lockHeld ? undefined : await acquireDaemonLock(id);
  try {
    const state = await readDaemonState(id); if (!state) return;
    try { process.kill(state.pid, 'SIGTERM'); } catch { /* process exited */ }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!await readDaemonState(id)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    try { process.kill(state.pid, 'SIGKILL'); } catch { /* process exited */ }
    await fs.unlink(daemonFile(id)).catch(() => undefined);
  } finally { await unlock?.(); }
}
async function acquireDaemonLock(id: string): Promise<() => Promise<void>> {
  const file = `${daemonFile(id)}.lock`, nonce = randomBytes(16).toString('hex'), deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await fs.writeFile(file, JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600, flag: 'wx' });
      return async () => {
        try { const lock = JSON.parse(await fs.readFile(file, 'utf8')); if (lock.nonce === nonce) await fs.unlink(file); } catch { /* lock already cleared */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const lock = JSON.parse(await fs.readFile(file, 'utf8'));
        process.kill(lock.pid, 0);
      } catch {
        await fs.unlink(file).catch(() => undefined);
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error('Timed out waiting for another MCP connection operation.');
}
async function startDaemon(id: string): Promise<MCPDaemonState> {
  const unlock = await acquireDaemonLock(id);
  try {
    const existing = await readDaemonState(id); if (existing?.state === 'CONNECTED') return existing;
    await stopDaemon(id, true);
    const entry = process.argv[1]; if (!entry) throw new Error('Cannot locate the Wazir CLI entry point.');
    const child = spawn(process.execPath, [entry, 'mcp', 'serve', id], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    let spawnFailed = false; child.once('error', () => { spawnFailed = true; });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const state = await readDaemonState(id);
      if (state?.pid === child.pid && state.state === 'CONNECTED') return state;
      if (state?.pid === child.pid && state.state === 'FAILED') throw new Error(`MCP server connection failed (${state.error ?? 'MCP_CONNECTION_FAILED'}).`);
      let alive = false; try { if (child.pid) { process.kill(child.pid, 0); alive = true; } } catch { /* daemon exited */ }
      if (!alive || child.exitCode !== null || spawnFailed) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    try { if (child.pid) process.kill(child.pid, 'SIGTERM'); } catch { /* process exited */ }
    throw new Error('MCP server did not connect before the 15-second deadline. Run wa mcp doctor for details.');
  } finally { await unlock(); }
}

async function addMCP(registry: MCPRegistry): Promise<void> {
  console.log('ADD MCP SERVER');
  const id = await question('ID: '), name = await question('Name: ');
  const transport = await question('Transport [1] HTTP [2] STDIO: ') === '2' ? 'stdio' : 'http';
  const server: MCPServerDefinition = { id, name: name || id, enabled: true, transport };
  if (transport === 'http') {
    server.url = await question('Server URL: ');
    const method = await question('Authentication [1] None [2] OAuth [3] Bearer [4] Custom headers: ');
    if (method === '2') server.auth = { type: 'oauth', oauthConfig: { clientId: await question('Registered OAuth client ID (blank for dynamic registration): ') || undefined } };
    else if (method === '3') server.auth = { type: 'bearer', secretRef: await question('Bearer Secret Broker reference: ') };
    else if (method === '4') { const key = await question('Header name: '); server.headers = { [key]: { secretRef: await question('Secret Broker reference: '), prefix: await question('Prefix (e.g. Bearer; blank for none): ') } }; }
    else server.auth = { type: 'none' };
  } else {
    server.command = await question('Command: ');
    server.args = JSON.parse(await question('Arguments as JSON array (no secrets): ') || '[]');
    server.env = {};
    for (;;) {
      const key = await question('Environment variable name (blank to finish): '); if (!key) break;
      server.env[key] = { secretRef: await question('Secret Broker reference (or env:NAME): ') };
    }
    server.auth = { type: 'env' };
  }
  await registry.register(server);
}

async function configureMCP(registry: MCPRegistry, id: string, key: string, value: string): Promise<void> {
  const d = structuredClone(registry.get(id).definition);
  if (key === 'allow-write-tools') {
    if (id !== 'nvidia-runai' || !['true', 'false'].includes(value)) throw new Error('Expected nvidia-runai allow-write-tools true|false.');
    if (value === 'true') {
      registry.options.policy.registerMCPTool('mcp.nvidia-runai.__enable_writes', 'ADMIN', 'ask');
      const decision = await registry.options.policy.authorize({ tool: 'mcp.nvidia-runai.__enable_writes', input: {}, projectRoot: process.cwd() });
      if (decision.decision !== 'allow') throw new MCPError('MCP_POLICY_DENIED', id);
      await registry.event('MCP_WRITE_TOOLS_ENABLED', id, { decision: 'allow', approvalIdentity: 'interactive-user' });
    }
    if (d.transport === 'stdio') d.env = { ...d.env, RUNAI_ALLOW_WRITE_TOOLS: value }; d.metadata = { ...d.metadata, allowWriteTools: value };
  } else if (key === 'url') { d.url = value; d.transport = 'http'; delete d.command; delete d.args; delete d.env; }
  else if (key === 'auth') {
    if (!['none', 'bearer', 'oauth', 'env', 'headers'].includes(value)) throw new Error('Unknown authentication method.');
    d.auth = { type: value as any, ...(value === 'bearer' ? { secretRef: id === 'github' ? 'github_mcp_token' : `mcp.${id}.token` } : {}), ...(value === 'oauth' ? { oauthConfig: { clientId: id === 'nvidia-runai' ? 'runai-mcp' : undefined } } : {}) };
  } else if (key === 'oauth-client-id') d.auth = { type: 'oauth', oauthConfig: { ...d.auth?.oauthConfig, clientId: value } };
  else if (key === 'oauth-client-secret-ref') d.auth = { type: 'oauth', oauthConfig: { ...d.auth?.oauthConfig, clientSecretRef: value } };
  else if (key === 'mode' && value === 'local' && id === 'github') {
    d.transport = 'stdio'; delete d.url;
    d.command = 'docker'; d.args = ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'];
    d.env = { GITHUB_PERSONAL_ACCESS_TOKEN: { secretRef: 'github_mcp_token' } }; d.auth = { type: 'env' };
  } else if (key === 'mode' && value === 'local' && id === 'nvidia-runai') Object.assign(d, defaultMCPProfiles()[1]);
  else if (key.startsWith('policy.') && ['READ_ONLY', 'WRITE', 'DESTRUCTIVE', 'ADMIN', 'UNKNOWN'].includes(key.slice(7)) && ['allow', 'ask', 'deny'].includes(value)) d.policy = { ...d.policy, [key.slice(7)]: value };
  else throw new Error('Unsupported setting. Use url, auth, oauth-client-id, oauth-client-secret-ref, mode local, allow-write-tools, or policy.<RISK>.');
  await stopDaemon(id);
  await registry.update(d);
}

export function registerMCPCommands(program: Command): void {
  const command = program.command('mcp').description('Manage MCP servers, credentials and discovered capabilities');
  const run = (action: (r: MCPRegistry, ...args: any[]) => Promise<unknown>) => async (...args: any[]) => {
    const registry = new MCPRegistry({ directory: configDir(), tools: new ToolRegistry(), policy: new PolicyEngine({ projectRoot: process.cwd(), approveCallback: createApprover }), secrets: await createSecretBroker({ secretsDir: configDir() }), autoConnect: false });
    try { await registry.initialize(); const output = await action(registry, ...args); if (output !== undefined) console.log(typeof output === 'string' ? output : registry.auth.redact(JSON.stringify(output, null, 2))); }
    catch (e) { console.error(e instanceof MCPError ? e.code : 'MCP operation failed. Check configuration and run wa mcp doctor.'); process.exitCode = 1; }
    finally { await registry.close(); }
  };
  const status = async (r: MCPRegistry) => ['MCP SERVERS', 'SERVER          TRANSPORT AUTH       STATUS          TOOLS', ...await Promise.all(r.list().map(async s => {
    const daemon = await readDaemonState(s.definition.id);
    return `${s.definition.id.padEnd(15)} ${s.definition.transport.padEnd(9)} ${(s.definition.auth?.type ?? 'none').padEnd(10)} ${(daemon?.state ?? s.state).padEnd(15)} ${daemon?.tools ?? s.tools.length}`;
  }))].join('\n');
  command.command('list').action(run(status));
  command.command('status').action(run(status));
  command.command('add').action(run(addMCP));
  command.command('remove <id>').action(run(async (r, id) => { await stopDaemon(id); await r.remove(id); }));
  command.command('enable <id>').action(run((r, id) => r.enable(id, true)));
  command.command('disable <id>').action(run(async (r, id) => { await stopDaemon(id); await r.enable(id, false); }));
  command.command('connect <id>').action(run(async (r, id) => { const s = await startDaemon(id); return `${id}: ${s.state} (${s.tools} tools); persistent connection active.`; }));
  command.command('disconnect <id>').action(run(async (_r, id) => { await stopDaemon(id); return `${id}: DISCONNECTED`; }));
  command.command('inspect <id>').action(run(async (r, id) => { const s = r.get(id), daemon = await readDaemonState(id); return { ...s.definition, status: daemon?.state ?? s.state, tools: daemon?.tools ?? s.tools.length, resources: daemon?.resources ?? s.resources.length, prompts: daemon?.prompts ?? s.prompts.length }; }));
  command.command('serve <id>').action(run(async (r, id) => {
    const nonce = randomBytes(24).toString('hex');
    try { await r.connect(id); }
    catch (error) {
      const code = error instanceof MCPError ? error.code : 'MCP_CONNECTION_FAILED';
      await writeDaemonState(id, { pid: process.pid, nonce, state: 'FAILED', tools: 0, resources: 0, prompts: 0, error: code, updatedAt: new Date().toISOString() });
      throw error;
    }
    const publish = () => writeDaemonState(id, { pid: process.pid, nonce, state: r.get(id).state, tools: r.get(id).tools.length, resources: r.get(id).resources.length, prompts: r.get(id).prompts.length, updatedAt: new Date().toISOString() });
    await publish();
    const timer = setInterval(() => { void publish().catch(() => undefined); }, 1000);
    try { await new Promise<void>(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); }); }
    finally { clearInterval(timer); const state = await readDaemonState(id); if (state?.nonce === nonce) await fs.unlink(daemonFile(id)).catch(() => undefined); }
  }));
  for (const kind of ['tools', 'resources', 'prompts'] as const) command.command(kind + ' <id>').action(run(async (r, id) => { await r.connect(id); return r.get(id)[kind]; }));
  command.command('auth <id>')
    .option('--oauth', 'Use the server documented OAuth flow')
    .option('--pat', 'Use a Personal Access Token (GitHub)')
    .action(run(async (r, id, opts: { oauth?: boolean; pat?: boolean }) => {
      if (opts.oauth && opts.pat) throw new Error('Choose either --oauth or --pat.');
      await stopDaemon(id);
      if (id === 'github' && (opts.oauth || opts.pat)) {
        const d = structuredClone(r.get(id).definition);
        d.auth = opts.oauth ? { type: 'oauth', oauthConfig: { ...d.auth?.oauthConfig } } : { type: 'bearer', secretRef: 'github_mcp_token' };
        await r.update(d);
      } else if (opts.oauth || opts.pat) throw new Error('These auth options currently apply to GitHub.');
      await authenticateMCP(r, id);
      return 'Credentials stored via Secret Broker.';
    }));
  command.command('test <id>').action(run(async (r, id) => { await r.connect(id); return { server: id, status: r.get(id).state, capabilities: r.get(id).capabilities }; }));
  command.command('doctor').action(run(async r => r.list().map(s => ({ server: s.definition.id, state: s.state, next: s.state === 'AUTH_REQUIRED' ? `wa mcp auth ${s.definition.id}` : `wa mcp test ${s.definition.id}` }))));
  command.command('config <id> <key> <value>').action(run(configureMCP));
  command.command('import <file>').action(run(async (r, file) => { await importMCPConfig(r, JSON.parse(await fs.readFile(file, 'utf8'))); return 'Imported; secret literals migrated to Secret Broker.'; }));
  command.command('export').action(run(async r => ({ servers: r.list().map(s => s.definition) })));
  command.command('read <id> <uri>').action(run((r, id, uri) => r.readResource(id, uri, { projectRoot: process.cwd() })));
  command.command('prompt <id> <name> [arguments]').action(run((r, id, name, args) => r.getPrompt(id, name, JSON.parse(args ?? '{}'), { projectRoot: process.cwd() })));
}
