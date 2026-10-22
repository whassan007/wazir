# Wazir v0.2.12 Main Merge Plan & Sequence

**Canonical Release Branch:** `integration/v0.2.12-completion`  
**Preserved Checkpoint Branch:** `integration/v0.2.11-reconciliation` (`12a6ac84319ccf67ab1c37a6c5b3186a4990c2e6`)  
**Baseline Release Tag:** `v0.2.11` (`56ad6ee915386416c49723651d179b0b42287e91`)  
**Current `origin/main` Tip:** `f7c97cff5c5ec7fadbf0992942ab0f4531fda798`

---

## 1. Atomic Commit History on `integration/v0.2.12-completion`

The canonical branch `integration/v0.2.12-completion` builds cleanly on top of `v0.2.11` (`56ad6ee`) with self-contained, bisectable commits:

1. `353c1c9` — `feat(reconciliation): port main's resource quotaGroup, READY-aware scheduler scoring, nemo.py, and e2e acceptance suite`
2. `14198ea` — `feat(agents,memory,handoff): port fleet-aware subagent placement, fleet memory, and durable handoffs from test/real-world-acceptance`
3. `8c37ba1` — `docs(test): add live-session evidence from test/real-world-acceptance@ec863ef`
4. `ca78171` — `test(live): stop hardcoding the CLI version in the e2e acceptance suite`
5. `12a6ac8` — `docs(reconciliation): branch analysis, feature matrix, fast-path decision, test results, release readiness` *(Preserved checkpoint `integration/v0.2.11-reconciliation`)*
6. `e14f675` — `feat(nvidia,agents): reconcile policy-governed NVIDIA provider and fleet subagent routing guardrails`
7. `93288b3` — `feat(tui): reconcile Mission Control TUI with conversation renderer and approval queue`
8. `3aad1af` — `fix(core,test): preserve verified READY state across read-only reconciles and exclude tmp from vitest`
9. `3fda9b3` — `fix(cli,tools): wire deterministic command fast-path in run.ts and ignore worktrees/tmp in snapshot`
10. `0000165` — `docs(reconciliation): update all 5 reconciliation docs with v0.2.12 completion evidence`
11. `46541ad` — `feat(execution): reconcile verification scoping, repoIntegrityGuard, and answer surfacing from origin/main`
12. `f3b115a` — `fix(security): upgrade @modelcontextprotocol/client and shell-quote to resolve production advisories`
13. **Final v0.2.12 Optimization & Consolidation Commit** — `perf(router,cli,tools): memoize ResourceRouter.assess, skip read-only fast-path snapshots, and complete v0.2.12 release audit`

---

## 2. Recommended PR and Merge Sequence into `main`

Because `origin/main` (`f7c97cf`) was still at `0.2.7` while `v0.2.11` (`56ad6ee`) was cut ahead of `origin/main` and `integration/v0.2.12-completion` now contains **100% of the functional work from both `v0.2.11` and `origin/main` (`f7c97cf`)**, the merge into `main` is straightforward and conflict-free when executed in the following sequence:

### Step 1: Push the Canonical Integration Branch
```bash
git push -u origin integration/v0.2.12-completion
```

### Step 2: Record Merge Parentage Against `origin/main` (`--strategy=ours` Merge Commit or PR Merge)
Because every functional change from `origin/main` (`f7c97cf`) is already reconciled and verified on `integration/v0.2.12-completion` (verified in `docs/reconciliation/FEATURE-PARITY.md`), tie the `origin/main` commit graph into `integration/v0.2.12-completion` so `main` can fast-forward cleanly:
```bash
git checkout integration/v0.2.12-completion
git merge -s ours origin/main -m "chore(release): record origin/main lineage into integration/v0.2.12-completion"
```
*(Alternatively, open a GitHub PR from `integration/v0.2.12-completion` -> `main` and resolve any overlapping hunks in favor of `integration/v0.2.12-completion`.)*

### Step 3: Open and Review the Release PR (`integration/v0.2.12-completion` -> `main`)
- **PR Title**: `release(v0.2.12): canonical NVIDIA provider, Mission Control TUI, 3-tier fast path, and branch reconciliation`
- **Merge Method**: **Create a merge commit (`--no-ff`)** — do **not** squash-merge, so the atomic reconciliation commits remain individually bisectable in `git log`.

### Step 4: Post-Merge Tagging & Archive Cleanup (After Explicit Maintainer Authorization)
1. Tag `v0.2.12` on `main` after merge verification passes.
2. Archive and prune superseded feature branches (`feat/nvidia-native-provider`, `feat/nvidia-execution-provider`, `feat/mission-control-tui`, `feat/ultra-low-latency-fast-path`, `test/real-world-acceptance`).
