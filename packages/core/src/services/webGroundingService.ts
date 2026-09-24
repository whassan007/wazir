import { randomUUID } from 'node:crypto';
import { retryConnect, type KeyValueStore } from '@wazir/shared';
import type { ToolExecutionContext } from '../types/tool.js';
import { WebError, type GroundedResult, type GroundedDocument, type GroundedSearch, type WebLimits, type WebFetchRequest, type WebSearchRequest, type FetchProvider, type SearchProvider, type ProviderContext, type ContentExtractor, type ContentSanitizer } from '../types/web.js';
import { PolicyEngine } from './policyEngine.js';
import { WebProviderRegistry, normalizeWebError } from './webProviders.js';
import { checkWebDestination, domainMatches, parseWebUrl, validateWebUrl, type WebResolver } from './webSecurity.js';
import { CitationManager, HtmlContentExtractor, WebContentSanitizer, webHash } from './webContent.js';
import { compileToolSchema } from './toolValidation.js';

export const WEB_DEFAULT_LIMITS: Readonly<WebLimits> = Object.freeze({
  maxSearchResults: 5, maxFetchBytes: 2_000_000, maxExtractedCharacters: 30_000, maxGroundingTokens: 8000,
  maxRedirects: 5, requestTimeoutMs: 15_000, connectTimeoutMs: 5000, readTimeoutMs: 5000,
  totalWebBudgetMs: 60_000, maxRequests: 30, concurrency: 3, cacheEntries: 64, cacheTtlMs: 60_000, maxRetries: 2,
});
const domains = { type: 'array', maxItems: 30, uniqueItems: true, items: { type: 'string', maxLength: 253, pattern: '^[A-Za-z0-9][A-Za-z0-9.-]*$' } };
export const WEB_SEARCH_SCHEMA = { type: 'object', additionalProperties: false, required: ['query'], properties: {
  query: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' }, maxResults: { type: 'integer', minimum: 1, maximum: 50 },
  domains, excludeDomains: domains, recencyDays: { anyOf: [{ type: 'integer', minimum: 1, maximum: 36500 }, { type: 'null' }] },
} };
export const WEB_FETCH_SCHEMA = { type: 'object', additionalProperties: false, required: ['url'], properties: {
  url: { type: 'string', format: 'uri', pattern: '^https?://[^/?#\\s]+', maxLength: 4096 }, maxChars: { type: 'integer', minimum: 1, maximum: 1_000_000 },
} };
const searchSchema = compileToolSchema(WEB_SEARCH_SCHEMA), fetchSchema = compileToolSchema(WEB_FETCH_SCHEMA);
export interface WebEvent { event: string; operationId: string; executionId?: string; jobId?: string; agentId?: string; at: string; [key: string]: unknown }
export interface WebGroundingOptions {
  budgetStore?: Pick<KeyValueStore, 'update'>;
  policy: PolicyEngine; providers: WebProviderRegistry; limits?: Partial<WebLimits>; resolver?: WebResolver;
  extractor?: ContentExtractor; sanitizer?: ContentSanitizer; now?: () => number;
  /** Awaited durable event sink. Failure prevents evidence publication. */
  emit: (event: WebEvent) => Promise<void>;
  /** Retain sanitized evidence through the existing execution store; never raw HTML/credentials. */
  retain?: (result: GroundedResult, context: ToolExecutionContext) => Promise<void>;
}
interface PersistedWebBudget { requests: number; chargedMs: number; reservations: Record<string, { ms: number; expires: number }> }
export class WebGroundingService {
  readonly limits: Readonly<WebLimits>;
  private readonly cache = new Map<string, { expires: number; result: GroundedResult }>();
  private readonly budgets = new Map<string, { requests: number; elapsed: number; active: number; reservedMs: number }>();
  private active = 0;
  private readonly citations = new CitationManager();
  private readonly extractor: ContentExtractor;
  private readonly sanitizer: ContentSanitizer;
  private readonly now: () => number;
  constructor(readonly options: WebGroundingOptions) {
    if (options.budgetStore && !options.budgetStore.update) throw new Error('Web budget persistence requires atomic store updates');
    const limits = { ...WEB_DEFAULT_LIMITS, ...options.limits };
    for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < (['cacheEntries', 'cacheTtlMs', 'maxRetries', 'maxRedirects'].includes(key) ? 0 : 1)) throw new Error(`Invalid web limit: ${key}`);
    if (limits.maxRetries > 5 || limits.maxFetchBytes > 20_000_000 || limits.maxExtractedCharacters > 1_000_000 || limits.maxGroundingTokens > 250_000 || limits.requestTimeoutMs > 300_000 || limits.cacheEntries > 1000) throw new Error('Web limits exceed safety ceiling');
    this.limits = Object.freeze(limits); this.now = options.now ?? Date.now;
    this.extractor = options.extractor ?? new HtmlContentExtractor(); this.sanitizer = options.sanitizer ?? new WebContentSanitizer();
  }
  search(request: WebSearchRequest, ctx: ToolExecutionContext): Promise<GroundedSearch> { return this.run('search', request, ctx) as Promise<GroundedSearch>; }
  fetch(request: WebFetchRequest, ctx: ToolExecutionContext): Promise<GroundedDocument> { return this.run('fetch', request, ctx) as Promise<GroundedDocument>; }
  /** Release controller-owned budget state only after a job/execution is terminal. */
  releaseBudget(id: string): void { if (!this.budgets.get(id)?.active) this.budgets.delete(id); }
  private async run(operation: 'search' | 'fetch', raw: WebSearchRequest | WebFetchRequest, ctx: ToolExecutionContext): Promise<GroundedResult> {
    const started = this.now(), operationId = randomUUID();
    const base = { operationId, executionId: ctx.executionId, jobId: ctx.jobId, agentId: ctx.agentId };
    const emit = (event: string, fields: Record<string, unknown> = {}) => this.options.emit({ ...base, event, at: new Date(this.now()).toISOString(), ...fields });
    let provider: SearchProvider | FetchProvider | undefined;
    let budget: { requests: number; elapsed: number; active: number; reservedMs: number } | undefined;
    let reserved = 0, admitted = false, timer: ReturnType<typeof setTimeout> | undefined;
    let networkCallsThisAttempt = 0, networkRequests = 0, bytesDownloaded = 0;
    let durableReservation = false, providerAttempts = 0;
    const durableKey = ctx.jobId || ctx.executionId ? `web:budget:${webHash(ctx.jobId ?? ctx.executionId!)}` : undefined;
    const consumeDurableRequest = async () => {
      if (!durableKey || !this.options.budgetStore) return;
      await this.options.budgetStore.update!<PersistedWebBudget>(durableKey, current => {
        if (!current || current.requests >= this.limits.maxRequests) throw new WebError('WEB_BUDGET_EXCEEDED');
        return { ...current, requests: current.requests + 1 };
      });
    };
    try {
      await emit(`web.${operation}.started`, { requestHash: webHash(JSON.stringify(raw)), ...(operation === 'search' ? { queryHash: webHash(String((raw as WebSearchRequest).query)) } : {}) });
      const decision = await this.options.policy.authorize({ tool: `web_${operation}`, input: {}, executionId: ctx.executionId, projectRoot: ctx.projectRoot });
      if (decision.decision !== 'allow' || ctx.networkAllowed === false) throw new WebError('WEB_POLICY_DENIED');
      if (!(operation === 'search' ? searchSchema(raw) : fetchSchema(raw))) throw new WebError(operation === 'search' ? 'WEB_SEARCH_FAILED' : 'WEB_URL_BLOCKED');
      if (operation === 'fetch' && this.sanitizer.sanitize((raw as WebFetchRequest).url) !== (raw as WebFetchRequest).url) throw new WebError('WEB_URL_BLOCKED');
      ctx.signal?.throwIfAborted();
      const policy = this.options.policy.webPolicy();
      const request = operation === 'search' ? {
        query: (raw as WebSearchRequest).query.trim().replace(/\s+/g, ' '),
        maxResults: Math.min((raw as WebSearchRequest).maxResults ?? this.limits.maxSearchResults, this.limits.maxSearchResults),
        domains: (raw as WebSearchRequest).domains?.map(d => d.toLowerCase()).sort(),
        excludeDomains: (raw as WebSearchRequest).excludeDomains?.map(d => d.toLowerCase()).sort(), recencyDays: (raw as WebSearchRequest).recencyDays,
      } : { url: parseWebUrl((raw as WebFetchRequest).url).href, maxChars: Math.min((raw as WebFetchRequest).maxChars ?? this.limits.maxExtractedCharacters, this.limits.maxExtractedCharacters, this.limits.maxGroundingTokens * 4) };
      if ('url' in request) checkWebDestination(parseWebUrl(request.url!), policy);
      provider = this.options.providers.select(operation, policy.allowedProviders);
      const metadata = provider.metadata;
      if (metadata.authentication !== 'none' && policy.authenticationAllowed === false) throw new WebError('WEB_POLICY_DENIED');
      if (operation === 'fetch' && metadata.type === 'mcp' && !policy.trustedMcpFetchServers?.includes(metadata.serverId!)) throw new WebError('WEB_POLICY_DENIED');
      // Fail closed instead of evicting budgets and allowing an old execution to reset its limits.
      const budgetId = ctx.jobId ?? ctx.executionId ?? 'diagnostic';
      budget = this.budgets.get(budgetId);
      if (!budget) {
        if (this.budgets.size >= 10_000) throw new WebError('WEB_BUDGET_EXCEEDED');
        budget = { requests: 0, elapsed: 0, active: 0, reservedMs: 0 }; this.budgets.set(budgetId, budget);
      }
      if (this.active >= this.limits.concurrency || budget.requests >= this.limits.maxRequests || budget.elapsed + budget.reservedMs >= this.limits.totalWebBudgetMs) throw new WebError('WEB_BUDGET_EXCEEDED');
      reserved = Math.min(this.limits.requestTimeoutMs, this.limits.totalWebBudgetMs - budget.elapsed - budget.reservedMs);
      if (durableKey && this.options.budgetStore) {
        const state = await this.options.budgetStore.update!<PersistedWebBudget>(durableKey, current => {
          const state = current ?? { requests: 0, chargedMs: 0, reservations: {} };
          const reservations = Object.fromEntries(Object.entries(state.reservations).filter(([, r]) => r.expires > this.now()));
          if (state.requests >= this.limits.maxRequests || state.chargedMs >= this.limits.totalWebBudgetMs || Object.keys(reservations).length >= this.limits.concurrency) throw new WebError('WEB_BUDGET_EXCEEDED');
          const ms = Math.min(reserved, this.limits.totalWebBudgetMs - state.chargedMs);
          return { requests: state.requests + 1, chargedMs: state.chargedMs + ms, reservations: { ...reservations, [operationId]: { ms, expires: this.now() + ms } } };
        });
        reserved = state.reservations[operationId].ms; durableReservation = true;
      }
      if (this.active >= this.limits.concurrency) throw new WebError('WEB_BUDGET_EXCEEDED');
      budget.active++; budget.reservedMs += reserved; this.active++; admitted = true;
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(new DOMException('web timeout', 'TimeoutError')), reserved);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
      const providerContext: ProviderContext = { signal, limits: this.limits, execution: ctx,
        onRequest: async url => {
          if (networkCallsThisAttempt++ > 0) {
            if (budget!.requests >= this.limits.maxRequests) throw new WebError('WEB_BUDGET_EXCEEDED');
            budget!.requests++;
            await consumeDurableRequest();
          }
          networkRequests++;
          await emit('web.request', { provider: metadata.id, url, requestNumber: networkRequests });
        },
        addBytes: count => { bytesDownloaded += count; },
        validateUrl: async url => {
          signal.throwIfAborted();
          if (this.sanitizer.sanitize(url) !== url) throw new WebError('WEB_URL_BLOCKED');
          const validated = await validateWebUrl(url, policy, this.options.resolver);
          signal.throwIfAborted(); return validated;
        } };
      const key = webHash(JSON.stringify([operation, metadata.id, request, policy]));
      const cached = this.cache.get(key);
      let result: GroundedResult;
      if (cached && cached.expires > this.now()) {
        // Revalidate source destinations before reusing a cached fetch after policy/DNS changes.
        if (cached.result.kind === 'web_document') {
          await this.deadline(providerContext.validateUrl(cached.result.url), signal);
          await this.deadline(providerContext.validateUrl(cached.result.finalUrl), signal);
        }
        result = { ...structuredClone(cached.result), origin: 'CACHE' };
        budget.requests++;
      } else {
        this.cache.delete(key);
        const rawResult = await retryConnect(async () => {
          if (budget!.requests >= this.limits.maxRequests) throw new WebError('WEB_BUDGET_EXCEEDED');
          budget!.requests++;
          if (providerAttempts++ > 0) await consumeDurableRequest();
          networkCallsThisAttempt = 0;
          try {
            if (operation === 'fetch') await this.deadline(providerContext.validateUrl((request as WebFetchRequest).url), signal);
            return await this.deadline(operation === 'search' ? (provider as SearchProvider).search(request as WebSearchRequest, providerContext) : (provider as FetchProvider).fetch(request as WebFetchRequest, providerContext), signal);
          } catch (e) { throw normalizeWebError(e, operation === 'search' ? 'WEB_SEARCH_FAILED' : 'WEB_FETCH_FAILED'); }
        }, { signal, policy: { maxRetries: this.limits.maxRetries }, onRetry: async (attempt, delayMs, error, decision) => {
          await emit(`web.${operation}.retry`, { provider: metadata.id, attempt, delayMs, status: (error as WebError).code, reason: decision.reason });
        } });
        const retrievedAt = new Date(this.now()).toISOString();
        if (operation === 'search') result = this.normalizeSearch(rawResult, request as WebSearchRequest, metadata.id, retrievedAt);
        else {
          const response = rawResult as import('../types/web.js').FetchResponse;
          if (typeof response?.body !== 'string' || !Number.isSafeInteger(response.bytesDownloaded) || response.bytesDownloaded < 0) throw new WebError('WEB_FETCH_FAILED');
          if (Buffer.byteLength(response.body) > this.limits.maxFetchBytes || response.bytesDownloaded > this.limits.maxFetchBytes) throw new WebError('WEB_RESPONSE_TOO_LARGE');
          await this.deadline(providerContext.validateUrl(response.finalUrl), signal);
          const extracted = this.extractor.extract(response);
          const title = this.sanitizer.sanitize(extracted.title).slice(0, 300);
          const clean = this.sanitizer.sanitize(extracted.content);
          const content = clean.slice(0, (request as WebFetchRequest).maxChars!);
          const url = (request as WebFetchRequest).url, finalUrl = parseWebUrl(response.finalUrl).href;
          const citation = this.citations.createCitation({ url, finalUrl, title, source: metadata.id, retrievedAt, publishedAt: null, contentHash: webHash(content), evidenceKind: 'document' });
          result = { kind: 'web_document', trust: 'UNTRUSTED_EXTERNAL_CONTENT', url, finalUrl, title, contentType: response.contentType.split(';')[0],
            content, retrievedAt, truncated: content.length < clean.length, citation, provider: metadata.id, origin: 'LIVE', bytesDownloaded: response.bytesDownloaded,
            charactersExtracted: clean.length, tokensEstimated: Math.ceil(content.length / 4) };
          await emit('web.extract.completed', { provider: metadata.id, url, bytesDownloaded: response.bytesDownloaded, charactersExtracted: clean.length });
          if (result.truncated) await emit('web.content.truncated', { provider: metadata.id, charactersExtracted: clean.length, charactersKept: content.length });
        }
        signal.throwIfAborted();
        if (this.now() - started >= reserved) throw new WebError('WEB_TIMEOUT');
      }
      await this.options.retain?.(result, ctx);
      metadata.health = 'healthy';
      await emit(`web.${operation}.completed`, { provider: metadata.id, duration: this.now() - started, status: 'success', cacheHit: result.origin === 'CACHE',
        networkRequests, bytesDownloaded,
        origin: result.origin, retrievedAt: result.retrievedAt, resultCount: result.kind === 'web_search' ? result.results.length : 1,
        citationCount: result.kind === 'web_search' ? result.results.length : 1,
        ...(result.kind === 'web_document' ? { url: result.url, finalUrl: result.finalUrl,
          charactersExtracted: result.charactersExtracted, tokensEstimated: result.tokensEstimated, citation: result.citation } : { query: result.query, queryHash: webHash(result.query), tokensEstimated: Math.ceil(JSON.stringify(result).length / 4) }),
      });
      if (result.origin === 'LIVE' && this.limits.cacheEntries) {
        while (this.cache.size >= this.limits.cacheEntries) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { expires: this.now() + this.limits.cacheTtlMs, result: structuredClone(result) });
      }
      return result;
    } catch (error) {
      const failure = normalizeWebError(error, operation === 'search' ? 'WEB_SEARCH_FAILED' : 'WEB_FETCH_FAILED');
      if (provider) provider.metadata.health = 'degraded';
      await emit(`web.${operation}.failed`, { provider: provider?.metadata.id, duration: this.now() - started, status: failure.code, httpStatus: failure.status, networkRequests, bytesDownloaded });
      throw failure;
    } finally {
      clearTimeout(timer);
      if (admitted && budget) { budget.active--; budget.reservedMs -= reserved; budget.elapsed += Math.max(0, this.now() - started); this.active--; }
      if (durableReservation && durableKey && this.options.budgetStore) {
        await this.options.budgetStore.update!<PersistedWebBudget>(durableKey, state => {
          if (!state?.reservations[operationId]) return state!;
          const reservations = { ...state.reservations }; delete reservations[operationId];
          return { ...state, reservations, chargedMs: Math.max(0, state.chargedMs - reserved + Math.max(0, this.now() - started)) };
        });
      }
    }
  }
  private async deadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    let listener!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      listener = () => reject(new WebError(signal.reason?.name === 'TimeoutError' ? 'WEB_TIMEOUT' : 'WEB_CANCELLED'));
      signal.addEventListener('abort', listener, { once: true }); if (signal.aborted) listener();
    });
    try { return await Promise.race([operation, aborted]); } finally { signal.removeEventListener('abort', listener); }
  }
  private normalizeSearch(raw: unknown, request: WebSearchRequest, provider: string, retrievedAt: string): GroundedSearch {
    if (Buffer.byteLength(JSON.stringify(raw) ?? '') > this.limits.maxFetchBytes) throw new WebError('WEB_RESPONSE_TOO_LARGE');
    const items = Array.isArray(raw) ? raw : (raw as { results?: unknown })?.results;
    if (!Array.isArray(items)) throw new WebError('WEB_SEARCH_FAILED');
    const result: GroundedSearch = { kind: 'web_search', trust: 'UNTRUSTED_EXTERNAL_CONTENT', query: this.sanitizer.sanitize(request.query), provider, retrievedAt, origin: 'LIVE', results: [] };
    const seen = new Set<string>();
    for (const item of items) {
      if (result.results.length >= request.maxResults!) break;
      if (typeof item?.url !== 'string') continue;
      let url: URL;
      try { if (this.sanitizer.sanitize(item.url) !== item.url) continue; url = parseWebUrl(item.url); checkWebDestination(url, this.options.policy.webPolicy()); } catch { continue; }
      if (seen.has(url.href) || request.domains?.length && !request.domains.some(d => domainMatches(url.hostname, d)) || request.excludeDomains?.some(d => domainMatches(url.hostname, d))) continue;
      const publishedAt = typeof item.publishedAt === 'string' && Number.isFinite(Date.parse(item.publishedAt)) ? new Date(item.publishedAt).toISOString() : null;
      if (request.recencyDays && (!publishedAt || Date.parse(publishedAt) < this.now() - request.recencyDays * 86_400_000)) continue;
      const text = (value: unknown, max: number) => this.sanitizer.sanitize(this.extractor.extract({ url: url.href, finalUrl: url.href, contentType: 'text/html', body: typeof value === 'string' ? value : '', bytesDownloaded: 0 }).content).slice(0, max);
      const title = text(item.title, 200), snippet = text(item.snippet, 1000);
      const citation = this.citations.createCitation({ url: url.href, finalUrl: url.href, title, source: provider, retrievedAt, publishedAt, contentHash: webHash(snippet), evidenceKind: 'search_snippet' });
      result.results.push({ title, url: url.href, snippet, source: provider, publishedAt, retrievedAt, rank: result.results.length + 1, citation });
      if (JSON.stringify(result).length > this.limits.maxGroundingTokens * 4) { result.results.pop(); break; }
      seen.add(url.href);
    }
    return result;
  }
}
