# Release Readiness

## Gate check (per the reconciliation spec's release-gate rules)

| Gate condition | Status |
|---|---|
| Failing required tests | **None.** 290 test files run across every directory this reconciliation touched, 2250 passed, 50 skipped (pre-existing skips, e.g. tests needing a real Postgres instance), 0 failed. |
| Missing functionality | **None removed.** Every DEFER decision left v0.2.11's existing, working implementation in place untouched — nothing that worked before this branch was created stopped working. |
| Duplicate competing execution paths | **Resolved** for the one case found (fast-path/direct-answer execution — see FAST-PATH-DECISION.md). No other duplicate-path collisions were found in the commits reconciled. |
| Broken provider routing | **Not found.** NVIDIA provider routing on this branch is exactly v0.2.11's existing, tested implementation (deliberately not touched — see below). |
| Unverified security boundaries | **One explicitly flagged, not silently assumed.** Fleet-placed subagent dispatch does not yet carry main's provider-only-routing guardrail (Guardrail 3) — documented as a named gap in FEATURE-MATRIX.md, not hidden. Everything else ported was either unchanged from a tested source or covered by new tests. |
| Unexplained performance regressions | **None found; one genuine improvement, several explicitly not re-measured.** The scheduler scoring change is strictly additive (same tiers, finer-grained). No change touched a hot path without a corresponding passing test. Live-model latency claims from either lineage are explicitly marked BLOCKED/not-reproduced in TEST-RESULTS.md rather than assumed. |

**No P0 or P1 regression was found in anything that was integrated.** Three
items are explicitly **not** integrated and therefore cannot regress
anything on this branch (WorkspaceMutationAttributor, mission-control TUI
merge, NVIDIA provider merge) — see "Deferred work" below for what finishing
them requires.

## What's on this branch vs. the `v0.2.11` tag

4 commits, 45 files changed, +2515/-51:

1. `353c1c9` — scheduler READY-aware scoring, resource quotaGroup, Nemotron
   script, resource-routing benchmark, production-realistic e2e acceptance
   suite (cherry-picked from `main`).
2. `14198ea` — fleet-aware subagent placement, fleet-shared memory
   (`remember_fact`/`recall_facts`), durable agent handoffs (`wa handoff`),
   ported from `test/real-world-acceptance@ec863ef` with one real wiring
   bug fixed along the way (handoffs were never actually constructed).
3. `8c37ba1` — live-session test evidence files (markdown/CSV, no code).
4. `ca78171` — fixed one stale hardcoded-version assertion found while
   running the newly-ported e2e suite for real.

Full diff: `git diff 56ad6ee903c2972d635a84d200fde1fbf64e4205..HEAD` from
this worktree.

## Deferred work (not on this branch, with a concrete path forward)

| Item | Why deferred | What finishing it requires |
|---|---|---|
| `WorkspaceMutationAttributor` | Confirmed, reproducible bug: breaks tool-timeout mutation detection (`timeoutTermination.test.ts`) | Dedicated debugging session using that failing test as the acceptance harness. The 1386-line implementation is architecturally sound (call-attributed mutation tracking, external/concurrent-change distinction via a cross-process ledger) — this is "finish it," not "redesign it." |
| Mission-control TUI merge (`1c95e40` vs v0.2.11's own) | Both versions are real and tested; main's is substantially larger (+294 lines); `fleetTui.ts` is also touched by the subagent-placement work on this branch, raising conflict surface | Side-by-side UI review (screenshots/recordings of both), then a deliberate merge or pick — not a code-only diff. **Check `feat/mission-control-tui` on origin first** — may already supersede both. |
| NVIDIA provider merge (`12f8273` vs v0.2.11's own) | Both versions are real, tested (v0.2.11: 4/5 passing, 1 skipped), and meaningfully different (184 diff lines in `hostedProviders.ts` alone) | Feature-by-feature parity diff (policy governance, model listing, auth flow) before deciding which wins or how to combine. **Check `feat/nvidia-native-provider` and `feat/nvidia-execution-provider` on origin first.** |
| `estimateTarget`/`CONTEXT_RELOAD_REQUIRED` false-positive fix | v0.2.11 has similar-looking logic already; not verified whether it has the same bug main fixed | A targeted regression test reproducing main's original bug report (resident-model context reuse triggering a false `INSUFFICIENT_MEMORY`), run against this branch's `modelLifecycleService.ts` |
| Guardrail 3 (provider-only routing) for fleet-placed subagents | Depends on `parentExecution`/`routingMode` fields tied to main's specific NVIDIA/routing shape, which differs from v0.2.11's | Falls out naturally once the NVIDIA-provider reconciliation above settles which `Task.execution`/routing-config shape is canonical |

## Rollback instructions

Nothing on `main`, `v0.2.11`, `test/real-world-acceptance`, or any other
existing branch was modified, reset, or force-pushed — this entire
reconciliation lives only on the new `integration/v0.2.11-reconciliation`
branch, created locally in an isolated worktree and never pushed.

- **To discard this reconciliation entirely:** delete the branch
  (`git branch -D integration/v0.2.11-reconciliation`) and/or the worktree
  it lives in. No other ref is affected.
- **To roll back to just the v0.2.11 tag's state:**
  `git checkout 56ad6ee903c2972d635a84d200fde1fbf64e4205` (or
  `git reset --hard` to it on a throwaway copy of this branch — never on a
  shared branch).
- **To roll back one integration step:** each commit on this branch is a
  self-contained, independently-reviewable unit (see list above) — revert
  or `git reset --hard` to the prior commit's SHA as needed.
- **Nothing was published:** no push, no merge into any existing branch, no
  tag created or moved, per the task's explicit constraints.

## Recommended PR target and merge strategy

**Do not merge this directly into `main`, `v0.2.11`'s release chain, or any
existing branch yet.** Recommended sequence:

1. **Open a PR from `integration/v0.2.11-reconciliation` targeting a new
   branch cut from the current release chain tip** (i.e. from the `v0.2.11`
   tag, or from whatever `release/v0.2.12` would be if one doesn't exist
   yet) — **not** `main`, since `main` itself still needs reconciling
   against this same release lineage (it's 10 commits of independent work
   ahead of `v0.2.11`'s common ancestor, only some of which — the quotaGroup/
   scheduler-scoring/e2e-suite pieces — are now captured here; the rest,
   NVIDIA and mission-control, still need their own reconciliation per the
   table above).
2. **Review the 4 commits individually**, in the order listed above — each
   is self-contained and was verified independently (see TEST-RESULTS.md's
   per-commit checkpoints).
3. **Before merging, check the 4 origin branches flagged in
   BRANCH-ANALYSIS.md** (`feat/mission-control-tui`,
   `feat/nvidia-native-provider`, `feat/nvidia-execution-provider`,
   `improve/resource-routing-accuracy`) in case they already contain more
   advanced versions of the deferred work than either lineage reconciled
   here.
4. **Merge strategy:** a regular merge commit (not squash) is recommended,
   so each of the 4 commits' detailed rationale (which exists only in this
   branch's commit messages and these 5 documents) remains individually
   inspectable in `main`'s history — this reconciliation intentionally
   avoided bundling unrelated decisions into one commit specifically so
   future readers (human or agent) can trace which specific change came
   from which source commit and why.
5. **After this merges, `main` must still be separately reconciled** against
   the same `v0.2.11`-based lineage for the NVIDIA and mission-control
   TUI work — this PR does not make `main` and the release chain
   consistent, it only resolves the subset of their divergence that was
   safe to resolve without a dedicated UI/provider review.
