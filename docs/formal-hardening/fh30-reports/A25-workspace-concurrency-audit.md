# A25 — Formal Audit Report: Shared Workspaces, Parallel File Edits, Optimistic Concurrency & Conflict Detection

- **Agent ID**: A25
- **Role**: Gemini TIER 1 — Shared Workspaces & Optimistic Concurrency Auditor
- **Program**: Wazir 30-Agent Cost-Optimized Formal Hardening Program
- **Group**: GROUP I (P1 — Agent Workspaces & Multi-Agent Concurrency)
- **Target Repository**: `/Users/wael/Code/Wazir`
- **Target HEAD SHA**: `4661c33a6caeaca0639853463e4ccbbe3ebc63d8`
- **Critical Invariant**: *"One agent must not silently overwrite another agent's confirmed work."* / *"Concurrent agents applying overlapping patches must detect workspace revision conflict, serialize, or reconcile deterministically; no silent lost update."*
- **Alloy 6 Specification**: `tests/formal-hardening/models/a25-workspace-concurrency.als`
  - `WitnessMultiAgentExecution`: SAT (scope 2 Agent, 2 File, 3 Content, 6 steps)
  - `check NoSilentLostUpdate`: **SAT (Counterexample Found)** (scope 2 Agent, 2 File, 3 Content, 6 steps)
  - `check NoContaminatedCommit`: **SAT (Counterexample Found)** (scope 2 Agent, 2 File, 3 Content, 6 steps)
  - **Artifact Log**: `tests/formal-hardening/logs/alloy-a25-workspace/` (`receipt.json`, `NoSilentLostUpdate-solution-0.txt`, `NoContaminatedCommit-solution-0.txt`)
- **Deterministic Reproduction Suite**: `tests/formal-hardening/reproductions/A25-workspace-concurrency.test.ts` (5 / 5 passing reproductions)
- **Status**: **CONFIRMED PRODUCTION DEFECTS**

---

## 1. Executive Summary

This formal audit investigated workspace isolation, parallel file mutations, optimistic concurrency, and conflict detection across `JobOrchestrator`, `createFleetTaskExecutor` (`fleetRunner.ts`), `WorktreeManager`, `VerifiedIntegrationCoordinator`, `filesystem.ts` (`writeTool`, `editTool`), `workspaceSnapshot.ts`, `ExecutionEngine`, and `CheckpointService`.

Our investigation revealed that while Wazir includes advanced components for worktree management (`WorktreeManager`), candidate merge conflict analysis (`VerifiedIntegrationCoordinator`), and checkpoint hashing (`workspaceSnapshot.ts`), **the critical invariant is violated across multiple reachable production execution paths**:

1. **Shared Job Worktree Colocation & Silent Overwrite (Default Configuration)**: In `createFleetTaskExecutor` (`apps/cli/src/fleetRunner.ts:109-111`), `runnerOptions.shareJobWorktree` defaults to `true`. All parallel tasks dispatched by `JobOrchestrator` for a job execute inside the identical filesystem directory (`.wazir/worktrees/<jobId>`). When two parallel agents edit the same file, neither `writeTool` nor `editTool` (`packages/tools/src/filesystem.ts`) verifies base revisions or content hashes. The second write unconditionally overwrites confirmed changes made by the first agent without notice or rollback.
2. **Contaminated Auto-Commit of In-Flight / Unverified Sibling Edits (P0 Integrity Violation)**: When a task completes in a shared worktree, `fleetRunner.ts:643` calls `engine.worktrees.commitWorktree(worktreeInfo, ...)` without passing `intendedFiles`. `WorktreeManager.commitWorktree` (`packages/core/src/services/worktreeManager.ts:385`) stages all workspace changes via `git add -A`. Any intermediate, unverified, or syntactically broken file authored by a concurrent sibling task is committed into the completed task's git commit. If `autoMerge` is active, this unverified broken state is immediately merged into `main`.
3. **False Success on Merge Conflict Abort (Silent Work Loss)**: When a task completes and calls `mergeBranch` (`packages/core/src/services/worktreeManager.ts:435-485`), if git detects a merge conflict against the target branch, `mergeBranch` aborts the merge (`git merge --abort`) and returns `{ success: false, conflicts: [...] }`. In `apps/cli/src/fleetRunner.ts:648-650`, the orchestrator completely ignores the return value of `mergeBranch`. The task is marked as `completed` with full success, even though its verified code was reverted and discarded.
4. **Asynchronous TOCTOU Race in `getOrCreateJobWorktree` Causing Silent Workspace Escape**: `WorktreeManager.getOrCreateJobWorktree` performs an in-memory map lookup followed by an asynchronous `createWorktree`. When `JobOrchestrator` dispatches two ready tasks simultaneously, both enter `createWorktree` concurrently. One creates the directory, causing the other to throw an exception (`refusing to replace existing worktree path` or `fatal: ... already exists`). `fleetRunner.ts:113-116` catches this error and silently falls back to `taskRoot = engine.projectRoot`, causing the racing task to execute directly in the host repository.
5. **Target Working Tree Mutation & Unserialized Git Concurrency Locks**: `WorktreeManager.mergeBranch` checks out and merges directly inside `projectRoot` (the operator's live checkout) without acquiring a lock or mutex. Concurrent task completions race on `git checkout` and `git merge`, causing `.git/index.lock` collisions and corrupted branch states.
6. **Total Disconnect of `VerifiedIntegrationCoordinator`**: Although `VerifiedIntegrationCoordinator` contains comprehensive multi-candidate conflict detection (`same-file`, `rename-delete`, `dependency`, `test-fixture`, `git-merge`) and isolated candidate qualification, it is **never invoked** by `JobOrchestrator`, `fleetRunner`, `JobManager`, or `run.ts`. It exists as an isolated class tested only in unit tests.
7. **Unconditional Overwrite in Checkpoint Fork Non-Git Merges**: In `CheckpointService.mergeFork` (`packages/core/src/services/checkpointService.ts:450-456`), non-git workspaces use `fs.writeFile` to copy every file from the fork into `parentWorkspace` without checking if `parentWorkspace` was mutated while the fork was running, destroying concurrent work.

---

## 2. Exhaustive Workspace Concurrency Trace Matrix

| Subsystem / Operation | File & Line | Isolation Boundary | Optimistic Concurrency / Revision Check | Conflict Detection & Rollback | Resulting Status |
|---|---|---|---|---|---|
| `fleetRunner:createFleetTaskExecutor` | [`apps/cli/src/fleetRunner.ts:109-111`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L109-L111) | ⚠️ Shared Job Worktree (`.wazir/worktrees/<jobId>`) by default | ❌ None. Tasks share disk directory | ❌ None. Parallel agents collocated | ⚠️ Unisolated parallel execution |
| `fleetRunner:worktreeFallback` | [`apps/cli/src/fleetRunner.ts:114-116`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L114-L116) | ❌ Host Project Root (`engine.projectRoot`) | ❌ None | ❌ None. Silent fallback on error | 🚨 Isolation Escape |
| `writeTool.execute` | [`packages/tools/src/filesystem.ts:88-95`](file:///Users/wael/Code/Wazir/packages/tools/src/filesystem.ts#L88-L95) | Dependent on task root | ❌ None. Reads beforeHash at write time; no base revision check | ❌ None. Overwrites unconditionally | 🚨 Silent Lost Updates |
| `editTool.execute` | [`packages/tools/src/filesystem.ts:155-175`](file:///Users/wael/Code/Wazir/packages/tools/src/filesystem.ts#L155-L175) | Dependent on task root | ❌ None. Only verifies oldString presence | ❌ None. Applies edit on stale buffer | 🚨 Silent Stale Edits |
| `fleetRunner:commitWorktree` | [`apps/cli/src/fleetRunner.ts:643-646`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L643-L646) | Shared worktree | ❌ No `intendedFiles` passed | ❌ None. `git add -A` captures sibling edits | 🚨 Contaminated Commits |
| `worktreeManager:commitWorktree` | [`packages/core/src/services/worktreeManager.ts:385`](file:///Users/wael/Code/Wazir/packages/core/src/services/worktreeManager.ts#L385) | Worktree directory | ❌ `git add -A` stages all dirty files | ❌ None | 🚨 Unverified Code Staged |
| `fleetRunner:mergeBranch` | [`apps/cli/src/fleetRunner.ts:649`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L649) | Target branch | ❌ Return value ignored | ❌ None. Abort ignored; reported as success | 🚨 False Verified Success |
| `worktreeManager:mergeBranch` | [`packages/core/src/services/worktreeManager.ts:445-452`](file:///Users/wael/Code/Wazir/packages/core/src/services/worktreeManager.ts#L445-L452) | Direct mutation of `projectRoot` | ❌ No check if target moved past `baseSha` | ⚠️ Aborts merge on conflict; no queue/mutex | 🚨 Git Index Lock Collision |
| `worktreeManager:getOrCreateJobWorktree` | [`packages/core/src/services/worktreeManager.ts:195-201`](file:///Users/wael/Code/Wazir/packages/core/src/services/worktreeManager.ts#L195-L201) | In-memory Map | ❌ Async TOCTOU race | ❌ None. Throws and triggers host fallback | 🚨 Concurrent Collision |
| `checkpointService:mergeFork` | [`packages/core/src/services/checkpointService.ts:450-456`](file:///Users/wael/Code/Wazir/packages/core/src/services/checkpointService.ts#L450-L456) | Non-git workspace | ❌ Overwrites parent workspace via `fs.writeFile` | ❌ None. No comparison with parent revision | 🚨 Unconditional Overwrite |
| `runSubagent:executeTool` | [`apps/cli/src/run.ts:1532, 1542`](file:///Users/wael/Code/Wazir/apps/cli/src/run.ts#L1532-L1542) | Parent workspace root | ❌ No worktree created for subagents | ❌ None. Subagent directly mutates parent | ⚠️ Unisolated Subagent Writes |
| `VerifiedIntegrationCoordinator` | [`packages/core/src/services/verifiedIntegrationCoordinator.ts:177`](file:///Users/wael/Code/Wazir/packages/core/src/services/verifiedIntegrationCoordinator.ts#L177) | Candidate worktrees | ✅ Checks `targetSha`, detects conflicts, runs tests | ✅ Blocks conflicting or failing candidate merges | ❌ **ORPHANED** (Never called by orchestrator) |

---

## 3. Detailed Vulnerability Analyses

### 3.1 [P1-A25-01] Shared Job Worktrees Enable Silent Overwrite of Confirmed Agent Edits
- **Locations**:
  - [`apps/cli/src/fleetRunner.ts:109-111`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L109-L111)
  - [`packages/tools/src/filesystem.ts:88-95`](file:///Users/wael/Code/Wazir/packages/tools/src/filesystem.ts#L88-L95)
  - [`packages/tools/src/filesystem.ts:155-175`](file:///Users/wael/Code/Wazir/packages/tools/src/filesystem.ts#L155-L175)
- **Severity**: **P1 (Material Data Integrity Loss / Lost Updates)**
- **Alloy Invariant**: `NoSilentLostUpdate` in `tests/formal-hardening/models/a25-workspace-concurrency.als` (Counterexample SAT)
- **Reproduction**: `DEFECT 4` in `tests/formal-hardening/reproductions/A25-workspace-concurrency.test.ts`
- **Mechanism**:
  In `fleetRunner.ts`:
  ```typescript
  worktreeInfo = runnerOptions.shareJobWorktree !== false
    ? await engine.worktrees.getOrCreateJobWorktree(engine.projectRoot, jobId)
    : await engine.worktrees.createWorktree(engine.projectRoot, jobId, taskId);
  taskRoot = worktreeInfo.worktreeDir;
  ```
  Because `shareJobWorktree` is undefined on default CLI runs, `runnerOptions.shareJobWorktree !== false` is `true`. `JobOrchestrator` schedules parallel tasks up to `concurrencyLimit`. Every parallel task in the job is assigned `taskRoot = .wazir/worktrees/<jobId>`.
  When Agent A and Agent B concurrently modify the same file (e.g. `src/index.ts`):
  1. Both agents call `readTool` at $t_0$, reading Version 0.
  2. Agent A writes Version A at $t_1$. `writeTool` reads `beforeHash` immediately prior to writing, writes Version A, and returns success. Agent A runs verification tests and confirms its work.
  3. Agent B writes Version B at $t_2$. `writeTool` reads `beforeHash` (which is now Version A's hash) and unconditionally overwrites the file with Version B.
  4. Neither `writeTool` nor `editTool` accepts a `baseHash`, `expectedHash`, or `workspaceRevision` parameter.
  5. Agent A's confirmed work is silently clobbered with zero conflict warning, violation log, or retry trigger.

### 3.2 [P0-A25-02] Contaminated Auto-Commit of In-Flight / Unverified Sibling Edits via `git add -A`
- **Locations**:
  - [`apps/cli/src/fleetRunner.ts:642-650`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L642-L650)
  - [`packages/core/src/services/worktreeManager.ts:384-386`](file:///Users/wael/Code/Wazir/packages/core/src/services/worktreeManager.ts#L384-L386)
- **Severity**: **P0 (False Verified Completion & Unverified Mutation Merge)**
- **Alloy Invariant**: `NoContaminatedCommit` in `tests/formal-hardening/models/a25-workspace-concurrency.als` (Counterexample SAT)
- **Reproduction**: `DEFECT 2` in `tests/formal-hardening/reproductions/A25-workspace-concurrency.test.ts`
- **Mechanism**:
  When Agent A completes its task in a shared worktree:
  ```typescript
  if (worktreeInfo && evaluation.success && !wasCancelled) {
    const commitRes = await engine.worktrees.commitWorktree(
      worktreeInfo,
      `wazir(${jobId}): ${task.title || task.input.slice(0, 60)}`,
    );
    if (runnerOptions.autoMerge && commitRes.committed) {
      await engine.worktrees.mergeBranch(engine.projectRoot, worktreeInfo.branch);
    }
  }
  ```
  `fleetRunner.ts` invokes `commitWorktree` without providing `options.intendedFiles`.
  Inside `WorktreeManager.commitWorktree`:
  ```typescript
  if (options?.intendedFiles && options.intendedFiles.length > 0) {
    await execFileAsync('git', [...GIT_NO_HOOKS, 'reset'], { cwd: info.worktreeDir });
    await execFileAsync('git', [...GIT_NO_HOOKS, 'add', '--', ...options.intendedFiles], { cwd: info.worktreeDir });
  } else {
    await execFileAsync('git', [...GIT_NO_HOOKS, 'add', '-A'], { cwd: info.worktreeDir });
  }
  ```
  Because `options.intendedFiles` is omitted, git runs `git add -A`.
  If Agent B is concurrently executing in the shared worktree and has written intermediate, partial, or broken test files or implementation files, `git add -A` stages Agent B's unverified modifications into Agent A's commit.
  When `autoMerge` runs, this contaminated commit is merged into `main`. Wazir reports Agent A as `completed` with verified status, even though unverified and potentially broken code from Agent B was permanently committed into repository history.

### 3.3 [P1-A25-03] False Success on Merge Conflict Abort (Ignored `mergeBranch` Failure)
- **Locations**:
  - [`apps/cli/src/fleetRunner.ts:648-650`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L648-L650)
  - [`packages/core/src/services/worktreeManager.ts:460-485`](file:///Users/wael/Code/Wazir/packages/core/src/services/worktreeManager.ts#L460-L485)
- **Severity**: **P1 (Silent Loss of Agent Work / False Success)**
- **Reproduction**: `DEFECT 3` in `tests/formal-hardening/reproductions/A25-workspace-concurrency.test.ts`
- **Mechanism**:
  When `runnerOptions.autoMerge` is enabled:
  ```typescript
  if (runnerOptions.autoMerge && commitRes.committed) {
    await engine.worktrees.mergeBranch(engine.projectRoot, worktreeInfo.branch);
  }
  // ...
  return {
    supervisorDecision,
    success: evaluation.success && !wasCancelled,
    result: summary ?? (evaluation.success ? 'completed' : 'failed'),
    // ...
  };
  ```
  Notice that `fleetRunner.ts` **does not examine the return value** of `mergeBranch`.
  In `WorktreeManager.mergeBranch`:
  If the target branch has diverged such that git encounters a conflict (`UU`, `AA`, `UD` status entries):
  ```typescript
  catch (error) {
    let conflicts: string[] = [];
    // ... extracts conflicts ...
    await execFileAsync('git', [...GIT_NO_HOOKS, 'merge', '--abort'], { cwd: projectRoot });
    return {
      success: false,
      mergedBranch: branch,
      targetBranch: target,
      conflicts,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  ```
  `mergeBranch` cleanly aborts the merge and returns `{ success: false, conflicts }`.
  Because `fleetRunner` disregards this return object, execution flows directly to returning `success: true`. The orchestrator updates the task to `completed` in `JobManager` and records success.
  The user is presented with a green `completed` status, while in reality the merge was aborted and the agent's confirmed work was discarded.

### 3.4 [P1-A25-04] Asynchronous TOCTOU Race in `getOrCreateJobWorktree` Triggers Silent Host Root Fallback
- **Locations**:
  - [`packages/core/src/services/worktreeManager.ts:191-203`](file:///Users/wael/Code/Wazir/packages/core/src/services/worktreeManager.ts#L191-L203)
  - [`packages/core/src/services/worktreeManager.ts:224-226`](file:///Users/wael/Code/Wazir/packages/core/src/services/worktreeManager.ts#L224-L226)
  - [`apps/cli/src/fleetRunner.ts:113-116`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L113-L116)
- **Severity**: **P1 (Workspace Escape / Isolation Breakdown)**
- **Reproduction**: `DEFECT 1` in `tests/formal-hardening/reproductions/A25-workspace-concurrency.test.ts`
- **Mechanism**:
  In `WorktreeManager`:
  ```typescript
  async getOrCreateJobWorktree(projectRoot: string, jobId: string): Promise<WorktreeInfo> {
    const existing = this.jobWorktrees.get(jobId);
    if (existing) {
      const exists = await fs.access(existing.worktreeDir).then(() => true).catch(() => false);
      if (exists) return existing;
    }
    const info = await this.createWorktree(projectRoot, jobId);
    this.jobWorktrees.set(jobId, info);
    return info;
  }
  ```
  `jobWorktrees` is an in-memory map. When `JobOrchestrator` starts two parallel tasks simultaneously:
  1. Task 1 calls `getOrCreateJobWorktree`. `existing` is undefined. Task 1 begins `await this.createWorktree`.
  2. Task 2 calls `getOrCreateJobWorktree`. `existing` is still undefined because Task 1 has not resolved or set the map entry. Task 2 begins `await this.createWorktree`.
  3. Task 1 creates the directory `.wazir/worktrees/<jobId>` and runs `git worktree add`.
  4. Task 2 reaches line 224 in `createWorktree`: `if (await fs.access(worktreeDir)...) throw new Error("refusing to replace existing worktree path ...")` or git reports `fatal: ... already exists`.
  5. Task 2 rejects.
  6. In `fleetRunner.ts:113-116`:
     ```typescript
     try {
       worktreeInfo = ... await engine.worktrees.getOrCreateJobWorktree(...);
       taskRoot = worktreeInfo.worktreeDir;
     } catch (err) {
       // Fallback to project root if worktree creation fails
       taskRoot = engine.projectRoot;
     }
     ```
  7. Task 2 catches the collision error and **silently falls back to running directly on `engine.projectRoot`**.
  8. Task 1 is running in the worktree, while Task 2 is running in the host checkout, breaking workspace isolation under ordinary parallel scheduling.

### 3.5 [P1-A25-05] Unserialized Direct Target Mutations Cause Git Index Lock Collisions in `mergeBranch`
- **Locations**:
  - [`packages/core/src/services/worktreeManager.ts:442-452`](file:///Users/wael/Code/Wazir/packages/core/src/services/worktreeManager.ts#L442-L452)
- **Severity**: **P1 (Git Concurrency Lock Collision / Corrupted Merge)**
- **Mechanism**:
  `WorktreeManager.mergeBranch` executes:
  ```typescript
  await execFileAsync('git', [...GIT_NO_HOOKS, 'checkout', target], { cwd: projectRoot });
  await execFileAsync('git', [...GIT_NO_HOOKS, 'merge', '--no-ff', branch, ...], { cwd: projectRoot });
  ```
  There is no serialization queue, mutex, or advisory file lock on `projectRoot`. When multiple tasks finish concurrently in isolated worktrees (`shareJobWorktree: false`), each task calls `mergeBranch(engine.projectRoot, ...)` at the same time.
  Both processes concurrently invoke `git checkout` and `git merge` in `projectRoot`. Git attempts to create `.git/index.lock`. One process fails with `fatal: Unable to create '.git/index.lock': File exists`.
  The error triggers the catch block, aborting the merge with `git merge --abort` and returning failure, which is then ignored by `fleetRunner.ts` (Defect 3.3).

### 3.6 [P1-A25-06] Stale-Base Merges Bypass Post-Merge Integration Verification (`VerifiedIntegrationCoordinator` Disconnect)
- **Locations**:
  - [`packages/core/src/services/worktreeManager.ts:435-485`](file:///Users/wael/Code/Wazir/packages/core/src/services/worktreeManager.ts#L435-L485)
  - [`packages/core/src/services/verifiedIntegrationCoordinator.ts:174-176`](file:///Users/wael/Code/Wazir/packages/core/src/services/verifiedIntegrationCoordinator.ts#L174-L176)
- **Severity**: **P1 (Semantic Merge Conflicts & Broken Target Build)**
- **Mechanism**:
  When two tasks A and B are created on base commit $C_0$:
  - Task A modifies `api.ts`, tests pass, and merges into `main` ($C_1$).
  - Task B modifies `service.ts` relying on the old signature of `api.ts`. Tests pass in Task B's worktree because Task B's worktree only contains $C_0$.
  - Task B completes and calls `mergeBranch`.
  - Git's 3-way merge sees changes in different files (`api.ts` vs `service.ts`) and performs a clean merge without conflicts.
  - No build, typecheck, or integration tests are executed against the merged commit on `main`.
  - `main` is now broken.
  Wazir contains a dedicated class, `VerifiedIntegrationCoordinator`, explicitly designed to prevent this by tracking `staleBase: candidate.manifest.baseSha !== targetSha`, checking for overlapping semantic dependencies, and running `verifyCandidate` on a detached candidate worktree.
  However, `VerifiedIntegrationCoordinator` is **completely disconnected** from runtime orchestration. Neither `JobOrchestrator` nor `fleetRunner` references or invokes `VerifiedIntegrationCoordinator`.

### 3.7 [P1-A25-07] Checkpoint Fork Non-Git Merge Blindly Overwrites Concurrent Parent Workspace Mutations
- **Locations**:
  - [`packages/core/src/services/checkpointService.ts:450-456`](file:///Users/wael/Code/Wazir/packages/core/src/services/checkpointService.ts#L450-L456)
- **Severity**: **P1 (Unconditional Overwrite Without Concurrency Check)**
- **Reproduction**: `DEFECT 5` in `tests/formal-hardening/reproductions/A25-workspace-concurrency.test.ts`
- **Mechanism**:
  In `CheckpointService.mergeFork`:
  ```typescript
  // Non-git fallback: copy modified files from forked worktree to parent workspace
  const forkedSnapshot = await this.snapshotWorkspaceFiles(forkResult.forkedWorktreePath);
  for (const [relPath, content] of Object.entries(forkedSnapshot)) {
    const destPath = path.join(parentWorkspace, relPath);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, content, 'utf8');
  }
  ```
  In non-git workspaces, `mergeFork` takes all files present in the forked worktree and writes them directly to `parentWorkspace`.
  If another concurrent task or the operator updated any file in `parentWorkspace` during the fork's lifespan, `mergeFork` unconditionally overwrites those changes with no diffing, no base revision check, and no conflict detection.

### 3.8 [P1-A25-08] Subagents Mutate Parent Workspace Directly Without Worktree Isolation
- **Locations**:
  - [`apps/cli/src/run.ts:1532, 1542`](file:///Users/wael/Code/Wazir/apps/cli/src/run.ts#L1532-L1542)
  - [`apps/cli/src/fleetRunner.ts:392`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L392)
- **Severity**: **P1 (Unisolated Concurrent Subagent Writes)**
- **Mechanism**:
  When an agent invokes `dispatch_subagent`:
  `runSubagent` (`apps/cli/src/run.ts:1180`) configures the child execution runtime with `projectRoot: context.projectRoot`.
  No isolated worktree or branch is created for the subagent.
  All tool calls executed by the subagent (`write`, `edit`, `quick_shell`) run directly in the parent agent's workspace.
  If the parent agent continues execution, or if multiple subagents are dispatched concurrently, their mutations interleave arbitrarily on disk without revision gating or conflict detection.

---

## 4. Formal Verification with Alloy 6

To mathematically verify that concurrent agents can silently overwrite confirmed work and commit unverified in-flight changes, we formulated a temporal Alloy 6 model:

- **Model File**: `tests/formal-hardening/models/a25-workspace-concurrency.als`
- **Analyzer Execution**:
  ```bash
  mkdir -p tests/formal-hardening/logs/alloy-a25-workspace
  java -jar tools/alloy/org.alloytools.alloy.dist.jar exec -f -t text -c '*' \
    -o tests/formal-hardening/logs/alloy-a25-workspace \
    tests/formal-hardening/models/a25-workspace-concurrency.als
  ```
- **Verification Results**:
  ```text
  00. run   WitnessMultiAgentExecution     0         1/1     SAT
  01. check NoSilentLostUpdate             0         1/1     SAT (Counterexample Found)
  02. check NoContaminatedCommit           0         1/1     SAT (Counterexample Found)
  ```

### 4.1 Invariant 1: NoSilentLostUpdate Counterexample Trace
The Alloy solver generated a minimal 6-step temporal trace (`NoSilentLostUpdate-solution-0.txt`):
1. **State 0**: `Workspace.file` contains `File$0 -> Content$1`.
2. **State 1**: `Agent$1` reads `File$0`, observing `Content$1`.
3. **State 2**: `Agent$0` reads `File$0`, observing `Content$1`.
4. **State 3**: `Agent$0` writes `Content$0` to `File$0` (`vulnerableWrite`).
5. **State 4**: `Agent$0` runs tests and confirms `File$0 -> Content$0` (`confirmWork`). `AgentState.confirmedEdit` records `Agent$0 -> File$0 -> Content$0`.
6. **State 5**: `Agent$1` invokes `vulnerableWrite` based on its stale observation of `Content$1`. It writes to `File$0`.
7. **Violation**: `LostUpdateObserved` transitions from `{}` to `{Agent$0}`. `Agent$0`'s confirmed edit is permanently destroyed.

### 4.2 Invariant 2: NoContaminatedCommit Counterexample Trace
The Alloy solver generated a minimal 4-step temporal trace (`NoContaminatedCommit-solution-0.txt`):
1. **State 0**: Initial workspace with clean state.
2. **State 1**: `Agent$1` reads `File$0`.
3. **State 2**: `Agent$1` writes unverified changes to `File$0`, making `File$0` dirty (`AgentState.inFlightDirty = {Agent$1 -> File$0}`).
4. **State 3**: `Agent$0` finishes its independent task and executes `vulnerableSharedCommit` (`git add -A`).
5. **Violation**: `ContaminatedCommitObserved = {Agent$0}`. `Agent$0` commits `Agent$1`'s unverified in-flight modifications into the commit and merges it into target history.

---

## 5. Deterministic Vitest Reproductions

All identified defects were reproduced with deterministic unit and integration tests executing against Wazir's actual TypeScript classes:

- **Suite File**: `tests/formal-hardening/reproductions/A25-workspace-concurrency.test.ts`
- **Execution Command**:
  ```bash
  npx --no-install vitest run tests/formal-hardening/reproductions/A25-workspace-concurrency.test.ts
  ```
- **Test Results**: **5 / 5 PASSED** (Execution duration: 1.24s)
  ```text
  ✓ DEFECT 1: getOrCreateJobWorktree has an asynchronous TOCTOU race condition under concurrent calls
  ✓ DEFECT 2: commitWorktree uses git add -A and commits unverified in-flight sibling edits in shared worktree
  ✓ DEFECT 3: mergeBranch aborts on conflict but fleetRunner ignores return value, causing silent loss of work
  ✓ DEFECT 4: writeTool and editTool have no optimistic concurrency checks and silently overwrite concurrent edits
  ✓ DEFECT 5: CheckpointService.mergeFork non-git fallback unconditionally overwrites concurrent parent mutations
  ```

---

## 6. Remediation & Hardening Recommendations

To guarantee that one agent never silently overwrites another agent's confirmed work, Wazir must implement the following architectural protections:

1. **Enforce Isolated Worktrees by Default in `fleetRunner.ts`**:
   - Change `runnerOptions.shareJobWorktree` to default to `false`.
   - Each task in a job must receive a dedicated worktree (`.wazir/worktrees/<jobId>-<taskId>`) and branch (`wazir/<jobId>/<taskId>`).
2. **Scope Worktree Commits to Intended Files**:
   - In `fleetRunner.ts:643`, pass `options.intendedFiles: finalRecord.filesChanged`.
   - In `WorktreeManager.commitWorktree`, reject `git add -A` unless explicitly requested. Only stage files modified by the completing execution.
3. **Handle `mergeBranch` Results and Fail Closed on Conflicts**:
   - In `fleetRunner.ts:649`, assert that `mergeRes.success === true`.
   - If `mergeBranch` fails with conflicts, record the failure on the execution, mark the task as `failed` or `blocked` (requiring operator or conflict assistance), and never report `completed`.
4. **Serialize `mergeBranch` with an Async Mutex**:
   - Add a file lock or in-process queue in `WorktreeManager` to serialize merges into `projectRoot`, preventing concurrent `.git/index.lock` collisions.
5. **Resolve the `getOrCreateJobWorktree` Race with Promise Deduplication**:
   - Store `Map<string, Promise<WorktreeInfo>>` instead of `Map<string, WorktreeInfo>` so concurrent callers await the single in-flight creation promise.
6. **Integrate `VerifiedIntegrationCoordinator` into Job Finalization**:
   - Hook `VerifiedIntegrationCoordinator` into `JobOrchestrator` when all tasks in a job complete.
   - Plan and qualify the candidate merges in a detached worktree, running mandatory checks before promoting to the target branch.
7. **Add Optimistic Revision Tokens to File Tools**:
   - Add `expectedHash?: string` and `baseRevision?: number` to `writeTool` and `editTool` schemas.
   - If provided, compare against current disk content hash; fail closed with `CONCURRENT_MODIFICATION_DETECTED` if the file changed since reading.
8. **Add Concurrency Checks to Non-Git `mergeFork`**:
   - In `CheckpointService.mergeFork`, compare `parentWorkspace` file hashes against the snapshot taken at fork creation time; refuse to overwrite files that were modified concurrently.
