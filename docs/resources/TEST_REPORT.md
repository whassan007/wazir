# Resource Orchestration — Test, Live Integration and Benchmark Report

Run on 2026-10-12, on the DGX Spark (NVIDIA GB10, 121.7 GiB unified memory), with LM Studio on :1234.

## Automated suite

| Check | Result |
|---|---|
| Typecheck | pass |
| Full vitest | **2051 passed, 0 failed**, 18 skipped (818 files; skips are PostgreSQL, bwrap sandbox and live-lifecycle infrastructure) |
| Acceptance gates | 80/80 PASS, "READY FOR RELEASE" |
| New resource tests | `packages/core/tests/resources.test.ts` (33), `packages/runtimes/openai/tests/providerSignals.test.ts` (12) |

### Required scenarios (deterministic mocks, injectable clock)

| # | Scenario | Test |
|---|---|---|
| 1 | Two subscriptions, different quotas | `1. two subscriptions…` |
| 2 | One approaching exhaustion | `2. …reserved for complex work`, `2b. conservation mode…` |
| 3 | Both exhausted | `3. both subscriptions exhausted: deferred…` |
| 4 | DGX Spark available | `4. local accounts admit routine work…` |
| 5 | DGX Spark unavailable | `5. local endpoint unavailable…released` |
| 6 | GPU memory exhaustion | `6. GPU out-of-memory…released`, `6b. GPU concurrency queues` |
| 7 | Concurrent agents, same budget | `7. …separate processes cannot double-spend` (two DB connections on one file) |
| 8 | Provider rate limiting | `8. HTTP 429 with Retry-After…`, `rate-limit headers reporting zero…` |
| 9 | Unknown subscription limits | `9. unknown limits are handled explicitly per policy` |
| 10 | Quota reset | `10. quota resets at the window boundary` |
| 11 | Restart during execution | `11/17. a restart recovers abandoned reservations once` |
| 12 | Interrupted stream | `12. an interrupted stream is charged conservatively` |
| 13 | Duplicate retries | `13. duplicate reconciliation…never charges twice` |
| 14 | Usage reporting delays | `14. missing provider usage is recorded as an estimate` |
| 15 | Capability mismatch | `15. …context window, workload`, `complex work is not silently substituted` |
| 16 | Local model underperformance | `16. an underperforming local model loses…` |
| 17 | Reservation recovery | `11/17. …` |
| 18 | Accounting reconciliation | `18. reconciliation replaces the reservation…and calibrates` |
| 19 | Authentication failures | `19. authentication failure blocks the account…never retried` |
| 20 | Workflows spanning windows | `20. a rolling window releases usage as it ages out` |
| — | Emergency stop, paid gate, spend and task ceilings, config validation, append-only audit, provider usage/cost/cache | corresponding tests |

## Live integration (real endpoints)

| Test | Result |
|---|---|
| DGX Spark capacity probe | **Measured:** GB10, 0% util, 51 °C, 12 W; 13.6–14.9 GiB of 121.7 GiB available; LM Studio reachable with 3 loaded models (ctx 8192); Ollama **unreachable** (reported, not hidden); GPU memory n/a (unified) |
| Governed local inference (`wa ask --model nvidia/nemotron-3-nano-omni`, ×3) | 3 answers; 3 ledger rows `provider-reported` (27 in / 99–172 out, 1.4–2.3 s); one failed JIT load of an unloaded model was **released**, not charged; audit 4 admitted = 3 settled + 1 released |
| Governed coding task (`wa run`, local) | **Refused by GPU memory admission** (`INSUFFICIENT_MEMORY`): the 20k-token prompt needs a context reload and only 13.6 GiB was free. A correct, explained refusal; it motivated load-aware routing. |
| Subscription budget (Antigravity, limit 2 requests/5h, throwaway `WAZIR_HOME`) | Run 1 admitted; Antigravity fixed the bug (`npm test` passes). Run 2 **refused in 3 s, before the CLI launched**: "requests/5h at 100% (critical)…reserved for critical-review work". Ledger: 1 request used, source `estimated`. |
| Paid provider APIs (Anthropic / OpenAI / Google) | **NOT TESTED live**: no API keys are configured on this machine. Structured 429/Retry-After/rate-limit parsing is tested against the real OpenAI adapter with mocked HTTP. |
| Claude Code / Codex subscriptions | **NOT TESTED live**: Claude Code refuses to start inside a Claude Code session; codex-acp 0.16.0 is too old for the account's model (see `wa agents check`). |
| vLLM | **NOT TESTED live**: no vLLM server here. The metrics parser exists and is reachable via `WAZIR_VLLM_URL`. |
| Ollama | **NOT TESTED live**: daemon not running. |

## Benchmark: before versus after (`scripts/bench-resource-governor.mjs`)

| | Ungoverned (before) | Governed (after) | Overhead |
|---|---|---|---|
| Synthetic instant adapter, n=500, file-backed WAL ledger | p50 0.001 ms, p95 0.002 ms | p50 0.137 ms, p95 0.190 ms, mean 0.439 ms | **+0.14 ms p50** per request |
| Live LM Studio, nemotron-3-nano-omni, 32-token reply, n=10 | p50 475.8 ms, p95 492.8 ms | p50 474.7 ms, p95 485.6 ms | within noise (−1.1 ms) |

All 530 benchmark requests (500 synthetic + 20 warm-up + 10 live) produced exactly 530 ledger
rows. The mean exceeds p50 because of occasional WAL checkpoints. Admission is a single SQLite
transaction; it is not a bottleneck relative to any real model call.
