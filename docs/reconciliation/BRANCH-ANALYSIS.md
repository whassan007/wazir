# Branch Analysis

Verified with git, not assumed, on 2026-10-20 against `origin` as fetched that day.

## Ancestry facts

```
git cat-file -t v0.2.11            -> tag
git rev-list -n1 v0.2.11           -> 56ad6ee903c2972d635a84d200fde1fbf64e4205
git log -1 --format='%H %s' v0.2.11^{commit}
  -> 56ad6ee903c2972d635a84d200fde1fbf64e4205 chore(release): prepare v0.2.11
```

`v0.2.11` is a **tag**, not a branch. It points at commit `56ad6ee`, whose
`package.json` reports version `0.2.11`. It was cut from `release/v0.2.10`'s
lineage, itself the tip of a chain of release branches going back through
v0.2.9, v0.2.7, v0.2.3, ... to v0.1.61 — each with its own
`chore(release): prepare vX.Y.Z` commit.

```
git merge-base main v0.2.11   -> 8598c44e0c9bf8aa173059ca1b4a51539b45b50e
git rev-parse main             -> f7c97cff5c5ec7fadbf0992942ab0f4531fda798
git log --oneline main..v0.2.11 | wc -l   -> 16
git log --oneline v0.2.11..main | wc -l   -> 10
```

`main` and `v0.2.11` **diverged** from common ancestor `8598c44`. Neither is
an ancestor of the other. `main`'s own `package.json` still reports `0.2.7`
— it was never advanced through the v0.2.8–v0.2.11 release train.

```
git merge-base test/real-world-acceptance main
  -> 7133f160a6bd1b92ff956657431de34c4c7bffa6   (= main's own commit 7133f16)
git log --oneline main..test/real-world-acceptance
  -> ec863ef feat(agents): fleet-aware subagent placement, ...
  -> a9e67b5 fix(execution): scope verification, preserve model readiness, ...
```

`test/real-world-acceptance` branched from a point on `main`'s own history
(commit `7133f16`), then added two commits of its own. It is a sub-lineage
of `main`, not an independent third lineage in the strict graph sense — but
its one feature commit (`ec863ef`) was written against the state `main` was
in *then*, which already included `main`'s NVIDIA/routing work, so when
applied against `v0.2.11` (which has independently-evolved, differently-shaped
routing/NVIDIA code) it does not apply cleanly. See FEATURE-MATRIX.md.

## Commits unique to `main` (10, main..v0.2.11 has none of these)

| Commit | Subject | Subsystem |
|---|---|---|
| f7c97cf | feat(fast-path): ultra-low-latency direct-answer execution and resident model prioritization | run.ts, resources/router.ts |
| ed4f1d9 | feat(fast-path): implement ultra-low-latency direct-answer execution path | run.ts, LMStudio healthCheck, scheduler scoring, handoff.ts |
| 7133f16 | test(e2e): establish production-realistic Wazir acceptance testing | tests/live/* |
| be64805 | chore(release): prepare v0.2.7 | version bump |
| 0668ca1 | Merge commit '12f8273' into release/v0.2.7 | merge |
| 48f48e6 | fix(api): fence stale lease results and deduplicate retries | apps/api/src/server.ts |
| 1c95e40 | feat(tui): deliver modern Wazir mission control interface | apps/cli/src/tui/missionControl.ts (+294) |
| 12f8273 | feat(nvidia): integrate first-class policy-governed NVIDIA hosted provider | hostedProviders.ts, commands.ts, run.ts |
| 2a61e59 | feat(resources): harden shared quota routing and accounting | resources/{budgetManager,ledger,router,types}.ts |
| 607ba43 | feat(nvidia): add interactive Nemotron streaming utility | nemo.py |

## Commits unique to `v0.2.11`'s lineage (16, v0.2.11..main has none of these)

| Commit | Subject |
|---|---|
| 56ad6ee | chore(release): prepare v0.2.11 |
| dd5b0b7 | test(cli): pin environment in banner session guard test |
| b9d9a9d | test(config): exclude codex-dgx-execution from vitest |
| c512fcf | chore(release): regenerate package manager manifests for v0.2.5 |
| 0bc91e6 | test: align stale assertions with current behavior |
| 070bd94 | fix(agents,tests): keep fake runtimes' models visible to availability check |
| e0a87a6 | fix(cli,core): verify model availability before dispatch and show the model actually routed (P0-B) |
| 9c4fb4a | fix(agents): stop on 2nd identical tool-validation failure (P0-D) |
| 6211048 | feat(mobile,dispatch): add mobile app scaffold, dispatch cancellation/recovery, test dir migration |
| 973111f | fix(agents): add deterministic fast path for ls/pwd/git status/diff/log |
| c7ea2ab | fix(agents): stop fast-path classifier blocking on ambiguous verbs alone |
| 14813e3 | feat(evaluation,tui,tests): complete 6-category execution integrity, TUI usability, LIVE-CODE-01..08 release-gate suites |
| 246d4cb | perf(execution): repair P0 wa run cold-start, store, and conversational fast-path latency |
| f6a6ce7 | fix(cli): don't let lock-contended execution writes crash the task |
| 6a6fb8b | fix(execution): correctly classify failed tool operations |

## `test/real-world-acceptance`'s own 2 commits (beyond its `main` base)

| Commit | Subject |
|---|---|
| a9e67b5 | fix(execution): scope verification, preserve model readiness, surface answers on failure |
| ec863ef | feat(agents): fleet-aware subagent placement, fleet-shared memory, durable handoffs, workspace mutation attribution |

## Other origin branches (not reconciled here — out of this task's scope)

`origin` carries ~35 branches beyond the three in scope: `feat/agent-delegation`,
`feat/autonomous-auto-updater`, `feat/cross-platform-*` (4 branches),
`feat/distribution-*` (3), `feat/interactive-acp-execution`,
`feat/mission-control-tui`, `feat/native-continuous-self-improvement`,
`feat/nvidia-*` (2), `feat/resource-orchestration`,
`feat/ultra-low-latency-fast-path`, `feat/wazir-mobile-android`,
`fix/codex-dgx-p0-reliability`, `fix/codex-style-chat`,
`fix/comprehensive-live-reliability`, `fix/distributed-lease-fencing`,
`fix/durable-execution-api`, `fix/remediation-hardening-consolidation`,
`fix/tui-chat-responsiveness`, `hardening/*` (3),
`improve/gemini-execution-integrity`, `improve/nvidia-runtime-hardening`,
`improve/resource-routing-accuracy`, `reliability/autonomous-recovery`,
`repair/stability-audit`, plus release branches v0.1.61 through v0.2.10.

Of direct relevance to the subsystems in this reconciliation:
`feat/mission-control-tui`, `feat/nvidia-native-provider`,
`feat/nvidia-execution-provider`, and `feat/ultra-low-latency-fast-path` look,
by name, like they may carry *further* independent work on exactly the two
subsystems (mission-control TUI, NVIDIA provider) this reconciliation
deferred, and `improve/resource-routing-accuracy` / `fix/distributed-lease-fencing`
likewise for resource routing and lease fencing. None of these were opened,
diffed, or merged — flagging them is as far as this task's scope goes. Before
doing the NVIDIA/TUI follow-up work recommended in FEATURE-MATRIX.md, check
these branches first; there may already be more advanced versions than either
`main` or `v0.2.11` carries.

## Integration branch

Created with:
```
git checkout -b integration/v0.2.11-reconciliation 56ad6ee903c2972d635a84d200fde1fbf64e4205
```
4 commits added on top of the v0.2.11 tag (`353c1c9`, `14198ea`, `8c37ba1`, `ca78171`).
45 files changed, +2515/-51 vs the v0.2.11 tag. Full diff: `git diff 56ad6ee..HEAD`.
