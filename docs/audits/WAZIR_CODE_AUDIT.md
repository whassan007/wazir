# Wazir Code Audit

Scope: runtime adapters, agent lifecycle, job orchestration, tool subprocesses,
external/ACP agent delegation, worker dispatch SSE, memory store, CLI config,
Mission Control TUI, health reporting, acceptance harness. Each finding was
reproduced with a failing test before it was fixed unless marked otherwise.

Severity: P0 security boundary / destructive · P1 broken workflow, hang, false
reporting · P2 intermittent, leak, weak diagnostics · P3 minor.

## Fixed

| # | Sev | Finding | Location | Root cause |
|---|---|---|---|---|
| F1 | **P0** | ACP delegated agents were **auto-approved**. With no operator resolver, or a resolver that returned no decision, `requestPermission` picked an approving option. A delegated Claude Code / Codex / Qwen session asking to run a shell command was approved with no human involved. Resolver errors and unknown option IDs were not handled either. | `packages/agents/src/acp/acpClient.ts:323` | Fallback to `pickLeastEscalating(options, 'proceed')` |
| F2 | P1 | ACP permission options were classified only by label, so a reject option labelled "No" or "Skip" was treated as *proceed*. The ACP `kind` field was ignored. | `packages/core/src/permissions/adaptorUtils.ts:58` | Heuristic only |
| F3 | P1 | ACP client could crash the host process: a spawn failure (`ENOENT`) had no `'error'` listener, and `void sendPromptNow()` left a failed turn as an unhandled rejection. `ACP_INIT_TIMEOUT_MS` was declared but never used, so `initialize` could hang forever. | `acpClient.ts:108`, `:140`, `:254` | Missing handlers / dead constant |
| F4 | P1 | External agent harnesses (`ExternalAgentAdapter`, wired in `apps/cli/src/engine.ts:255`) **ignored cancellation** until the process exited (up to 10 min). The timeout only killed the direct child; grandchildren kept the stdout pipe open, so `close` never fired and **the timeout never ended the run**. A timeout was reported as "exited with code null". Captured output was unbounded. | `packages/agents/src/externalAgent.ts:57` | `isCancelled` checked only after exit; no process group |
| F5 | P1 | Mission Control `why <topic>` **fabricated evidence**: hard-coded "immutable" hashes (`sha256:model-route-7f9a8b1c`, …), `Benchmark Confidence 0.94 (n=120)`, `100% HEALTHY`, `PASS (42/42 passed)`, a fallback model `claude-3-5-sonnet`, all stamped `verifiedAt: now`. Operators were shown proof that did not exist. | `apps/cli/src/tui/fleetTui.ts:1142` | Placeholder data shipped as output |
| F6 | P1 | `/canary` control view was unreachable: `renderCanaryView` existed and was unit-tested but was never wired into `FleetTui` (no command, no key handling, no pane). | `fleetTui.ts:3477`, `:6834` | Integration never completed |
| F7 | P1 | `cancelTask` on an already-finished task overwrote `completed` with `cancelled` (job and graph node), erasing a real success. `cancelJob` already preserved finished tasks; `cancelTask` did not. | `packages/core/src/services/jobOrchestrator.ts:273` | No terminal-state guard |
| F8 | P2 | All five provider adapters (OpenAI, Anthropic, Google, LM Studio, Ollama) created a **new `TextDecoder` per chunk**, so `{stream: true}` did nothing. Multi-byte UTF-8 characters split across chunks (emoji, Arabic, CJK) became `U+FFFD`. | `packages/runtimes/*/src/index.ts` (decoder now at openai:244, anthropic:231, google:285, lmstudio:502, ollama:322) | Decoder instantiated inside the read loop |
| F9 | P2 | Provider streams were not aborted when a consumer stopped iterating early. The `finally` block only deleted the map entry, so a local model kept generating into a closed reader. | `finally` in the same five adapters | Missing `controller.abort()` |
| F10 | P2 | Ollama `listModels` (`/api/tags`) had no timeout, so a stalled daemon hung discovery. | `packages/runtimes/ollama/src/index.ts:113` | Missing `AbortSignal.timeout` |
| F11 | P2 | Worker SSE endpoint leaked streams. The `close` listener was attached after `await dispatcher.subscribe()`, so a worker that disconnected during the await stayed registered and its 5 s keep-alive timer ran forever. A store error in `subscribe` was an unhandled rejection after headers had been sent. | `apps/api/src/server.ts:648` | Listener registered after await |
| F12 | P2 | `config.json` silently overrode `WAZIR_OLLAMA_URL`, `WAZIR_LMSTUDIO_URL`, `WAZIR_API_URL`, `WAZIR_API_TOKEN` and `WAZIR_REGISTRATION_TOKEN`. `wa init` writes localhost URLs to the file, which broke the documented Docker setup (README §Docker). | `apps/cli/src/config.ts:161` | Inverted precedence |
| F13 | P2 | `SqliteMemoryStore.searchDialogue`, documented as BM25 ranking, scored only the **100 most recent** segments. Older memories could never be retrieved, however relevant. | `packages/memory/src/sqlite/sqliteMemoryStore.ts:159` | `LIMIT` applied before matching |
| F14 | P2 | The acceptance harness crashed on a catalog test whose gate is undefined (`G97`–`G100`), so no release verdict was produced. An absolute `--report` path was also joined onto the repo root (ENOENT). | `scripts/acceptance-test-harness.mjs:356`, `:522` | Unchecked lookup; `join` instead of `resolve` |
| F15 | P3 | `searchTreeNavigation.test.ts` mocks did not implement the real `TerminalScreen`/engine contract, so 12 tests failed for reasons unrelated to the feature under test. | test file | Mock drift |

## Verified as sound (no change)

- **Tool subprocesses** (`packages/tools/src/process.ts`): process-group kill on timeout and abort, minimal child environment, output spilled to disk instead of being truncated.
- **Health model** (`packages/core/src/services/healthDiagnostics.ts`): reachability, loaded state and inference health are kept separate. Inference state comes only from recorded outcomes and is `UNKNOWN` when there are none. `wa doctor` reported a non-running Ollama and a non-loaded model accurately.
- **Agent stop conditions** (`packages/agents/src/stopConditions.ts`, `codingAgent.ts`): wall-clock, token, tool-call and no-progress budgets, an identical-call circuit breaker, and a repair-cycle cap.
- **Orchestrator in-run cancellation**: the abort check runs before the success branch, and orphaned tasks are retried within limits.
- **Completion verification**: a model claiming success without edits is rejected (observed live; see functional tests).

## Open (not fixed; see WAZIR_REMAINING_RISKS.md)

Dispatch-record retention, ACP child environment inheritance, repair oscillation
detection, N/A checks reported as `ok:false`, LM Studio adapter default port, and
the undefined G97–G100 gates.
