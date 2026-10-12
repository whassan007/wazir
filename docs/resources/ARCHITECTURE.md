# Resource-Aware Orchestration — Architecture Assessment

## 1. Current state (before this work)

| Concern | Existing component | State |
|---|---|---|
| Model invocation | `RuntimeAdapter.generate()` in `packages/runtimes/*` | Six call sites call it directly: `run.ts` (×2), `fleetRunner.ts`, `commands.ts` (×2), `workers/taskExecutor.ts`. Agents call it through `AgentRuntime` wrappers. **No chokepoint, so no admission control or accounting.** |
| Adapter instances | `engine.ts`: `adapterList` (local) and `adapterById` (hosted added at startup) | Both lookups (`engine.adapters`, `worker.adapterForModel`) are served from the same instances. |
| Model selection | `Scheduler.plan()`, `packages/core/src/services/scheduler.ts` | Capability and evidence scoring, per-(model, task class) circuit breaker, hosted placement gated by `PolicyEngine`. **No cost, quota, capacity or latency terms.** |
| Task classification | `complexity.ts` (trivial/small/complex), `TaskCapabilityClassifier` | Reusable for workload classes. |
| GPU / memory | `hardwareDiscovery.ts` (detects GB10 unified memory), `ComputerRegistry.resourceSnapshot()`, `ModelLifecycleService` load admission and memory reservations | Admission covers **model loading** only, not concurrent inference load. |
| Local runtimes | LM Studio and Ollama adapters (OpenAI-compatible) | vLLM works through the same OpenAI-compatible adapter. Loaded-model inspection exists. |
| Hosted providers | Anthropic / OpenAI / Google adapters, `SecretBroker` credentials | **One credential per provider.** HTTP errors flattened to strings: no status, no `Retry-After`, no rate-limit headers, no cached or reasoning tokens. |
| Subscriptions | None. Delegated CLI agents (PR #3: claude-code, codex, antigravity, …) use the vendor CLI's own login. | The only legitimate way to use a consumer subscription. **No usage accounting.** |
| Usage reporting | `GenerationEvent.completed.usage` (input/output, LM Studio cache) | Reported per event, **never aggregated or persisted per account**. |
| Retry / failure | `@wazir/shared` `classifyFailure`, `providerRetryDecision` (connection stage only) | No auth or quota failure classes; `Retry-After` ignored. |
| Persistence | `KeyValueStore` (JSON file, `~/.wazir/wazir.json`); `node:sqlite` with WAL in `@wazir/memory` | JSON store has no multi-row transactions. SQLite is already a dependency (Node ≥ 22.5). |
| Observability | `TelemetryService`, `healthDiagnostics`, `wa doctor`, Fleet TUI, API `/metrics` | No resource or economics view. |

## 2. Reuse versus build

| Need | Decision |
|---|---|
| Admission control on every request | **Build (thin):** a `GovernedRuntimeAdapter` decorator applied once, where adapters are created in `engine.ts`. Every existing call path is covered with no call-site changes and no second scheduler. |
| Routing | **Extend** `Scheduler.plan()` with resource terms (capacity, cost, latency, quota risk) and hard resource constraints. No new scheduler. |
| Workload classes | **Reuse** `complexity.ts` and `TaskCapabilityClassifier`. |
| GPU admission | **Extend:** inference-concurrency limits per local runtime, on top of `ModelLifecycleService`'s existing memory admission. |
| Ledger | **Build** on `node:sqlite` with WAL (already a dependency). The JSON KV store cannot do atomic check-and-reserve. |
| Accounts | **Build** a small registry loaded from `~/.wazir/resources.json`, validated at load. Credentials stay in `SecretBroker` and the vendor CLIs; the registry holds only references. |
| Tokenizer | **No new dependency.** Character-based estimate with a safety margin, calibrated per model from observed actual/estimated ratios, and always labelled as an estimate. Exact tokenizers exist for only some vendors (none for Anthropic or arbitrary local GGUF models), so a single heuristic plus calibration is more honest than a partial tokenizer zoo. |
| Failure handling | **Extend** `@wazir/shared`: `AUTH_FAILED` and `QUOTA_EXHAUSTED` classes, and `Retry-After` parsing. Hosted adapters emit structured HTTP failures. |
| Dashboard | **Build** a CLI view (`wa resources`, `--watch`) and a JSON endpoint, both reading only the ledger and local probes; no provider polling. |

## 3. Target flow

```
task ─► Scheduler.plan()  ── hard constraints (privacy, auth, emergency stop, paid-fallback,
          │                    account blocked/exhausted)  then  score = w·[quality, reliability,
          │                    capacity] − w·[cost, latency, quota risk]   (explained + recorded)
          ▼
   GovernedRuntimeAdapter.generate(req)
          │ 1 estimate tokens (calibrated)   2 resolve account for (runtime, model)
          │ 3 BudgetManager.admit → ledger.reserve (one SQLite transaction: window usage +
          │   live reservations + estimate ≤ hard limit; GPU concurrency for local)
          ▼ admitted ──► inner adapter.generate ──► completed → reconcile(actual)  (idempotent per requestId)
                                                ├► 429 / Retry-After → cooldown event, release
                                                ├► 401/403 → account AUTH_BLOCKED (no retry)
                                                ├► quota → account EXHAUSTED until reset
                                                └► ambiguous (stream cut) → charge the reservation (conservative)
          ▼ denied ──► error event with the reason (DEFERRED / BLOCKED) — nothing is sent
```
