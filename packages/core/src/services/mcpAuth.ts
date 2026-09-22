import { randomBytes, createHash } from 'node:crypto';
import { sanitizeUntrustedOutput } from '@wazir/shared';
import type { OAuthClientProvider, OAuthClientMetadata, StoredOAuthTokens, StoredOAuthClientInformation, OAuthClientInformationContext } from '@modelcontextprotocol/client';
import { MCPError, type MCPServerDefinition, type MCPConfigValue } from '../types/mcp.js';

/** Structural interface to the existing secrets broker; never another store. */
export interface MCPSecrets {
  getCredential(key: string): Promise<string | undefined>;
  putCredential(key: string, value: string): Promise<void>;
  deleteCredential(key: string): Promise<boolean>;
}
export class MCPAuthProvider {
  private readonly known = new Set<string>();
  constructor(readonly secrets: MCPSecrets) {}
  async secret(ref: string): Promise<string | undefined> {
    if (!/^(env:)?[A-Za-z0-9_.-]{1,160}$/.test(ref)) throw new MCPError('MCP_AUTH_FAILED');
    const value = ref.startsWith('env:') ? process.env[ref.slice(4)] : await this.secrets.getCredential(ref);
    if (value) {
      this.known.add(value);
      try { const parsed = JSON.parse(value); for (const key of ['access_token', 'refresh_token', 'client_secret']) if (parsed[key]) this.known.add(parsed[key]); } catch { /* opaque secret */ }
    }
    return value;
  }
  async value(value: MCPConfigValue): Promise<string> {
    if (typeof value === 'string') return value;
    const secret = await this.secret(value.secretRef);
    if (!secret) throw new MCPError('MCP_AUTH_REQUIRED');
    return (value.prefix ?? '') + secret;
  }
  async resolve(server: MCPServerDefinition): Promise<{ headers: Record<string, string>; env: Record<string, string>; authProvider?: OAuthClientProvider }> {
    const headers: Record<string, string> = {}, env: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.headers ?? {})) headers[key] = await this.value(value);
    for (const [key, value] of Object.entries(server.env ?? {})) env[key] = await this.value(value);
    if (server.auth?.type === 'bearer') headers.Authorization = await this.value({ secretRef: server.auth.secretRef ?? '', prefix: 'Bearer ' });
    const authProvider = server.auth?.type === 'oauth' ? this.oauth(server) : undefined;
    if (authProvider && !await authProvider.tokens()) throw new MCPError('MCP_AUTH_REQUIRED', server.id);
    return { headers, env, authProvider };
  }
  redact(value: unknown): string {
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const secret of [...this.known].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
    return sanitizeUntrustedOutput(text);
  }
  oauth(server: MCPServerDefinition, redirect?: (url: URL) => void | Promise<void>): BrokerOAuthProvider {
    return new BrokerOAuthProvider(server, this, redirect);
  }
}

export class BrokerOAuthProvider implements OAuthClientProvider {
  private verifier?: string;
  private readonly nonce = randomBytes(24).toString('hex');
  private readonly prefix: string;
  constructor(private readonly server: MCPServerDefinition, private readonly auth: MCPAuthProvider, private readonly redirect?: (url: URL) => void | Promise<void>) {
    this.prefix = `mcp.${server.id}.${createHash('sha256').update(`${server.url}|${server.auth?.oauthConfig?.clientId ?? ''}`).digest('hex').slice(0, 24)}`;
  }
  get redirectUrl(): string { return this.server.auth?.oauthConfig?.redirectUrl ?? 'http://127.0.0.1:18973/callback'; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'Wazir', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: this.server.auth?.oauthConfig?.clientSecretRef ? 'client_secret_post' : 'none', scope: this.server.auth?.oauthConfig?.scope };
  }
  state(): string { return this.nonce; }
  async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    const cfg = this.server.auth?.oauthConfig;
    if (cfg?.clientId) return { client_id: cfg.clientId, client_secret: cfg.clientSecretRef ? await this.auth.secret(cfg.clientSecretRef) : undefined };
    const stored = await this.auth.secret(`${this.prefix}.client`);
    const info = stored ? JSON.parse(stored) : undefined;
    return ctx?.issuer && info?.issuer && info.issuer !== ctx.issuer ? undefined : info;
  }
  async saveClientInformation(info: StoredOAuthClientInformation): Promise<void> { await this.auth.secrets.putCredential(`${this.prefix}.client`, JSON.stringify(info)); }
  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    const stored = await this.auth.secret(`${this.prefix}.tokens`);
    const tokens = stored ? JSON.parse(stored) : undefined;
    return ctx?.issuer && tokens?.issuer && tokens.issuer !== ctx.issuer ? undefined : tokens;
  }
  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.auth.secrets.putCredential(`${this.prefix}.tokens`, JSON.stringify(tokens));
    await this.auth.secret(`${this.prefix}.tokens`);
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.redirect) throw new MCPError('MCP_AUTH_REQUIRED', this.server.id);
    await this.redirect(url);
  }
  saveCodeVerifier(value: string): void { this.verifier = value; }
  codeVerifier(): string { if (!this.verifier) throw new MCPError('MCP_AUTH_FAILED', this.server.id); return this.verifier; }
  saveDiscoveryState(state: any): Promise<void> { return this.auth.secrets.putCredential(`${this.prefix}.discovery`, JSON.stringify(state)); }
  async discoveryState(): Promise<any> { const s = await this.auth.secret(`${this.prefix}.discovery`); return s ? JSON.parse(s) : undefined; }
  async invalidateCredentials(scope: string): Promise<void> {
    if (scope === 'all' || scope === 'tokens') await this.auth.secrets.deleteCredential(`${this.prefix}.tokens`);
    if (scope === 'all' || scope === 'client') await this.auth.secrets.deleteCredential(`${this.prefix}.client`);
    if (scope === 'all' || scope === 'discovery') await this.auth.secrets.deleteCredential(`${this.prefix}.discovery`);
    this.verifier = undefined;
  }
}
