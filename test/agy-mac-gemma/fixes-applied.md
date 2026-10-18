# Fixes Applied

## Fix 1 — M1 / P1-1: model readiness falsely resets to "not ready" on every read-only health check

**File:** `packages/core/src/services/modelLifecycleService.ts`, `reconcileObserved()` (model-instance loop, ~line 829).

**Root cause (fully confirmed via source + live reproduction):**
- A real task's `load()` calls `this.verify()` and correctly sets instance `state: 'READY'`.
- `wa doctor` / `wa models health` / `wa models list` create their engine with `readOnlyLifecycle: true`
  (`apps/cli/src/health.ts:102`, and multiple sites in `apps/cli/src/index.ts`), which becomes
  `discoverAndReconcile({ verify: false })` (`apps/cli/src/engine.ts:484`).
- `reconcileObserved()` unconditionally rebuilt each instance's `state` from scratch every pass
  (`state: loaded ? 'LOADED' : ...`), discarding a previously-earned `'READY'`, and only re-promoted it
  back to `'READY'` by calling `verify()` — which is explicitly skipped when `verify` is `false`.
- Net effect: any read-only status command permanently downgrades a perfectly working, already-verified
  model back to "not ready," and it only flips back to `READY` for the instant a real task happens to use
  it directly through `load()` — confirmed live: `wa models health --detail` showed `ready=false` even
  17 minutes after a real, successful inference against the exact same model/instance.

**Fix:** preserve `state: 'READY'` across a reconcile pass when nothing that would invalidate a prior
verification has actually changed (still loaded, same health, same observed context as when it was last
verified), and skip the (now redundant) re-verify call in that case. Falls back to the original
reset-and-maybe-verify behavior whenever anything meaningful changed.

**Regression test:** `packages/core/tests/modelLifecycleAdmission.test.ts` —
`'preserves a verified READY state across a read-only (verify:false) reconcile'`. Confirmed RED before
the fix (`expected false to be true`), GREEN after. Also asserts the read-only pass does *not* re-probe
the model (so this isn't just "always verify," which would defeat the purpose of `readOnlyLifecycle`).

**Verification run:**
```
npx vitest run packages/core/tests/modelLifecycleAdmission.test.ts apps/cli/tests/modelLifecycle.test.ts
```
71 tests passed, 0 failed. `npx tsc --build packages/core apps/cli` clean.

## Fix 2 — P0-1 (defense-in-depth, root cause unconfirmed): git-HEAD integrity guard around `wa run`

**New file:** `packages/core/src/services/repoIntegrityGuard.ts` — `captureHeadFingerprint(projectRoot)`
snapshots the checked-out branch + commit sha; `describeUnexpectedHeadDrift(projectRoot, before)` compares
against current state and returns a description only when the *same* branch's commit moved (a deliberate
branch switch by the user is not flagged).

**Wiring:** `apps/cli/src/commands.ts`'s `runTaskCommand()` (the actual `wa run` CLI handler) captures a
fingerprint immediately before calling `executeTask(...)` and checks it immediately after; if drift is
detected, the task outcome is forced to `success: false` with the drift description prepended to both
`reasons` and `errors` — so a user (or a script parsing `--json` output) cannot receive what looks like an
ordinary result while their repository history was silently mutated.

**Why this scope, not a deeper engine-level guard:** the actual mechanism behind the 2026-10-17 merge
incident (issues-ranked.md P0-1) was not isolated despite ruling out four candidate code paths with direct
evidence, including reading this exact execution's full durable event log. Wiring a HEAD check into the
generic `ExecutionEngine` (used by every execution, including hosted ones without a real local git
workspace, and tasks that *legitimately* produce isolated-worktree commits) risked false positives and a
much larger, riskier change under audit time constraints. Scoping it to the one concrete entry point where
the incident was reproduced (`wa run`'s CLI handler, operating directly on `engine.projectRoot`) gets the
actual safety property — the user is told, loudly, every time — with a small, fully tested, low-risk change.

**Regression tests:** `packages/core/tests/repoIntegrityGuard.test.ts`, 6 cases against real temporary git
repositories (not mocked), including a case that reproduces the *exact* real-world scenario (`git merge
--no-ff --no-edit <branch>` on the checked-out branch) and asserts it's detected, plus cases confirming
ordinary working-tree edits and deliberate branch switches are correctly *not* flagged.

**Verification run:**
```
npx vitest run packages/core/tests/repoIntegrityGuard.test.ts apps/cli/tests/agentPreflight.test.ts apps/cli/tests/nvidiaProviderSystem.test.ts apps/cli/tests/executeTask.e2e.test.ts
```
All passed (6 + 33, 1 pre-existing skip unrelated to this change). `npx tsc --build packages/core apps/cli`
clean.

**Residual risk / what this does NOT fix:** if the real mechanism recurs, the user will now find out
immediately instead of silently — but the underlying cause of P0-1 is still open. See issues-ranked.md.

## Fix 3 — P0-2: trivial prompts ran the full monorepo build/test/lint/typecheck battery

**File:** `packages/agents/src/codingAgent.ts`, VERIFY phase (~line 1774).

**Root cause (fully confirmed):** the check-skip condition only covered grounded-research tasks with no
file changes (`groundedResearch && filesChangedSet.size === 0 ? [] : [...]`). For the default `coding`
task type, `build`/`test`/`lint`/`typecheck` ran unconditionally — even when the VERIFY phase's own
mutation check, two lines earlier, had *already* concluded "Agent declared completion but produced no
code modifications" because `filesChangedSet` was empty. Running the full check battery in that case is
pure waste: the task is already a guaranteed failure, and there's nothing new on disk for the checks to
verify. This is exactly what happened live: "What is 23 + 19?" cost 3m40s and a Tauri/crates.io network
failure for a one-token answer.

**Fix:** `skipChecks = filesChangedSet.size === 0 && (groundedResearch || mutationRequired)`. Skips
checks precisely when nothing changed *and* that already dooms the task (mutation was required, or it's
grounded research with no evidence) — but still runs the full battery for a legitimate verify-only task
(`mutationRequired: false`) that correctly expects zero file changes, e.g. "run the test suite and tell me
if it's green."

**Regression tests:** `packages/agents/tests/codingAgent.skipChecksOnNoMutation.test.ts` (new) — a coding
task that answers without writing anything skips the battery (red before the fix: `build` was in the
executed-tools list; green after); a `mutationRequired: false` task with no changes still runs the full
battery (guards against over-broadening the skip). Also updated a pre-existing test,
`codingAgent.maxTurns.test.ts` *"still executes the requested tool on every turn..."*, which had
(unintentionally) pinned the exact bug — it asserted checks ran even when a MAX_TURNS-exhausted run never
wrote anything. Updated its assertion to the corrected behavior with an explanatory comment, rather than
leaving a test that locks in the pathology this fix removes.

**Verification run:**
```
npx vitest run packages/agents/tests/codingAgent*.test.ts
```
154/154 passed (49 files). Also re-ran `apps/cli/tests/executeTask.e2e.test.ts`,
`apps/cli/tests/fleetRunner.e2e.test.ts`, `apps/cli/tests/resume.e2e.test.ts`,
`apps/cli/tests/escalation.e2e.test.ts` (28/28 passed) — confirms legitimate tasks that *do* write files
still correctly trigger "Running check (build/test/lint/typecheck)". `npx tsc --build packages/agents
apps/cli packages/core` clean.

## Fix 4 — P0-4: the model's actual answer was discarded whenever VERIFY failed the task

**Files:** `packages/agents/src/codingAgent.ts` (two `kind: 'error'` yield sites), `apps/cli/src/run.ts`
(the turn-consumption `switch`).

**Found while re-verifying fix 3 live**, not from static analysis: after fix 3 made G02 ("12 x 8") run in
33s instead of 3m26s, the task still correctly failed (no code changes for a Q&A prompt), but the final
`--json` output had no `result` field — the model's actual answer ("96", confirmed present in the
execution's event log) was silently thrown away. Root cause: `codingAgent.ts`'s VERIFICATION_FAILED and
MAX_TURNS error turns never attached `modelSummary`, and `run.ts` only ever captured `turn.content` into
the final `summary`/`result` field on a `'done'` turn, never on an `'error'` turn.

**Fix:** attach `content: modelSummary` to both error-yield sites; `run.ts`'s `case 'error':` now also
does `if (turn.content) summary = turn.content;`.

**Regression test:** `apps/cli/tests/executeTask.e2e.test.ts`, new case asserting `outcome.result ===
'96'` alongside `outcome.success === false` for a model that answers "96" without writing any file.
Red → green.

**Live verification (real Gemma model, LM Studio):**
```
wa run "What is 12 x 8? Return only the number." --model google/gemma-4-12b-qat --runtime lmstudio --routing-mode LOCAL_ONLY --json
```
→ `"success": false, "result": "96", ...` — total wall time 1m10s (previously 3m26s before fix 3, and
would have shown no result at all before fix 4). This is the first task in this audit verified against
the real pinned model with both the slowness and the missing-answer problems resolved.

**Note on rebuilding:** this repo's installed `wa` (`/opt/homebrew/bin/wa` → resolves into this checkout)
runs a pre-built, bundled `bin/wa.js` (18MB, via `npm run bundle` / `scripts/bundle.mjs`), not the live
TypeScript source — `tsc --build` alone updates each package's own `dist/`, but the bundle must be
regenerated separately (`npm run bundle`, not the full `npm run build`, which pulls in the Tauri desktop
app and hits the network) before any source fix is actually reflected in the CLI you run. Vitest also
resolves workspace packages (`@wazir/core`, `@wazir/agents`) through their built `dist/` output, not
their source — rebuild (`npx tsc --build <package>`) before trusting a test result that depends on an
edit to a dependency package, not just the test's own package. Lost real time to this twice during this
session; worth a `package.json` note or a `wa doctor` check for "source newer than bundle" in its own
right, though not actioned this session.

## P0-3 retracted (verified not a bug, no fix needed)
See issues-ranked.md — a dedicated test (`modelLifecycleAdmission.test.ts`, *"reusing an already-READY
model is ADMITTED..."*) proved the admission path correctly distinguishes a safe reuse of an
already-resident model from a genuine fresh load, and that real memory scarcity still correctly denies a
fresh load. Passed with zero code changes.

## P1-3 revised (not model hallucination; a narrower, real scoping gap — not fixed this session)
See issues-ranked.md — the full event log for `exec-mvd704q7-1` shows the agent's own tool calls never
wrote the `test/codex-gemma-execution/*` files; they were swept into that task's `workspace.mutated`
report because that mechanism diffs the whole project directory, not just what the agent touched (my own
concurrent file write landed in the same report as proof). The real, still-open defect is this
unscoped-diff attribution — narrower and less alarming than "the model lies," but still worth fixing.
Not attempted this session (needs a design decision on what "belongs to this task" should mean for a
workspace diff — out of scope for a quick patch).

## Not yet fixed (tracked, not attempted this session)
- P1-2: lmstudio memory reported as flat `24/24 GiB CRITICAL` (partially root-caused, not changed).
- P1-3 (revised): workspace-mutation diff isn't scoped to the agent's own changes (see above).
- P0-1: root cause of the unauthorized merge itself remains open (the HEAD-integrity guard is
  defense-in-depth, not a fix) — see issues-ranked.md for the live question of whether a separate,
  concurrent agent/tool session was running against this repo at the same time.
