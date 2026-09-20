# Wazir — Agent Execution & Orchestration Safety Test Plan

Status: active · Owner: Wazir CLI team · Applies to: the model turn loop (`CodingAgent`), the job orchestrator, the policy engine, and OS-level sandboxing — everything a job goes through below the terminal surface (see `docs/test-plans/terminal-interface.md` for that layer).

## 1. Purpose

Every case in this plan exists because a real job got stuck, crashed, ran forever, or silently did the wrong thing, and the failure was traced back to a specific gap: no per-turn timeout, no stuck-loop detection, unbounded context growth, a malformed tool call silently losing its arguments, a job status that never persisted, a sandboxed compiler unable to reach its own cache. The plan is not a paper description of intent — `node scripts/agent-execution-test-plan.mjs` runs the whole matrix and reports per-case PASS/FAIL/SKIP/MISSING, so "still fixed" is a checkable claim, not a memory.

## 2. Scope

In scope:
- `packages/agents/src/codingAgent.ts` — the model turn loop: per-turn timeout, the circuit breaker, context compaction, JSON action parsing/repair/normalization
- `packages/core/src/services/jobOrchestrator.ts` — job/task timeout, cancellation, persistence, orphan reconciliation, retries
- `packages/core/src/services/policyEngine.ts` — shell command classification and the hardening review items
- `packages/tools/src/sandbox.ts` — bwrap (Linux) / Seatbelt (macOS) profile generation
- cross-job/cross-task data isolation (task-id collisions, independent contexts)

Out of scope (covered by other plans):
- terminal rendering, keybindings, TUI layout — `docs/test-plans/terminal-interface.md`
- model runtime adapters (LM Studio / Ollama HTTP layer) — exercised directly in `tests/runtime/*`, not itemized here

## 3. Test levels

| Level | Meaning |
|-------|---------|
| L1 | Pure function / unit — no engine, no fake runtime |
| L2 | Component test — real engine/orchestrator + a fake model adapter or in-memory store |
| L3 | End-to-end through a real orchestrator + real execution path |

## 4. Environment & prerequisites

- Node.js >= 20, workspace built (`npm run build` — the runner enforces freshness)
- No network, no real model required — every case runs against a fake model adapter, an in-memory store, or a pure function
- Linux/macOS/Windows bash-compatible shell; CI-safe

## 5. Running the plan

```bash
# Full executable plan (build-if-stale → run suites → per-case matrix → report)
node scripts/agent-execution-test-plan.mjs

# Subsets / CI knobs
node scripts/agent-execution-test-plan.mjs --skip-build
node scripts/agent-execution-test-plan.mjs --only AGT-001,AGT-010
npm run test:agent          # raw vitest run of all suites in the matrix
npm run test:plan:agent     # alias for the plan runner
```

The runner writes `agent-execution-test-plan-report.json` (gitignored) with per-case status, vitest totals, and timestamps. Exit code 0 ⇒ every case PASS (SKIP allowed); 1 ⇒ any FAIL or MISSING (plan/code drift); 2 ⇒ plan itself broken (unknown ids, missing files).

## 6. Test case matrix

Priority: B = blocking (a job would hang, crash, corrupt state, or silently misreport), R = regression, F = feature.
Status vocabulary: PASS · FAIL · SKIP · MISSING (case not found in code — drift).

### A. Model turn safety — timeouts and malformed action recovery
| ID | Case | Entry | Level | Pri |
|----|------|-------|-------|-----|
| AGT-001 | a hung model turn is cancelled by its own timeout, not the job timeout | codingAgent.turnTimeout: `cancels a turn that exceeds modelTurnTimeoutMs instead of hanging until the job-level timeout` | L2 | B |
| AGT-002 | a normal fast turn is never cancelled | codingAgent.turnTimeout: `never cancels a turn that completes well within the timeout` | L2 | R |
| AGT-003 | argv-array shell command (`{"command":["mkdir","-p","x"]}`) is joined into one quoted string | parseAction: `joins an argv-array shell command into a single quoted string` | L1 | B |
| AGT-004 | `cmd` is accepted as an alias for `command` on the shell tool | parseAction: `accepts cmd as an alias for command on the shell tool` | L1 | R |
| AGT-005 | a flat shell command missing the `input` wrapper is rescued instead of dropped | parseAction: `rescues a flat shell command when the model forgets the input wrapper` | L1 | B |
| AGT-006 | arguments under `parameters`/`arguments`/`args` are rescued into `input` | parseAction: `rescues arguments from a parameters/arguments/args container` | L1 | R |
| AGT-007 | JSON action parsing tolerates markdown fences, unbalanced brackets, raw newlines, stacked objects | parseAction.test.ts (whole file) | L1 | R |

### B. Stuck-loop detection
| ID | Case | Entry | Level | Pri |
|----|------|-------|-------|-----|
| AGT-010 | circuit breaker trips after the same tool call repeats `toolRepeatLimit` times | codingAgent.circuitBreaker: `stops after the same tool call repeats toolRepeatLimit times, instead of grinding to maxTurns` | L2 | B |
| AGT-011 | circuit breaker does not false-positive on varying tool input | codingAgent.circuitBreaker: `does not trip when consecutive tool calls use different input` | L2 | R |
| AGT-012 | `maxTurns` hard-caps the loop regardless of constructor vs per-request override | codingAgent.maxTurns.test.ts (whole file) | L2 | B |

### C. Context management
| ID | Case | Entry | Level | Pri |
|----|------|-------|-------|-----|
| AGT-020 | context compaction bounds prompt growth once the ratio threshold is crossed | codingAgent.contextCompaction: `collapses older turns into a summary once the estimated token usage crosses the compaction ratio` | L2 | B |
| AGT-021 | compaction never activates when the host reports no `contextTokens` ceiling | codingAgent.contextCompaction: `never compacts when the host does not report a contextTokens ceiling` | L2 | R |

### D. Job orchestration — timeout, cancellation, persistence
| ID | Case | Entry | Level | Pri |
|----|------|-------|-------|-----|
| AGT-030 | a task that runs past its timeout is auto-stopped with a clear reason | jobOrchestrator: `automatically stops a task that runs past its timeout, marking it failed with a clear reason` | L2 | B |
| AGT-031 | a job finishing within its timeout is left untouched | jobOrchestrator: `does not touch a job that finishes comfortably within its timeout` | L2 | R |
| AGT-032 | cancelling one task does not terminate sibling tasks | jobOrchestrator: `supports single-task cancellation without terminating sibling tasks` | L2 | B |
| AGT-033 | job-level terminal status persists, surviving a process restart | jobOrchestrator: `persists the job-level terminal status, not just task status, so it survives a process restart` | L2 | B |
| AGT-034 | self-heals a job record stuck at running from before the persistence fix | jobOrchestrator: `self-heals job records already stuck at running from before the persistence fix` | L2 | R |
| AGT-035 | a genuinely orphaned running task is marked failed on load | jobOrchestrator: `marks a genuinely orphaned running task as failed on load, instead of stuck running forever` | L2 | B |
| AGT-036 | a merely pending (never started) job is left alone on load | jobOrchestrator: `leaves a merely pending (never started) job alone on load — that is not an orphan` | L2 | R |
| AGT-037 | `deleteJob` refuses to delete a still-running job | jobOrchestrator: `deleteJob removes a finished job from memory and the store, and refuses one still running` | L2 | R |
| AGT-038 | `cancelTask` transitions task and agent state to cancelled with a reason | jobLifecycleAndValidation: `cancelTask transitions task and agent state to cancelled with "Cancelled by user"` | L2 | B |
| AGT-039 | a cancelled job never later races back to completed | jobLifecycleAndValidation: `once cancelled, a job must never later transition to completed (race condition test)` | L2 | B |
| AGT-040 | invalid transitions out of `completed` are rejected | jobLifecycleAndValidation: `rejects invalid transitions: completed -> running` | L2 | R |
| AGT-041 | invalid transitions out of `failed` are rejected | jobLifecycleAndValidation: `rejects invalid transitions: failed -> running` | L2 | R |
| AGT-042 | invalid transitions out of `cancelled` are rejected | jobLifecycleAndValidation: `rejects invalid transitions: cancelled -> running` | L2 | R |

### E. Cross-job / cross-task isolation
| ID | Case | Entry | Level | Pri |
|----|------|-------|-------|-----|
| AGT-050 | concurrent tasks get independent contexts with no cross-leak | jobLifecycleAndValidation: `provides independent contexts to concurrent tasks with no cross-leak` | L2 | B |
| AGT-051 | no token leakage between jobs that would otherwise share a default task id | fleetTui: `does not leak tokens between jobs that would otherwise share the same default task id` | L2 | B |
| AGT-052 | cancelling an already-finished job errors instead of crashing the process | fleetTui: `pressing c on an already-finished job reports an error instead of crashing the process` | L2 | B |

### F. Shell policy safety
| ID | Case | Entry | Level | Pri |
|----|------|-------|-------|-----|
| AGT-060 | shell classification: chaining/substitution/redirection bypass attempts, compiled-binary trust scoping | policyEngineShell.test.ts (whole file) | L1 | B |
| AGT-061 | policy hardening review items (newline injection, host reads, code-exec flags, output flags, git verbs, protected paths, env dumps, MCP allow-list) | policyEngineHardening.test.ts (whole file) | L1 | B |

### G. Sandbox isolation
| ID | Case | Entry | Level | Pri |
|----|------|-------|-------|-----|
| AGT-070 | bwrap masks the home directory but re-exposes toolchain/cache dirs (incl. macOS `Library/Caches`) | sandbox: `bwrap: read-only root, masked home with toolchains re-exposed, writable project, no network by default` | L1 | B |
| AGT-071 | Seatbelt denies home except project/tmp/toolchain-cache allowlist (incl. macOS `Library/Caches`) | sandbox: `seatbelt: denies home, allows project + tmp writes, denies network by default` | L1 | B |
| AGT-072 | sandbox fails closed under `WAZIR_SANDBOX=required` when no backend is usable | sandbox: `refuses to run tool processes when no backend is usable` | L2 | B |

### H. Retry / graph correctness
| ID | Case | Entry | Level | Pri |
|----|------|-------|-------|-----|
| AGT-080 | a policy denial never triggers a retry attempt | jobLifecycleAndValidation: `policy denial never triggers a retry attempt` | L2 | B |
| AGT-081 | the retry loop stops at `maxRetries` instead of looping forever | jobLifecycleAndValidation: `stops after reaching maxRetries without infinite loop` | L2 | B |
| AGT-082 | cyclical/duplicate/dangling task graphs are rejected before they can run | jobLifecycleAndValidation.test.ts (graph validation section) | L2 | R |

## 7. Acceptance criteria

An agent-loop, orchestrator, policy, or sandbox change is mergeable when:
1. `node scripts/agent-execution-test-plan.mjs` exits 0 (all 36 cases PASS or SKIP; no FAIL/MISSING)
2. All priority-B cases PASS (a job must never hang past its own timeout, loop on an identical failing action, overflow its context window, silently drop a malformed-but-recoverable tool call, misreport its terminal status, leak data across jobs, or crash the host process)
3. A newly-fixed bug ships with a new case added to §6 and the runner matrix in the same change — that is the whole point of this plan; a fix without a regression case is not done
4. No case may be deleted to make the plan green; it is renamed or retired with a reason in the commit

## 8. Maintenance

- Source of truth for case→test mapping: `scripts/agent-execution-test-plan.mjs` (CASES array). §6 above is generated from it — keep them in sync when renaming tests.
- MISSING in the report means a renamed/deleted test — fix the mapping or restore the test, never ignore.
- Report artifact: `agent-execution-test-plan-report.json` (gitignored). CI can upload it as an artifact.
- Related docs: `docs/test-plans/terminal-interface.md` (terminal/TUI layer), `docs/sandbox.md` (sandbox isolation design).
