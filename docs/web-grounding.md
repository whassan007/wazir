# Web grounding

Wazir exposes `web_search` and `web_fetch` through the existing ToolRegistry. Networking, provider selection, policy, DNS validation, extraction, credentials, limits, caching and evidence are owned by `WebGroundingService` in core. No model runtime requires a web API or receives provider credentials.

Web access is opt-in. Without `web.enabled`, the coding agent and its tool surface remain unchanged. With it enabled, the native coding agent advertises `web.search` and `web.fetch` and also supports explicit `research` tasks. Other agents must independently declare these capabilities. Tool dispatch checks the capability as well as PolicyEngine authorization and task-level network permission.

## Implementation map

| Requirement | Reused component | Implementation | Verification |
|---|---|---|---|
| Canonical search/fetch/evidence | Core domain types | `types/web.ts`, `webGroundingService.ts` | `core/tests/webGrounding.test.ts` |
| Provider selection | Existing core service pattern | `WebProviderRegistry`, HTTP, JSON endpoint and MCP adapters in `webProviders.ts` | Provider normalization and MCP tests |
| URL/network authorization | `PolicyEngine` | `WebPolicy`, `webSecurity.ts`, pinned Node HTTP socket lookup | Schemes, IP ranges, DNS, redirects, policy, size and timeout tests |
| Extraction/sanitization | Shared sanitizer, MCP credential redactor | Cheerio HTML parsing, Turndown Markdown conversion, `webContent.ts` | Headings, links, code, tables, hidden/script/style removal, redaction |
| Retry | Shared `retryConnect` / `ExecutionFailure` | Typed web failures mapped to existing retry classes | Bounded transient retry; no policy retry |
| Context | `ContextCompiler`, `ObservationCompactor`, CodingAgent compaction | Grounded parts with preserved citation envelopes; combined per-model-call grounding budget | Compiler and agent tests |
| Credentials/MCP | Existing SecretBroker, `MCPRegistry`, `MCPToolAdapter`, `MCPAuthProvider` | Explicit tool bindings, existing schema/auth/policy/lifecycle dispatch | MCP normalization, explicit fetch trust |
| Evidence/history | ExecutionEngine events and audit log | `web.evidence`, `web.context`, `web.answer`, operation and network events | CLI history test |
| CLI/TUI | Commander, existing fleet progress metadata | `apps/cli/src/web.ts`; compact provider/result/size/citation display | CLI JSON and existing fleet tests |

## Configuration

Merge the desired settings into the existing Wazir `config.json` (normally `~/.wazir/config.json`). Enabling web capabilities does not itself enable network permission.

```json
{
  "networkAllowed": true,
  "web": {
    "enabled": true,
    "policy": {
      "searchAllowed": true,
      "fetchAllowed": true,
      "allowInternal": false,
      "authenticationAllowed": true,
      "deniedDomains": ["blocked.example"]
    },
    "limits": {
      "maxSearchResults": 5,
      "maxFetchBytes": 2000000,
      "maxExtractedCharacters": 30000,
      "maxGroundingTokens": 8000,
      "maxRedirects": 5,
      "requestTimeoutMs": 15000,
      "connectTimeoutMs": 5000,
      "readTimeoutMs": 5000,
      "totalWebBudgetMs": 60000,
      "maxRequests": 30,
      "concurrency": 3,
      "cacheEntries": 64,
      "cacheTtlMs": 60000,
      "maxRetries": 2
    }
  }
}
```

`allowedDomains` and `deniedDomains` apply to initial URLs, DNS-validated redirect destinations and native search endpoints. An allowlist must include both the search endpoint and desired document domains. Deny wins. `allowedProviders` limits provider IDs. URL credentials, credential-shaped query parameters, non-HTTP schemes, private/reserved IPs, mixed public/private DNS answers and local/internal hostnames are blocked by default. Internal retrieval needs the host-owned `allowInternal` policy; tool arguments cannot enable it.

Limits are validated and have hard safety ceilings. The request budget covers attempts and native HTTP redirects; cache hits also consume an operation. Concurrent calls share limits by job, or execution when no job exists; subagents inherit the parent's budget scope. Time is reserved before dispatch to prevent concurrent operations overspending the job budget. Excess concurrency fails with `WEB_BUDGET_EXCEEDED` instead of creating an unbounded queue. Engine-backed job/execution counters and reservations use atomic updates in the existing KeyValueStore, preserving quotas across restarts. A crash conservatively charges its reservation. A controller may call `releaseBudget` to release local bookkeeping only after the job/execution is terminal; durable counters are not reset. Standalone diagnostics have invocation-local budgets.

### Native search endpoint

No vendor or free public search service is assumed. Configure an enterprise endpoint implementing this small contract:

```json
{
  "web": {
    "enabled": true,
    "search": {
      "id": "enterprise-search",
      "endpoint": "https://search.example.org/search",
      "secretRef": "env:WAZIR_SEARCH_TOKEN"
    }
  }
}
```

The service performs a bounded GET with `query`, `maxResults`, optional comma-separated `domains`/`excludeDomains`, and optional `recencyDays`. The endpoint returns JSON:

```json
{"results":[{"title":"Release notes","url":"https://example.org/releases","snippet":"Compact source excerpt","publishedAt":"2026-09-20T00:00:00Z"}]}
```

`secretRef` is optional and resolves through the existing broker boundary. A configured credential is sent as a Bearer header only over HTTPS. Search API redirects are disabled. Raw provider fields never enter model context. Domain filters, deduplication, result limits and recency are enforced after normalization; dated filtering drops undated results rather than inventing dates. Ranking preserves provider order with deterministic ranks.

Other native integrations implement `SearchProvider`/`FetchProvider` and register with `WebProviderRegistry`. Provider metadata includes operations, type, auth requirements, availability, priority and health. There is no startup search call.

### MCP providers

Use the existing `wa mcp` configuration/authentication flow first, then bind canonical tools:

```json
{
  "web": {
    "enabled": true,
    "mcp": [{"id":"mcp-search","serverId":"search-server","searchTool":"search","fetchTool":"fetch","priority":10}],
    "policy": {"trustedMcpFetchServers":["search-server"]}
  }
}
```

Bound remote tools accept the same inputs as Wazir's tools. Search returns the JSON result contract above. Fetch returns `{content, finalUrl, contentType}`; content type defaults to Markdown. The adapter accepts MCP structured content or JSON in text content. Arbitrary provider-specific text is rejected, not guessed into citations. For other remote schemas, add a host-owned adapter mapping.

The existing MCP adapter performs schema validation, credential resolution, MCP policy authorization and execution. Bound MCP tools are removed from the direct model surface and ordinary dispatch, so the model uses the grounding service. Internal adapter invocation remains controller-owned.

**MCP network trust:** Wazir cannot enforce socket pinning or inspect intermediate redirects inside a remote server. MCP fetch is denied unless that server is explicitly listed in `trustedMcpFetchServers`. This authorizes delegation of network enforcement to that server. Wazir additionally validates the requested and returned final URLs locally. Only trust a fetch server whose own redirect/DNS policy meets the deployment's requirements. MCP connection/request limits still come from the existing MCP implementation.

## Use

```sh
wa web providers --json
wa web status --json
wa web search "Node.js 22 release notes" --json
wa web fetch https://nodejs.org/ --json
wa run --type research "Research the current Node.js release using web grounding. Return the version and cite a source you actually retrieved."
```

Search returns compact snippets; it never automatically fetches results. The agent chooses documents to fetch. Research completion requires a fetched document and a corresponding source ID or URL in the answer. Coding tasks retain their existing code verification requirements.

All web diagnostic output is JSON, including failures, with no ANSI formatting. CLI and agents use the same service. The TUI displays provider, origin, counts or sizes, citation and duration through existing progress events. Execution history remains the source of truth.

## Evidence and context

Every successful operation issues citations with canonical source URLs, final URL, provider, timestamp, content hash and an evidence kind. Search citations prove retrieval of a search snippet; they do not claim the destination page was fetched. Document citations prove a successful document fetch. Citation IDs are derived by the controller, never accepted from provider text or model claims.

HTML is parsed, active/chrome/hidden elements removed, links normalized, useful structure converted to Markdown, credentials and terminal controls scrubbed, and content bounded. Retrieved text is explicitly `UNTRUSTED_EXTERNAL_CONTENT`. Prompt injection remains document data and grants no permissions. Policy is checked independently of prompt content.

The existing execution store retains sanitized, bounded evidence in `web.evidence`. Raw HTML, response headers, cookies and credentials are not retained. ContextCompiler preserves citation envelopes during compaction. Before each model call, the CLI/fleet runtime consolidates referenced web sources under `maxGroundingTokens` and records the exact compiled excerpt/hash/IDs in `web.context`. If citation metadata alone cannot fit, it fails explicitly instead of exceeding the budget or silently removing provenance.

`web.answer` associates references in the final output with issued sources and reports unissued source IDs. It does **not** prove semantic entailment of every claim. A model-written URL never creates evidence.

Operation, extraction, truncation, retry, network request, completion and failure events include execution/job/agent identity when available, timing, provider, hashes, cache origin and resource counts. Native HTTP byte/request counts include retries. For MCP, the remote server's internal network usage is not observable; returned content size is available. Provider exceptions are replaced with typed failure codes. Diagnostic evidence and events use the existing audit JSONL log.

The bounded in-memory cache preserves the original retrieval timestamp and citation. Hits are `CACHE`, never newly dated `LIVE` evidence. Keys include provider, canonical request options and effective web policy. Expiry causes live retrieval. The cache does not survive process restart; engine-backed quotas and execution/audit evidence do.

## Deliberate boundaries

- No browser automation, JavaScript rendering, PDF parsing, compression decoding, or cookie/session propagation. Unsupported content fails explicitly.
- No built-in vendor search credentials or automatic provider provisioning. Native JSON search and explicitly configured MCP bindings are available.
- No separate unrestricted `fetchMany` API: callers batch existing registry tool calls, retaining capability/policy/job-budget checks. Native provider calls are infrastructure APIs, not agent privileges.
- Retention contains the sanitized bounded artifact, not a complete raw response. Token estimation uses Wazir's deterministic character approximation.
- Separate controllers share durable job quotas only when configured with the same atomic KeyValueStore. They do not share the in-memory content cache. Remote MCP servers' internal HTTP request counts remain outside Wazir's visibility.
