# Wazir v0.1.58 hardening: audit, fixes and evidence

Branch `hardening/v0.1.59`, based on `main` at **`cd010dcc2e6bec66ddd305f8ef382c43b2c42545`**
(`chore(release): v0.1.58`, which includes PR #3 agent delegation and PR #4 resource orchestration).
Environment: DGX Spark (Linux 7.0.0-1019-nvidia, aarch64), Node 22.22.3, LM Studio on :1234.

This was one working session. It covers the highest-risk gaps found, not all twelve phases of
the brief. Anything not demonstrated is marked **UNVERIFIED** or **NOT DONE**.

## A. Baseline architecture (as implemented, not as documented)

| Subsystem | Where | State |
|---|---|---|
| ResourceLedger (SQLite WAL, BEGIN IMMEDIATE, append-only audit) | `packages/core/src/resources/ledger.ts` | IMPLEMENTED_AND_VERIFIED (now incl. real multi-process tests) |
| TokenBudgetManager (admit/reserve/reconcile/fail, emergency stop) | `resources/budgetManager.ts` | IMPLEMENTED_AND_VERIFIED; lease defect fixed (C1) |
| AccountRegistry + implicit accounts | `resources/accounts.ts` | IMPLEMENTED_AND_VERIFIED |
| Governed runtime adapters (every local + hosted adapter) | `resources/governedAdapter.ts`, `apps/cli/src/engine.ts` | IMPLEMENTED_AND_VERIFIED; raw hosted adapters are used only for auth/health |
| Resource-aware model routing | `resources/router.ts` via `Scheduler` | IMPLEMENTED_BUT_UNVERIFIED live (unit tests only) |
| Subscription admission for delegated agents | `apps/cli/src/run.ts` | IMPLEMENTED_AND_VERIFIED live (2 real delegations) |
| ExternalAgentAdapter / AcpClientAdapter | `packages/agents/src/externalAgent.ts`, `acp/acpClient.ts` | IMPLEMENTED; orphaning defect fixed (C3, C5) |
| Agent preflight (real probe prompt, TTL cache) | `packages/agents/src/preflight.ts`, `apps/cli/src/agentPreflight.ts` | IMPLEMENTED_AND_VERIFIED; extended with DEGRADED + task history |
| Durable execution records, tool checkpoints, OUTCOME_UNKNOWN, owner liveness | `packages/core/src/services/executionEngine.ts` | IMPLEMENTED_AND_VERIFIED; interrupted-execution gap fixed (C4) |
| Safe resume (`planTaskResume`: refuse unresolved side effects) | `apps/cli/src/recovery.ts` | IMPLEMENTED_AND_VERIFIED (existing tests) |
| Deterministic evaluation, oracle-weakening detection | `packages/evaluation`, `core/services/verificationIntegrity.ts` | IMPLEMENTED; **bypassed for delegated agents** before C2 |
| Context compiler / compaction | `core/services/context*.ts` | IMPLEMENTED_BUT_UNVERIFIED (not audited this session) |
| Local capacity (meminfo, nvidia-smi, endpoint probes) | `resources/localCapacity.ts` | IMPLEMENTED; dashboard only, **not used for admission** |
| Agent-to-agent failover | — | **MISSING** (`--agent` pins one agent; no auto-delegation) |

Dependency map: `wa run` → `planTask` (Scheduler → ResourceRouter → TokenBudgetManager.preview) →
`ExecutionEngine.create` → [native: governed RuntimeAdapter → ledger] | [delegated: `budget.admit` →
ACP/External adapter → vendor CLI] → `evaluateExecution` → `setStatus`. All admission and
settlement goes through one `ResourceLedger` file shared by every `wa` process.

### Five highest-risk failure modes found

1. **Delegated work accepted on exit 0** (P0): wrong code marked `completed`. Fixed in C2.
2. **Orphaned agents after `wa` dies** (P0): agent kept editing the workspace unsupervised. Fixed in C3/C5.
3. **Lease expiry mid-flight** (P1): long delegations were settled early and dropped out of concurrency limits. Fixed in C1.
4. **Executions stuck `running` forever** after a crash (P1): dishonest state, no orphan detection. Fixed in C4.
5. **No agent-level failover** (P2): when the chosen agent is FAILED (Codex, Gemini, Qwen, OpenCode today), the task fails; it is not rerouted. NOT DONE.

## B. Existing features verified and reused (not rebuilt)

- `snapshotWorkspace` / `workspaceMutations` (tools) → delegated-work observation.
- `detectOracleWeakening`, `isVerificationAsset`, `taskAuthorizesVerificationChanges` → refuse weakened tests.
- Registered `build/typecheck/lint/test` check tools and `recordCheck` → Wazir runs the checks itself.
- `ExecutionEngine` owner/liveness model → interrupted-execution detection.
- Preflight cache file → compatibility registry (task history, DEGRADED), no new store.
- `TokenBudgetManager.preview` → admission probe in `wa resources validate`.

## C. Defects found (evidence, severity)

| # | Severity | Defect | Evidence |
|---|---|---|---|
| C1 | P1 | Delegation reservation never renewed its 15-min lease; adapter renewed only on provider events. Any later `admit()` (any process) expired and settled it mid-flight, freeing its concurrency slot. | Code read (`run.ts` delegation admit, `governedAdapter.ts`); regression test `lease heartbeat`. |
| C1b | P2 | `recoverExpired()` appended an `expired` event even when its UPDATE lost the race. | Real 4-process test: **4** `expired` events for one reservation on old code, 1 after. |
| C2 | **P0** | External agents' file edits were invisible → `filesChanged=[]` → `checks_pass` skipped → task `completed` on exit 0. | e2e test: a wrong fix (`a * b`) was `completed` on old code (4/4 tests fail on old code, pass after). |
| C2b | P1 | Oracle detector did not count `assert.strictEqual(...)`; deleting all node:assert assertions was not flagged. | Unit test fails on old regex. |
| C3 | **P0** | `ExternalAgentAdapter` detached group survived `wa` SIGKILL. | Live repro: edits continued 5 → 15 after parent died; automated test. |
| C4 | P1 | Execution owned by a dead process stayed `running` forever (delegated runs have no tool checkpoints to mark). | Unit test. |
| C5 | **P0** | Same orphaning in `AcpClientAdapter` (the path Codex/Qwen/Gemini actually use). | Found during live Codex run ("delegated … over ACP"); test fails on old code. |
| C6 | P2 | Unknown limit + `unknownLimitPolicy: deny` returned `deferred` with a retry time that can never succeed. | Live `wa resources validate` on an enforced config. |
| C7 | P2 | `wa resources validate` only checked JSON shape. | Code read. |
| C8 | P2 | READY meant "answered a probe", even if every real task then failed. | Live cache: probe READY is independent of task outcomes. |

## D. Commits (branch `hardening/v0.1.59`, not pushed)

```
64c96f3 fix(resources): renew leases on a timer and recover each expiry once        (C1, C1b)
4497c80 fix(verification): count node:assert method calls as assertions             (C2b)
3548d03 fix(delegation): verify delegated agents' work instead of trusting exit 0  (C2)
dbd7168 fix(agents): kill a delegated agent when Wazir itself dies                 (C3)
4b72634 fix(executions): fail executions whose owning process died                 (C4)
78fbade feat(resources): validate setup against a production profile               (C6, C7)
4935131 fix(acp): kill an ACP agent's process group when Wazir dies                (C5)
e71adad feat(agents): track real task outcomes and report DEGRADED agents          (C8)
```

Rollback: each commit is independent and revertable with `git revert <sha>`. Behavioural
switches for operators: `policy.enforce` (unchanged default `false`) and `wa resources stop`.
Behaviour changes users will notice: delegated tasks that change source now run the project's
npm `build/typecheck/lint/test` scripts and fail if they fail or if none exist (same rule the
native agent already had); a workspace that cannot be snapshotted fails as `UNVERIFIED`.

## E. Live vs simulated tests

**Live (real providers, this DGX Spark):**

| Test | Command | Result |
|---|---|---|
| Delegation to Codex (ACP) | `wa run --agent codex --type coding "<fix add>"` in a temp git+npm project | Task **failed**, correctly: provider 400 "model requires a newer version of Codex" (codex-cli 0.157.1). 0 files changed, error recorded, reservation settled once (conservative). 8 s. |
| Delegation to Antigravity | same task, `--agent antigravity` | **Completed, verified by Wazir**: observed `src/add.js` change, ran `npm run test` at the new revision, passed. Ledger: one `estimated` settlement, no live reservations. 19 s. |
| `wa resources validate` default / `--profile production` on real install | isolated `WAZIR_HOME` | exit 0 with 22 warnings / exit 1 with 22 errors (the same findings, promoted) (6 implicit subscriptions, 3 unpriced implicit APIs, enforcement off). |
| Enforced config probe | isolated `WAZIR_HOME`, `enforce: true` | Limits refused routine work at threshold and blocked unknown/deny accounts as configured. |
| Orphaned agent after parent SIGKILL | scripted agent via built `ExternalAgentAdapter` | Before: agent alive, edits 5 → 15. After: agent dead within ~1 s, edits 5 → 5. |

**Deterministic (simulated, in CI suite):** 6-process ledger race (exactly 20/60 admitted
against a 20k-token limit); SIGKILL between reservation and settlement with 4 concurrent
recoverers (one conservative charge, one `expired` event); lease heartbeat over 5 simulated
minutes; 5 delegation e2e scenarios through real `executeTask` + real `npm` (wrong fix, right
fix, deleted assertions, rewritten test script, agent crash); agent and ACP orphan kills with a
real SIGKILLed host process; interrupted-execution marking; DEGRADED transitions; validator profiles.

Full suite: **282 files, 2072 passed, 18 skipped, 0 failed** (264 s). Typecheck clean.

Not run: the `ai-test-harness` evaluation, network-latency injection, DGX disconnect,
remote-worker restart, corrupted-state injection, context-overflow injection (see I).

## F. Resource-governance enforcement

- Enforcement default stays **off**; nothing was silently enabled. `--profile production` is a
  validation gate only. Documented in `docs/resources/RUNBOOK.md`.
- Unknown (`limit: null`) vs unlimited (no limits) is now reported distinctly.
- Reservation/settlement idempotency and cross-process atomicity: **verified** with real processes.
- Process death between reserve and settle: **verified** (conservative charge exactly once).
- Emergency stop independent of `enforce`: verified by existing tests (unchanged).
- Subscription usage remains an **estimate** (vendor CLIs report no tokens); labelled as such.

## G. Recovery and failover

- Recovery after `wa` death: agent process group killed (verified), execution marked
  `failed`/`INTERRUPTED` on next start (verified), reservation charged conservatively (verified).
  Replay remains gated by `planTaskResume`. **Caveat:** a delegated agent's own side effects are
  invisible to Wazir's tool checkpoints, so a resumed delegated task re-runs the agent against
  the partially edited tree; at-most-once is **not** guaranteed for external side effects an
  agent performs itself (e.g. `git push`, network calls).
- Agent failover: **MISSING / NOT DONE.**

## H. Benchmarks

**UNVERIFIED.** No baseline-vs-final benchmark with identical workloads was run; no performance
claims are made. Observed single-run timings only: live verified delegation 19 s (Antigravity),
failed delegation 8 s (Codex), full test suite 264 s.

## I. Remaining risks and limitations

1. No agent failover; 4 of 6 installed agents are currently FAILED for provider/version reasons
   (Codex CLI too old for its model, Gemini tier retired, Qwen endpoint unreachable, OpenCode context overflow).
2. Delegated-task verification only knows npm scripts; non-npm projects that change source fail
   as "no checks were executed" (honest, but blocks Python/Go/Rust work until a check registry exists).
3. Checks run agent-modified code on the host; the tool sandbox (bwrap) is unavailable on this
   machine (unprivileged user namespaces disabled), so checks run unsandboxed.
4. Failed delegations are charged at the full conservative estimate even when the provider
   rejected the request up front.
5. The watchdog is POSIX-only and polls at 1 s; PID reuse within that window could, in theory,
   keep a group alive one extra tick.
6. Local GPU capacity is observed (dashboard) but not used for admission beyond `maxConcurrent`.
7. Context pipeline, DGX saturation/thrashing and remote-worker failure were not audited this session.

## J. Next five improvements (ranked: reliability benefit ÷ (effort + maintenance))

| Rank | Improvement | Benefit | Effort | Maintenance |
|---|---|---|---|---|
| 1 | Capability- and health-aware agent failover using the preflight registry (READY/DEGRADED + last verified task), recording every decision in the ledger `routing` events | High | Medium | Low |
| 2 | Project check registry beyond npm (pytest, go test, cargo, make) for delegated verification | High | Low | Low |
| 3 | Classify delegation failures as pre-dispatch (release) vs ambiguous (charge) from ACP error codes | Medium | Low | Low |
| 4 | Feed `localCapacity` GPU-memory readings into local admission (prevent overcommit/thrash) | Medium | Medium | Medium |
| 5 | Failure-injection suite runner (`scripts/fault-suite`) wrapping the deterministic tests above plus latency/disconnect/corruption injectors, with a results table per run | Medium | Medium | Medium |

## Acceptance criteria

| Criterion | Status |
|---|---|
| Verified end-to-end task completion | **VERIFIED** (live, Antigravity) |
| Correct accounting and configured budget enforcement | **VERIFIED** (multi-process tests + live probe) |
| Safe task recovery after interruption | **VERIFIED** for process death; network partition **UNVERIFIED** |
| No duplicate side effects in tested recovery scenarios | **VERIFIED** for ledger charges; agent-internal side effects **UNVERIFIED** |
| Functional preflight and failure classification | **VERIFIED** (live cache + DEGRADED tests) |
| Safe failover between compatible agents | **NOT DONE** |
| Separation of local GPU and external-agent resources | Existing behaviour (no local model load for delegations); **UNVERIFIED** under saturation |
| Honest, observable execution state | Improved (INTERRUPTED, DEGRADED, validate); TUI not changed |
| Passing regression and integration tests | **VERIFIED** (2072 passed) |

Production readiness is **not** claimed.
