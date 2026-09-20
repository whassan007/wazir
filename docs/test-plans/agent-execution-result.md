# Agent Execution & Orchestration Safety Test Plan — Execution Result

Plan: `docs/test-plans/agent-execution.md` · Executed: 2026-09-20 22:20 UTC

## Run metadata

| | |
|---|---|
| Command | `node scripts/agent-execution-test-plan.mjs` |
| Exit code | 0 (green) |
| Environment | Linux x64 · Node v22.22.3 · vitest 2.1.9 |
| Commit | e348c9e (main) |

## Result

**38/38 cases PASS — FAIL 0 · SKIP 0 · MISSING 0**

| Section | Cases | PASS | FAIL |
|---|---|---|---|
| A. Model turn safety (timeouts, malformed action recovery, prose bailout) | 9 | 9 | 0 |
| B. Stuck-loop detection | 3 | 3 | 0 |
| C. Context management | 2 | 2 | 0 |
| D. Job orchestration (timeout, cancellation, persistence) | 13 | 13 | 0 |
| E. Cross-job / cross-task isolation | 3 | 3 | 0 |
| F. Shell policy safety | 2 | 2 | 0 |
| G. Sandbox isolation | 3 | 3 | 0 |
| H. Retry / graph correctness | 3 | 3 | 0 |

## Per-case results

| ID | Pri | Level | Status | Case | Detail |
|---|---|---|---|---|---|
| AGT-001 | B | L2 | PASS | a hung model turn is cancelled by its own timeout, not the job timeout | 44.3ms |
| AGT-002 | R | L2 | PASS | a normal fast turn is never cancelled | 0.4ms |
| AGT-003 | B | L1 | PASS | argv-array shell command is joined into one quoted string | 0.5ms |
| AGT-004 | R | L1 | PASS | cmd is accepted as an alias for command on the shell tool | 0.2ms |
| AGT-005 | B | L1 | PASS | a flat shell command missing the input wrapper is rescued | 0.3ms |
| AGT-006 | R | L1 | PASS | arguments under parameters/arguments/args are rescued into input | 0.3ms |
| AGT-007 | R | L1 | PASS | JSON action parsing tolerates fences, unbalanced brackets, raw newlines, stacked objects | 17 tests |
| AGT-008 | B | L2 | PASS | a turn that streams a lot of prose without ever opening its JSON object is cancelled early | 1.4ms |
| AGT-009 | R | L2 | PASS | a short, normal preamble before the JSON action does not trigger the bailout | 0.3ms |
| AGT-010 | B | L2 | PASS | circuit breaker trips after the same tool call repeats toolRepeatLimit times | 1.4ms |
| AGT-011 | R | L2 | PASS | circuit breaker does not false-positive on varying tool input | 0.4ms |
| AGT-012 | B | L2 | PASS | maxTurns hard-caps the loop regardless of constructor vs per-request override | 4 tests |
| AGT-020 | B | L2 | PASS | context compaction bounds prompt growth once the ratio threshold is crossed | 2.4ms |
| AGT-021 | R | L2 | PASS | compaction never activates when the host reports no contextTokens ceiling | 0.8ms |
| AGT-030 | B | L2 | PASS | a task that runs past its timeout is auto-stopped with a clear reason | 1002.2ms |
| AGT-031 | R | L2 | PASS | a job finishing within its timeout is left untouched | 0.9ms |
| AGT-032 | B | L2 | PASS | cancelling one task does not terminate sibling tasks | 60.6ms |
| AGT-033 | B | L2 | PASS | job-level terminal status persists, surviving a process restart | 1.1ms |
| AGT-034 | R | L2 | PASS | self-heals a job record stuck at running from before the persistence fix | 0.5ms |
| AGT-035 | B | L2 | PASS | a genuinely orphaned running task is marked failed on load | 0.4ms |
| AGT-036 | R | L2 | PASS | a merely pending (never started) job is left alone on load | 0.2ms |
| AGT-037 | R | L2 | PASS | deleteJob refuses to delete a still-running job | 21.9ms |
| AGT-038 | B | L2 | PASS | cancelTask transitions task and agent state to cancelled with a reason | 20.2ms |
| AGT-039 | B | L2 | PASS | a cancelled job never later races back to completed | 22.3ms |
| AGT-040 | R | L2 | PASS | invalid status transitions out of a terminal state are rejected | 2.8ms |
| AGT-041 | R | L2 | PASS | invalid status transitions out of failed are rejected | 0.3ms |
| AGT-042 | R | L2 | PASS | invalid status transitions out of cancelled are rejected | 0.3ms |
| AGT-050 | B | L2 | PASS | concurrent tasks get independent contexts with no cross-leak | 21.0ms |
| AGT-051 | B | L2 | PASS | no token leakage between jobs that would otherwise share a default task id | 206.9ms |
| AGT-052 | B | L2 | PASS | cancelling an already-finished job errors instead of crashing the process | 115.3ms |
| AGT-060 | B | L1 | PASS | shell classification: chaining/substitution/redirection bypass attempts, compiled-binary trust scoping | 25 tests |
| AGT-061 | B | L1 | PASS | policy hardening review items | 88 tests |
| AGT-070 | B | L1 | PASS | bwrap masks the home directory but re-exposes toolchain/cache dirs (incl. macOS Library/Caches) | 7.5ms |
| AGT-071 | B | L1 | PASS | seatbelt denies home except project/tmp/toolchain-cache allowlist (incl. macOS Library/Caches) | 6.5ms |
| AGT-072 | B | L2 | PASS | sandbox fails closed under WAZIR_SANDBOX=required when no backend is usable | 8.3ms |
| AGT-080 | B | L2 | PASS | a policy denial never triggers a retry attempt | 0.3ms |
| AGT-081 | B | L2 | PASS | the retry loop stops at maxRetries instead of looping forever | 0.2ms |
| AGT-082 | R | L2 | PASS | cyclical/duplicate/dangling task graphs are rejected before they can run | 14 tests |

## Notes

- Priority: B = blocking (a job would hang, crash, corrupt state, or silently misreport), R = regression. Levels: L1 pure function/unit, L2 component test against a real orchestrator/engine + fake model adapter, L3 full end-to-end.
- Machine-readable report: `agent-execution-test-plan-report.json` (gitignored; regenerate with the command above).
- Every case here maps to a test written specifically because a real job hit that exact failure mode this session — see the commit history for `packages/agents/src/codingAgent.ts`, `packages/core/src/services/jobOrchestrator.ts`, and `packages/tools/src/sandbox.ts` for the incidents each one guards against.
- This plan is complementary to `docs/test-plans/terminal-interface.md`: two cases (AGT-051, AGT-052) are shared with that plan (TUI-021, TUI-024) because they're fundamentally job-isolation/crash-safety bugs that happen to be exercised through the TUI test harness — kept in both since they protect two different concerns (data integrity here, rendering there).
