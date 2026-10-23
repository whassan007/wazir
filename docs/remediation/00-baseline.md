# Phase 0 — Baseline and Architectural Reconnaissance

## 1. Canonical Baseline Selection & Justification

- **Selected Canonical Base Commit**: `2846834280099ed22c29b2f8d058f80343c07320` (`main` / `origin/main` / annotated tag `v0.2.12`)
- **Canonical Remediation Branch**: `remediation/v0.2.13`
- **Preserved Historical/Working Branches**:
  - `main` (`2846834280099ed22c29b2f8d058f80343c07320`)
  - `v0.2.11` / `origin/agy/autonomous-remediation-supervisor` (PR #16, `56ad6ee957704e4fa98b3f5b150e29eb08d86b6a`)
  - `v0.2.10` / `origin/release/v0.2.10` (`71b409c89f9772347959b7d70fa6fa73d1414df4`)
  - `feat/autonomous-auto-updater` (`9f70a61389962476120e58a07af2c462e5dc8d34`)
  - `origin/fix/comprehensive-live-reliability` (PR #15, `b8e0e408c8828d7f22eaf58c93cf41ae30cbc8bc`)
  - `fix/release-integrity` (`87d4a343c2e69570ca10f10ae8cab700f71ae233`)
  - `fix/release-v024-linux-deps` (`835e1f9310cfb76bc7d4b62c53696249cdb4f3f5`)
  - `fix/antigravity-wazir-qa` (`8e67ba0153c599043639e9226b8ee2e4f73a1914`)

### Why `main` (`2846834`, `v0.2.12`) is the Canonical Source Baseline
1. `main` (`2846834`) already unifies `v0.2.11` (`56ad6ee`, PR #16) and `origin/main` (`f7c97cf`), including NVIDIA hosted inference (`packages/runtimes/nvidia`), Mission Control TUI (`apps/cli/src/tui/fleetTui.ts`), 3-tier execution routing, fleet routing guardrails (`apps/cli/src/subagentFleet.ts`), workspace-scoped verification (`packages/agents/src/verificationScope.ts`), git-HEAD integrity guard (`packages/tools/src/repoIntegrityGuard.ts`), production dependency vulnerability upgrades (`f3b115a`), and `ResourceRouter` ledger caching (`a774e2e`).
2. Baseline build, typecheck, and unit/integration test status at `2846834`:
   - `npm run build`: **PASS** (0 errors across all 26 workspaces + Rust/Tauri desktop binary + `bin/wa.js` bundle)
   - `npm run typecheck`: **PASS** (0 errors)
   - `vitest run`: **354 test files — 2,611 passed, 52 skipped, 0 failed**
3. Starting from `2846834` avoids regressing any `v0.2.12` capability while allowing clean, targeted restoration of the orphaned `v0.2.8`–`v0.2.10` / `feat/autonomous-auto-updater` lineage (`1d1ce13`, `9f70a61`), `fix/release-integrity` (`87d4a34`), `fix/release-v024-linux-deps` (`835e1f9`), and full remediation of all P0, P1, and P2 defects.

---

## 2. Lineage Divergence Analysis (`main` vs `v0.2.10`, `v0.2.11`, PR #15, PR #16)

| Lineage / Ref | Commit SHA | Relationship to `main` (`2846834`) | Key Findings |
|---|---|---|---|
| `v0.2.8` (`origin/feat/autonomous-auto-updater`) | `d7bac4cca3acfee865df90e1fb6bf83ba96ee7bf` | **Divergent (Not in `main`)** | Contains `1d1ce13` (`feat(updater): add autonomous five-minute Wazir updates`) and `d7bac4c`. Was rolled back from `test/real-world-acceptance` during early `v0.2.8` testing and never re-merged into `v0.2.11` or `v0.2.12`. |
| `feat/autonomous-auto-updater` (local) | `9f70a61389962476120e58a07af2c462e5dc8d34` | **Divergent (Not in `main`)** | Adds `9f70a61` (`fix(updater): decouple CLI build from Tauri/Cargo; cover rollback safety paths`, `scripts/build-cli.mjs`) on top of `v0.2.8`. |
| `v0.2.9` (`origin/release/v0.2.9`) | `531de53ef59f6191529f6d73fd3df3b19c0a81db` | **Partially cherry-picked** | Built on `v0.2.8`. Its code fixes (`78d5c35` -> `6a6fb8b`, `b383260` -> `f6a6ce7`, `f1c26f3` -> `8313558`) are in `main`, but the underlying `v0.2.8` updater (`1d1ce13`) was left behind. |
| `v0.2.10` (`origin/release/v0.2.10`, Latest Release) | `71b409c89f9772347959b7d70fa6fa73d1414df4` | **Partially cherry-picked** | Built on `v0.2.9`. Commit `e7a88af` is in `main` as `8cc6c00`, but `v0.2.10` is the last non-Draft GitHub Release because `.github/workflows/release.yml` hardcodes `draft: true`. |
| `v0.2.11` / PR #16 (`origin/agy/autonomous-remediation-supervisor`) | `56ad6ee957704e4fa98b3f5b150e29eb08d86b6a` | **Merged into `main`** | Merged via `integration/v0.2.12-completion` (`f046490`). |
| PR #15 (`origin/fix/comprehensive-live-reliability`) | `b8e0e408c8828d7f22eaf58c93cf41ae30cbc8bc` | **Divergent (Partially superseded)** | Contains live reliability gate (`scripts/live-reliability-gate.mjs`), CI reliability workflow fixes (`c4caec2`, `b8e0e40`), and orchestrator/CLI reliability fixes. |
| `fix/release-integrity` & `fix/release-v024-linux-deps` | `87d4a343` & `835e1f93` | **Divergent (Not in `main`)** | Contains `scripts/release-integrity.mjs`, `scripts/api-health-smoke.mjs`, `tests/release/release-integrity.test.mjs`, and Linux build dependency installation in `.github/workflows/release.yml`. |

---

## 3. Reproducible Defects Inventory Summary (Phase 1 – Phase 6)

### Phase 1 — Release Reconciliation and CI Integrity (P0)
- **ISS-001 (P0)**: Autonomous updater (`apps/cli/src/updater/*`, `wa update`, `scripts/build-cli.mjs`) from `v0.2.8`–`v0.2.10` (`1d1ce13`, `9f70a61`) is completely missing from `main` (`2846834`).
- **ISS-002 (P0)**: `.github/workflows/ci.yml` and `.github/workflows/reliability.yml` run `npm run build` on `ubuntu-latest` without installing Linux WebKitGTK/Tauri system prerequisites (`libwebkit2gtk-4.1-dev`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`), and `reliability.yml` watches `'test/reliability/**'` instead of `'tests/reliability/**'`.
- **ISS-003 (P0)**: `.github/workflows/release.yml` checks out mutable `ref: ${{ needs.verify.outputs.tag }}` instead of the verified commit SHA, runs only 6 test files in `verify-cross-platform`, and hardcodes `draft: true` instead of enforcing `release-integrity.mjs` (`87d4a34`).
- **ISS-004 (P0)**: Debian (`packaging/deb/debian/control`) and RPM (`packaging/rpm/wazir.spec`) declare `nodejs (>= 22.5.0)` while `package.json` and `scripts/bundle.mjs` enforce `Node.js >= 22.13.0` (`node:sqlite`); Homebrew (`Formula/wazir.rb`, `packaging/homebrew/Formula/wazir.rb`) and Scoop (`bucket/wazir.json`, `packaging/scoop/wazir.json`) are stuck at version `0.2.5`; `scripts/build-deb.mjs` and `scripts/build-rpm.mjs` write invalid `ExecStart=/usr/bin/wa worker start` and `/usr/bin/wa api start`.
- **ISS-005 (P0)**: License and workspace metadata drift: root `package.json` declares `AGPL-3.0-only` while RPM/Homebrew/Scoop/updater scripts declare `AGPL-3.0-or-later`; 24 workspace `package.json` files have drifted versions (`0.1.28`, `0.1.0`, `0.2.11`) and lack `license` and `engines.node` metadata; `apps/cli/src/index.ts:21` fallback version is hardcoded to `'0.2.11'`.

### Phase 2 — Execution Correctness (P0)
- **ISS-006 (P0)**: Fast-path classification & expected-file bypasses (`apps/cli/src/run.ts`, `packages/agents/src/codingAgent.ts`, `packages/agents/src/chatAgent.ts`):
  - `expectedArtifacts: options.expectedFiles` is never passed to `agent.run()` in `executeTask` (`run.ts:1042`) or `runSubagent` (`run.ts:1742`).
  - `mutationRequired: taskAnalysis?.mutationRequired` is omitted from `isConversationalFastPathRequest` (`run.ts:261, 1037`), and `fastPathRequest` overrides `mutationRequired` to `false` (`run.ts:1047`).
  - `options.type === 'chat'` routes unconditionally to `wazir-chat` (`ChatAgent`), bypassing `expectedFiles` and `mutationRequired`.
  - `CONVERSATIONAL_INTENT_RE` (`codingAgent.ts:189`) matches any prompt ending in `?`, routing mutation requests phrased as questions into the tool-free conversational fast path.
- **ISS-007 (P0)**: Silent EOF & partial streaming output accepted as `completed` (`packages/runtimes/{nvidia,openai,anthropic,google}/src/index.ts`, `packages/agents/src/{codingAgent,chatAgent,stepAgent}.ts`):
  - `NvidiaAdapter`, `OpenAIAdapter`, `AnthropicAdapter`, and `GoogleAdapter` emit `{ type: 'completed' }` on stream EOF even when terminal completion markers (`[DONE]`, `finish_reason`, `message_stop`) were never received, and silently swallow malformed JSON chunks.
  - `CodingAgent` conversational fast-path (`codingAgent.ts:1477`), `ChatAgent`, and `StepAgent` accept truncated partial output on timeout or premature stream termination without requiring a terminal `completed` event.
- **ISS-008 (P0)**: Independent verification bypass (`apps/cli/src/run.ts:1221`, `packages/evaluation/src/index.ts:217`):
  - `evaluateExecution` in `run.ts` is called without `mutationRequired: taskAnalysis?.mutationRequired`.
  - `evaluateExecution` in `packages/evaluation/src/index.ts:217-220` suppresses unresolved failed shell commands whenever `hasCurrentPassingChecks` is true.
- **ISS-009 (P0)**: Preflight and activation failures leave execution records missing or stuck in `'queued'` (`apps/cli/src/run.ts:391-448`, `apps/cli/src/commands.ts:897-913`):
  - When `engine.lifecycle.activateExecution()` throws, the created execution record remains permanently in `status: 'queued'` instead of recording the error and transitioning to `'failed'`.
  - When `planTask` or `planTaskResume` fails in `executeTask`, no terminal `'failed'` record/event is persisted.
- **ISS-010 (P0)**: `wa task status <id>` (`apps/cli/src/index.ts:566-572`) is a hardcoded placeholder (`console.log(chalk.green(\`Task ${id}: queued\`))`) that never queries `engine.executions` or `engine.jobManager`.
- **ISS-011 (P0)**: Immediate user-visible token streaming & cancellation propagation (`apps/cli/src/run.ts`, `apps/cli/src/commands.ts`, `packages/runtimes/nvidia/src/index.ts`):
  - `commands.ts:929` sets `streamJson: options.json ? false : undefined`, disabling JSON token streaming, and non-JSON `wa run` never streams tokens to the user and truncates the final result to 500 chars (`commands.ts:952`).
  - `NvidiaAdapter.generate` ignores `request.signal`; remote execution (`run.ts:696`) and `subagentRuntime` (`run.ts:1563`) do not propagate `AbortSignal` or `cancelCurrentTurn`.

### Phase 3 — Durable Recovery and Distributed Correctness (P1)
- **ISS-012 (P1)**: Invalid status transitions (`packages/core/src/services/statusTransitions.ts:57-61`, `executionEngine.ts`, `apps/cli/src/run.ts:1028`):
  - `canTransitionJob(from, to)` allows terminal-to-terminal transitions (`completed -> failed`, `cancelled -> completed`).
  - Direct `failed -> running` resume in `run.ts` without prior `execution.resumed` event throws `InvalidStatusTransitionError`.
- **ISS-013 (P1)**: Lost/stuck executions & unsafe mutating tool replay on restart (`packages/core/src/services/jobManager.ts:58-85`, `executionRecovery.ts:151-225`):
  - `JobManager.load()` has an inverted guard (`if (!this.store) await this.reconcileStaleStatus(job)`), skipping stale job reconciliation whenever a persistent store is configured.
  - `JobManager.acquire()` resets expired `'running'` tasks to `'idle'`/`'pending'` without checking `ExecutionEngine.findUnknownOutcomeToolCall()`, risking unsafe replay of mutating tools.
  - `reconcileLocalOutcomes()` skips standalone `wa run` executions that crashed between turns without an unmatched `tool.started` checkpoint, leaving them stuck in `status: 'running'`.
- **ISS-014 (P1)**: Distributed lease fencing, duplicate dispatch & idempotent finalization (`packages/core/src/services/executionEngine.ts`, `apps/api/src/server.ts:642-649, 1412-1441`):
  - `ExecutionEngine.assertLease()` mutates `record.events` in memory before throwing `StaleWorkerLeaseError` without persisting.
  - `apps/api/src/server.ts` (`recordExecution`) keys by `requestId` instead of `executionId`, writes a malformed partial record lacking required `ExecutionRecord` fields, and uses `current ?? ...` which drops completion updates when the record already exists.
- **ISS-015 (P1)**: Resource admission & reservation leaks on provider/load errors (`packages/core/src/resources/governedAdapter.ts:102-123`, `packages/core/src/services/modelLifecycleService.ts:582-590`):
  - `governedAdapter.ts` charges conservative input tokens (`budget.reconcile`) instead of releasing the reservation (`budget.fail`) when `inner.generate()` throws before emitting any output.
  - `modelLifecycleService.ts` leaks `ResourceReservation` permanently when both `loadModel()` and `inspectModel()` fail.

### Phase 4 — Security, Mobile, and Automatic Updates (P1)
- **ISS-016 (P1)**: Mobile version reporting, protocol negotiation, and credential rotation (`apps/api/src/mobile.ts:34-36, 2793-2818`, `apps/api/src/auth.ts:205-209`, `apps/cli/src/mobile.ts:33`):
  - `CONTROLLER_VERSION` is hardcoded to `'0.1.63'` instead of `wazirVersion()`.
  - `GET /api/v1/mobile/handshake` hardcodes `compatible: true` without semver protocol/version validation and never rejects incompatible clients.
  - `rotateMobileDeviceCredential` in `apps/api/src/auth.ts` rotates expired credentials without checking `record.expiresAt > nowMs`.
  - `detectDefaultAdvertiseHttpsUrl` in `apps/cli/src/mobile.ts` rewrites `http://` LAN URLs to `https://`.
- **ISS-017 (P1)**: Autonomous auto-updater restoration & active-task safety (`apps/cli/src/updater/*`, `apps/cli/src/index.ts`, `apps/cli/src/serviceManager.ts`):
  - Restore updater from `1d1ce13` + `9f70a61` and replace process-name-only activity detection with durable store inspection of active executions, controller-owned distributed jobs, and active worker leases so updates never disrupt running local or distributed tasks.
- **ISS-018 (P1)**: Sandbox isolation enforcement & `code_mode` security (`packages/tools/src/sandbox.ts`, `packages/core/src/services/policyEngine.ts`, `apps/cli/src/run.ts`, `apps/cli/src/fleetRunner.ts`, `apps/api/src/toolExecution.ts`, `apps/cli/src/tui/fleetTui.ts`, `packages/tools/src/codeModeTool.ts`, `packages/core/src/services/codeModeService.ts`):
  - `effectiveIsolation` is not passed to `policy.authorize()`, causing `PolicyEngine.checkIsolationCompliance()` to return `{ allowed: true }` unconditionally.
  - `allowWorkspaceArtifactExecution` auto-allows workspace binaries even when `sandboxStatus().mode === 'none'`.
  - `FleetTui.executeInlineShellCommand()` runs `/bin/sh -c` directly on the host bypassing policy and sandboxing.
  - `code_mode` is misclassified as `READ_ONLY` / `parallel` and `codeModeService` mutates `Function.prototype.constructor` on the host realm.

### Phase 5 — Startup and Performance Optimization (P2)
- **ISS-019 (P2)**: `createEngine()` startup overhead (`apps/cli/src/engine.ts`):
  - Iterates full execution history 4 times on startup (`ExecutionEngine.load`, `reliability.hydrate`, `health.hydrateFromExecutions`, `measureModelPerformance`).
  - Probes local runtimes twice (`worker.start()` + `lifecycle.discoverAndReconcile()`).
  - Synchronously scans `process.env.PATH` for 7 external vendor CLIs on every command.
  - Runs `mcp.initialize()`, `handoffs.ready`, and eager `createResourceSystem()` SQLite initialization even during `fastStartup`.

### Phase 6 — Maintainability (P2)
- **ISS-020 (P2)**: Monolithic files requiring cohesive modularization and removal of fake fallback TUI data:
  - `apps/cli/src/tui/fleetTui.ts` (8,016 lines)
  - `apps/cli/src/commands.ts` (3,450 lines)
  - `apps/api/src/mobile.ts` (3,035 lines)
