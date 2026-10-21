# Issues Ranked — Wazir Mac/Gemma Usability & Reliability Audit

## P0 — Execution failures

### P0-1 (OPEN, root cause unconfirmed): Unauthorized git merge coincided with a single `wa run` invocation

**Repro:** `cd /Users/wael/Code/Wazir && wa run "What is 23 + 19? Return only the number." --model google/gemma-4-12b-qat --runtime lmstudio --routing-mode LOCAL_ONLY --json`
(execution id `exec-mvd704q7-1`, started 2026-10-18T02:14:46.255Z, failed 2026-10-18T02:18:24.311Z).

**Impact:** Immediately after/during this single command, the current branch (`test/real-world-acceptance`)
gained a new merge commit `e531017 Merge tag 'v0.2.8' into test/real-world-acceptance` (git's own default
tag-merge message, "ort" strategy) that did not exist before the command ran — ~1450 lines across 28 files,
including a whole new "autonomous five-minute updater" feature. No confirmation prompt, no CLI output
mentioning it, no entry in `~/.wazir/audit.jsonl`, and — critically — **no git subcommand of any kind
appears in this execution's own durable event log** (`wa executions events exec-mvd704q7-1 --json`, full
transcript inspected). This is a severe trust/safety issue: a user (or an audit) cannot tell from Wazir's
own observability surface that their repository history was mutated.

**Root cause:** NOT CONFIRMED, despite a thorough source audit. Ruled out with evidence:
- `apps/cli/src/updater/service.ts` (v0.2.8's own new feature) — zero git calls, only runs on explicit
  `wa update`, and this machine's homebrew install method can't self-modify the working tree anyway
  (confirmed by reading the full file and its wiring in `apps/cli/src/index.ts:155-168`).
- `packages/core/src/services/worktreeManager.ts:326-377` `mergeBranch()` — always supplies a custom
  `-m "Merge branch '<branch>' into <target>"`; message format doesn't match git's default tag-merge
  message we observed. Also gated on `evaluation.success` in its only caller
  (`apps/cli/src/fleetRunner.ts:632-639`), and our task failed.
- `packages/core/src/services/verifiedIntegrationCoordinator.ts` — by its own doc comment (line ~145)
  "deliberately does not promote or merge a qualified candidate into a target branch"; its merges
  (lines 329, 450) only ever touch a disposable detached worktree, never the real checked-out branch.
- The agent's own tool calls for this execution — full event log pulled and read; the only shell
  commands executed were `echo $((23 + 19))` (denied by policy, correctly, non-interactive ask→deny)
  and `echo 42` (allowed, ran fine). No `git merge`/`checkout`/`fetch` tool call anywhere.

**Policy engine behaved correctly where it was actually invoked** — `packages/core/src/services/policyEngine.ts`'s
`resolveAsk()` and `apps/cli/src/approve.ts`'s `createApprover()` both correctly deny `ask`-classified
actions (including `git merge`, via `GIT_ASK`) when non-interactive, "never silently allowed." The gap is
that whatever performed this merge did not go through `policy.authorize()` at all.

**Resolved (most likely explanation, confirmed with the user):** the user confirmed a separate agent/tool
session was running against this same repository during this exact window (see P1-3 below, where the
same concurrent session's file writes were independently proven to exist via this execution's unscoped
workspace diff). That session would have its own shell access entirely outside Wazir's `PolicyEngine`,
which fully explains why no trace of the merge exists in any of Wazir's audit/event logs. **This specific
incident is very likely not a Wazir defect.** Downgrading confidence accordingly, but keeping the
defense-in-depth fix (fix 2) regardless, since Wazir still has no general way to detect a concurrent
process mutating the repo during a task, and silently handing back a result in that situation is wrong
regardless of who caused it.

**Remediation applied:** reverted via `git stash push -u` (preserving genuine pre-existing uncommitted WIP
and all audit artifacts) → `git reset --hard 7133f16` → `git stash pop` → manually discarded the 4 files
that were drift unrelated to the pre-existing WIP (`apps/cli/package.json`, root `package.json`,
`scripts/build-binary.mjs`, `scripts/pack-npm.mjs` — confirmed via diff that none of this drift was part
of the user's original pre-session uncommitted changes). Verified final `git status` matches the exact
pre-session state plus only the new `test/` audit directory.

**Fix implemented (defense-in-depth, independent of root cause):** see fixes-applied.md — a git-HEAD
integrity guard wrapping task execution that fails loudly if HEAD moves through any path other than
Wazir's own audited merge.

### P0-2 (CONFIRMED and FIXED): Trivial prompts are routed through the full multi-phase coding-agent pipeline, including a full monorepo build

**Repro:** same command as P0-1.

**Impact:** "What is 23 + 19?" — a one-token-answer arithmetic question — was classified as a `coding` task
and routed through `wazir-coding`'s plan → implement → verify pipeline. The `verify` phase unconditionally
ran `npm run build`, `npm run test`, `npm run lint`, `npm run typecheck` against the **entire monorepo**,
including a Tauri desktop Rust build that tried to reach `crates.io` (no network access in this sandboxed
run) and failed after ~69s and ~70s respectively. Total wall time: 3 minutes 40 seconds for a question
that should take under a second and need zero verification. The task was then reported `"success": false`
with the top-level reason "Agent declared completion but produced no code modifications" — penalizing the
agent for correctly not writing code to answer an arithmetic question.

**Impact on observability:** the actual correct answer ("42", produced via `echo 42` at
2026-10-18T02:15:33Z, policy-approved, tool succeeded) is never surfaced anywhere in the final JSON output
or exit status — the task is reported as a hard failure with a wall of irrelevant Rust/npm network-error
noise, with no resolution of the user's actual question visible.

**Root cause (fully confirmed via source):** `packages/agents/src/codingAgent.ts`'s VERIFY phase
(~line 1774, before fix) ran `['build', 'test', 'lint', 'typecheck']` unconditionally for any task whose
type isn't `research`, regardless of whether the agent's own tool calls changed anything
(`filesChangedSet.size`). The one existing skip condition (`groundedResearch && filesChangedSet.size === 0`)
only applied to grounded-research tasks. For a plain `coding`-typed task — the default when `--type` is
omitted — checks ran even when `filesChangedSet.size === 0`, i.e. even when the SAME verify phase had
*already* independently concluded, two lines earlier, "Agent declared completion but produced no code
modifications" (line 1746, `mutationRequired && filesChangedSet.size === 0`). Running build/test/lint/
typecheck in that situation is pure waste: the task is already going to fail for lack of any mutation, and
nothing changed for the checks to usefully verify.

**Fix:** skip the check battery whenever `filesChangedSet.size === 0 && (groundedResearch || mutationRequired)`
— i.e. skip exactly when the task is already guaranteed to fail for having changed nothing (coding) or has
no grounded evidence to show for it (research), while still running checks for a legitimate verify-only
task (`mutationRequired: false`, e.g. "run the test suite and tell me if it's green") that correctly expects
zero file changes. See fixes-applied.md for test evidence.

**Severity:** P0 — this was the single most impactful usability finding: ordinary use of `wa run` (or
presumably `wa chat`) for a simple question could silently cost minutes of wall time, a full unrelated build
failure, and a false "failed" verdict. **Status: FIXED.**

### P0-3 (RETRACTED — verified NOT a bug): Local model admitted despite its own "INSUFFICIENT" memory classification

**Original evidence (`exec-mvd704q7-1` event `MODEL_LOAD_PLAN_CREATED`):**
```
"estimatedTotalMemory": 12713103196.16,     // ~11.8 GiB needed for a FRESH load
"currentlyAvailableMemory": 214748364.8,    // ~0.2 GiB available
"postLoadAvailableMemory": -12498354831.36, // negative!
"classification": "INSUFFICIENT",
"reuse": true,
"admissionDecision": { "status": "ADMITTED", "reasons": [] }
```
At first read this looked like admission control ignoring its own safety classification. It does not:
`estimate.classification` describes what a *fresh* load would cost right now; `reuse: true` means the
instance was already resident (verified `READY` by an earlier reconcile pass in the same `wa run`
invocation) and the memory-sufficiency checks in `modelLifecycleService.ts`'s `estimate()` are only
applied inside the `if (!reuse) { ... }` branch — correctly, since reusing an already-loaded model needs
no new allocation. Wrote a test pinning the exact boundary
(`packages/core/tests/modelLifecycleAdmission.test.ts`, *"reusing an already-READY model is ADMITTED even
when a hypothetical fresh load would be INSUFFICIENT, but a genuine fresh load under the same scarcity is
DENIED"*): it passes with **zero code changes**, confirming (a) reuse is correctly admitted without a
redundant memory check, and (b) a genuine fresh load of a different model under identical scarcity is
still correctly rejected with `MODEL_ADMISSION_DENIED`.

**Residual (minor, not actioned):** the `MODEL_LOAD_PLAN_CREATED` event still surfaces a stale/irrelevant
`classification: INSUFFICIENT` next to `admissionDecision: ADMITTED` with no field explaining that the
classification only describes the fresh-load path and is moot for a reuse. Purely cosmetic/observability;
downgraded out of P0, not tracked further this session.

### P0-4 (CONFIRMED and FIXED, found while re-running G02 after the P0-2 fix): the model's actual answer was discarded entirely when verification failed

Once P0-2 was fixed, re-running G02 ("What is 12 x 8?") dropped from 3m26s to 33s — but the task still
failed (correctly: `coding`-typed tasks default to `mutationRequired`, and answering a question isn't a
code change) and the final JSON result had **no `result` field at all**, only the generic
"Agent declared completion but produced no code modifications" error. Pulling the execution's event log
showed the model *did* answer (2 valid actions, 0 malformed) — but `packages/agents/src/codingAgent.ts`'s
VERIFICATION_FAILED and MAX_TURNS error turns never carried the model's `modelSummary` forward, and
`apps/cli/src/run.ts`'s turn-consumption loop only ever set `summary` (which becomes the final `result`
field) on a `'done'` turn, never on an `'error'` turn. So a correctly-answered trivial question that
VERIFY (rightly) didn't count as "real work" gave the user **zero way to tell whether the model got it
right** — arguably worse than the P0-2 slowness, since now the task fails *fast* with no information at
all.

**Fix:** both error-yield sites in `codingAgent.ts` now include `content: modelSummary` (when the model
said anything before the failure), and `run.ts`'s `case 'error':` handler now also sets `summary =
turn.content` when present — mirroring the existing `'done'` handling. Verified live: G02 rerun now
returns `"result": "96"` alongside `"success": false`.

**Regression test:** `apps/cli/tests/executeTask.e2e.test.ts`, *"a Q&A prompt answered correctly without
writing any file still surfaces the answer, even though VERIFY fails it for making no code changes"* —
red before the fix (`outcome.result` was `undefined`), green after.

## P1 — Observability failures

### P1-1 (CONFIRMED, root-caused): `wa models health --detail` / `wa doctor` report a loaded, idle, working local model as `ready=false`

See model-verification.md for full detail. Root cause: `packages/core/src/services/modelLifecycleService.ts`
only promotes a model's lifecycle `state` to `'READY'` (required for `ready=true` in
`packages/core/src/services/healthDiagnostics.ts:150`) via an explicit `verify()` probe
(`modelLifecycleService.ts:556-564`), and that probe is skipped during reconcile
(`modelLifecycleService.ts:834-837`) whenever a model was loaded outside Wazir (e.g. directly via LM
Studio) at a context length that doesn't match a previously-stored `desired.contextTokens`. The model then
sits at `state: 'LOADED'`/`ready:false` indefinitely even though it's fully functional.

**User impact:** a user who loads a model directly via LM Studio (very common workflow) will see Wazir
report it as not ready, with no indication of *why*, and no guidance to re-run `wa models load`/`pin` to
force the verify probe.

### P1-2 (CONFIRMED, partially root-caused): lmstudio runtime memory always reads near-100% CRITICAL

Formula in `healthDiagnostics.ts:51-62` is internally consistent; no hardcoded numerator==denominator bug
found. Most likely driver: `packages/core/src/services/computerRegistry.ts:110` falls back to
`os.freemem()` when no fresh load sample exists, which under-counts reclaimable/cached memory on macOS,
biasing the fraction toward CRITICAL. Secondary possible contributor: unsettled `activeReservations` are
added to the CRITICAL fraction and may not be released if a load operation times out
(`modelLifecycleService.ts:539` comment). Not fully isolated — would need instrumenting `resourcePressure()`'s
live inputs to confirm which factor dominates. This audit's own observation (P0-3) shows this Mac may
genuinely be under severe memory pressure right now, which could also just mean the reading is correct.

### P1-3 (REVISED — not the model; a real Wazir scoping gap): the task's reported "filesChanged" includes files the agent never touched

**Original read (retracted):** this looked like the Gemma model hallucinating a fictional "Codex" audit
instead of answering. **Corrected, with evidence:** pulling the complete durable event log for
`exec-mvd704q7-1` shows the agent's own tool-call trace (`kind: "tool_call", raw: ...`) contains exactly
two actions — `echo $((23 + 19))` (denied, non-interactive) and `echo 42` (ran fine) — nothing else. The
10 files under `test/codex-gemma-execution/` (and, notably, this audit's own
`test/agy-mac-gemma/model-verification.md`, which *I* wrote via a separate tool while this exact task was
running in the background) both show up in that execution's `workspace.mutated` events purely because
they changed on disk during the task's wall-clock window — this event is a directory-wide hash-diff
snapshot (`verifyWorkspace: true`), not scoped to files the agent's own write/edit tool calls touched
(those are tracked separately, correctly, in `filesChangedSet`, which stayed empty — hence the accurate
"no code modifications" failure).

**Real, confirmed defect:** Wazir's workspace-mutation detection for a task attributes *any* concurrent
filesystem change under the project root to that task, regardless of source. Running `wa run` while
literally anything else writes to the same project directory — another terminal, another tool, an editor
autosave, or (most likely here) a separate, unrelated agent session someone had running against this same
repo — gets misattributed into that task's own "files changed" report. This is a real observability/
correctness gap (not fixed this session — see fixes-applied.md "not yet fixed"), but it is a narrower,
less alarming issue than "the model lies."

**Confirmed:** asked the user directly — another agent/tool session *was* running against this same
repository during that window. This resolves the open question: the `test/codex-gemma-execution/*` files
were almost certainly written by that other process, not fabricated by Gemma/`wazir-coding`, and were
only pulled into this execution's report because of the unscoped-diff gap above. The same external
process — not Wazir — is also now the leading explanation for the P0-1 merge (issues-ranked.md P0-1),
since an independent agent session would have its own shell access entirely outside Wazir's
policy/audit path. **This session's P0-1 incident is very likely a false alarm about Wazir's own code**,
but the defense-in-depth fix (fixes-applied.md, fix 2) and this unscoped-diff gap remain worth having
regardless — Wazir had no way to tell the user a concurrent process was mutating files/history in their
project while a task ran, and now at least the HEAD-movement half of that is surfaced loudly instead of
silently.

### P0-5 (CONFIRMED, not fixed — architectural/scoping decision, not a narrow bug): the "build"/"test" check used by VERIFY builds the ENTIRE monorepo, including a network-dependent desktop app

**Evidence:** every benchmark task that actually wrote a file (G04, G05, G06) "failed" — not because the
model's answer was wrong (all three were correct: `HELLO MAC`, `{"status":"ok","count":5}`, a correct
`square.py`), but because `npm run build`/`npm run test` at the repo root cascade through
`--workspaces --if-present`, which includes `@wazir/desktop`'s Tauri build — and that tries to reach
`crates.io` over the network, which this environment doesn't have (or doesn't allow), and fails after a
burst of retried DNS failures every single time. This is the single most impactful pattern observed
across the whole benchmark run: **any real coding task in this environment is reported as "failed"
verification for a reason that has nothing to do with the task**, regardless of how correct or trivial
the actual code change was.

**Why this is separate from P0-2:** P0-2 (fixed) skips the check battery when nothing changed — it
doesn't help once a task legitimately writes even one file, which is the normal case for "write a
function"-style prompts. This is a distinct, broader problem: the check battery itself is scoped to the
whole monorepo rather than to what the task actually touched, and includes a check (`@wazir/desktop`'s
build) with an external dependency unrelated to almost everything a coding agent would plausibly be asked
to do.

**Not fixed this session:** this needs a product decision, not a narrow patch — candidates include
scoping `build`/`test` to the workspace(s) containing the changed files (`npm run build --workspace
<pkg>`), making the Tauri/desktop build excludable from the agent's generic check battery, or giving
`wa run`/task definitions a way to specify which checks actually apply. Any of these changes the meaning
of "verification passed" for the whole product, not just this one task type, so it's flagged here with
full evidence rather than attempted under audit time constraints.

### P1-4 (CONFIRMED, not fixed): a coding-type task can be denied admission for a context reload under memory pressure, with no CLI-level way to avoid it

G06 ("write a Python function...") was denied outright on first attempt — `MODEL_ADMISSION_DENIED:
CONTEXT_RELOAD_REQUIRED: INSUFFICIENT_MEMORY` — because the task's required context exceeded what the
model was already loaded at (ctx=8192), and a fresh load at the larger context didn't fit in the ~187MB
of free RAM this Mac had at that moment (`vm_stat`: `Pages free: 11416` × 16KiB page size). Retried
immediately after with the identical command and it succeeded — confirming this is real, transient
memory pressure (consistent with P1-2/the "24/24 GiB CRITICAL" reading), not a logic bug. `wa run` has no
`--context` flag (confirmed via `--help`) to let an operator say "reuse whatever's already loaded, don't
reload" — only `wa models pin --context` operates at that level, disconnected from `wa run`'s own
admission path. A user hitting this gets a terse, uninformative error with no actionable next step (free
memory and retry; or `wa models pin` the model at a larger context ahead of time) surfaced anywhere.

## P2 — Performance issues

### P2-1: 90+ second latency before first visible progress on a trivial local-model request
Even setting aside the full-repo build, model admission + first generation for "echo $((23+19))" took
from 02:14:46 to 02:15:13 (27s) before the first (denied) tool call, and total time-to-answer ("42") was
at 02:15:33 — 47 seconds for a 12B local model to answer trivial arithmetic. Likely dominated by the
severe memory pressure in P0-3 (postLoadAvailableMemory deeply negative → heavy swapping/contention).

---

*Status: Phase 7 ranking in progress — this reflects findings from the environment/model verification
pass and the single G01 benchmark execution. G02–G10 not yet run (see HANDOFF.md for resume point).*
