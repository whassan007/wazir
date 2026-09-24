# Execution architecture upgrade

## Inspection and implementation map

Baseline: `84255a61eed8991d3be4c910aeeb0fb57a30773e`, with pre-existing local
changes in the planner, engine, agent, orchestration, evaluation and TUI.
Those changes are retained.

| Requirement | Existing implementation | Remaining gap / modification target | Regression coverage |
|---|---|---|---|
| Durable execution history | `packages/core/src/services/executionEngine.ts`, `packages/registry/src/database.ts`, `apps/cli/src/engine.ts`, shared `KeyValueStore` | Sequence and envelope migration, isolated history, ordered writes, atomic history extension | Clock rollback, conflicting writers, restart, insertion deduplication, persistence failure |
| Failure-aware retry | `packages/shared/src/retry.ts`, runtime adapters, `jobOrchestrator.ts` | Shared failure classes, separate provider/protocol/tool/coding budgets | Provider failure versus compiler/policy failure, repair exhaustion |
| Schema-first tool pipeline | `packages/tools/src/registry.ts`, `packages/core/src/types/tool.ts`, CLI run/fleet/MCP callbacks | Central validation, output contracts, side-effect classes, stable checkpoint IDs | Invalid input/output, crash after dispatch, unknown outcome recovery |
| Physical mutation truth | `packages/tools/src/filesystem.ts`, `FileMutationResult`, CLI tool callbacks | Preserve existing before/after hashes; cover command-driven changes | Failed/no-op edit, one revision per real mutation |
| Verification fencing | `packages/evaluation/src/index.ts`, execution engine workspace/evidence records | Require exact revision at every completion entry point; protect verification inputs | Stale build/test evidence, model claims, oracle weakening |
| Bounded context and attempts | `packages/agents/src/codingAgent.ts`, `ContextCompiler` | Controller-level budgets, attempt/context separation, observation compaction, semantic progress | Context growth, raw evidence retention, stop conditions |
| Routing and reliability | `Scheduler`, Agent/Model/Runtime/Computer registries, RuntimeAdapters | Evidence-backed model reliability and failure-based routing/circuits | Explicit route events, capability selection, circuit recovery |
| Minimum tool surface and policy | `PolicyEngine`, `ApprovalQueue`, tool descriptors | Enforced task-specific tool selection and protected verification | Denial precedence and unavailable tools |
| Recovery and provenance | `RecoveryManager`, JobManager ownership/JobGraph, worker leases, `ProvenanceManager` | Event-derived execution reconstruction, retained budgets, safe same-execution resume | Unknown side effects, lease fencing, identity retention |
| Projections and acceptance | CLI `commands.ts`, `fleetRunner.ts`, `tui/fleetTui.ts`, integration/live coding harnesses | Durable TUI projections and decision explanations; real coding acceptance | JSON compatibility, replay projection, exact-revision completion |

## First tranche: durable event envelope

The engine emits `eventId`, `executionId`, `jobId`, `sequence`, `timestamp`,
and `eventType`, retaining `id` and `type` for existing consumers. Standalone
executions explicitly carry `jobId: null`; fleet executions carry the owning job.
Optional step/turn/attempt/call identifiers can be supplied by controller producers.
Agent/model/runtime/computer/worker and workspace revision are captured on insertion.

Legacy events retain their IDs and array order. Startup adds the new envelope,
rejects invalid sequence/identity, and durably records discovered unknown outcomes
without adding duplicates on every restart. Event reads return detached copies.
Replay follows insertion sequence rather than the wall clock.

Persistence remains in the existing record store. Engine writes use independent
snapshots and serialize asynchronous persistence. Production CLI and registry
adapters use atomic `KeyValueStore.update`, compare the storage revision, and
require every existing event to remain an unchanged prefix. A storage conflict
fails closed; a losing process must reload rather than overwrite the winner.
Custom persistence callbacks must provide equivalent atomicity when shared across
processes. Stores without atomic update are rejected by the production adapter.

Storage errors propagate. The JSON store distinguishes a missing first-run file
from corruption, unreadable data, or disappearance of a previously observed file;
it cannot replace those failures with an empty history. Repeated terminal status
notifications do not append duplicate terminal events, and stale completion
rejections are persisted before returning the error.

This is a foundation, not the complete mission. Event vocabulary is available for
later producers, but this tranche does not claim that every listed event is emitted.
Full state reconstruction, failure classification, retry budgets, stable tool-call
matching, model-attempt/context separation, reliability routing, and live acceptance
remain subsequent work. Existing mutable non-event record fields remain compatibility
projections; this patch does not yet derive every field from events.

## Second tranche: classified provider connection retries

The existing shared retry module now has explicit failure classes, a validated
finite retry policy, bounded jitter, and interruptible backoff. Its historical
four-attempt default remains; the configurable policy defaults are five retries,
500 ms initial delay, 10 seconds maximum, and 10% jitter. A custom predicate can
narrow eligibility but cannot make a policy/code/tool/cancellation failure eligible
for provider retry.

The existing LM Studio and Ollama connection retry loops use this policy. Runtime
adapters continue to own protocol-specific behavior; generation after the connection
boundary is not replayed. Hosted adapters that previously failed immediately still
do so. This tranche does not add automatic tool retries or coding repair policy.

CLI, fleet, and subagent execution persist classified retry intent before advancing
the provider iterator. Retry evidence records attempt, failure class, provider/model,
request-scoped turn/step identifiers, delay, and reason, excluding raw error bodies.
The existing worker protocol now forwards retry events and waits for event reporting
before allowing the provider iterator to advance. Request-scoped retry policy travels
with worker requests. Aggregate job/protocol/coding budgets and failure-based routing
remain subsequent work.

## Third tranche: schema-first tool pipeline, idempotency checkpoints, physical mutation truth

`ToolRegistry.register()` now compiles a validated JSON-schema contract per tool
(`compileToolSchema`, shared with the MCP adapter, which no longer carries its own
duplicate Ajv setup) and assigns `sideEffectClass` (`READ_ONLY` /
`IDEMPOTENT_WRITE` / `NON_IDEMPOTENT_WRITE`), `concurrencySafety`, and a default
timeout when a tool doesn't declare its own. `@wazir/tools`'s `executeTool()` is the
single pipeline every call site (CLI `run.ts`'s main and subagent loops,
`fleetRunner.ts`, and MCP's `executeMCPForAgent`) now goes through: input schema
validation before dispatch, an `allowedTools` gate (`POLICY_DENIED` outside the
task's tool surface — Phase 8's minimum tool surface, enforced here rather than by
prompt instruction alone), a durable `checkpoint()` callback the caller must resolve
before the tool actually runs, a timeout/cancellation race that reports
`TOOL_OUTCOME_UNKNOWN` for a non-read-only tool interrupted after dispatch (not
`TOOL_EXECUTION_FAILED` — an interrupted write's real-world effect is unconfirmed,
not confirmed-absent), and output schema validation when a tool declares one
(`ARTIFACT_CONTRACT_FAILED` on mismatch).

Idempotency: `ExecutionEngine.recordToolStart()` persists a `ToolCallCheckpoint`
(`callId`, `argumentsHash`, `sideEffectClass`, `workspaceRevision` at dispatch,
state `STARTED`) before the tool's own side effect can occur, refuses a second
`STARTED`/`OUTCOME_UNKNOWN` non-read-only checkpoint until the prior one is
reconciled, and `setStatus('completed')` itself refuses completion while any
checkpoint is still `STARTED`/`OUTCOME_UNKNOWN` — a controller invariant, not a
convention a model or caller can skip.

Physical mutation truth: `snapshotWorkspace()`/`workspaceFingerprint()`/
`workspaceMutations()` (`packages/tools/src/workspaceSnapshot.ts`) hash the
relevant file(s) before and after a mutating tool call — the single target path for
`write`/`edit`, a full recursive walk otherwise (e.g. `shell` running a build) — and
`executeTool()` only reports a `fileMutations` entry where the content hash actually
changed. A failed write, a no-op edit, and a write that reproduces byte-identical
content all correctly report no mutation and no revision increment; only a real
content change does. `ExecutionEngine.recordFileMutations()` re-filters on
`beforeHash !== afterHash` as a second gate before incrementing `workspaceRevision`.

Revision-fenced verification (Phase 11): `CheckRunRecord.workspaceRevision` pins a
build/test/lint/typecheck result to the exact revision it was run against, and
`setStatus('completed')` walks `record.evidence`/`record.evaluation` and rejects
completion (`ARTIFACT_CONTRACT_FAILED`) unless current evidence exists for the
*current* workspace revision — a later mutation invalidates it
(`verification.invalidated`/`evidence.stale` events), and the model cannot argue its
way past this. **Fixed in this tranche**: `run.ts` and `fleetRunner.ts` originally
captured the check's `workspaceRevision` *before* dispatching the tool, then
recorded file mutations from that same call *after* recording the check. A build
step that writes its own output artifact (e.g. `g++ ... -o main` — the compiled
binary is itself a detected mutation) was therefore immediately stale by the time
`evaluateExecution()` ran, because the check was stamped against the pre-build
revision while the binary's appearance had already bumped the workspace to the next
one — `BUILD_EVIDENCE_STALE` on a build that had, in fact, just passed. Both call
sites now record file mutations first and re-read the current revision immediately
before stamping the check, so a check's own legitimate output artifacts don't
retroactively invalidate the check that produced them. Covered by
`apps/cli/tests/executeTask.e2e.test.ts`'s "compiles source code via a raw `shell`
call IS recorded as a real check and can succeed".

Regression coverage added this tranche: `packages/core/tests/toolCheckpoints.test.ts`
(checkpoint lifecycle, duplicate-write rejection, completion blocked on unreconciled
outcome), `packages/tools/tests/physicalExecution.test.ts` (failed/no-op/real edit
revision behavior, shell-driven mutation detection), `packages/tools/tests/
toolContractPipeline.test.ts` (input/output schema validation, `allowedTools`
denial, timeout → `TOOL_OUTCOME_UNKNOWN`).

## Fourth tranche: explicit termination reasons

`AgentTurn` gained a `terminationReason?: TerminationReason` field
(`packages/core/src/types/agent.ts`), a closed union matching Phase 12's stop-condition
vocabulary (`COMPLETED`, `VERIFICATION_PASSED`, `MAX_TURNS`, `MAX_REPAIRS`,
`NO_PROGRESS`, `MODEL_PROTOCOL_BUDGET_EXHAUSTED`, `POLICY_DENIED`, `CANCELLED`, ...),
set only on the terminal `'done'`/`'error'` turn of a `CodingAgent.run()`. Every
existing stop point in `CodingAgent` now tags it explicitly instead of leaving a
caller to infer the reason from free-text `error` prose:

- repeated malformed-JSON or tool-validation failures (both the PLAN and WORK
  phases) → `MODEL_PROTOCOL_BUDGET_EXHAUSTED`
- `repairState.cycle > maxRepairCycles` → `MAX_REPAIRS`; `consecutiveNoProgress >= 2`
  → `NO_PROGRESS` (same guard, now distinguishable)
- the WORK-phase turn loop exiting because the turn budget ran out (as opposed to the
  model reporting `done`) is tracked (`turnBudgetExhausted`) and carried onto whatever
  VERIFY then produces — a verification failure caused by running out of turns is now
  `MAX_TURNS`, not indistinguishable from an ordinary failed check
- a clean VERIFY pass → `VERIFICATION_PASSED`

Deliberately left untouched: the cancellation checks (`request.isCancelled?.()`)
still bare-`return` without yielding a terminal turn — tagging those would mean
emitting a turn where none exists today, which is a behavior change existing callers
don't expect; and the circuit breaker (`ACTION_BLOCKED_DUPLICATE`) still only nudges
the model with another turn rather than terminating, so `REPEATED_ACTION` isn't
assigned anywhere yet — semantic no-progress detection driving an actual escalation
(Phase 13) is separate, larger work.

Regression coverage: `packages/agents/tests/codingAgent.terminationReason.test.ts`
(`MAX_TURNS`, `VERIFICATION_PASSED`, `MODEL_PROTOCOL_BUDGET_EXHAUSTED`).

## Fifth tranche: run-level wall-clock budget

`CodingAgentOptions.maxWallClockMs` / `AgentRunRequest.maxWallClockMs` (constructor
default 20 minutes, same override pattern as `maxTurns`/`maxRepairCycles`) caps total
run duration independent of turn/repair counts. This is distinct from the existing
`modelTurnTimeoutMs`, which only bounds a single turn — a task whose every individual
turn completes quickly could still run far longer than intended in aggregate; this is
exactly the originally-reported motivating bug (a trivial task taking 258 seconds
while never exceeding its per-turn or turn-count budgets). Checked at the top of both
the PLAN and WORK loop iterations (a run already past budget stops before starting
its next turn rather than being cut off mid-turn), yielding a terminal error turn
tagged `terminationReason: 'MAX_WALL_CLOCK'`. Both current callers
(`apps/cli/src/engine.ts`, `apps/api/src/server.ts`) construct `CodingAgent` with no
options, so the new default applies automatically without further wiring; a
per-request override (e.g. a future CLI `--max-wall-clock` flag) is available but not
yet plumbed through `run.ts`/`fleetRunner.ts`.

Regression coverage: `packages/agents/tests/codingAgent.wallClock.test.ts` (budget
already exhausted stops before any model call; per-request override; a normal run
well within budget is unaffected).

## Sixth tranche: total tool-call budget

`CodingAgentOptions.maxToolCalls` / `AgentRunRequest.maxToolCalls` (constructor
default 100, same override pattern as the other budgets) caps the total number of
real tool dispatches across the whole run, checked immediately before each dispatch
in both the PLAN and WORK phases and tagged `terminationReason: 'MAX_TOOL_CALLS'` on
trip. This is distinct from `toolRepeatLimit` (the existing circuit breaker), which
only catches the *exact same* call repeated back to back — a model alternating
between several different, individually-novel tools or arguments (e.g. reading a
different file every turn without ever converging) is not caught by that breaker at
all, and previously would only have been bounded by `maxTurns`, which a
tool-call-heavy strategy can exhaust real side effects well before reaching.

Regression coverage: `packages/agents/tests/codingAgent.maxToolCalls.test.ts`
(budget trips with no repeated calls at all — proof it's independent of the circuit
breaker; per-request override; a normal run well within budget is unaffected).

## Seventh tranche: total token budget

`CodingAgentOptions.maxTokens` / `AgentRunRequest.maxTokens` (constructor default 2M,
same override pattern as the other budgets) caps cumulative model-usage-reported
tokens (input + output summed across every turn) for the whole run, tagged
`terminationReason: 'MAX_TOKENS'` on trip. `modelTurn()` previously discarded
`GenerationEvent.usage` entirely — the `'completed'` event branch wasn't even handled
in its consumption loop — so this required threading `usage` back out of `modelTurn`
alongside `content`/`toolCall`/`timedOut`. Only enforced when the runtime actually
reports `usage`; a runtime that never does (verified by a dedicated test) leaves this
budget silently unenforced rather than guessing at a token count from content length.
This is the token-side half of the class of bug the whole mission started from — a
trivial task accumulating hundreds of thousands of cumulative input tokens while
staying comfortably within its turn/tool-call/wall-clock budgets, because nothing
bounded total reported cost.

Regression coverage: `packages/agents/tests/codingAgent.maxTokens.test.ts` (budget
trips independent of turn/tool-call counts; per-request override; not enforced when
usage is never reported; a normal run well within budget is unaffected).

## Eighth tranche: semantic no-progress and repeated-action termination

`CodingAgent` now judges progress from physical facts after every executed tool
call: a real content change on disk (`fileMutations[].changed`), or an observation
it has not seen before (`observationFingerprint`, `packages/agents/src/diagnostics.ts`).
The fingerprint ignores how a call was phrased: differently-worded empty results
(`''`, `No matches found.`, `none`) collapse into one, and failures reduce to their
diagnostic fingerprints. `maxNoProgressIterations` (option and per-request override,
default 6) consecutive calls with neither stop the run with `terminationReason:
'NO_PROGRESS'`. That covers `glob *.cpp` → `glob src/*.cpp` → `find . -name '*.cpp'`,
which the exact-repeat breaker cannot catch.

The circuit breaker still corrects the model once. If the model sends the blocked
action again, the run ends with `REPEATED_ACTION`, not a loop that runs until
`maxTurns`. The `maxTurns` test fixture used to write byte-identical content every
turn. It now varies the content, because that test covers turn capping and the
identical-write loop is now correctly a `REPEATED_ACTION`.

Regression coverage: `packages/agents/tests/codingAgent.noProgress.test.ts`.

## Not yet done

Phase 2/3 (model-attempt vs. execution-history separation, observation compaction),
Phase 12 remainder (a composed `StopCondition[]` the controller evaluates centrally,
rather than each condition being its own inline check scattered through
`CodingAgent` — these tranches added typed *reasons* and several *budgets*, not the
unified *mechanism*), Phase 13 (semantic no-progress detection beyond the existing
exact-duplicate-call circuit breaker), Phase 14–24 (model capability registry and
circuit breaker, protected-verification tamper detection, full
recovery-from-events reconstruction, `wa explain`/CLI projections of the new event
vocabulary, and the live acceptance run). The existing per-run
`maxTurns`/`maxRepairCycles`/`toolRepeatLimit`/`maxWallClockMs`/`maxToolCalls`/
`maxTokens` caps in `CodingAgent` and the trivial/small/complex task-complexity
budgets (`packages/core/src/services/complexity.ts`) predate (or, for the newer
ones, sit alongside) this mission and are not the same thing as the mission's
controller-owned `StopCondition` composition — they overlap in effect but aren't
unified into one typed mechanism yet.
