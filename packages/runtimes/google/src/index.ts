import type {
  AuthLoginResult,
  AuthMethod,
  AuthStatus,
  DiscoveredModel,
  GenerationEvent,
  GenerationRequest,
  HealthStatus,
  OAuthLoginOptions,
  ProviderAuthAdapter,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeInfo,
  StoredCredential,
} from '@wazir/runtimes-interfaces';
import { isStoredCredential } from '@wazir/runtimes-interfaces';
import type { SecretBroker } from '@wazir/secrets';
import { buildAuthorizationUrl, createLoopbackCallbackServer, exchangeCodeForToken, generatePkce, generateState, refreshAccessToken } from './oauth.js';

export { GOOGLE_OAUTH_SCOPES } from './oauth.js';

const API_BASE = 'https://generativelanguage.googleapis.com';
const SECRET_KEY = 'google';
const OAUTH_EXPIRY_SKEW_MS = 60_000; // treat a token as expired 60s early so a borderline-fresh token never fails mid-request

interface GeminiModelListing {
  name: string; // "models/gemini-1.5-pro"
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

export interface GoogleAdapterOptions {
  /** Google Cloud OAuth "Desktop app" client id. Required only for `loginWithOAuth`/`refresh` —
   *  API-key auth works without it. Google requires each application to register its own OAuth
   *  client (ai.google.dev/gemini-api/docs/oauth); Wazir does not ship a shared/public one. */
  clientId?: string;
  /** Desktop-app OAuth "client secret" — per Google's own guidance this is not confidential for
   *  installed apps, but it is still never written to plaintext config (env var or a reserved
   *  Secret Broker key only — see `wa auth configure google`). */
  clientSecret?: string;
}

function resolveModelId(name: string): string {
  return name.startsWith('models/') ? name.slice('models/'.length) : name;
}

/**
 * Google Gemini adapter: the only one of the three providers with a
 * genuinely documented third-party OAuth path (ai.google.dev/gemini-api/docs/oauth),
 * alongside the same API-key mechanism the other two providers use.
 */
export class GoogleAdapter implements RuntimeAdapter, ProviderAuthAdapter {
  readonly id = 'google';
  readonly type = 'google' as const;
  readonly provider = 'google' as const;
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly secrets: SecretBroker,
    private readonly options: GoogleAdapterOptions = {},
  ) {}

  get supportedMethods(): AuthMethod[] {
    // OAuth is only offered once a client id is actually configured — an
    // unconfigured client would otherwise advertise a login option that
    // fails immediately, which is exactly the "don't advertise an
    // unsupported method" rule this feature is built under, applied to a
    // *local configuration* gap rather than a provider-support gap.
    return this.options.clientId ? ['api-key', 'oauth-pkce'] : ['api-key'];
  }

  // ==================== ProviderAuthAdapter ====================

  async loginWithApiKey(apiKey: string): Promise<AuthLoginResult> {
    const probe = await this.probeApiKey(apiKey);
    if (!probe.ok) {
      return { ok: false, status: { provider: 'google', authenticated: false, eligible: false, reason: probe.reason }, error: probe.reason };
    }
    const stored: StoredCredential = {
      provider: 'google',
      method: 'api-key',
      credential: { kind: 'api-key', apiKey },
      obtainedAt: new Date().toISOString(),
    };
    await this.secrets.putCredential(SECRET_KEY, JSON.stringify(stored));
    return { ok: true, status: { provider: 'google', authenticated: true, method: 'api-key', eligible: true } };
  }

  async loginWithOAuth(options: OAuthLoginOptions): Promise<AuthLoginResult> {
    if (!this.options.clientId) {
      const reason = 'Google OAuth requires a client id — set providers.google.oauthClientId (config) or WAZIR_GOOGLE_OAUTH_CLIENT_ID (env). See `wa auth providers` for setup steps.';
      return { ok: false, status: { provider: 'google', authenticated: false, eligible: false, reason }, error: reason };
    }

    const state = generateState();
    const pkce = generatePkce();
    const server = options.createCallbackServer ? await options.createCallbackServer() : await createLoopbackCallbackServer();
    const redirectUri = `http://127.0.0.1:${server.port}/callback`;

    try {
      const url = buildAuthorizationUrl({ clientId: this.options.clientId, redirectUri, state, codeChallenge: pkce.challenge });
      options.onAuthorizationUrl(url);

      const { code } = await server.waitForCallback(state, options.timeoutMs ?? 120_000, options.signal);

      const token = await exchangeCodeForToken({
        clientId: this.options.clientId,
        clientSecret: this.options.clientSecret,
        code,
        codeVerifier: pkce.verifier,
        redirectUri,
      });

      const stored: StoredCredential = {
        provider: 'google',
        method: 'oauth-pkce',
        credential: { kind: 'oauth', accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: token.expiresAt, scope: token.scope },
        obtainedAt: new Date().toISOString(),
      };
      await this.secrets.putCredential(SECRET_KEY, JSON.stringify(stored));
      return { ok: true, status: { provider: 'google', authenticated: true, method: 'oauth-pkce', expiresAt: token.expiresAt, eligible: true } };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, status: { provider: 'google', authenticated: false, eligible: false, reason }, error: reason };
    } finally {
      await server.close();
    }
  }

  async refresh(): Promise<AuthLoginResult> {
    const stored = await this.readStoredCredential();
    if (!stored || stored.credential.kind !== 'oauth' || !stored.credential.refreshToken) {
      const reason = 'no refreshable OAuth credential stored — run `wa auth login google --oauth`';
      return { ok: false, status: { provider: 'google', authenticated: false, eligible: false, reason }, error: reason };
    }
    if (!this.options.clientId) {
      const reason = 'Google OAuth client id not configured — cannot refresh';
      return { ok: false, status: { provider: 'google', authenticated: false, eligible: false, reason }, error: reason };
    }
    try {
      const token = await refreshAccessToken({ clientId: this.options.clientId, clientSecret: this.options.clientSecret, refreshToken: stored.credential.refreshToken });
      const updated: StoredCredential = {
        provider: 'google',
        method: 'oauth-pkce',
        credential: { kind: 'oauth', accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: token.expiresAt, scope: token.scope },
        obtainedAt: new Date().toISOString(),
      };
      await this.secrets.putCredential(SECRET_KEY, JSON.stringify(updated));
      return { ok: true, status: { provider: 'google', authenticated: true, method: 'oauth-pkce', expiresAt: token.expiresAt, eligible: true } };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, status: { provider: 'google', authenticated: false, eligible: false, reason }, error: reason };
    }
  }

  async status(): Promise<AuthStatus> {
    const stored = await this.readStoredCredential();
    if (!stored) return { provider: 'google', authenticated: false, eligible: false, reason: 'not authenticated' };
    if (stored.credential.kind === 'oauth') {
      const expired = Date.parse(stored.credential.expiresAt) - OAUTH_EXPIRY_SKEW_MS <= Date.now();
      return {
        provider: 'google',
        authenticated: true,
        method: 'oauth-pkce',
        expiresAt: stored.credential.expiresAt,
        eligible: !expired,
        reason: expired ? 'OAuth token expired — run `wa auth login google --oauth` to refresh' : undefined,
      };
    }
    return { provider: 'google', authenticated: true, method: 'api-key', eligible: true };
  }

  async logout(): Promise<void> {
    await this.secrets.deleteCredential(SECRET_KEY);
  }

  async discoverModels(): Promise<DiscoveredModel[]> {
    const auth = await this.resolveRequestAuth();
    if (!auth) return [];
    return this.listModelsWithAuth(auth);
  }

  // ==================== RuntimeAdapter ====================

  async discover(): Promise<RuntimeInfo> {
    return { id: this.id, name: 'Google Gemini', version: 'v1beta', url: API_BASE };
  }

  async healthCheck(): Promise<HealthStatus> {
    const auth = await this.resolveRequestAuth();
    if (!auth) return { status: 'unavailable', message: 'not authenticated — run `wa auth login google`' };
    const probe = auth.kind === 'api-key' ? await this.probeApiKey(auth.apiKey) : await this.probeAccessToken(auth.accessToken);
    return probe.ok ? { status: 'healthy' } : { status: 'unavailable', message: probe.reason };
  }

  async listModels(): Promise<DiscoveredModel[]> {
    return this.discoverModels();
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      chat: true,
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: true,
      embeddings: true,
      reasoning: true,
      modelLoad: false,
      modelUnload: false,
      modelDownload: false,
      statefulChat: false,
      mcp: false,
    };
  }

  async *generate(request: GenerationRequest): AsyncIterable<GenerationEvent> {
    const auth = await this.resolveRequestAuth();
    if (!auth) {
      yield { type: 'error', error: 'not authenticated: run `wa auth login google`' };
      return;
    }

    const controller = new AbortController();
    const requestId = request.requestId ?? `google-${Date.now()}`;
    this.controllers.set(requestId, controller);

    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
    for (const message of request.messages) {
      if (message.role === 'system') continue;
      const role = message.role === 'assistant' ? 'model' : 'user';
      const content = message.role === 'tool' ? `[tool result: ${message.content}]` : message.content;
      contents.push({ role, parts: [{ text: content }] });
    }
    if (request.prompt) contents.push({ role: 'user', parts: [{ text: request.prompt }] });

    const url = new URL(`${API_BASE}/v1beta/models/${encodeURIComponent(request.modelId)}:streamGenerateContent`);
    url.searchParams.set('alt', 'sse');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth.kind === 'api-key') {
      url.searchParams.set('key', auth.apiKey);
    } else {
      headers.authorization = `Bearer ${auth.accessToken}`;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          contents,
          systemInstruction: request.systemPrompt ? { parts: [{ text: request.systemPrompt }] } : undefined,
          generationConfig: { temperature: request.temperature, topP: request.topP, maxOutputTokens: request.maxTokens },
          tools: request.tools?.length
            ? [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }]
            : undefined,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      this.controllers.delete(requestId);
      yield { type: 'error', error: controller.signal.aborted ? 'cancelled' : error instanceof Error ? error.message : String(error) };
      return;
    }

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      this.controllers.delete(requestId);
      yield { type: 'error', error: `Google API error: HTTP ${response.status} ${body.slice(0, 300)}` };
      return;
    }

    let full = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const toolCalls: Array<{ name: string; args: unknown }> = [];
    let pending = '';

    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += new TextDecoder().decode(value, { stream: true });
        let index = pending.indexOf('\n');
        while (index !== -1) {
          const line = pending.slice(0, index).trim();
          pending = pending.slice(index + 1);
          index = pending.indexOf('\n');
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;

          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }

          const candidate = chunk.candidates?.[0];
          for (const part of candidate?.content?.parts ?? []) {
            if (typeof part.text === 'string' && part.text) {
              full += part.text;
              yield { type: 'token', content: part.text };
            } else if (part.functionCall) {
              toolCalls.push({ name: part.functionCall.name, args: part.functionCall.args });
            }
          }
          if (chunk.usageMetadata) {
            inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
            outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
          }
        }
      }

      for (const [index, call] of toolCalls.entries()) {
        yield { type: 'tool_call', toolCallId: `tool-${index}`, toolName: call.name, toolInput: call.args };
      }

      yield { type: 'completed', content: full, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };
    } catch (error) {
      if (controller.signal.aborted) {
        yield { type: 'completed', content: full, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };
      } else {
        yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      this.controllers.delete(requestId);
    }
  }

  async cancel(requestId: string): Promise<void> {
    this.controllers.get(requestId)?.abort();
  }

  // ==================== internal ====================

  private async readStoredCredential(): Promise<StoredCredential | undefined> {
    const raw = await this.secrets.getCredential(SECRET_KEY);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      return isStoredCredential(parsed) && parsed.provider === 'google' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** Resolves the credential to use for a live request. For an OAuth
   *  credential nearing/past expiry, attempts a silent refresh first —
   *  callers (generate/healthCheck/discoverModels) never see a stale token. */
  private async resolveRequestAuth(): Promise<{ kind: 'api-key'; apiKey: string } | { kind: 'oauth'; accessToken: string } | undefined> {
    const stored = await this.readStoredCredential();
    if (!stored) return undefined;
    if (stored.credential.kind === 'api-key') return { kind: 'api-key', apiKey: stored.credential.apiKey };

    const expired = Date.parse(stored.credential.expiresAt) - OAUTH_EXPIRY_SKEW_MS <= Date.now();
    if (!expired) return { kind: 'oauth', accessToken: stored.credential.accessToken };

    const refreshed = await this.refresh();
    if (!refreshed.ok) return undefined;
    const after = await this.readStoredCredential();
    return after && after.credential.kind === 'oauth' ? { kind: 'oauth', accessToken: after.credential.accessToken } : undefined;
  }

  private async probeApiKey(apiKey: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      const response = await fetch(`${API_BASE}/v1beta/models?key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(5000) });
      if (response.status === 400 || response.status === 401 || response.status === 403) return { ok: false, reason: 'invalid API key' };
      if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'unreachable' };
    }
  }

  private async probeAccessToken(accessToken: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      const response = await fetch(`${API_BASE}/v1beta/models`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(5000) });
      if (response.status === 401 || response.status === 403) return { ok: false, reason: 'access token invalid or expired' };
      if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'unreachable' };
    }
  }

  private async listModelsWithAuth(auth: { kind: 'api-key'; apiKey: string } | { kind: 'oauth'; accessToken: string }): Promise<DiscoveredModel[]> {
    try {
      const url = auth.kind === 'api-key' ? `${API_BASE}/v1beta/models?key=${encodeURIComponent(auth.apiKey)}` : `${API_BASE}/v1beta/models`;
      const response = await fetch(url, {
        headers: auth.kind === 'oauth' ? { authorization: `Bearer ${auth.accessToken}` } : undefined,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as { models?: GeminiModelListing[] };
      return (data.models ?? [])
        .filter((model) => (model.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((model) => ({
          id: resolveModelId(model.name),
          name: model.displayName ?? resolveModelId(model.name),
          capabilities: ['generalChat', 'coding'],
          contextWindow: model.inputTokenLimit,
          toolCalling: true,
          structuredOutput: true,
          vision: /vision|1\.5|2\.0|2\.5/.test(model.name),
          audio: false,
          embedding: false,
          reasoning: /thinking|2\.0-flash-thinking|2\.5/.test(model.name),
        }));
    } catch {
      return [];
    }
  }
}

export function createGoogleAdapter(secrets: SecretBroker, options?: GoogleAdapterOptions): GoogleAdapter {
  return new GoogleAdapter(secrets, options);
}
