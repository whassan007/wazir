# Branch Analysis

Verified with git on 2026-10-20 against local refs and `origin`.

## Phase 1 Checkpoint Preservation

- **Initial reconciliation checkpoint branch:** `integration/v0.2.11-reconciliation`
- **Verified checkpoint commit SHA:** `12a6ac84319ccf67ab1c37a6c5b3186a4990c2e6` (`docs(reconciliation): add branch analysis, feature matrix, fast-path decision, test results, and release readiness`)
- **Working completion branch:** `integration/v0.2.12-completion` (cut directly from `12a6ac84319ccf67ab1c37a6c5b3186a4990c2e6`, leaving `integration/v0.2.11-reconciliation` untouched).

## Ancestry & Branch Topology Facts

```
git cat-file -t v0.2.11            -> tag
git rev-list -n1 v0.2.11           -> 56ad6ee903c2972d635a84d200fde1fbf64e4205
git log -1 --format='%H %s' v0.2.11^{commit}
  -> 56ad6ee903c2972d635a84d200fde1fbf64e4205 chore(release): prepare v0.2.11
```

`v0.2.11` is a **tag** pointing at commit `56ad6ee` (`package.json` version `0.2.11`), descending from the `release/v0.2.10` release train.

```
git merge-base main v0.2.11   -> 8598c44e0c9bf8aa173059ca1b4a51539b45b50e
git rev-parse main             -> f7c97cff5c5ec7fadbf0992942ab0f4531fda798
git log --oneline main..v0.2.11 | wc -l   -> 16
git log --oneline v0.2.11..main | wc -l   -> 10
```

`main` and `v0.2.11` diverged from common ancestor `8598c44e0c9bf8aa173059ca1b4a51539b45b50e`.

```
git merge-base test/real-world-acceptance main
  -> 7133f160a6bd1b92ff956657431de34c4c7bffa6   (= main's commit 7133f16)
git log --oneline main..test/real-world-acceptance
  -> ec863ef feat(agents): fleet-aware subagent placement, ...
  -> a9e67b5 fix(execution): scope verification, preserve model readiness, ...
```

## Deep Inspection of Specialized Feature Branches (Phases 2–4)

In Phase 2–4, we inspected the specialized branches flagged during the initial checkpoint:

| Branch Ref | Tip Commit | Relationship to `main` & `v0.2.11` | Findings |
|---|---|---|---|
| `origin/feat/nvidia-native-provider` | `12f82735ec617758101c9fd7de328ef141ef106e` | Exact ancestor of `main` (merged via `0668ca1`) | Delivers policy-governed NVIDIA provider (`HOSTED_API_INFERENCE` vs `LOCAL_GPU_INFERENCE`, `routing.mode = 'provider_only'`, `NVIDIA_CURATED_MODELS`, parameter-strip retry on HTTP 400, secret redaction, `wa providers` CLI, 15 adapter + 10 system tests). |
| `origin/feat/nvidia-execution-provider` | `5d79045a496f45520c64053a6c1146b775b3e33d` | Older branch off `v0.2.2` (`49fd90d`), merged into `v0.2.11` via `73355ff` | Earlier iteration of `@wazir/runtimes-nvidia`; already present on `v0.2.11`. Contained programmatic `NvidiaAdapter` constructor options (`apiKey`, `env`, `fetchImpl`, `retryBaseDelayMs`) and `resolveHostedProviderApiKey`/`inspectHostedProviderStatus` helpers that were retained during our Phase 2 unification. |
| `origin/feat/mission-control-tui` | `1c95e400ef28b03152a560f0d1ab6abfc262b0b8` | Exact commit on `main` (`1c95e40`) | Delivers the 3-pane adaptive Mission Control cockpit (`narrow`/`standard`/`wide`), `buildMissionControlSnapshot`, modal overlays (`CommandPalette`, `Help`, `BlockInspector`, `RawPayload`), and approval queue diff previews. Reconciled in Phase 3 with `v0.2.11`'s `conversationRenderer.ts` and `eventSummarizer.ts`. |
| `origin/feat/ultra-low-latency-fast-path` | `ed4f1d96ff6a2df2943106205cc20996dc8a735d` | Exact commit on `main` (`ed4f1d9`) | Inline `isDirectAnswerRequest` bypass in `run.ts` (superseded by `v0.2.11`'s `ChatAgent` + `isConversationalFastPathRequest` + `isDeterministicCommandRequest`), plus the `stillVerified` (`READY` state) preservation fix in `modelLifecycleService.ts` (ported in Phase 4). |

## Commits Unique to `main` (10 commits)

| Commit | Subject | Status on `integration/v0.2.12-completion` |
|---|---|---|
| `f7c97cf` | `feat(fast-path): ultra-low-latency direct-answer execution and resident model prioritization` | Replaced by canonical `ChatAgent` + `isDeterministicCommandRequest` + READY scheduler scoring |
| `ed4f1d9` | `feat(fast-path): implement ultra-low-latency direct-answer execution path` | Scheduler READY scoring + `modelLifecycleService` `stillVerified` READY state preservation + `handoff.ts` wiring merged; inline fast-path replaced |
| `7133f16` | `test(e2e): establish production-realistic Wazir acceptance testing` | Merged (`353c1c9` + `ca78171`) |
| `be64805` | `chore(release): prepare v0.2.7` | Superseded by `v0.2.11` |
| `0668ca1` | `Merge commit '12f8273' into release/v0.2.7` | Merged via canonical NVIDIA reconciliation (`e14f675`) |
| `48f48e6` | `fix(api): fence stale lease results and deduplicate retries` | Superseded by `v0.2.11`'s `TaskDispatcher.reconcile()` |
| `1c95e40` | `feat(tui): deliver modern Wazir mission control interface` | Merged and reconciled with `v0.2.11` conversation renderer (`93288b3`) |
| `12f8273` | `feat(nvidia): integrate first-class policy-governed NVIDIA hosted provider` | Merged and unified with `v0.2.11` programmatic APIs (`e14f675`) |
| `2a61e59` | `feat(resources): harden shared quota routing and accounting` | Merged (`353c1c9`) |
| `607ba43` | `feat(nvidia): add interactive Nemotron streaming utility` | Merged (`353c1c9`) |

## Commits Unique to `v0.2.11` Lineage (16 commits)

All 16 commits in `v0.2.11` (`56ad6ee`) are preserved as the base of `integration/v0.2.11-reconciliation` and `integration/v0.2.12-completion`.

## Commits Added on `integration/v0.2.11-reconciliation` (Phase 1 Checkpoint)

1. `353c1c9` — `feat(reconciliation): port main's resource quotaGroup, READY-aware scheduler scoring, nemo.py, and e2e acceptance suite`
2. `14198ea` — `feat(agents,memory,handoff): port fleet-aware subagent placement, fleet memory, and durable handoffs from test/real-world-acceptance`
3. `8c37ba1` — `test(evidence): port live-session concurrency and Gemma execution reports from test/real-world-acceptance`
4. `ca78171` — `fix(tests): read package.json version in realWorldAcceptance Journey 1 instead of hardcoded 0.2.7`
5. `12a6ac8` — `docs(reconciliation): add branch analysis, feature matrix, fast-path decision, test results, and release readiness`

## Commits Added on `integration/v0.2.12-completion` (Phases 2–6)

1. `e14f675` — `feat(nvidia,agents): reconcile policy-governed NVIDIA provider and fleet subagent routing guardrails`
2. `93288b3` — `feat(tui): reconcile Mission Control TUI with conversation renderer and approval queue`
3. `3aad1af` — `fix(core,test): preserve verified READY state across read-only reconciles and exclude tmp from vitest`
4. `3fda9b3` — `fix(cli,tools): wire deterministic command fast-path in run.ts and ignore worktrees/tmp in snapshot`
