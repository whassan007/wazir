# Repairs Log: Ultra-Low-Latency Fast Path

## Repair 1: LM Studio Health Check Subprocess Elimination
- **File**: `packages/runtimes/lmstudio/src/index.ts`
- **Issue**: `healthCheck()` was unconditionally executing `execFileAsync(lmsBin, ['ls'])` before checking the REST API. On warm systems with LM Studio already running, spawning the `lms` CLI took 320–500 ms of CPU and child process overhead.
- **Root Cause**: Diagnostic CLI check was ordered ahead of the lightweight HTTP REST check.
- **Fix**: Reordered `healthCheck()` to probe `this.nativeModels()` via HTTP first. If reachable, server running and model inventory are returned in 10–20 ms without executing any child subprocesses.
- **Observed Effect**: Engine discovery latency reduced from 520 ms to 15 ms (35x speedup).

## Repair 2: Elimination of Redundant Model Readiness Probing
- **File**: `packages/core/src/services/modelLifecycleService.ts`
- **Issue**: When `plan.reuse === true`, `performLoad()` was calling `await this.verify(i, plan.effectiveContext)`. This sent an inference completion request (`Reply OK.`) to LM Studio, costing 1.5–3.0 seconds on every activation. Furthermore, `createEngine()` at CLI startup was calling `discoverAndReconcile({ verify: true })`, probing all loaded models before any command was parsed.
- **Root Cause**: Lifecycle service lacked distinction between cold load verification and warm resident model reuse, and CLI commands did not pass a fast-startup flag.
- **Fix**:
  1. In `performLoad()`: If `plan.reuse === true`, only verify if `options.verify` is explicitly requested. If `i.state !== 'READY'`, promote to `READY` directly without probe.
  2. In `createEngine()`: Added `fastStartup?: boolean` option. When `fastStartup === true` (used by `wa run`, `wa ask`, and `wa chat`), `discoverAndReconcile` passes `{ verify: false }`, and skips background reconciliation and startup policies.
- **Observed Effect**: Eliminated 2.5–5.0 seconds of unnecessary inference probes during startup and activation.

## Repair 3: Resident Model Context Reuse & Memory Short-Circuit
- **File**: `packages/core/src/services/modelLifecycleService.ts`
- **Issue**: In `estimateTarget()`, when a model was already resident in LM Studio with 8192 tokens context, tasks without explicit context options defaulted to desired context 32768. This caused `i.contextTokens === context` to evaluate to `8192 === 32768` (false), marking `reuse = false` and flagging `CONTEXT_RELOAD_REQUIRED`. Since available free RAM was low (the model was already occupying 7.15 GB), admission failed with `CONTEXT_RELOAD_REQUIRED: INSUFFICIENT_MEMORY`.
- **Root Cause**: The target context logic did not recognize resident context tokens as satisfying unconstrained requests (`requested === undefined`).
- **Fix**:
  1. In `estimateTarget()`: When `requested === undefined` and `i.loaded && (i.state === 'READY' || i.state === 'LOADED') && i.contextTokens >= minimum`, set `desired = i.contextTokens`.
  2. Inside `estimateAt()`: If `i.loaded && i.contextTokens === candidateContext && i.residentMemoryBytes`, return the observed resident memory metrics directly without running runtime estimator subprocesses (`lms load --estimate-only`).
  3. In `reuse` condition: Allow `(i.state === 'READY' || i.state === 'LOADED')`.
- **Observed Effect**: Eliminated false-positive `CONTEXT_RELOAD_REQUIRED` and `INSUFFICIENT_MEMORY` rejections; resident models are seamlessly reused without eviction or reloads.

## Repair 4: Direct-Answer Fast Path for Non-Mutating Tasks
- **Files**: `apps/cli/src/run.ts`, `apps/cli/src/commands.ts`
- **Issue**: Simple queries like `what is 23 + 19?`, `reverse the word WAZIR`, and `generate JSON ...` were being routed through the full multi-phase coding agent (`wazir-coding`). The agent spent 5 turns executing:
  - Turn 1: `[plan]` planning tokens
  - Tool surface compilation (13 tools, 1529 tokens)
  - Turn 2: `[implement]` with bash `bc` or python execution
  - Turn 3: `[verify]` build/test runner checks
  - Evaluation failure: "no files changed, no checks were executed"
- **Root Cause**: CLI treated every `wa run` task as a software repository code-editing task requiring workspace mutation and verification evidence.
- **Fix**:
  1. Implemented `isDirectAnswerRequest(description, options)` to classify non-mutating requests (arithmetic, string transformation, JSON generation, direct Q&A, and standalone code snippets).
  2. For direct-answer tasks:
     - Automatically default `task.type` to `'chat'` and `minimumContext` to 4096.
     - Skip workspace tool compilation and active context parts scanning.
     - Skip preflight tool infrastructure verification (`runWorkerPreflight`).
     - Skip git head fingerprinting and drift detection (`captureHeadFingerprint` / `describeUnexpectedHeadDrift`).
     - Directly invoke `adapter.generate()` with single-turn streaming.
     - Display immediate visible progress with `StatusLoader` (<500 ms).
     - Directly evaluate success on completion without requiring file mutations or test suite executions.
- **Observed Effect**: Wall-clock turnaround dropped from 35.4 s to 4.94 s on arithmetic, 63 s to 6.17 s on string reversal, and 336 s to 5.92 s on JSON generation.

## Repair 5: Token Streaming Variable Resolution
- **File**: `apps/cli/src/run.ts`
- **Issue**: In the initial direct-answer streaming loop draft, tokens were accumulated using `directSummary += event.token`. Because `GenerationEvent` defines `{ type: 'token'; content: string }`, `event.token` was `undefined`, resulting in corrupted output (`undefinedundefined...`).
- **Root Cause**: Mismatch between runtime interface property (`content`) and local accumulation variable (`token`).
- **Fix**: Updated accumulation to `const chunk = event.content ?? (event as any).token ?? ''; directSummary += chunk;` and inspected `event.content` on `event.type === 'completed'`.
- **Observed Effect**: Streaming answers now correctly capture and return the model's text (e.g. `42`, `RIZAW`, JSON object, and Python code).

## Repair 6: Resident Model Prioritization in Automatic Model Selection
- **Files**: `packages/core/src/services/scheduler.ts`, `apps/cli/src/commands.ts`
- **Issue**: When `wa run` or `wa ask` was called without an explicit `--model` flag:
  1. In `scheduler.ts`: When `google/gemma-4-12b-qat` had accumulated historical failures under `task.type === 'coding'`, its reliability circuit breaker was `OPEN`, causing the scheduler to reject it and attempt to load an unloaded 27B model (`qwen/qwen3.8-27b`), failing due to memory constraints.
  2. In `askCommand`: Hosted models were not filtered when hosted providers were unauthenticated/unauthorized, picking `01-ai/yi-large` as the default candidate and failing with policy refusal.
- **Root Cause**: Resident models did not receive sufficient scheduling priority over cold candidates, and direct tasks inherited the `coding` task type.
- **Fix**:
  1. In `run.ts`: Direct tasks default `task.type` to `'chat'`, isolating them from coding circuit breaker history.
  2. In `scheduler.ts`: Awarded a `+30` score bonus to loaded `READY` instances (`+15` for `LOADED`).
  3. In `commands.ts` (`askCommand`): Filtered out unauthorized hosted models by default when `allowHosted` is not enabled, and explicitly searched for resident loaded models first.
- **Observed Effect**: `wa run "what is 23 + 19?"` and `wa ask "what is 23 + 19?"` without any flags automatically select the resident `google/gemma-4-12b-qat` model and complete in <5.2 s.
