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

## Ninth tranche: observation compaction

`ObservationCompactor` (`packages/core/src/services/observationCompactor.ts`,
exported from `@wazir/core`) decides what the model sees of a tool result.
Output within budget (4000 chars) passes through verbatim. Larger output is
reduced by kind: a failed build/test becomes `exitCode`, `failedCommand`,
`failedFiles`, `primaryErrors` (gcc/clang, tsc, eslint, test-runner FAIL lines),
`additionalErrors` and a short tail. Searches become a match count plus whole
lines. Git diffs get a per-file `+/-` summary. Anything else keeps its head and
tail with an omission marker. `CodingAgent.pushToolResult` uses it in place of the
old blind `slice(0, 4000)`. The raw `ToolResult` is unchanged in the `tool_call`
turn, which is the execution evidence callers persist.

Regression coverage: `packages/core/tests/observationCompactor.test.ts`,
`packages/agents/tests/codingAgent.toolResultOutput.test.ts` (raw kept as evidence,
compact form in model context).

## Tenth tranche: protected verification

`detectOracleWeakening` (`packages/core/src/services/verificationIntegrity.ts`)
recognizes verification assets (test files and directories, fixtures,
golden/expected outputs, test-runner config) and flags these changes: a deleted
asset, fewer test cases, fewer assertions, new skip/disable markers, an added
assertion that cannot fail, or any edit to an expected output. Adding coverage is
never flagged. `executeTool()` runs this check before dispatch for `write`/`edit`.
It computes the content the call would produce, and a weakening change returns
`POLICY_DENIED` / `VERIFICATION_PROTECTED` with no checkpoint and no write. The
exception is `ToolExecutionContext.allowVerificationChanges`, which the CLI (main
run, subagent, fleet) sets only when `taskAuthorizesVerificationChanges(task)`
sees an explicit request such as "update the expected output". "Add a regression
test" and "make the tests pass" do not authorize it.

Also fixed while mirroring the edit semantics: the `edit` tool used
`String.replace(old, new)`, which expands `$&`/`$1` in the replacement text. It
now inserts the replacement literally.

Not covered yet: oracle weakening through `shell` (e.g. `sed -i` on a test file).
Policy already requires approval for `rm`/`mv` there, but shell edits are not
content-checked.

Regression coverage: `packages/core/tests/verificationIntegrity.test.ts`,
`packages/tools/tests/protectedVerification.test.ts`.

## Eleventh tranche: model circuit breaker

`ModelReliabilityTracker` (`packages/core/src/services/modelReliability.ts`) keeps a
rolling window of model-attributable outcomes per (model, task class). Success is
`VERIFICATION_PASSED`/`COMPLETED`. Failure is protocol exhaustion, `NO_PROGRESS`,
`REPEATED_ACTION`, `MAX_REPAIRS`/`MAX_TURNS`/`MAX_TOOL_CALLS`/`MAX_TOKENS`.
Cancellation, policy denial and wall-clock limits are ignored. The circuit only
opens after `minSamples` (default 4) at a failure rate of at least 0.6. It stays
`OPEN` for a cooldown (default 10 minutes), then goes `HALF_OPEN`: a successful
trial closes it with a clean window, and a failed trial reopens it.

`Scheduler` accepts an optional `reliability` dependency. An `OPEN` circuit
rejects the model from capability routing for that task class, and the reason is
recorded. An explicit model pin is still honored (no silent substitution), with a
warning in the routing reasons. The CLI persists each terminal turn's reason as
the durable `termination.completed` event (`apps/cli/src/termination.ts`, used by
the main run, subagent and fleet). The engine rebuilds the tracker from those
events at startup (`reliability.hydrate(await executions.list())`), so circuit
state comes from execution history, not process memory.

Regression coverage: `packages/core/tests/modelReliability.test.ts`,
`apps/cli/tests/termination.test.ts`.

Verification for tranches 8–11 was targeted, not a full suite run: `npx vitest run
packages/core packages/agents packages/tools` plus the CLI e2e/fleet/TUI/context/
dashboard/modelLifecycle/termination tests and `tests/integration/policyBypassSweep`.
Result: 68 files, 617 passed, 6 skipped (the pre-existing live-coding tests).
`npx tsc --build apps/cli` exited 0.

## Twelfth tranche: model attempts separated from model context

A rejected model attempt is now an execution fact, not a canonical assistant
message. This covers unparseable output, invalid tool arguments, a mutating tool
during planning, and an unknown action shape. The yielded turn keeps the raw text
(execution history), but `CodingAgent` no longer pushes it into `messages`.
Instead, one repair note is appended to the latest user message. On repeated
failures the note is replaced rather than accumulated, and it is removed when a
valid action is accepted, so later requests carry none of the failure history.
This also removes the back-to-back user messages the old correction path
produced, which strict chat templates reject. An action refused by the duplicate
circuit breaker is well-formed, so it still stays visible next to the refusal.

Each `runtime.generate()` call now receives a snapshot of `messages`. A request is
what the model saw at that turn, and later transcript edits cannot rewrite it.

Regression coverage: `packages/agents/tests/codingAgent.attemptContext.test.ts`.
Verification: `npx tsc --build apps/cli` exit 0; `npx vitest run packages/agents
apps/cli/tests/executeTask.e2e.test.ts` passed (24 files, 115 tests).

## Thirteenth tranche: failure-based model escalation

`CodingAgent` no longer treats every model failure as terminal. Protocol-budget
exhaustion (malformed JSON or repeated invalid arguments), `REPEATED_ACTION`,
semantic `NO_PROGRESS`, and a stalled repair loop (same diagnostics twice) first
call the new optional `AgentRuntime.escalate()`. That is bounded by
`maxModelEscalations` (option and per-request override, default 1). The agent
decides only that the current model has demonstrably failed. The host, which owns
routing, names the replacement or declines with a reason, and either answer is
explainable. On a switch the agent resets its per-model counters but keeps
workspace facts (seen observations, changed files). It drops any pending repair
note, tells the model about the switch, and yields a typed
`AgentTurn.routeChange` (`previousModel`, `newModel`, `failureClass`, `reason`,
`routeDecision`). An exhausted repair *budget* (`MAX_REPAIRS`) is a controller
limit and still terminates. A declined, unsupported or budget-exhausted
escalation terminates with the original reason, so behavior without a host hook
is unchanged.

Routing stays in the Scheduler. `ScheduleInput.excludeModelIds` rejects models
the run already tried, with an explicit reason. The CLI host (`planEscalation`,
`apps/cli/src/escalation.ts`, wired into `run.ts`) re-plans with the tried models
excluded and any pin cleared. It never substitutes a pinned model. It accepts
only a candidate the current placement can serve right now: same runtime, same
computer, `READY_NOW`. Re-placing a running execution (another computer, a model
load) is declined with that reason rather than attempted. Every decision,
accepted or declined, is recorded as `model.route.changed` with `accepted`,
`failureClass`, `reason` and `routeDecision`. An accepted escalation counts as a
failure of the abandoned model in the circuit breaker. The run's
`termination.completed` event is attributed to the model that was running at the
end, and `ModelReliabilityTracker.hydrate` rebuilds both from events.

Not yet wired: the fleet runner (`fleetRunner.ts`) provides no `escalate` hook,
so fleet tasks keep the terminate-on-failure behavior.

Regression coverage: `packages/agents/tests/codingAgent.escalation.test.ts`,
`apps/cli/tests/escalation.test.ts`, and additions to
`packages/core/tests/modelReliability.test.ts` (Scheduler exclusion, hydrate from
route changes).

Verification: another session was editing `packages/core` at the same time, and
its untracked `services/webContent.ts` does not compile. That blocked
`tsc --build`, so I typechecked with a scratch tsconfig covering
`packages/core/src` (minus the in-progress `web*.ts` files), `packages/agents/src`
and `apps/cli/src`: exit 0. Tests: `npx vitest run` on the escalation,
modelReliability, scheduler, termination and executeTask e2e tests plus the whole
`packages/agents` package. All passed.

## Fourteenth tranche: measured model performance

`ModelRecord.performance` (per task class, `ModelPerformanceProfile`) holds
empirically measured behavior. The fields are `samples`, `verifiedSuccessRate`,
`firstPassBuildRate`, `firstPassTestRate`, `protocolFailureRate`, `noProgressRate`,
`schemaReliability`, `medianToolCalls` and `medianDurationMs`.
`measureModelPerformance` (`packages/core/src/services/modelPerformance.ts`)
derives them only from durable execution evidence: the typed
`termination.completed` event, accepted `model.route.changed` events,
revision-stamped check records, recorded tool calls and execution timestamps.
Nothing is hand-entered, and nothing comes from model claims. First-pass rates
use a run's *first* build/test check, so a later passing rerun doesn't inflate
them. A rate no run could observe is `null`, not 0. After an escalation, the
failure is charged to the abandoned model and the outcome credited to the final
one, but run-level metrics (first-pass, tool calls, duration) are skipped
because they can't be attributed to one model. `schemaReliability` needed a new
input: the agent's per-run protocol metrics (valid vs attempted actions) were
computed but never persisted. `recordTermination` now stores them on the
`termination.completed` event.

`ModelRegistry.setPerformance`/`performanceFor` store the profiles.
`register()` preserves them when discovery re-registers a model. The CLI
engine measures from execution history at startup, after model discovery. The
Scheduler uses a profile only with at least 3 samples: up to +2 for verified
success, -1 for a majority protocol-failure rate. It records the measurement in
the routing reasons, e.g. `measured coding: 100% verified over 3 runs, protocol
failures 0%, first-pass build 67%`. Model size or name never enters the score.

The existing `wa benchmark` (single-prompt latency) is unchanged and does not
feed these profiles. Only real executions do.

Regression coverage: `packages/core/tests/modelPerformance.test.ts`. Verification:
scratch-tsconfig typecheck of core/agents/cli sources with no errors outside
another session's in-progress `web*` files. `npx vitest run` on
modelPerformance, scheduler, schedulerHostedRouting, modelReliability,
termination, escalation, executeTask e2e, modelLifecycleAdmission,
modelResources, jobOrchestrator and the CLI modelLifecycle tests: all passed
(11 files, 96 tests).

## Fifteenth tranche: execution summary (observability)

`summarizeExecution` (`packages/core/src/services/executionSummary.ts`) derives a
per-execution summary entirely from the durable record:
- **Time:** total, model inference (from `generation.started/completed` pairs,
  minus backoff), retry backoff (from `retry.scheduled` delays), tool time and
  verification time (a subset of tool time). `unattributedMs` is the remainder no
  recorded activity accounts for.
- **Counts:** model requests (including ones started but never completed), tool
  calls and failures, invalid actions, blocked duplicates, repair phases,
  context compactions, retries, escalations, checks, and policy
  allow/deny/ask.
- **Other:** tokens, context size, workspace revision, the model sequence, and
  the typed termination reason.

It holds only identifiers, counts and durations. A test verifies that
prompt/tool content never leaks into it, so it is safe for generic telemetry.
`wa executions inspect` shows it as a Summary block, and `--json` adds a
`summary` field next to the unchanged record fields (still valid JSON).

Verified read-only against this machine's real persisted history (29
executions). All loaded and summarized. None had typed terminations yet, since
they predate the termination event, so there were correctly no measured
profiles or open circuits. The most recent real run is an example of what the
summary surfaces. It took 440s total, but only 96s was model inference and 0.1s
tools, leaving 344s unattributed, with 28 context compactions in 30 model
requests. That points to compaction firing almost every turn and to a large
unexplained gap, both worth investigating.

Deferred: the agent does not persist its own run counters (longest no-progress
streak, token total) or a typed reason for an ordinary verification failure
(currently no `termination.completed` event). Both need edits to
`codingAgent.ts`/`run.ts`, which another session was editing at the same time.

Build note: CLI tests import `@wazir/core`/`@wazir/agents` from `dist/`. Once the
other session's untracked `webContent.ts` broke `tsc --build`, `dist/` went
stale, so the CLI-level runs reported for tranches 13–14 exercised previously
built package code. Their core/agent logic was tested from source. In this
tranche I rebuilt `dist/` with `tsc -p` (which emits despite that unrelated
error) and re-ran the termination, escalation, executeTask e2e, fleetRunner e2e
and inspect-summary CLI tests against the fresh build. All passed.

Regression coverage: `packages/core/tests/executionSummary.test.ts`,
`apps/cli/tests/inspectExecutionSummary.test.ts`.

## Sixteenth tranche: event-derived recovery and outcome reconciliation

The engine already turned a dispatched call with no recorded result into
`OUTCOME_UNKNOWN` on load. It then refused completion and any further write
"until reconciled", but no reconcile API existed, so a crashed execution could
never finish.

- **`ExecutionEngine.reconcileToolCall(executionId, callId, inspection)`**
  resolves such a call from physical evidence. `APPLIED` records it as completed,
  and `NOT_APPLIED` as failed, so the action may be issued again. `UNDETERMINED`
  is refused. The evidence and who inspected are part of the durable record. The
  call is idempotent through stable event IDs, and a second reconciliation of a
  resolved call is rejected.
- **`reconstructExecutionState` / `planRecovery`**
  (`packages/core/src/services/executionRecovery.ts`, plus
  `ExecutionEngine.reconstruct()`) rebuild the state from events:
  - the last confirmed workspace revision
  - the last confirmed tool result
  - unresolved tool calls
  - the lease holder, when lease events exist
  - which checks are current at that revision and which are stale
  - consumed budgets, and remaining ones given limits

  The plan is `none` for a terminal execution. It is `reconcile` (listing each
  unresolved non-read-only call, never a replay) while any remain, `terminate`
  when a budget is already exhausted, and otherwise `resume` the *same*
  execution at its revision.
- **`inspectToolOutcome`** (`packages/tools/src/outcomeInspection.ts`) answers
  only what the filesystem proves:
  - read-only: `NOT_APPLIED`
  - `write`: exact intended content is `APPLIED`, anything else `NOT_APPLIED`
    (safe to reissue, because the write sets exact content)
  - `edit`: old-text-only is `NOT_APPLIED`, new-text-only `APPLIED`; overlap,
    both or neither is `UNDETERMINED`
  - shell, git, MCP and other external effects: always `UNDETERMINED`
- **`RecoveryManager`** takes an optional `inspectToolOutcome`. It reconciles
  proven outcomes before orphaning, reports them in `reconciled`, and keeps
  undetermined ones in `unknownOutcomes`, out of live retry.
- **The CLI** (`apps/cli/src/recovery.ts`) inspects only executions that ran on
  this computer outside a job worktree. The execution record does not carry a
  worktree path, and remote workers' files aren't local. Everything else is
  `UNDETERMINED` with that reason. On non-read-only startup the engine reconciles
  local standalone executions' provable outcomes.

Finding: `writeProjectFile` opens with `O_TRUNC` and then writes, so it is not
atomic. A crash mid-write leaves a truncated file. Recovery handles this safely
(truncated means `NOT_APPLIED` for `write`, and `UNDETERMINED` for `edit`, whose
original text may be lost). Making the write atomic (temp file plus rename)
would need care around the current same-inode and `O_NOFOLLOW` checks, and is
left open.

Not done: resuming the agent loop itself inside the recovered execution. The
plan says when resumption is safe and at which revision, but the orchestrator
still retries a task as before.

Regression coverage: `packages/core/tests/executionRecovery.test.ts`,
`packages/tools/tests/outcomeInspection.test.ts`, `apps/cli/tests/recovery.test.ts`.
Verification: the shared `node_modules` lost `vitest` during the other
session's dependency changes, so tests ran through `npx vitest@2.1` (the
project's pinned major) with a scratch config. `packages/core`,
`packages/tools` and the CLI recovery/e2e/fleet/termination/inspect tests ran:
48 of 49 files passed (486 passed, 6 skipped). `mcp.integration.test.ts` failed
at file load in the combined run but passed 19/19 on its own. It covers MCP
code this tranche doesn't touch.

## Seventeenth tranche: leftovers from tranches 13, 15 and 16

### Recovery (Phase 21)

- **Atomic writes.** `writeProjectFile` writes an exclusive temp file beside the
  target (`O_EXCL | O_NOFOLLOW`, inode and containment re-checked like reads),
  fsyncs it and renames it over the target. An existing file keeps its
  permission bits. A crash now leaves the old file or the complete new one,
  never a truncated half-write. This covers `write`, `edit` and every other
  caller.
- **Workspace root recorded.** `Execution.workspaceRoot` records the directory
  the execution's tools ran in: the project root for `wa run` and its
  subagents, the task root (worktree) for fleet tasks. `localOutcomeInspector`
  inspects that directory, so a job task's unknown outcome can now be resolved
  from its own worktree. A job execution with no recorded root (created before
  this change), or whose recorded root no longer exists, stays `UNDETERMINED`.

Regression coverage: `packages/tools/tests/atomicWrite.test.ts`, additions to
`apps/cli/tests/recovery.test.ts`.

## Not yet done

- Phase 12 remainder: one composed `StopCondition[]` evaluated centrally. The
  checks are still inline in `CodingAgent`.
- Phase 14 remainder: an escalation hook for the fleet runner, and mid-run
  re-placement (a different computer, or loading a model) as an escalation target.
- Phase 17 remainder: agent-side run counters and a typed reason for an ordinary
  verification failure (see the fifteenth tranche).
- Phase 21 remainder: resuming the agent loop inside the recovered execution
  (the recovery plan says when it's safe; tasks are still retried as before).
- Phase 22: `wa executions events|explain` projections of the new events.
- Phase 24: the live acceptance run.
