# CLI Execution Reliability — P0 Remediation Handoff

Checkpoint ID: 0001-p0-abd-complete
Timestamp: 2026-10-19T20:31:31-07:00
Current phase: P0 remediation (3 of 5 P0 items fixed, verified, and merged to branch)
Repository: /home/wael/Code/Wazir
Git branch: agy/autonomous-remediation-supervisor
Git commit: e0a87a61e214c0b703ae7c73343a6eab14ca87ce
Wazir version: 0.2.5
PR: https://github.com/whassan007/wazir/pull/16
Handed off by: Claude (Sonnet 5), interactive session
Handed off to: next worker (e.g. the local Qwen-model-driven autonomous loop) continuing this branch

## Objective

Repair `wa chat`'s CLI execution pipeline per the P0/P1 reliability brief: a
trivial `ls` was entering the full coding-agent loop, loading a model, hitting
a tool-schema validation bug, and running to `MAX_TURNS=30` without ever
producing output. Five P0 items were scoped; three are done.

## Important: concurrent writer on this branch

While this session worked, **another autonomous process was actively editing
the same working tree concurrently** — most visibly `packages/agents/src/codingAgent.ts`
and its fast-path classifier tests (extending `WORKSPACE_OR_TOOL_ACTION_RE` to
catch network-tool directives like `curl`/`nslookup`/`openssl s_client`), plus
new untracked dirs `test/model-routing/`, `test/github-integration/`,
`test/github-mcp/`, `test/runtime/liveModelRouting.test.ts`, and edits to
`packages/core/src/types/mcp.ts`. This is presumably the Qwen-model-driven
supervisor loop this branch is named for. **Before editing `codingAgent.ts`
again, run `git status`/`git diff` first** — it may have moved since this
note was written, and merging blind risks clobbering live, uncommitted work.
Only commit files you've actually read and intend to change; this session
deliberately left all of the above untouched and staged only the files each
of its own commits names.

## Status of the 5 P0 items

| ID | Item | Status | Commit |
|---|---|---|---|
| P0-A | Simple commands (`ls`/`pwd`/`git status`/`diff`/`log`) routed into full agent loop | **Fixed** | `973111f` |
| P0-B | Displayed model ≠ actual execution model; unavailable model dispatched anyway | **Fixed** (completed/verified work already present uncommitted in tree; this session verified + committed it) | `e0a87a6` |
| P0-C | `search` tool `TOOL_VALIDATION_FAILED: /regex must be string` | **Not started** | — |
| P0-D | Uncontrolled 30-turn loop on repeated identical failure | **Fixed** | `9c4fb4a` |
| P0-E | Sandbox (bwrap) unavailable → silent fail-open to host execution | **Not started** | — |

P1 items (cancellation/terminal-state machine, progress reporting) and the
required CSV/evidence artifacts (`test/cli-reliability/{issues,execution-results,
model-routing,tool-validation,benchmark-results}.csv`, `fixes-applied.md`,
`FINAL-REPORT.md`) from the original brief are **also not started**.

## Action Taken (this session)

1. **P0-A** — Added `isDeterministicCommandRequest()` in `codingAgent.ts`: a
   narrow, exact-match allowlist (`ls`, `dir`, `pwd`, `git status`, `git diff`,
   `git log`, with simple flags/paths) that rejects shell metacharacters and
   never infers shell intent from prose. Wired into `CodingAgent.run()` ahead
   of the conversational fast path — a match calls `runtime.executeTool`
   directly (through the existing sandbox/authorization path) and returns a
   terminal turn with zero model calls, zero agent turns.
2. **P0-D** — The existing validation-failure tracking
   (`validateAction`'s `consecutiveValidationFailures`/`lastValidationKey`)
   only escalated/terminated after the *3rd* identical failure, and escalation
   could still exhaust `MAX_TURNS` if no fallback model was configured —
   exactly the reported `search` regex loop. Added a tighter breaker: the
   **2nd** identical validation failure (same tool, same reason) now
   terminates immediately with a new `IDENTICAL_VALIDATION_FAILURE`
   termination reason, in both the native and legacy action-processing
   branches. Removed the now-unreachable 3-strike branch. Registered the new
   reason as model-attributable in `packages/core/src/services/modelReliability.ts`.
3. **P0-B** — Found this already implemented, uncommitted, in the working
   tree (presumably by the concurrent Qwen-driven loop). Verified it
   typechecks (`apps/cli`, `packages/core`) and passes (22/22 new + existing
   tests in `apps/cli/tests/modelLifecycle.test.ts`), then committed it rather
   than re-implementing: `apps/cli/src/routeAvailability.ts` (new) plans a
   task, then verifies the chosen model is still served by its runtime before
   dispatch, excluding and re-planning (bounded to 3 attempts) on
   `MODEL_UNAVAILABLE`, recording each skip as a `ModelFallback`; a pinned
   model is never silently substituted. `fleetTui.ts` now shows the model
   actually bound to the running task, not a merely-ready model or stale pin.
   `modelLifecycleService.ts` had a broken availability probe
   (`setTimeout(resolve, ms)` — passing the resolver positionally as the
   timeout's own callback-arg, which does fire but was clearly meant to be
   `setTimeout(() => resolve(), ms)`; fixed for clarity/correctness parity).
   `scheduler.ts` gained the `ModelFallback` type and `SchedulerDecision.fallbacks`.

## Observed Result

- `npx tsc --noEmit` clean on `packages/agents`, `packages/core`, `apps/cli`.
- `packages/agents` suite: 279/279 passing (P0-A, P0-D commits).
- `packages/agents` + `packages/core` combined: 1150/1150 passing (P0-D commit).
- `apps/cli/tests/modelLifecycle.test.ts`: 22/22 passing (P0-B commit).
- Full `apps/cli/tests/` run: **1 pre-existing failure**, unrelated to any of
  this session's changes — confirmed by stashing the P0-B files and
  re-running: `apps/cli/tests/fleetTui.test.ts` → "shows a failed tool call
  with a plain-language reason, not the raw policy rule id" (expects screen
  to contain `'shell failed'` / `'Blocked: empty shell command'`; neither
  appears). Not triaged further this session — needs its own investigation.
- No real `wa chat` interactive manual run yet for any of the three fixes —
  only vitest coverage. The brief requires end-to-end interactive
  verification; that's still outstanding for P0-A/B/D too.

## Decision

Committed and pushed P0-A, P0-D, and P0-B to
`agy/autonomous-remediation-supervisor` as three separate, independently
revertable commits, each with its own test coverage, rather than batching
them — the user explicitly scoped this down to "one P0 at a time" early in
the session.

## Files Modified

- P0-A (`973111f`): `packages/agents/src/codingAgent.ts`,
  `packages/agents/tests/codingAgent.deterministicCommand.test.ts` (new).
- P0-D (`9c4fb4a`): `packages/agents/src/codingAgent.ts`,
  `packages/agents/tests/codingAgent.toolArgValidation.test.ts`,
  `packages/core/src/services/modelReliability.ts`,
  `packages/core/src/types/agent.ts`.
- P0-B (`e0a87a6`): `apps/cli/src/routeAvailability.ts` (new),
  `apps/cli/src/run.ts`, `apps/cli/src/tui/fleetTui.ts`,
  `apps/cli/tests/modelLifecycle.test.ts`,
  `packages/core/src/services/modelLifecycleService.ts`,
  `packages/core/src/types/scheduler.ts`.
- A separate, unrelated batch commit (`6211048`, pushed earlier in this
  session before P0 work started) carries a mobile app scaffold and
  dispatch-cancellation/recovery work that predates this handoff's scope —
  see its own commit message for detail, not repeated here.

## Verification

All of the above is vitest + tsc verification, not live interactive
verification. Nothing in this handoff should be read as "manually confirmed
in `wa chat`" — that step is explicitly still open.

## Outstanding Issues

1. **P0-C** (`search` tool `regex` argument validation / generation) — not
   started. The brief's root-cause ask ("why is `regex` not a string — model
   generation, schema mismatch, planner transformation?") still needs tracing
   through `packages/tools/src/search.ts` (schema ~line 137-139, build logic
   ~151-165) and wherever the model's tool-call JSON is parsed before
   `validateAction` sees it. P0-D makes a *repeated* instance of this bug
   non-catastrophic (stops at 2 failures instead of running to MAX_TURNS),
   but does not fix the *first* occurrence.
2. **P0-E** (sandbox fail-open) — not started. `packages/tools/src/sandbox.ts`:
   for `requested === 'auto'` (the default), bwrap probe failure silently
   falls through to `mode: 'none'` with no `required` flag — true fail-open.
   Needs a policy decision (and likely a config default change) to fail
   closed instead, per the brief's `SANDBOX_UNAVAILABLE` requirement.
3. **P1 cancellation/terminal-state machine** and **P1 progress reporting** —
   not started.
4. **Required evidence artifacts** (`issues.csv`, `execution-results.csv`,
   `model-routing.csv`, `tool-validation.csv`, `benchmark-results.csv`,
   `fixes-applied.md`, `FINAL-REPORT.md`) — not started. None of this
   session's verification claims (test counts, tsc results above) have been
   transcribed into those files yet.
5. **The pre-existing `fleetTui.test.ts` failure** noted above — not triaged,
   not attributed to any specific commit on this branch (confirmed pre-dating
   P0-B's changes; not checked against older history).
6. **Live interactive verification** — none of P0-A/B/D has been run against
   a real `wa chat` session yet, only against vitest's fake adapters.

## Immediate Next Action

Pick up **P0-C** (`search` tool `/regex must be string`): reproduce against
a real model (the brief's own transcript was against
`google/gemma-4-12b-qat` / `gemma-4-26b-a4b-it-qat`), trace the exact
argument from model output through to `validateAction`, and fix at the
source (schema mismatch, serialization, or model-facing tool description)
rather than only containing the symptom (which P0-D already does).

## Recovery Notes

Nothing in this handoff depends on in-memory state — it's a plain git branch.
Safe to resume directly by pulling `agy/autonomous-remediation-supervisor`
at `e0a87a6` (or later) and re-running `git status` first to see what the
concurrent process has done since.
