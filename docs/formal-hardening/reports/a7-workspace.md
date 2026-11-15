# Wazir Formal Hardening Report: Subagent A7
## Multi-Agent Workspace Isolation & Conflict Detection

- **Target Repository**: `https://github.com/whassan007/wazir`
- **Worktree**: `/Users/wael/Code/Wazir/.worktrees/fh-a7-workspace`
- **Git HEAD SHA**: `4661c33a6caeaca0639853463e4ccbbe3ebc63d8`
- **Alloy 6 Analyzer**: `tools/alloy/org.alloytools.alloy.dist.jar` (Version 6.2.0)
- **Status**: **CONFIRMED & FIXED**

---

### 1. Executive Summary

Subagent A7 audited the Multi-Agent Workspace Isolation & Conflict Detection subsystem in Wazir, specifically covering:
- `packages/core/src/services/verifiedIntegrationCoordinator.ts`
- `packages/core/src/services/worktreeManager.ts`
- `packages/core/src/services/repoIntegrityGuard.ts`
- `packages/tools/src/workspaceSnapshot.ts`
- `packages/evaluation/src/gitSynchronizationPolicy.ts`

Through formal modeling in Alloy 6 and concrete execution of the Alloy 6.2 CLI, we identified and proved a core safety violation: **Silent Lost Updates on Stale Base Revisions** during multi-agent branch qualification. When an agent branched from an older base revision and the target branch advanced with concurrent edits to the same files, `VerifiedIntegrationCoordinator.plan()` failed to detect candidate-target file overlaps and merge conflicts. The plan reported `conflicts: []` and `readyToBuildCandidate: true`, enabling silent clobbering of concurrent changes.

Additionally, our inspection revealed a concurrency race in `WorktreeManager.getOrCreateJobWorktree` where concurrent task startup crashed on duplicate worktree paths, as well as an omission of 4 out of 7 Git unmerged conflict status codes (`DU`, `AU`, `UA`, `DD`) in `WorktreeManager.mergeBranch`.

All three defects were reproduced deterministically in Vitest (`packages/core/tests/a7WorkspaceDefects.test.ts`), verified failing before fix, patched minimally in production code, and verified passing with 100% regression and existing suite green (32/32 tests passing).

---

### 2. Formal Alloy 6 Modeling & Verification

#### Models Created
1. **Sound Reference Model**: `docs/formal-hardening/models/a7-workspace.als`
2. **Defective Mutant Model**: `docs/formal-hardening/models/a7-workspace-mutant.als`

#### Core Invariants
1. **`NoStaleBaseIntegration`**:
   $$\forall a \in Agent.\; (a.status = Completed \land a.status' = Integrated) \implies (\forall f \in a.modifiedFiles.\; Target.fileRev[f] = a.baseRev)$$
   *An agent can never transition to `Integrated` if Target has modified any of the agent's files since its base revision.*
2. **`NoSilentLostUpdate`**:
   $$\forall a \in Agent.\; (a.status = Completed \land a.status' = Integrated) \implies (a \notin Coordinator.flaggedConflicts \land \forall f \in a.modifiedFiles.\; Target.fileRev[f] = a.baseRev)$$
   *An agent never integrates without conflict detection if its files have moved on target.*
3. **`SameFileConflictDetected`**:
   $$\forall a_1 \neq a_2 \in Agent, f \in File.\; (a_1.status = Integrated \land a_2.status = Integrated \land f \in (a_1.modifiedFiles \cap a_2.modifiedFiles)) \implies \exists Coordinator.flaggedConflicts$$
   *Two concurrent agents modifying overlapping files cannot both integrate without conflict detection.*
4. **`ConflictedAgentNeverIntegrates`**:
   $$\forall a \in Agent.\; a \in Coordinator.flaggedConflicts \implies \Box (a.status \neq Integrated)$$
   *An agent flagged as conflicted can never transition to `Integrated`.*
5. **`WorkspaceIsolation`**:
   $$\forall a_1 \neq a_2 \in Agent.\; (a_1.status = Working \land a_2.status' \neq a_2.status) \implies (a_1.modifiedFiles' = a_1.modifiedFiles \land a_1.baseRev' = a_1.baseRev)$$
   *While an agent works in its worktree, other agents' transitions do not alter its private modifications or base revision.*

#### Positive Witness Runs
- **`BothIntegratedDisjoint`**: Confirms that two concurrent agents modifying disjoint files can both integrate cleanly into Target ($SAT$).
- **`ConflictDetected`**: Confirms that when agents touch the same file or target advances, conflict detection fires ($SAT$).

#### Alloy 6 CLI Execution Results

Command executed:
```bash
java -jar tools/alloy/org.alloytools.alloy.dist.jar exec -f -t text -c '*' \
  -o docs/formal-hardening/results/a7-workspace docs/formal-hardening/models/a7-workspace.als
```

Sound Model Results (`docs/formal-hardening/results/a7-workspace/receipt.json`):
```text
00. run   BothIntegratedDisjoint             SAT (positive witness)
01. run   ConflictDetected                   SAT (positive witness)
02. check NoStaleBaseIntegration             UNSAT (no counterexample)
03. check NoSilentLostUpdate                 UNSAT (no counterexample)
04. check ConflictedAgentNeverIntegrates     UNSAT (no counterexample)
05. check SameFileConflictDetected           UNSAT (no counterexample)
06. check WorkspaceIsolation                 UNSAT (no counterexample)
```

Mutant Model Results (`docs/formal-hardening/results/a7-workspace-mutant/receipt.json`):
```text
00. run   BothIntegratedDisjoint             SAT (positive witness)
01. run   ConflictDetected                   SAT (positive witness)
02. check NoStaleBaseIntegration             SAT (COUNTEREXAMPLE FOUND!)
03. check NoSilentLostUpdate                 SAT (COUNTEREXAMPLE FOUND!)
04. check ConflictedAgentNeverIntegrates     UNSAT (holds)
05. check SameFileConflictDetected           SAT (COUNTEREXAMPLE FOUND!)
06. check WorkspaceIsolation                 UNSAT (holds)
```

The Alloy mutant trace revealed a 10-step sequence:
1. `Target` is initialized at revision $R_0$.
2. `AgentA` branches from $R_0$, modifies $File_1$, and completes.
3. `AgentB` branches from $R_0$, modifies $File_1$, and completes.
4. `AgentA` integrates into `Target`. `Target.head` advances to $R_1$, updating $File_1 \mapsto R_1$.
5. In the defective model, `AgentB` only checks candidate-candidate overlaps against pending completed candidates. Since `AgentA` is already `Integrated` (not `Completed`), `hasConflict[AgentB]` returns `false`.
6. `AgentB` integrates into `Target` at step 8, updating $File_1 \mapsto R_2$ and silently overwriting `AgentA`'s changes on `Target` without any conflict flagged!

---

### 3. Production Code Defects & Fixes

#### Issue 1 (P1): Stale Base Conflict Omission & Silent Lost Updates in `VerifiedIntegrationCoordinator.plan`
- **Location**: `packages/core/src/services/verifiedIntegrationCoordinator.ts` (lines 350–388)
- **Preconditions**: An agent branches from commit $C_0$ and modifies file $F$. While the agent is working, target branch `main` advances with a commit that also touches $F$.
- **Observed Behavior**:
  `VerifiedIntegrationCoordinator.plan()` only ran a pairwise loop comparing candidates against each other:
  ```typescript
  for (let i = 0; i < valid.length; i++) for (let j = i + 1; j < valid.length; j++)
  ```
  It calculated `targetAdvanced = valid.filter((candidate) => candidate.manifest.baseSha !== targetSha)` and formatted the string:
  `reason: "position X: deterministic task-id order on a base older than target; conflict check required"`,
  **but never actually executed the conflict check against `targetSha`!**
  As a result:
  - `plan.conflicts` was empty `[]`.
  - `plan.readyToBuildCandidate` returned `true`.
  - Downstream callers and operators received no warning of conflicting changes between the candidate and `main`.
- **Minimal Patch Applied**:
  For all candidates where `candidate.manifest.baseSha !== targetSha`:
  1. Inspect changes on target branch since candidate base revision (`listFileChanges(repository, candidate.manifest.baseSha, targetSha)`).
  2. Compute file overlap between candidate `changedFiles` and target changed files.
  3. Execute `git merge-tree --write-tree targetSha candidate.manifest.headSha` to determine syntactic clean/conflict status.
  4. Register `IntegrationConflict` (with `branches: [targetBranch, candidate.branch]`, kind `same-file` / `dependency` / `test-fixture`, and syntactic status).
  5. Updated `analyzeConflict()` to properly handle `targetBranch` conflict context.

#### Issue 2 (P1): Concurrency Race in `WorktreeManager.getOrCreateJobWorktree`
- **Location**: `packages/core/src/services/worktreeManager.ts` (lines 191–203)
- **Preconditions**: Multiple tasks within the same job start concurrently (e.g. via `Promise.all`).
- **Observed Behavior**:
  Both callers checked `this.jobWorktrees.get(jobId)` simultaneously before either finished calling `await this.createWorktree()`. Both attempted to create `.wazir/worktrees/<jobId>`, causing the second caller to crash with:
  `fatal: '.../.wazir/worktrees/<jobId>' already exists`.
- **Minimal Patch Applied**:
  Added an `inFlightJobWorktrees = new Map<string, Promise<WorktreeInfo>>()` deduplication map. Concurrent callers await the in-flight creation Promise. Cleaned up entries on `removeWorktree()`.

#### Issue 3 (P2): Missing Git Conflict Status Codes in `WorktreeManager.mergeBranch`
- **Location**: `packages/core/src/services/worktreeManager.ts` (line 469)
- **Preconditions**: A git merge conflict occurs with porcelain codes other than `UU`, `AA`, or `UD` (for example, `DU` where a file is deleted on target but modified on the branch).
- **Observed Behavior**:
  `mergeBranch` filtered status lines using only `l.startsWith('UU') || l.startsWith('AA') || l.startsWith('UD')`, omitting `DU`, `DD`, `AU`, and `UA`. When a `DU` conflict occurred, `mergeResult.conflicts` returned empty `[]`.
- **Minimal Patch Applied**:
  Expanded the prefix filter to include all 7 standard Git unmerged conflict codes: `['UU', 'AA', 'UD', 'DU', 'DD', 'AU', 'UA']`.

---

### 4. Verification Evidence & Test Results

#### Reproduction Tests (`packages/core/tests/a7WorkspaceDefects.test.ts`)
- `REPRO 1: plan() must detect stale-base conflict when target branch advanced and modified the same file`
  - **Before fix**: FAILED (`AssertionError: expected 0 to be greater than 0`).
  - **After fix**: PASSED (detected `same-file` conflict with `syntactic: 'conflict'`, `readyToBuildCandidate: false`).
- `REPRO 2: getOrCreateJobWorktree must not crash when called concurrently by multiple tasks`
  - **Before fix**: FAILED (`fatal: '...' already exists`).
  - **After fix**: PASSED (both concurrent callers received identical `WorktreeInfo`).
- `REPRO 3: mergeBranch must report conflict when file is deleted on target but modified on branch (DU conflict)`
  - **Before fix**: FAILED (`AssertionError: expected [] to include 'deleteme.txt'`).
  - **After fix**: PASSED (reported `'deleteme.txt'` in conflicts array).

#### Test Suite Execution
```bash
npx vitest run packages/core/tests/worktreeManager.test.ts \
               packages/core/tests/verifiedIntegrationCoordinator.test.ts \
               packages/core/tests/a7WorkspaceDefects.test.ts
```
**Outcome**: 3 test files passed, 32/32 tests passed (0 failures).

#### TypeScript Build
```bash
cd packages/core && npm run build
```
**Outcome**: Succeeded with exit code 0 (`tsc --build` clean).

---

### 5. Remaining Risks & Boundaries

1. **Multi-Process / Cross-PID Concurrency**: `inFlightJobWorktrees` serializes concurrent tasks within a single Node.js process runtime. If multiple separate OS processes share the same `worktreeRootDir` without coordinated orchestrator leases, filesystem directory locks (`flock`) should be added as defense-in-depth.
2. **Unrelated Histories**: If an agent candidate shares no common Git ancestor with the target branch, `checkSpecWriteFence` and manifest ancestor validation fail-closed upstream before qualification.
3. **Subtree Snapshot Scale**: In `workspaceSnapshot.ts`, file counts over 50,000 or sizes over 256MB continue to be bounded by fail-closed `RESOURCE_EXHAUSTED` budgets.
