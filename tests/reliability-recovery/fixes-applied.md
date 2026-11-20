# Fixes Applied (P0-A through P1-I)

## P0-A: Model Admission & Stale Telemetry Refresh
- **Root Cause:** `ModelLifecycleService.estimateTarget()` rejected models with `ESTIMATE_UNKNOWN` on missing/stale telemetry without calling `refreshResources()`, and conflated missing metadata, stale telemetry, and unsupported metadata.
- **Files & Functions:** `packages/core/src/services/modelLifecycleService.ts` (`estimateTarget`, `performLoad`, `planEviction`, `AdmissionExplanation`).
- **Fix:** Added bounded once-per-admission `refreshResources()` retry on missing/stale telemetry; distinguished `HARDWARE_TELEMETRY_UNAVAILABLE`, `HARDWARE_TELEMETRY_STALE`, `MODEL_METADATA_MISSING`, `MODEL_METADATA_UNSUPPORTED`, `INSUFFICIENT_MEMORY`, `MODEL_INCOMPATIBLE`, and `POLICY_DENIED`; added structured `AdmissionDecision.explanation`; ensured transient telemetry gaps do not trigger `markIneligible()`.
- **Verification:** `packages/core/tests/modelLifecycleAdmission.test.ts` (31/31) & `modelLoadingLifecycle.test.ts` (15/15) — **46/46 passed**.

## P0-B: Gemma 4 & Ollama Memory Estimation
- **Root Cause:** `OllamaAdapter.estimateModelLoad()` only accepted scalar `*.attention.head_count_kv`, could match `*.vision.*` keys, failed when `modelSizes` cache was empty, and failed on live Ollama 0.33.0 where `gemma4.attention.head_count_kv` is `null` and `gemma4` wasn't in `TOOL_CAPABLE_FAMILIES` (nor `details.capabilities` checked).
- **Files & Functions:** `packages/runtimes/ollama/src/index.ts` (`getArchValue`, `estimateModelLoad`, `resolveWeightBytes`, `listModels`, `TOOL_CAPABLE_FAMILIES`).
- **Fix:** Added architecture-prefixed key lookup excluding `.vision.`/`.mmproj.`, array + scalar + `null` (conservative MHA upper-bound) `head_count_kv` handling, explicit `key_length`/`value_length`, `/api/tags` weight fallback, and `details.capabilities` + `gemma4` tool-calling detection.
- **Verification:** `packages/runtimes/ollama/tests/` — **8/8 passed**; live DGX `gemma4:26b` @ 32k returned `53,607,025,510` bytes (`source: HEURISTIC`) with `toolCalling: true`.

## P0-C: DGX Unified-Memory & Remote Telemetry
- **Root Cause:** `apps/cli/src/engine.ts` only refreshed `local` computers in `refreshResources`, registered `fleetHosts` without `gpu.unifiedMemory`, and used hardcoded `cpuPercent: 10` heartbeats. `ComputerRegistry.resourceSnapshot()` dropped stale availability without surfacing `telemetryFresh` / `telemetrySource`.
- **Files & Functions:** `packages/core/src/services/computerRegistry.ts`, `packages/core/src/resources/localCapacity.ts`, `apps/cli/src/engine.ts` (`buildFleetHostHardware`, `refreshRemoteHostTelemetry`).
- **Fix:** Preserved/inferred `unifiedMemory` for GB10/DGX/Apple Silicon, tracked `telemetryTimestamp`/`telemetryFresh`/`telemetrySource`, and probed remote endpoints (`/telemetry`, `/api/ps`, `/api/v0/models`) without substituting Mac RAM.
- **Verification:** `remoteTelemetryAdmission.test.ts` (4/4) & `computerHeartbeatRecovery.test.ts` (2/2) — **6/6 passed**.

## P0-D: Context Preflight & Overflow Recovery
- **Root Cause:** Oversized prompts on 8192-token windows lacked preflight optional-schema reduction and relied solely on heuristic compression.
- **Files & Functions:** `packages/agents/src/qwenCore/wazirQwenAgent.ts` (`computePreflightBudget`), `packages/agents/src/qwenCore/chatCompressionService.ts` (`maybeCompressWithModel`).
- **Fix:** Added preflight budget accounting (system + history + tool schemas + output reserve) and ordered recovery: trim oversized tool outputs -> LLM/deterministic `<state_snapshot>` compaction -> strip optional tool schemas -> escalate to larger permitted model -> explicit `RESOURCE_EXHAUSTED` failure.
- **Verification:** `qwenCore.test.ts` (14/14) & `codingAgent.contextCompaction.test.ts` (8/8) — **22/22 passed**.

## P0-E: Read-Only Progress & Loop Detection
- **Root Cause:** Read-only code reviews with repeated `ls`/`find`/scan calls could hit `NO_PROGRESS` instead of synthesizing from already-gathered observations.
- **Files & Functions:** `packages/agents/src/qwenCore/loopDetectionService.ts`, `packages/agents/src/qwenCore/wazirQwenAgent.ts`.
- **Fix:** Added `readOnlyMode`, `uniqueReadObservations`, `duplicateToolCalls`, bounded scan budget, synthesis nudge, and `action: 'synthesize'` (`forceSynthesis = true` with `tools: []`) when unique observations exist.
- **Verification:** `qwenCore.test.ts` (14/14), `codingAgent.noProgress.test.ts` (6/6), & `tests/security/qwenPromptInjection.test.ts` (4/4) — **24/24 passed**.
- **Additional Hardening (Post-Audit):** Tracked `consecutiveFailures` in `LoopDetectionService` (`packages/agents/src/qwenCore/loopDetectionService.ts`) so 4+ consecutive failed/policy-denied tool calls in `readOnlyMode` do not trigger `action: 'synthesize'` and instead stop with `NO_PROGRESS`.

## P0-F: Non-Node Workspace & Path Resolution
- **Root Cause:** `process-tools.ts` assumed every repo has a root `package.json` (`ENOENT` on `~/Code/sim`), and `paths.ts` needed clean canonicalization for symlinked worktrees.
- **Files & Functions:** `packages/tools/src/process-tools.ts`, `packages/tools/src/paths.ts`, `apps/cli/src/tui/conversationController.ts`, `apps/cli/src/run.ts`, `apps/cli/src/fleetRunner.ts`, `packages/agents/src/nativeHarnessAdapter.ts`.
- **Fix:** Added non-Node project detection (`Cargo.toml`, `go.mod`, `pyproject.toml`, `Makefile`) returning structured `not applicable` instead of `ENOENT` when no `package.json` exists, while preserving strict workspace containment and symlink/traversal blocks. Updated check-recording callers (`run.ts`, `fleetRunner.ts`, `nativeHarnessAdapter.ts`) to check `result.metadata?.applicable === false` so non-applicable checks are never recorded as passing `checks`.
- **Verification:** `nonNodeWorkspace.test.ts`, `sandbox.test.ts`, `security.test.ts` — **35 passed, 10 platform-skipped**; `executeTask.e2e.test.ts` — **11/11 passed**.

## P0-G, P1-H, P1-I: Job Lifecycle, LM Studio Unload, & TUI Error Guidance
- **Root Cause:** `LMStudioAdapter.unloadModel()` failed on installed-but-unloaded models; `fleetTui.ts` suggested `!prompt` shell execution for natural-language prompts and overwrote timeout stop reasons with `cancelled by operator` without freezing task durations; `JobOrchestrator.finishJob()` used `node.error ?? reason` on timeout, leaving `'Cancelled by user'` intact.
- **Files & Functions:** `packages/runtimes/lmstudio/src/index.ts`, `apps/cli/src/tui/fleetTui.ts`, `packages/core/src/services/jobOrchestrator.ts` (`finishJob`).
- **Fix:** Distinguished installed vs loaded instances in `LMStudioAdapter` and added `unloadAllModels()`; removed `!prompt` shell tips in `fleetTui.ts`; preserved timeout reasons, added `finalizeJobTasks()` to enforce terminal state and frozen `durationMs`, and forced `node.error = reason` on `timedOut` in `JobOrchestrator.finishJob()`.
- **Verification:** `fleetTui.test.ts` (59/59), `openaiCompat.test.ts` (8/8), & `jobOrchestrator.test.ts` (19/19) — **86/86 passed**.
