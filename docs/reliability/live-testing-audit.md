# Wazir Live Testing & Reliability Audit (`v0.2.5`)

**Repository:** `~/Code/Wazir`  
**Branch:** `fix/comprehensive-live-reliability`  
**Audit Date:** 2026-10-17  
**Scope:** End-to-end reliability audit across all 14 Wazir subsystems, test suites, harnesses, and CI workflows.

---

## Executive Summary

A recent interactive `wa chat` session demonstrated that Wazir could accept user input without producing an observable outcome while existing automated tests passed. This audit examined the entire repository (`packages/**`, `apps/**`, `tests/**`, `scripts/**`, and `.github/workflows/**`) to identify why existing tests provided false confidence and where production reliability defects remained hidden.

### Root Causes of Systemic False Confidence
1. **Presentation-Mode Split Brain (`dashboard` vs `conversation`)**:
   `wa` and `wa chat` launch `FleetTui` in `presentationMode: 'conversation'` (`apps/cli/src/index.ts:1054,1095`). However, `FleetTui` defaults `this.presentationMode` to `'dashboard'` (`apps/cli/src/tui/fleetTui.ts:575`) when `options.presentationMode` is omitted. `TuiTestHarness` (`apps/cli/src/tui/inputHarness.ts:58`) omits `presentationMode`, causing 98% of `apps/cli/tests/fleetTui.test.ts` to test `dashboard` mode while asserting on internal fields (`tui.getStatusMessage()`, `tui.getCurrentView()`, `tui.expandedBlock`) that `ConversationRenderer` either never renders or clips to a transient single-line footer.
2. **In-Memory Object Invocation vs Real Process / PTY Execution**:
   Unit and E2E tests in `apps/cli/tests/*.test.ts` construct `RookEngine` in-memory with `MockInputStream` / `MockOutputStream` (`EventEmitter`s) rather than spawning `apps/cli/bin/wa.js` inside a real OS pseudo-terminal (`node-pty`). Meanwhile, process-spawning scripts (`scripts/smoke-test.mjs`, `scripts/tui-test-plan.mjs`, `scripts/package-check.mjs`) run with non-TTY pipes (`stdio: ['pipe', 'pipe', 'pipe']`), bypassing the TTY ANSI live-region renderer (`ConversationRenderer.render` lines 69–79) and raw-mode lifecycle controller.
3. **Mocked Wiring That Bypasses Production Security & Execution Paths**:
   Tests such as `packages/core/tests/codeMode.test.ts:24-34` use a hand-written mock `toolExecutor` to assert policy enforcement instead of instantiating `createCodeModeTool` (`packages/tools/src/codeModeTool.ts`), masking the fact that production `code_mode` bypassed `PolicyEngine` completely.
4. **Silent Test Skips & Platform Exclusions**:
   - `tests/runtime/liveModelMatrix.test.ts:184-190,256-261,298-302` executes `expect(true).toBe(true); return;` when local daemons are offline or in CI (`allowLiveDaemons = !isCI`), reporting skipped live runtime checks as green passing tests.
   - `packages/tools/tests/sandbox.test.ts:213-218` skips the entire live sandbox enforcement suite on macOS (`sandboxStatus().mode === 'bwrap'`), leaving `sandbox-exec` untested in live execution.
   - `tests/distributed/vitest.config.ts:2` throws an error on non-Linux platforms (`Distributed SIGKILL qualification requires Linux`), and all `tests/distributed/*.test.ts` files skip unless `WAZIR_DISTRIBUTED=1` is set.
5. **Worktree Test Contamination (`vitest.config.ts`)**:
   `vitest.config.ts:14` did not exclude `**/tmp/**`, causing `vitest` to discover and run stale duplicate test files inside `tmp/p0-remediation/**`.
6. **Unconditional Success Exit Codes in CLI & CI**:
   - Over 25 CLI subcommands in `apps/cli/src/index.ts` and `apps/cli/src/commands.ts` print red error strings on missing IDs or failed operations and exit with code `0` (`exitImproveOk()` in `index.ts:1533` explicitly calls `process.exit(0)` on all 19 `wa improve` commands).
   - `.github/workflows/ci.yml:81,92` appends `|| true` and `$global:LASTEXITCODE = 0` to `wa doctor`, masking unexpected CLI crashes.

---

## Part 1: Subsystem-by-Subsystem Audit (14 Subsystems × 8 Audit Questions)

### 1. CLI (`apps/cli/src/index.ts`, `apps/cli/src/commands.ts`, `apps/cli/src/searchCommands.ts`)
1. **What is currently tested?** `scripts/smoke-test.mjs` tests 16 read-only/list commands (`--version`, `--help`, `status`, `doctor`, `computers list`, `runtimes list`, `models list`, `agents list`, `tools list`, `policy list`, `executions list`, `history list`, `init`, `config show`, `secrets list`). `apps/cli/tests/doctor.test.ts` unit-tests `doctor(mockEngine)`.
2. **Mocked vs real?** `doctor.test.ts` uses a mock engine object. `smoke-test.mjs` spawns `bin/wa.js` against an empty workspace.
3. **Internal state vs user-visible behavior?** `smoke-test.mjs` checks stdout substrings and exit code `0`, but never tests mutating commands, `inspect`/`replay`/`merge`/`checkpoint`/`fork`/`rollback`/`promote` subcommands, or failure exit codes.
4. **Success and failure handling?** Failure handling is virtually untested at the CLI binary boundary.
5. **Can tests pass if unusable?** **Yes.** `wa computers inspect <id>` (`index.ts:146-152`) and `wa task status <id>` (`index.ts:514-520`) are hardcoded 3-line stubs that print fake green output (`Computer: <id>`, `Task <id>: queued`) and exit `0` without loading the engine.
6. **Assertions strong enough?** **No.** Missing-entity errors across `executions`, `history`, `jobs`, `artifacts`, `runtimes`, `benchmark`, `search`, `improve`, and `canary` return exit code `0`.
7. **Production binaries tested?** `bin/wa.js` is tested only for basic list commands in `smoke-test.mjs` and `package-check.mjs`.
8. **Concurrency, restarts, async failures?** Not exercised at the CLI command level.

### 2. Interactive TUI (`apps/cli/src/tui/fleetTui.ts`, `conversationRenderer.ts`, `terminalSession.ts`)
1. **What is currently tested?** `fleetTui.test.ts` (2,516 lines), `pasteBarrier.test.ts` (601 lines), `terminalIntegrity.test.ts` (653 lines), `tuiSessionLifecycle.test.ts` (494 lines), and `scripts/tui-test-plan.mjs`.
2. **Mocked vs real?** `TuiTestHarness` uses in-memory `EventEmitter` streams (`MockInputStream`/`MockOutputStream`), not a real PTY. `tui-test-plan.mjs` pipes stdin (`isTTY = false`) into `bin/wa.js chat`.
3. **Internal state vs user-visible behavior?** 95%+ of `fleetTui.test.ts` asserts on internal properties (`tui.getStatusMessage()`, `tui.getCurrentView()`, `tui.expandedBlock`) in `dashboard` mode.
4. **Success and failure handling?** Only shell command failure (`!sh -c "exit 7"`) and missing-model prompt failure were tested in conversation mode.
5. **Can tests pass if unusable?** **Yes.** In `conversation` mode (`wa chat`), `/why <topic>` renders nothing while locking keyboard input (`whyModalOpen = true`); `/block`, `/model-manager`, `/search`, `/improvement`, `/model-intelligence`, `/canary`, `/context`, `/provenance`, `/evidence`, and `/worktrees` produce zero visible output; unknown `/foo` commands (and `/status`, `/retry`, `/approve`, `/deny`, `/pin`, `/unpin`, `/clear`, bare `/sh`) fall through `submitCommand` and launch AI coding jobs!
6. **Assertions strong enough?** **No.** `tui-test-plan.mjs` batches all commands into a non-TTY pipe and checks coarse `.includes()` on combined stdout.
7. **Production binaries tested?** Only in non-TTY pipe mode (`tui-test-plan.mjs` and `tuiSessionLifecycle.test.ts`), never in a real PTY (`isTTY = true`).
8. **Concurrency, restarts, async failures?** Tested in-memory for `/fanout`, resize events, and duplicate submission IDs; not tested across real PTY sessions with live process restarts.

### 3. Agent Execution (`packages/agents/**`)
1. **What is currently tested?** 36 test files covering `CodingAgent`, `StepAgent`, `ExternalAgentAdapter`, `AcpAgentAdapter`, `AcpClient`, action parsing, repair loops, stop conditions, and subagent dispatch.
2. **Mocked vs real?** `CodingAgent` and `StepAgent` tests use scripted `AgentRuntime` generators and stubbed `executeTool` callbacks. `AcpClient` and `ExternalAgentAdapter` lifecycle tests spawn real child processes (`fakeAcpAgent.mjs`).
3. **Internal state vs user-visible behavior?** Validates yielded `AgentTurn` events and file changes in temp dirs.
4. **Success and failure handling?** Tests malformed JSON envelopes, tool errors, loop detection, and stream retries.
5. **Can tests pass if unusable?** **Yes.** `CodingAgent` (`codingAgent.ts:1778-1781`) skips failing host-side `VERIFY` checks (`build`, `test`, `lint`, `typecheck`) if output matches `/missing script|no such file|not found/i` (e.g., `Module not found` or `FileNotFoundError`), falsely reporting `VERIFICATION_PASSED`! Additionally, `StepAgent` (`stepAgent.ts:155`) omits `toolNames` when calling `parseAction(raw)` and skips host-side verification.
6. **Assertions strong enough?** Moderate; `codingAgent.terminationReason.test.ts` stubs `executeTool` rather than running the real `ToolRegistry` + `VerificationEngine`.
7. **Production binaries tested?** Source modules via Vitest; ACP tests run child Node scripts.
8. **Concurrency, restarts, async failures?** Stream retries, abort signals, and orphan process-group kills (`acpClient.orphan.test.ts`) are tested.

### 4. Task Planning, Orchestration & Verification (`packages/core/src/services/jobOrchestrator.ts`, `jobManager.ts`, `verificationEngine.ts`)
1. **What is currently tested?** `jobOrchestrator.test.ts`, `jobOrchestrator.concurrency.test.ts`, `jobOrchestrator.worktree.test.ts`, `jobManager.test.ts`, `verificationEngine.test.ts`, `executionVerification.test.ts`.
2. **Mocked vs real?** Real git worktrees (`WorktreeManager`) and real child processes in `verificationEngine.test.ts`; mock task executors in `jobOrchestrator.test.ts`.
3. **Internal state vs user-visible behavior?** Validates job DAG completion, worktree isolation, and merge outcomes.
4. **Success and failure handling?** Tests task failures, dependency cancellation, and merge conflicts.
5. **Can tests pass if unusable?** **Yes.**
   - `JobOrchestrator.doPump` (`jobOrchestrator.ts:600-605, 892`) deadlocks forever when `assignTask` returns `null` (because `readyNodes.unshift(node)` makes `readyNodes.length > 0` while `activeTasks.size === 0`).
   - `JobOrchestrator.assignTask` (`jobOrchestrator.ts:217`) creates a `'queued'` `ExecutionRecord` that `runOwnedJob` never closes (and `executeTask` duplicates at line 238), permanently blocking `ModelLifecycleService.unload()` with `MODEL_IN_USE`.
   - `MultiSurfaceService.getArtifactsForTarget` (`apps/api/src/multiSurface.ts:1502-1531`) fabricates a passing `'policy-and-sandbox-gate'` verification check whenever no checks were run.
6. **Assertions strong enough?** **No.** `jobOrchestrator.test.ts` never inspects `executionEngine.list()` after job completion.
7. **Production binaries tested?** Tested in-memory via Vitest.
8. **Concurrency, restarts, async failures?** Concurrency is tested in `jobOrchestrator.concurrency.test.ts`, but `assignTask` null-return deadlock and store-backed `JobManager` restart reconciliation were missed.

### 5. Local & Remote Model Routing (`packages/core/src/services/scheduler.ts`, `packages/scheduler/**`)
1. **What is currently tested?** `scheduler.test.ts`, `schedulerHeterogeneousFleet.test.ts`, `schedulerHostedRouting.test.ts`, `modelLifecycleAdmission.test.ts`.
2. **Mocked vs real?** Real `Scheduler`, `ModelRegistry`, `ComputerRegistry`, `RuntimeRegistry`, and `ResourceControlPlane`.
3. **Internal state vs user-visible behavior?** Validates `ScheduleDecision` and `ComputerScheduleDecision` objects.
4. **Success and failure handling?** Tests capability filtering, locality modes (`LOCAL_ONLY`, `PREFER_LOCAL`, `CLOUD_ALLOWED`, `NVIDIA`), and VRAM headroom vetoes.
5. **Can tests pass if unusable?** **Yes.**
   - In `apps/api/src/server.ts:1071-1147`, when a remote worker registers via `POST /computers/register` or heartbeats, `state.computers.register` updates `Computer`, but **never registers the worker's runtimes in `state.runtimes` or `ModelInstance`s in `state.models`**, causing `Scheduler.scheduleComputer` (`scheduler.ts:703-715`) to reject every remote worker!
   - `Scheduler.scheduleComputer` (`scheduler.ts:704`) only excludes `['DRAINING', 'UNLOADING', 'LOADING']`, allowing routing to instances in `'FAILED'` or `'UNAVAILABLE'` state!
   - `Scheduler.scheduleModel` (`scheduler.ts:221-225`) in `'NVIDIA'` routing mode wipes all `resource:*` rejection reasons (`preferred.rejected = []`), bypassing emergency stop, disabled account, and invalid API key blocks!
6. **Assertions strong enough?** Unit tests manually pre-populated `ModelRegistry.upsertInstance`, hiding the API server registration gap.
7. **Production binaries tested?** Tested in-memory via Vitest.
8. **Concurrency, restarts, async failures?** Tested in single-process memory.

### 6. Runtime Discovery & Activation (`packages/runtimes/**`, `packages/core/src/services/modelLifecycleService.ts`)
1. **What is currently tested?** Adapter unit tests (`ollama`, `lmstudio`, `openai`, `anthropic`, `google`, `nvidia`) and `tests/runtime/adapterContract.suite.ts`.
2. **Mocked vs real?** Local HTTP servers (`node:http`) for `ollama` and `lmstudio`; mocked `fetch` for cloud providers.
3. **Internal state vs user-visible behavior?** Validates yielded `RuntimeExecutionEvent` streams.
4. **Success and failure handling?** Tests HTTP 401/429/500 errors, retries, and mid-stream disconnects (for Ollama/LM Studio).
5. **Can tests pass if unusable?** **Yes.**
   - **False Success on Abort/Timeout**: 5 adapters (`ollama/src/index.ts:397`, `lmstudio/src/index.ts:645`, `openai/src/index.ts:303`, `anthropic/src/index.ts:296`, `google/src/index.ts:341`) catch `controller.signal.aborted` and yield `{ type: 'completed', content: full }` instead of `{ type: 'error', failureClass: 'CANCELLED' }`!
   - **False Success on Truncated Cloud SSE Streams**: `openai`, `anthropic`, `google`, and `nvidia` adapters ignore malformed JSON chunks (`catch { continue; }`) and yield `{ type: 'completed' }` on premature stream EOF without verifying `[DONE]`, `message_stop`, or `finishReason`. In fact, `packages/runtimes/openai/tests/adapter.test.ts:87-97` explicitly asserted this broken behavior as passing!
6. **Assertions strong enough?** **No.** `liveModelMatrix.test.ts` uses `expect(true).toBe(true)` when daemons are unavailable.
7. **Production binaries tested?** Tested via Vitest.
8. **Concurrency, restarts, async failures?** Tested via fault-injection HTTP servers in `tests/reliability/providerFaults.test.ts`.

### 7. Tool Execution, Sandboxing & Authorization (`packages/tools/**`, `packages/core/src/services/policyEngine.ts`)
1. **What is currently tested?** 17 test files in `packages/tools/tests/` (`security.test.ts`, `sandbox.test.ts`, `physicalExecution.test.ts`, `atomicWrite.test.ts`, `processGroupCleanup.test.ts`, `timeoutTermination.test.ts`, `terminalSession.test.ts`) and `packages/core/tests/policy.test.ts`, `codeMode.test.ts`.
2. **Mocked vs real?** Real filesystem, real child processes, real PTYs in `packages/tools/tests/`; mocked `toolExecutor` in `codeMode.test.ts`.
3. **Internal state vs user-visible behavior?** Validates file mutations, command output, and policy decisions.
4. **Success and failure handling?** Tests path traversal (`../`), symlink escape, command injection, and timeouts.
5. **Can tests pass if unusable?** **Yes—Critical Security/Policy Bypasses Found:**
   - **`code_mode` Full Policy Bypass (`packages/tools/src/codeModeTool.ts:11-40,65-89`)**: `codeModeTool` declares `permissions: ['filesystem_read']` (so `PolicyEngine` auto-allows it) and wires `CodeModeService` directly to `executeTool(registry, ...)` without `PolicyEngine`, allowing arbitrary `wazir.write`, `wazir.edit`, `wazir.git`, and `wazir.call('shell', ...)` with zero authorization!
   - **`terminal_open` & `terminal_send` Policy and Sandbox Bypass (`packages/core/src/services/policyEngine.ts:471-484`, `packages/tools/src/terminalSession.ts:154`)**: `PolicyEngine.evaluateTool` auto-allows `permissions: ['shell_execute']` for any tool not named `'shell'`, and `TerminalSession` spawns an unsandboxed `bash` PTY.
   - **`find -exec ... +` Bypass (`packages/core/src/services/policyEngine.ts:1288-1295`)**: `classifySafeCommandArgs` only searches for `;`, so `find . -exec echo {} + -delete` sets `i = args.length` and skips `-delete` (and never validates inner arguments of `-exec`).
   - **Workspace Build Auto-Allow (`policyEngine.ts:940`)**: `classifyBuildWorkspace` auto-allows `make`, `cargo run`, `go run` before `ASK_SHELL_COMMANDS` without checking if build files (`Makefile`, `Cargo.toml`, `.go`) were modified during the execution.
6. **Assertions strong enough?** **No.** `codeMode.test.ts` mocked the policy check; `sandbox.test.ts` skipped live enforcement on macOS.
7. **Production binaries tested?** Tested via Vitest.
8. **Concurrency, restarts, async failures?** Process-group cleanup and timeout SIGTERM/SIGKILL escalation are well tested.

### 8. Distributed Workers & Fleet Scheduling (`apps/api/**`, `apps/worker/**`, `packages/workers/**`, `tests/distributed/**`)
1. **What is currently tested?** `apps/api/tests/*.test.ts`, `packages/workers/tests/*.test.ts`, `tests/distributed/*.test.ts`.
2. **Mocked vs real?** `tests/distributed/*.test.ts` spawns real API and Worker processes; `apps/api/tests/*.test.ts` runs Express in-process.
3. **Internal state vs user-visible behavior?** Validates HTTP status codes, SSE dispatch, leases, and task results.
4. **Success and failure handling?** Tests worker SIGKILL, lease takeover, and idempotency keys.
5. **Can tests pass if unusable?** **Yes.**
   - `tests/distributed/vitest.config.ts:2` threw an error on macOS, preventing distributed tests from running locally on macOS.
   - `Worker.runTaskStream` (`packages/workers/src/worker.ts:339-360`) has no read/heartbeat timeout on `reader.read()`, hanging forever on half-open TCP connections.
   - `TaskDispatcher.recordEvent` (`apps/api/src/server.ts:241-249`) slices `events` at 10,000 items while `dispatchRemote` (`packages/workers/src/remoteDispatch.ts:81-88`) polls by array index (`seen < status.events.length`), dropping all events after 10,000.
   - `Worker.adapterForModel` (`packages/workers/src/worker.ts:213`) blindly falls back to the first healthy adapter even if that runtime does not serve the requested model.
6. **Assertions strong enough?** Moderate in `tests/distributed/`, but skipped by default in `npm test`.
7. **Production binaries tested?** `tests/distributed/` runs `apps/api/dist/main.js` and `apps/worker/dist/index.js` when enabled.
8. **Concurrency, restarts, async failures?** Exercised in `tests/distributed/`, except `RecoveryManager` is never wired into `apps/api/src/server.ts`.

### 9. Context & Conversation Management (`packages/core/src/services/contextEngine.ts`, `conversationRenderer.ts`)
1. **What is currently tested?** `packages/core/tests/contextEngine.test.ts`, `contextCompaction.test.ts`, `conversationRenderer` via `fleetTui.test.ts` and `terminalIntegrity.test.ts`.
2. **Mocked vs real?** Real `ContextEngine` and `ConversationRenderer`.
3. **Internal state vs user-visible behavior?** Validates token estimation, compaction generations, and ANSI output frames.
4. **Success and failure handling?** Tests budget limits and duplicate submission suppression.
5. **Can tests pass if unusable?** **Yes.** In `FleetTui.renderContextPane` (`fleetTui.ts:7386-7403`), when `this.contextSamples.length === 0`, the dashboard fabricates 7 fake generations (`G1..G7`) instead of showing the real empty state! And in `conversation` mode, `/compact` and `/clear-context` never append durable confirmation to the transcript.
6. **Assertions strong enough?** `fleetTui.test.ts` actually asserted on the fabricated `G1..G7` dashboard data!
7. **Production binaries tested?** Via Vitest and `tui-test-plan.mjs`.
8. **Concurrency, restarts, async failures?** Tested for rapid resize and submission deduplication.

### 10. Persistence, Checkpoints & Recovery (`packages/database/**`, `checkpointService.ts`, `executionEngine.ts`, `jobManager.ts`)
1. **What is currently tested?** `checkpointService.test.ts`, `executionPersistence.test.ts`, `jobRecovery.test.ts`, `tests/reliability/checkpointIntegrity.test.ts`, `restartPersistence.test.ts`, `postgresStore.test.ts`.
2. **Mocked vs real?** Real `JsonFileStore` and child processes in `tests/reliability/`; `MemoryStore` (or no store) in `checkpointService.test.ts`.
3. **Internal state vs user-visible behavior?** Validates file/git restoration and execution state transitions.
4. **Success and failure handling?** Tests crash recovery and dirty workspace blocking.
5. **Can tests pass if unusable?** **Yes—Multiple Broken Recovery & Lost State Bugs Found:**
   - `CheckpointService.checkpoint()`, `fork()`, and `rollback()` (`checkpointService.ts:140-146, 218-238, 301-360`) mutate `ExecutionRecord` in memory and call `pushEvent` without calling `executionEngine.flush(record)`, losing all `ExecutionRecord` checkpoint/rollback state on restart!
   - `ExecutionEngine` constructor (`executionEngine.ts:151-156`) fails to recover orphaned local executions if PID is reused (e.g., container PID 1) or hostname changes across container recreation, and ignores `'paused'` executions (`pausedExecutions` set is not restored from store).
   - `JobManager` (`jobManager.ts:62, 368-385`) skips `reconcileStaleStatus()` on startup when `this.store` is configured, and `jobManager.resume(id)` fails to set `job.status = 'ready'` when `this.store` is present and throws `JOB_LEASE_LOST`!
6. **Assertions strong enough?** **No.** `checkpointService.test.ts` ran without a `store`, completely missing the persistence bug.
7. **Production binaries tested?** Child scripts in `tests/reliability/`.
8. **Concurrency, restarts, async failures?** Tested in `tests/reliability/`, but missed `CheckpointService` record flushing and `JobManager.resume()` with a store.

### 11. Resource Budgets & Account Management (`packages/core/src/resources/**`)
1. **What is currently tested?** `resources.test.ts`, `resourcesMultiProcess.test.ts`, `resourceValidation.test.ts`, `resourceTelemetryGate.test.ts`.
2. **Mocked vs real?** Real SQLite (`node:sqlite`) database files and multi-process worker contention.
3. **Internal state vs user-visible behavior?** Validates `AdmissionDecision`, reservations, ledger settlements, and cooldowns.
4. **Success and failure handling?** Tests quota exhaustion, rate limits, auth failures, and crash lease recovery.
5. **Can tests pass if unusable?** **Yes.** Under `DEFAULT_POLICY.enforce = false` (`packages/core/src/resources/types.ts:171`), `TokenBudgetManager.admit` (`budgetManager.ts:132-136`) downgrades `local_busy` (`deferred`) to `outcome: 'admitted'`, causing `governAdapter` (`governedAdapter.ts:94-114`) to bypass the local concurrency queue completely!
6. **Assertions strong enough?** Tests in `resources.test.ts` explicitly passed `enforce: true`, missing the default `enforce: false` concurrency bypass in `governAdapter`.
7. **Production binaries tested?** Tested via Vitest.
8. **Concurrency, restarts, async failures?** Multi-process SQLite contention is tested in `resourcesMultiProcess.test.ts`.

### 12. External Agents, Mobile/MultiSurface API & Hosted Providers (`packages/agents/src/acp/**`, `apps/api/src/mobile.ts`, `multiSurface.ts`)
1. **What is currently tested?** `acpClient.*.test.ts`, `acpAgentAdapter.test.ts`, `mobileApi.test.ts`, `multiSurface.test.ts`.
2. **Mocked vs real?** Express in-process for `mobileApi.test.ts` and `multiSurface.test.ts`; child processes for ACP.
3. **Internal state vs user-visible behavior?** Validates REST/SSE responses and ACP JSON-RPC framing.
4. **Success and failure handling?** Tests auth tokens, pairing, and task submission.
5. **Can tests pass if unusable?** **Yes.**
   - `MobileServices.runManagedTask` (`apps/api/src/mobile.ts:1989-1992`) **never invokes an agent or model** when a user submits a task with a prompt (`plannedOperations` omitted): it defaults to `[{ tool: { name: 'read', input: { path: 'package.json' } } }]`, reads `package.json`, fabricates token counts, and marks the task `'completed'`!
   - `MultiSurfaceService.runScheduleNow` (`apps/api/src/multiSurface.ts:1234`) sets `sched.lastStatus = 'completed'` synchronously before the task even runs.
6. **Assertions strong enough?** **No.** `mobileApi.test.ts` and `multiSurface.test.ts` passed explicit `operations` arrays or only asserted `status === 'completed'`, hiding the hardcoded `package.json` stub.
7. **Production binaries tested?** Tested via Vitest.
8. **Concurrency, restarts, async failures?** `MobileEventHub.publish` (`mobile.ts:487`) fires unawaited `void this.persistState()` promises that race with shutdown.

### 13. Self-Improvement & Canary Mechanisms (`packages/core/src/services/selfImprovementService.ts`, `canaryDeploymentService.ts`, `searchService.ts`)
1. **What is currently tested?** `selfImprovement.test.ts`, `canaryDeployment.test.ts`, `searchService.test.ts`, `evaluator.test.ts`.
2. **Mocked vs real?** Real git worktree isolation in `selfImprovement.test.ts`; in-memory stores.
3. **Internal state vs user-visible behavior?** Validates experiment lifecycle, promotion gates, and rollback.
4. **Success and failure handling?** Tests promotion denial and regression rollback.
5. **Can tests pass if unusable?** **Yes.**
   - Every `wa improve *` CLI command (`apps/cli/src/index.ts:1533-1728`) calls `exitImproveOk()` (`process.exit(0)`), returning exit code `0` even when experiments are missing, blocked by git conflicts, or denied promotion!
   - In `FleetTui.renderImprovementPane` (`apps/cli/src/tui/fleetTui.ts:7309-7331`), when `experiments.length === 0`, the TUI fabricates a fake promoted experiment `exp-042` and healthy canary `canary-01`!
6. **Assertions strong enough?** CLI exit codes for `wa improve`, `wa search`, and `wa canary` were never tested.
7. **Production binaries tested?** Only unit-tested in-memory.
8. **Concurrency, restarts, async failures?** Worktree cleanup is tested in unit tests.

### 14. Error Handling, Observability, Installation & Release Packaging (`scripts/smoke-test.mjs`, `package-check.mjs`, `release-gate.mjs`, `.github/workflows/**`)
1. **What is currently tested?** `smoke-test.mjs`, `package-check.mjs`, `release-gate.mjs`, and `.github/workflows/{ci,reliability,release,postgres-distributed}.yml`.
2. **Mocked vs real?** `package-check.mjs` runs `npm pack` and installs the tarball into a temp directory.
3. **Internal state vs user-visible behavior?** Validates binary installation and basic command output.
4. **Success and failure handling?** Only checks happy-path exit code `0` (and allows `0 || 1` on `wa doctor`).
5. **Can tests pass if unusable?** **Yes.**
   - `wa status` (`apps/cli/src/status.ts:52, 77-80, 141`) hardcodes `version: '0.1.2'`, `executions: { active: 0, queued: 0 }`, and `Agents -> active: 0`.
   - `serviceManager.ts:147-186` (macOS `launchd`) ignores `options.port` and `options.apiUrl` when generating the plist `ProgramArguments`.
   - `.github/workflows/ci.yml:81,92` uses `|| true` on `wa doctor`.
6. **Assertions strong enough?** **No.** Release gate did not include a live interactive PTY + end-to-end execution reliability gate.
7. **Production binaries tested?** Yes (`package-check.mjs`), but only with trivial read-only invocations and EOF pipe exit.
8. **Concurrency, restarts, async failures?** Not exercised in packaging checks.

---

## Part 2: Prioritized Remediation Matrix

| ID | Severity | Category | Subsystem & Location | Defect Summary |
| :--- | :--- | :--- | :--- | :--- |
| **DEF-01** | **P0** | Silent Failure / Input Freeze | `apps/cli/src/tui/fleetTui.ts:848, 2283, 3825-4303` | In `conversation` mode (`wa chat`), `/why` renders nothing and freezes keyboard input; `/block`, `/model-manager`, `/search`, `/improvement`, `/model-intelligence`, `/canary`, `/context`, `/provenance`, `/evidence`, `/worktrees` produce zero output; `/model`, `/cancel`, `/compact`, `/steer`, `/clear-context` never append durable transcript output; unknown `/foo` commands (plus `/status`, `/retry`, `/approve`, `/deny`, `/pin`, `/unpin`, `/clear`, bare `/sh`) launch AI coding jobs; pending approvals block typing `/fleet`, `/approve`, `/deny`. |
| **DEF-02** | **P0** | False Success (CLI Stubs) | `apps/cli/src/index.ts:146-152, 514-520`, `status.ts:52,77` | `wa computers inspect <id>` and `wa task status <id>` are hardcoded stubs returning exit 0 with fake output; `wa status` hardcodes `version: '0.1.2'` and `active: 0, queued: 0`; `FleetTui` `/doctor` hardcodes healthy status; `renderImprovementPane` and `renderContextPane` fabricate `exp-042` and `G1..G7`. |
| **DEF-03** | **P0** | False Success (CLI Exit Codes & Ignored Flags) | `apps/cli/src/index.ts`, `apps/cli/src/commands.ts` | `exitImproveOk()` forces `process.exit(0)` on all 19 `wa improve` commands; `runtimes inspect`, `executions inspect|replay`, `history inspect`, `benchmark run`, `jobs inspect|merge|checkpoint|fork|rollback`, `artifacts *`, `search *`, `canary *`, `service install` exit 0 on failure; `wa history list --command` is ignored due to `command` vs `commandContains` mismatch. |
| **DEF-04** | **P0** | Unauthorized Execution | `packages/tools/src/codeModeTool.ts`, `policyEngine.ts:472, 940, 1288`, `terminalSession.ts:154` | `code_mode` auto-allowed as `filesystem_read` and executes all tools (`shell`, `write`, `edit`, `git`) without `PolicyEngine`; `terminal_open`/`terminal_send` bypass `PolicyEngine` and OS sandboxing; `find -exec ... +` skips remaining args; `classifyBuildWorkspace` auto-allows `make`/`cargo`/`go` even when build files were written by the agent. |
| **DEF-05** | **P0** | False Success (Runtimes & Verification) | `packages/runtimes/{ollama,lmstudio,openai,anthropic,google,nvidia}`, `codingAgent.ts:1759-1781`, `stepAgent.ts:155` | Aborted/timed-out streams in 5 adapters yield `{ type: 'completed' }` instead of `CANCELLED` error; truncated cloud SSE streams yield `{ type: 'completed' }`; `CodingAgent` skips failed `VERIFY` checks matching `/no such file|not found/i` and checks missing artifacts by basename; `StepAgent` omits `toolNames` in `parseAction`. |
| **DEF-06** | **P0** | False Success (Mobile/MultiSurface) | `apps/api/src/mobile.ts:1989-1992`, `multiSurface.ts:1234, 1502-1531` | `MobileServices.runManagedTask` defaults to reading `package.json` with fake token counts instead of executing the prompt; `MultiSurfaceService` fabricates passing `policy-and-sandbox-gate` verification checks and marks schedules `completed` before execution finishes. |
| **DEF-07** | **P1** | Infinite Execution / Deadlock | `packages/core/src/services/jobOrchestrator.ts:600-605, 892`, `worker.ts:339-360` | `JobOrchestrator.doPump` deadlocks forever when `assignTask` returns `null`; `Worker.runTaskStream` has no SSE read/heartbeat timeout on half-open connections. |
| **DEF-08** | **P1** | Duplicate Execution & Orphan Records | `packages/core/src/services/jobOrchestrator.ts:217-247, 649` | `JobOrchestrator.assignTask` creates orphaned `'queued'` `ExecutionRecord`s (and duplicates them in `executeTask`), permanently blocking `ModelLifecycleService.unload()` with `MODEL_IN_USE`. |
| **DEF-09** | **P1** | Invalid Routing | `apps/api/src/server.ts:1071-1147`, `scheduler.ts:221-225, 704`, `worker.ts:213` | Remote workers registered via `POST /computers/register` never populate `RuntimeRegistry` or `ModelRegistry` (`Scheduler` rejects all remote workers); `scheduleComputer` routes to `'FAILED'`/`'UNAVAILABLE'` model instances; `'NVIDIA'` routing mode wipes `resource:*` vetoes; `Worker.adapterForModel` falls back to unrelated runtime adapters. |
| **DEF-10** | **P1** | Lost State & Broken Recovery | `checkpointService.ts:140, 218, 320`, `executionEngine.ts:151`, `jobManager.ts:62, 368`, `server.ts` | `CheckpointService` mutates `ExecutionRecord` without flushing to store; `ExecutionEngine` orphan recovery fails on container PID 1 reuse / hostname change and `'paused'` state; `JobManager` skips startup reconciliation when store is present and `resume()` throws `JOB_LEASE_LOST`; `RecoveryManager` is not wired into `apps/api`; `TaskDispatcher` ring-buffer slicing breaks index-based event polling in `dispatchRemote`. |
| **DEF-11** | **P1** | Resource Overrun | `packages/core/src/resources/governedAdapter.ts:94-114`, `budgetManager.ts:132-136` | `TokenBudgetManager.admit` downgrades `local_busy` (`deferred`) to `admitted` when `enforce: false`, bypassing `governAdapter`'s local concurrency queue. |
| **DEF-12** | **P1** | Test Harness & CI Gaps | `vitest.config.ts:14`, `tests/distributed/vitest.config.ts:2`, `sandbox.test.ts:213`, `.github/workflows/ci.yml` | `vitest.config.ts` does not exclude `**/tmp/**`; `tests/distributed/vitest.config.ts` throws on macOS; `sandbox.test.ts` skips live `sandbox-exec` tests on macOS; `liveModelMatrix.test.ts` uses `expect(true).toBe(true)`. |
