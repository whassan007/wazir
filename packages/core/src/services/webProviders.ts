import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { WebError, type FetchProvider, type FetchResponse, type ProviderContext, type SearchProvider, type WebFetchRequest, type WebProviderMetadata, type WebSearchRequest } from '../types/web.js';
import type { SecretBroker } from './secretBroker.js';
import type { MCPRegistry } from './mcpRegistry.js';
import { mcpToolName } from './mcpRegistry.js';

export function normalizeWebError(error: unknown, fallback: 'WEB_SEARCH_FAILED' | 'WEB_FETCH_FAILED' = 'WEB_FETCH_FAILED'): WebError {
  if (error instanceof WebError) return error;
  const e = error as { code?: string; name?: string };
  if (e?.code === 'MCP_POLICY_DENIED') return new WebError('WEB_POLICY_DENIED');
  if (e?.code === 'MCP_AUTH_REQUIRED' || e?.code === 'MCP_AUTH_FAILED') return new WebError('WEB_AUTH_REQUIRED');
  if (e?.code === 'MCP_TOOL_TIMEOUT') return new WebError('WEB_TIMEOUT');
  if (e?.code === 'MCP_SERVER_UNAVAILABLE') return new WebError('WEB_PROVIDER_UNAVAILABLE');
  if (e?.code === 'MCP_CANCELLED') return new WebError('WEB_CANCELLED');
  if (e?.name === 'TimeoutError' || e?.code === 'ETIMEDOUT') return new WebError('WEB_TIMEOUT');
  if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') return new WebError('WEB_CANCELLED');
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(e?.code ?? '')) return new WebError('WEB_DNS_FAILED');
  if (/CERT|TLS|SSL/.test(e?.code ?? '')) return new WebError('WEB_TLS_FAILED');
  if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(e?.code ?? '')) return new WebError('WEB_CONNECTION_FAILED');
  return new WebError(fallback);
}

/** DNS is resolved once, validated, then pinned to the actual socket lookup.
 * Node's HTTP transport is used directly to avoid implicit redirects, proxies and decompression. */
export async function secureWebRequest(value: string, ctx: ProviderContext, headers: Record<string, string> = {}, allowRedirects = true): Promise<FetchResponse> {
  let next = value;
  let bytesDownloaded = 0;
  for (let redirect = 0; ; redirect++) {
    ctx.signal.throwIfAborted();
    const { url, addresses } = await ctx.validateUrl(next);
    await ctx.onRequest?.(url.href);
    const pinned = addresses[0];
    const response = await new Promise<{ status: number; location?: string; type: string; body: string }>((resolve, reject) => {
      const lookup: LookupFunction = (_host, options, callback) => {
        if ((options as { all?: boolean }).all) (callback as Function)(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      };
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'GET', agent: false, lookup, signal: ctx.signal,
        headers: { 'User-Agent': 'Wazir-WebGrounding/1.0', Accept: 'text/html,text/plain,text/markdown,application/json;q=0.9', 'Accept-Encoding': 'identity', ...headers },
      }, res => {
        clearTimeout(connectTimer);
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.destroy(); resolve({ status, location: res.headers.location, type: '', body: '' }); return;
        }
        if (status < 200 || status >= 300) {
          res.destroy(); reject(new WebError(status === 429 ? 'WEB_RATE_LIMITED' : status === 401 || status === 403 ? 'WEB_AUTH_REQUIRED' : 'WEB_HTTP_ERROR', status)); return;
        }
        if (Number(res.headers['content-length']) > ctx.limits.maxFetchBytes - bytesDownloaded) { res.destroy(); reject(new WebError('WEB_RESPONSE_TOO_LARGE')); return; }
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.destroy(); reject(new WebError('WEB_UNSUPPORTED_CONTENT_TYPE')); return; }
        const chunks: Buffer[] = [];
        res.setTimeout(ctx.limits.readTimeoutMs, () => request.destroy(new WebError('WEB_TIMEOUT')));
        res.on('data', (chunk: Buffer) => {
          bytesDownloaded += chunk.length;
          ctx.addBytes?.(chunk.length);
          if (bytesDownloaded > ctx.limits.maxFetchBytes) {
            const error = new WebError('WEB_RESPONSE_TOO_LARGE'); reject(error); request.destroy(error); res.destroy(); return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve({ status, type: res.headers['content-type'] ?? '', body: Buffer.concat(chunks).toString('utf8') }));
      });
      const connectTimer = setTimeout(() => request.destroy(new WebError('WEB_TIMEOUT')), ctx.limits.connectTimeoutMs);
      request.once('socket', socket => socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer)));
      request.once('close', () => clearTimeout(connectTimer));
      request.once('error', reject);
      request.end();
    }).catch(e => { throw ctx.signal.aborted ? new WebError(ctx.signal.reason?.name === 'TimeoutError' ? 'WEB_TIMEOUT' : 'WEB_CANCELLED') : normalizeWebError(e); });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!allowRedirects || redirect >= ctx.limits.maxRedirects) throw new WebError('WEB_REDIRECT_LIMIT');
      if (!response.location) throw new WebError('WEB_HTTP_ERROR', response.status);
      try { next = new URL(response.location, url).href; } catch { throw new WebError('WEB_URL_BLOCKED'); }
      continue;
    }
    return { url: value, finalUrl: url.href, contentType: response.type, body: response.body, bytesDownloaded };
  }
}
export class HttpFetchProvider implements FetchProvider {
  metadata: WebProviderMetadata = { id: 'http', type: 'native', capabilities: ['fetch'], authentication: 'none', available: true, priority: 0, health: 'unknown' };
  fetch(request: WebFetchRequest, ctx: ProviderContext) { return secureWebRequest(request.url, ctx); }
}
export class JsonSearchProvider implements SearchProvider {
  readonly metadata: WebProviderMetadata;
  constructor(private readonly config: { id?: string; endpoint: string; secretRef?: string }, private readonly secrets: Pick<SecretBroker, 'get'>) {
    this.metadata = { id: config.id ?? 'json-search', type: 'native', capabilities: ['search'], authentication: config.secretRef ? 'secret' : 'none', available: true, priority: 0, health: 'unknown' };
  }
  async search(request: WebSearchRequest, ctx: ProviderContext): Promise<unknown> {
    const url = new URL(this.config.endpoint);
    for (const [key, value] of Object.entries(request)) if (value !== undefined && value !== null) url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    const headers: Record<string, string> = {};
    if (this.config.secretRef) {
      if (url.protocol !== 'https:') throw new WebError('WEB_POLICY_DENIED');
      const secret = await this.secrets.get(this.config.secretRef);
      if (!secret) throw new WebError('WEB_AUTH_REQUIRED');
      headers.Authorization = `Bearer ${secret}`;
    }
    // Authenticated search endpoints cannot redirect credentials to another origin.
    const response = await secureWebRequest(url.href, ctx, headers, false);
    if (!/^application\/(?:[\w.+-]*\+)?json(?:;|$)/i.test(response.contentType)) throw new WebError('WEB_UNSUPPORTED_CONTENT_TYPE');
    try { return JSON.parse(response.body); } catch { throw new WebError('WEB_SEARCH_FAILED'); }
  }
}

/** Explicit host configuration maps a server's tools to canonical requests.
 * Uses MCPToolAdapter, including its schema validation, authorization, auth and lifecycle. */
export class MCPWebProvider implements SearchProvider, FetchProvider {
  readonly metadata: WebProviderMetadata;
  constructor(private readonly registry: MCPRegistry, private readonly config: { id: string; serverId: string; searchTool?: string; fetchTool?: string; priority?: number }) {
    this.metadata = { id: config.id, serverId: config.serverId, type: 'mcp', capabilities: [...(config.searchTool ? ['search' as const] : []), ...(config.fetchTool ? ['fetch' as const] : [])], authentication: 'mcp', available: true, priority: config.priority ?? 10, health: 'unknown' };
  }
  private async call(operation: 'search' | 'fetch', input: Record<string, unknown>, ctx: ProviderContext): Promise<any> {
    const remote = operation === 'search' ? this.config.searchTool : this.config.fetchTool;
    if (!remote) throw new WebError('WEB_PROVIDER_UNAVAILABLE');
    await this.registry.recover(this.config.serverId, { ...ctx.execution, signal: ctx.signal });
    const adapter = this.registry.options.tools.get(mcpToolName(this.config.serverId, remote));
    if (!adapter) throw new WebError('WEB_PROVIDER_UNAVAILABLE');
    const result = await adapter.execute(input, { ...ctx.execution, signal: ctx.signal });
    if (!result.ok) {
      throw new WebError(result.error === 'MCP_POLICY_DENIED' ? 'WEB_POLICY_DENIED' : result.error === 'MCP_AUTH_REQUIRED' ? 'WEB_AUTH_REQUIRED' : result.error === 'MCP_TOOL_TIMEOUT' ? 'WEB_TIMEOUT' : operation === 'search' ? 'WEB_SEARCH_FAILED' : 'WEB_FETCH_FAILED');
    }
    if (Buffer.byteLength(result.output) > ctx.limits.maxFetchBytes) throw new WebError('WEB_RESPONSE_TOO_LARGE');
    if (result.structuredOutput !== undefined) return result.structuredOutput;
    try {
      const envelope = JSON.parse(result.output).content;
      if (envelope.structuredContent) return envelope.structuredContent;
      const texts = envelope.content?.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n');
      return JSON.parse(texts);
    } catch { throw new WebError(operation === 'search' ? 'WEB_SEARCH_FAILED' : 'WEB_FETCH_FAILED'); }
  }
  search(request: WebSearchRequest, ctx: ProviderContext): Promise<unknown> { return this.call('search', { ...request }, ctx); }
  async fetch(request: WebFetchRequest, ctx: ProviderContext): Promise<FetchResponse> {
    await ctx.validateUrl(request.url);
    const result = await this.call('fetch', { ...request }, ctx);
    if (typeof result?.content !== 'string' || typeof result?.finalUrl !== 'string') throw new WebError('WEB_FETCH_FAILED');
    await ctx.validateUrl(result.finalUrl);
    return { url: request.url, finalUrl: result.finalUrl, contentType: result.contentType ?? 'text/markdown', body: result.content, bytesDownloaded: Buffer.byteLength(result.content) };
  }
}
export class WebProviderRegistry {
  private readonly providers = new Map<string, SearchProvider | FetchProvider>();
  register(provider: SearchProvider | FetchProvider): void {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(provider.metadata.id) || this.providers.has(provider.metadata.id)) throw new Error('Invalid or duplicate web provider');
    this.providers.set(provider.metadata.id, provider);
  }
  list(): WebProviderMetadata[] { return [...this.providers.values()].map(p => structuredClone(p.metadata)); }
  select(operation: 'search' | 'fetch', allowed?: string[]): SearchProvider | FetchProvider {
    const provider = [...this.providers.values()].filter(p => p.metadata.available && p.metadata.capabilities.includes(operation) && (!allowed || allowed.includes(p.metadata.id)))
      .sort((a, b) => b.metadata.priority - a.metadata.priority || a.metadata.id.localeCompare(b.metadata.id))[0];
    if (!provider) throw new WebError('WEB_PROVIDER_UNAVAILABLE');
    return provider;
  }
}
