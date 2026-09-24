import type { ToolExecutionContext } from './tool.js';
import { ExecutionFailure, type FailureClass } from '@wazir/shared';

export type WebFailureCode = 'WEB_SEARCH_FAILED' | 'WEB_FETCH_FAILED' | 'WEB_TIMEOUT' | 'WEB_DNS_FAILED'
  | 'WEB_CONNECTION_FAILED' | 'WEB_TLS_FAILED' | 'WEB_HTTP_ERROR' | 'WEB_REDIRECT_LIMIT'
  | 'WEB_RESPONSE_TOO_LARGE' | 'WEB_UNSUPPORTED_CONTENT_TYPE' | 'WEB_EXTRACTION_FAILED'
  | 'WEB_POLICY_DENIED' | 'WEB_URL_BLOCKED' | 'WEB_AUTH_REQUIRED' | 'WEB_PROVIDER_UNAVAILABLE'
  | 'WEB_RATE_LIMITED' | 'WEB_BUDGET_EXCEEDED' | 'WEB_CANCELLED';
export class WebError extends ExecutionFailure {
  constructor(readonly code: WebFailureCode, readonly status?: number) {
    const failureClass: FailureClass = code === 'WEB_TIMEOUT' ? 'TIMEOUT'
      : code === 'WEB_RATE_LIMITED' ? 'RATE_LIMIT'
      : code === 'WEB_CONNECTION_FAILED' ? 'TRANSPORT'
      : code === 'WEB_HTTP_ERROR' && status && status >= 500 ? 'SERVER'
      : ['WEB_POLICY_DENIED', 'WEB_URL_BLOCKED'].includes(code) ? 'POLICY_DENIED'
      : code === 'WEB_CANCELLED' ? 'CANCELLED' : 'NON_RECOVERABLE';
    super(failureClass, code);
  }
}
export interface WebSearchRequest {
  query: string; maxResults?: number; domains?: string[]; excludeDomains?: string[]; recencyDays?: number | null;
}
export interface WebFetchRequest { url: string; maxChars?: number }
export interface Citation {
  citationId: string; url: string; finalUrl: string; title: string; source: string;
  retrievedAt: string; publishedAt: string | null; contentHash: string;
  evidenceKind: 'search_snippet' | 'document';
}
export interface SearchResult {
  title: string; url: string; snippet: string; source: string; publishedAt: string | null;
  retrievedAt: string; rank: number; citation: Citation;
}
export interface GroundedDocument {
  kind: 'web_document'; trust: 'UNTRUSTED_EXTERNAL_CONTENT'; url: string; finalUrl: string;
  title: string; contentType: string; content: string; retrievedAt: string; truncated: boolean;
  citation: Citation; provider: string; origin: 'LIVE' | 'CACHE'; bytesDownloaded: number;
  charactersExtracted: number; tokensEstimated: number;
}
export interface GroundedSearch {
  kind: 'web_search'; trust: 'UNTRUSTED_EXTERNAL_CONTENT'; query: string;
  results: SearchResult[]; provider: string; origin: 'LIVE' | 'CACHE'; retrievedAt: string;
}
export type GroundedResult = GroundedDocument | GroundedSearch;
export interface WebLimits {
  maxSearchResults: number; maxFetchBytes: number; maxExtractedCharacters: number;
  maxGroundingTokens: number; maxRedirects: number; requestTimeoutMs: number;
  connectTimeoutMs: number; readTimeoutMs: number; totalWebBudgetMs: number;
  maxRequests: number; concurrency: number; cacheEntries: number; cacheTtlMs: number; maxRetries: number;
}
export interface WebPolicy {
  searchAllowed?: boolean; fetchAllowed?: boolean; allowInternal?: boolean;
  allowedDomains?: string[]; deniedDomains?: string[]; allowedProviders?: string[];
  authenticationAllowed?: boolean;
  /** Remote MCP servers own their network. Explicit operator trust is required for fetch. */
  trustedMcpFetchServers?: string[];
}
export interface WebProviderMetadata {
  id: string; type: 'native' | 'mcp' | 'browser'; capabilities: ('search' | 'fetch')[];
  authentication: 'none' | 'secret' | 'mcp'; available: boolean; priority: number;
  health: 'unknown' | 'healthy' | 'degraded'; serverId?: string;
}
export interface ProviderContext {
  signal: AbortSignal; limits: Readonly<WebLimits>; execution: ToolExecutionContext;
  /** Must be called before every destination, including redirects. */
  validateUrl(url: string): Promise<{ url: URL; addresses: { address: string; family: number }[] }>;
  onRequest?: (url: string) => Promise<void>;
  addBytes?: (bytes: number) => void;
}
export interface SearchProvider { metadata: WebProviderMetadata; search(request: WebSearchRequest, ctx: ProviderContext): Promise<unknown> }
export interface FetchResponse { url: string; finalUrl: string; contentType: string; body: string; bytesDownloaded: number }
export interface FetchProvider { metadata: WebProviderMetadata; fetch(request: WebFetchRequest, ctx: ProviderContext): Promise<FetchResponse> }
export interface ExtractedDocument { title: string; content: string }
export interface ContentExtractor { extract(response: FetchResponse): ExtractedDocument }
export interface ContentSanitizer { sanitize(text: string): string }
export interface WebConfig {
  enabled?: boolean; limits?: Partial<WebLimits>; policy?: WebPolicy;
  /** GET endpoint accepting query/maxResults/domains/excludeDomains/recencyDays; returns {results:[{title,url,snippet,publishedAt}]}. */
  search?: { id?: string; endpoint: string; secretRef?: string };
  mcp?: { id: string; serverId: string; searchTool?: string; fetchTool?: string; priority?: number }[];
}
