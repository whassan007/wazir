# Phase 4 — Execution Observability Audit

## 1. End-to-End Lifecycle Trace of a Request (`wa run "<prompt>" --json`)

Tracing request `C01` (`"What is 18 + 24? Return only the number."`) through `apps/cli/src/run.ts`, `apps/cli/src/engine.ts`, `packages/core/src/services/executionService.ts`, and `packages/agents/src/codingAgent.ts`:

| Lifecycle Stage | Actual Timestamp Offset (Baseline `C01 a1`) | Emitted on `stdout` (`--json`)? | Persisted in `~/.wazir/wazir.json`? | Observability Verdict |
|---|---:|---|---|---|
| 1. **Process Spawn** | `0 ms` | **No** (completely silent for 12.6s–18.5s) | No | **BLIND SPOT (12.6s–18.5s silent startup)** |
| 2. **Engine Initialization & Lock Acquisition** | `0 – 12,640 ms` | **No** (if lock fails after 10s, crashes with `unhandledRejection`, emitting non-JSON stack trace on `stderr`) | Writes `runtime/health/*` & `model/lifecycle/*` (32MB file rewrite per call) | **CRITICAL DEFECT** |
| 3. **Request Accepted (`start`)** | `12,649 ms` | **Yes:** `{"type":"start","executionId":"exec-mvd8mumr-1","goal":"...","routingMode":"LOCAL_ONLY","model":"gemma-4-26b-a4b-it-qat"}` | Yes (`execution/record/*`) | **Present (delayed by 12.6s)** |
| 4. **Model Selection & Readiness Verification** | `12,650 – 15,826 ms` | **No** (3.2s spent running `lms load --estimate-only` and duplicate `probeModel` silently) | Yes (`execution.prepared` in store only) | **MISSING ON STDOUT** |
| 5. **Dispatch to Runtime (`generation.started`)** | `15,826 ms` | **No** (`run.ts` ignores `generation.started` events in `--json` mode!) | Yes (`generation.started` in store only) | **MISSING ON STDOUT** |
| 6. **First Token Received (`first_token`)** | `~16,100 ms` | **No** (`LMStudioAdapter.generate` buffers non-streaming or only invokes `onChunk` without recording `firstTokenAt` or emitting a `first_token` NDJSON event) | **No** (neither store nor stdout records `firstTokenAt`) | **COMPLETELY MISSING** |
| 7. **Streaming Progress (`delta`)** | `16,100 – 17,679 ms` | **No** in `CodingAgent` JSON action loop (only raw text when `onDelta` fires, and `CodingAgent` suppresses `onDelta` during JSON action parsing!) | No | **MISSING FOR AGENT TASKS** |
| 8. **Multi-Turn / Tool / Repo Verification Loop** | `17,679 – 45,000+ ms` | **No!** When `CodingAgent` runs Turn 2 or runs repo-wide `npm run build` / `npm run test` during `VERIFY`, **zero events** are emitted on `stdout` in `--json` mode! | Stored only after completion or failure | **CRITICAL BLIND SPOT (27s+ silent hang)** |
| 9. **Completion / Failure / Cancellation / Timeout** | `45,007 ms` (killed by supervisor) | **No** when killed by timeout (`SIGTERM` is not caught to emit a structured cancellation event or release locks cleanly) | Left in `RUNNING` state forever in `wazir.json` | **ORPHANED `RUNNING` STATE** |

## 2. Specific Observability Defects Identified

1. **Silent 12.6s–18.5s Startup Before `{"type":"start"}`:**
   - `apps/cli/src/run.ts` initializes the entire engine (`createEngine`) before emitting any acknowledgment. During this window, the user or caller cannot tell whether the CLI is hung on a file lock, probing dead models, or loading weights.
2. **Missing `dispatch` and `first_token` Events in `--json` Mode (`apps/cli/src/run.ts:431-475`):**
   - `run.ts` subscribes to `engine.events.subscribe()`, which receives `execution.started`, `execution.prepared`, `generation.started`, `generation.completed`, `agent.step`, and `agent.verification`.
   - However, in `if (options.json)`, `run.ts` **only** forwards `delta` (which is never called by `CodingAgent`) and `complete`/`error`! All `execution.prepared`, `generation.started` (dispatch), `first_token`, and `agent.step` events are silently dropped in `--json` mode.
3. **Silent Repo-Wide Build/Test Execution During `VERIFY` Phase:**
   - After the model finishes generating `"42"` in `1.8s`, `CodingAgent` transitions to `VERIFY` and spawns `npm run build`, `npm run test`, `npm run lint`, and `npm run typecheck` across the Wazir monorepo without emitting progress events in `--json` mode, making a `1.8s` answer look like an infinite model hang.
4. **Uncaught `unhandledRejection` on Lock Timeout:**
   - When `JsonFileStore` times out waiting for `wazir.json.lock`, `run.ts` exits with a raw stack trace on `stderr` instead of a structured JSON error event when `--json` is passed.
