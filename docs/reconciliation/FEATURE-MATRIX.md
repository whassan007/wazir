# Feature Reconciliation Matrix & Inventory

Every commit and subsystem across `v0.2.11`, `main`, `test/real-world-acceptance`, `feat/nvidia-native-provider`, `feat/nvidia-execution-provider`, `feat/mission-control-tui`, and `feat/ultra-low-latency-fast-path`, reconciled on `integration/v0.2.12-completion`.

## 1. Phase-by-Phase Reconciliation Matrix

### `main` & Specialized Feature Branches

| Commit / Branch | Subsystem | Classification | Resolution on `integration/v0.2.12-completion` |
|---|---|---|---|
| `12f8273` (`feat/nvidia-native-provider`) + `5d79045` (`feat/nvidia-execution-provider`) | Canonical NVIDIA Provider | **CONSOLIDATED (`e14f675`)** | Unified `12f8273`'s policy-governed NVIDIA provider (`HOSTED_API_INFERENCE` vs `LOCAL_GPU_INFERENCE`, `routing.mode = 'provider_only'`, `NVIDIA_CURATED_MODELS`, HTTP 400 unsupported-parameter stripping, `Retry-After` handling, secret redaction, `wa providers list/inspect/test`, resource quota accounting) with `v0.2.11`'s programmatic `NvidiaAdapter` constructor options (`apiKey`, `env`, `fetchImpl`, `retryBaseDelayMs`, `client`) and `hostedProviders.ts` helpers (`resolveHostedProviderApiKey`, `inspectHostedProviderStatus`, `verifyHostedProviderConnectivity`). Verified by 15 unit tests (`nvidiaAdapter.test.ts`) + 10 system/live tests (`nvidiaProviderSystem.test.ts`). |
| `1c95e40` (`feat/mission-control-tui`) + `v0.2.11` (`14813e3`) | Mission-Control TUI | **CONSOLIDATED (`93288b3`)** | Merged `1c95e40`'s full 383-line `missionControl.ts` (`resolveLayoutMode`, `buildMissionControlSnapshot`, `renderMissionControlCockpit`, modal overlays for `CommandPalette`/`Help`/`BlockInspector`/`RawPayload`), `observabilityViews.ts` (`renderActionRail`), `brand.ts` (`renderExecutionHeaderCard`), and `screen.ts` terminal hygiene while preserving `v0.2.11`'s `conversationRenderer.ts` (`renderConversationFrame`, `composerHintForState`), `eventSummarizer.ts`, and `PendingApprovalRequest` (`rule`/`reasons` compatibility). All 227 TUI tests across 18 files pass. |
| `ec863ef` (`test/real-world-acceptance`) + `12f8273` (`main`) | Fleet Subagent Routing Guardrails (Guardrail 3) | **CONSOLIDATED (`14198ea`, `e14f675`)** | Enforced Guardrail 3 in `apps/cli/src/run.ts` (`runSubagent`) and `apps/cli/src/fleetRunner.ts`: propagates `parentExecution` (`routingMode`, `routingProvider`, `defaultModelId`, `allowFallback`) and `parentPolicy` (`allowHostedProviders`, `localOnly`, `dataClassification`) to child subagents and DAG child tasks; blocks cross-provider escape (`provider_only` / `NVIDIA`); enforces quota constraints and capability requirements (`vision`, `requiresCuda`, etc.). Verified by 5 tests in `subagentFleetPlacement.test.ts` and test 18 in `nvidiaProviderSystem.test.ts`. |
| `ed4f1d9`, `f7c97cf` (`main`) vs `246d4cb`, `c7ea2ab`, `973111f` (`v0.2.11`) | Fast-Path & Deterministic Command Execution | **CONSOLIDATED (`3fda9b3`)** | Retained `v0.2.11`'s `ChatAgent` + `isConversationalFastPathRequest` + `isDeterministicCommandRequest` as canonical; fixed `apps/cli/src/run.ts` (`planTask` and `executeTask`) so `isDeterministicCommandRequest` sets `mutationRequired: false` and enables deterministic zero-LLM execution for `pwd`/`ls`/`git status`/`git diff`/`git log`; added `.claude`, `.worktrees`, `tmp`, `temp` to `IGNORED_DIRECTORIES` in `packages/tools/src/paths.ts`. |
| `ed4f1d9` (`modelLifecycleService.ts`) | Model Admission & `READY` State Preservation | **CONSOLIDATED (`3aad1af`)** | Fixed `discoverAndReconcile({ verify: false })` in `packages/core/src/services/modelLifecycleService.ts` so read-only CLI reconciliation preserves a previously verified `READY` state (`stillVerified`) rather than downgrading resident models to `LOADED_UNVERIFIED`. Added 2 regression tests in `modelLifecycleAdmission.test.ts` (24/24 pass). |
| `ed4f1d9` (`scheduler.ts`) | READY-Aware Scheduler Scoring | **CONSOLIDATED (`353c1c9`)** | Ported tiered `+30` (`READY` + `loaded`) / `+15` (`loaded`) residency bonus into `packages/core/src/services/scheduler.ts`. |
| `2a61e59` (`main`) | Shared Quota Routing (`quotaGroup`) & Accounting | **CONSOLIDATED (`353c1c9`)** | Ported `AccountConfig.quotaGroup`, `TokenBudgetManager.scope()`, multi-account ledger queries, paid-advisory reasons, and `scripts/resource-routing-benchmark.mjs`. |
| `607ba43` (`main`) | Nemotron Streaming Utility (`nemo.py`) | **RETAINED / MERGED (`353c1c9`)** | Standalone utility merged cleanly. |
| `7133f16` (`main`) | Production-Realistic E2E Acceptance Suite | **CONSOLIDATED (`353c1c9`, `ca78171`)** | Merged `tests/live/realWorldAcceptance.test.ts` and `tests/live/harness/*`; fixed hardcoded version assertion (`ca78171`). All 10 journeys pass. |
| `ec863ef` (`test/real-world-acceptance`) | `FleetMemoryService` (`remember_fact`/`recall_facts`) & `HandoffService` (`wa handoff`) | **CONSOLIDATED (`14198ea`)** | Ported `FleetMemoryService`, memory tools + `PolicyEngine` allow-rule, and `HandoffService` with full `RookEngine` construction and CLI registration (`wa handoff create/list/show/export/resume`). |
| `48f48e6` (`main`) | API Lease-Fencing | **RETAINED (`v0.2.11` superior)** | `v0.2.11`'s `TaskDispatcher.claim()`/`reconcile()` already implements a superior lease recovery and orphan-fencing model. |
| `ec863ef` (`WorkspaceMutationAttributor`) | Call-Attributed Snapshot Diffing | **DEFERRED** | Reproducibly breaks tool-timeout mutation detection (`packages/tools/tests/timeoutTermination.test.ts`). `v0.2.11`'s simpler, reliable before/after `snapshotWorkspace` diff in `executeTool()` is retained and passes all 19 tool test suites. |

---

## 2. Explicit Feature Inventory (Phase 6 Deliverable)

### Retained (Preserved from `v0.2.11` without regression)
1. **`ChatAgent` (`packages/agents/src/chatAgent.ts`)**: First-class `AgentAdapter` for tool-free conversational fast-path execution with explicit in-code rejection of hallucinated tool calls, 60s wall-clock timeout, and 25ms cancellation polling.
2. **Authoritative Command Classifiers (`packages/agents/src/codingAgent.ts`)**: `isConversationalFastPathRequest()` and `isDeterministicCommandRequest()` (strict anchored allowlist for `pwd`, `ls`, `git status`, `git diff`, `git log`).
3. **Before/After Workspace Snapshot Diff (`packages/tools/src/index.ts`)**: Deterministic mutation detection across normal and timed-out tool executions (`timeoutTermination.test.ts`).
4. **LM Studio Native-First Health Check & Caching (`packages/runtimes/lmstudio/src/index.ts`)**: Sub-second local runtime discovery with `nativeModelsCache`.
5. **API `TaskDispatcher` Orphan Reconciliation (`apps/api/src/server.ts`)**: `reconcile()` pass before `claim()`/`redeliver()` with `recovery: 'orphaned'` state handling.
6. **Conversation Transcript Renderer & Event Summarizer (`apps/cli/src/tui/conversationRenderer.ts`, `eventSummarizer.ts`)**: Clean user/assistant/activity transcript rendering in `wa chat`.

### Consolidated (Merged & Reconciled across `main`, `v0.2.11`, and Feature Branches)
1. **Canonical Policy-Governed NVIDIA Provider (`packages/runtimes/nvidia`, `apps/cli/src/hostedProviders.ts`, `apps/cli/src/commands.ts`, `apps/cli/src/run.ts`)**:
   - Combines `feat/nvidia-native-provider@12f8273` and `feat/nvidia-execution-provider@5d79045` / `v0.2.11`.
   - OpenAI-compatible NVIDIA NIM API client (`https://integrate.api.nvidia.com/v1`, default model `nvidia/nemotron-3.5-super-vl-120b-a12b`).
   - Curated + live `/v1/models` catalog discovery with capability inference (`toolCalling`, `reasoning`, `vision`, `embedding`, `structuredOutput`, context window).
   - Secret Broker + `NVIDIA_API_KEY` resolution with strict redaction of `nvapi-*` and `Bearer` tokens.
   - Streaming separation of `delta.reasoning_content` and `delta.content`, native streaming tool calls, HTTP 400 unsupported-parameter stripping retry, and HTTP 429 `Retry-After` backoff.
   - Distinct `HOSTED_API_INFERENCE` vs `LOCAL_GPU_INFERENCE` placement explainability and resource ledger accounting.
2. **Fleet Subagent Provider-Routing Guardrails (`apps/cli/src/run.ts`, `apps/cli/src/fleetRunner.ts`)**:
   - Enforces Guardrail 1 (max depth 1), Guardrail 2 (policy eligibility), and Guardrail 3 (`provider_only` / `NVIDIA` routing confinement, hosted-provider policy authorization, quota constraints, and capability-based fleet placement via `Scheduler.plan()`).
3. **Mission-Control TUI (`apps/cli/src/tui/missionControl.ts`, `fleetTui.ts`, `observabilityViews.ts`, `screen.ts`, `brand.ts`)**:
   - Adaptive 1/2/3-pane layout (`narrow` <100 cols, `standard` 100–139 cols, `wide` >=140 cols), modal overlays (`CommandPalette`, `Help`, `BlockInspector`, `RawPayload`), approval queue diff previews, paste barrier protection, and non-TTY fallback.
4. **Deterministic Command Fast-Path End-to-End Wiring (`apps/cli/src/run.ts`, `packages/tools/src/paths.ts`)**:
   - Wired `isDeterministicCommandRequest` into `planTask()` and `executeTask()` so read-only shell commands (`pwd`, `ls`, `git status`, `git diff`, `git log`) execute via policy-gated tools with 0 LLM calls.
5. **Model Lifecycle `READY` State Preservation (`packages/core/src/services/modelLifecycleService.ts`)**:
   - Preserves `stillVerified` (`READY` state) across read-only `discoverAndReconcile({ verify: false })` passes, paired with tiered `+30`/`+15` scheduler residency scoring.
6. **Shared Quota Groups (`quotaGroup`), Fleet Memory (`remember_fact`/`recall_facts`), Durable Handoffs (`wa handoff`), and Real-World E2E Acceptance Suite (`tests/live/realWorldAcceptance.test.ts`)**.

### Deferred (Explicitly Scoped Out with Tracked Follow-Up)
1. **`WorkspaceMutationAttributor` (`ec863ef`)**: Deferred to a dedicated branch because its cross-process snapshot ledger misses file writes that complete immediately prior to a tool timeout (`timeoutTermination.test.ts`). `v0.2.11`'s before/after snapshot diff remains active.

### Removed / Replaced (Eliminated to Prevent Duplicate Architectures)
1. **Inline `isDirectAnswerRequest` Fast-Path Bypass (`main@ed4f1d9`, `f7c97cf`)**: Replaced by the canonical `ChatAgent` + `isConversationalFastPathRequest` + `isDeterministicCommandRequest` architecture (see `FAST-PATH-DECISION.md`).
