# Parallel agent integration

Wazir keeps agent work in Git worktrees and branches. An agent saying a task is
complete is not integration approval. The verified integration coordinator
checks branch provenance, plans the order, and qualifies the combined tree in a
detached worktree. It never promotes that tree into the target branch.

## Qualification flow

1. Create one worktree per agent from the target commit. `WorktreeInfo.baseSha`
   records the exact commit used to create it.
2. Commit the agent change. Build an `AgentIntegrationManifest` from the
   worktree with `VerifiedIntegrationCoordinator.createManifest`. Supply the
   task and agent identity, target branch, declared ownership, test results,
   verification evidence, and outstanding risks.
3. Call `plan(repository, targetBranch, candidates)`. The plan checks manifests
   against Git history and blob ids, reports stale bases, computes a stable
   dependency order, and identifies overlapping paths and Git merge conflicts.
4. Call `qualify` with the plan inputs and trusted combined-result checks. It
   refuses a dirty target checkout or a target SHA that differs from the one
   approved by the caller. It creates a detached candidate worktree outside the
   repository, merges the exact candidate commits in plan order, then runs
   combined checks against that resulting tree.
5. Review `IntegrationQualificationReport`. Only `READY` means all required
   checks passed against the recorded candidate SHA and tree. `CONFLICTED`,
   `FAILED`, and `STALE` are release blockers. A `READY` candidate is still a
   candidate; promotion requires a separate authorized operation.

Example shape:

```ts
const coordinator = new VerifiedIntegrationCoordinator({
  requiredChecks: ['build', 'typecheck', 'unit-tests', 'integration-tests'],
  // Protect test or policy oracles that agents must not edit.
  protectedPaths: ['tests/security/oracle.test.ts'],
});

const report = await coordinator.qualify(repository, {
  targetBranch: 'main',
  expectedTargetSha: approvedTargetSha,
  candidates: [{ branch: manifest.branch, manifest }],
  verifyCandidate: async (candidatePath) => runChecksInApprovedSandbox(candidatePath),
});
```

Each returned check must include its name, status, candidate `sourceSha`,
execution id, completion time, and SHA-256 digest of its result artifact. A
passing status without matching provenance does not qualify. The caller owns
the execution sandbox policy; candidate worktrees provide Git and filesystem
isolation, not an operating-system security sandbox. Do not execute untrusted
candidate scripts with ambient credentials or network access.

## Manifest schema (version 1)

```json
{
  "schemaVersion": 1,
  "taskId": "task-123",
  "agentId": "agent-abc",
  "branch": "wazir/job-123/task-123",
  "baseSha": "<git commit oid>",
  "headSha": "<git commit oid>",
  "targetBranch": "main",
  "changedFiles": ["src/module.ts", "src/old-name.ts"],
  "fileChanges": [
    { "status": "M", "path": "src/module.ts" },
    { "status": "R", "previousPath": "src/old-name.ts", "path": "src/new-name.ts" }
  ],
  "fileHashes": { "src/module.ts": "<git blob oid>", "src/new-name.ts": "<git blob oid>", "src/old-name.ts": null },
  "declaredOwnership": ["src/"],
  "testsExecuted": [{
    "name": "unit", "command": "npm test", "status": "PASS",
    "sourceSha": "<headSha>", "runId": "<execution id>",
    "runnerId": "<runner>", "exitCode": 0,
    "resultSha256": "<64 hex characters>",
    "startedAt": "<ISO timestamp>", "completedAt": "<ISO timestamp>"
  }],
  "verificationEvidence": [{
    "id": "<evidence id>", "status": "PASS",
    "sourceSha": "<headSha>", "resultSha256": "<64 hex characters>"
  }],
  "outstandingRisks": [],
  "createdAt": "<ISO timestamp>"
}
```

`fileHashes` are Git blob object ids for the final file contents; deleted paths
are `null`. The manifest is checked against the live branch, commit ancestry,
Git diff, and tree contents. It is provenance metadata, not a signature and not
proof that a runner actually executed a command. The combined qualification
checks are independently rerun on the assembled candidate and are the basis for
`READY`.

## Conflict handling and ordering

The plan sorts independent tasks by task id for reproducibility and places
declared dependencies before dependents. Missing dependencies and cycles block
planning. A base older than the current target is reported and the exact current
target is used for the disposable candidate; actual mergeability is checked
before readiness.

Overlapping paths are classified as ordinary same-file edits, rename/edit or
rename/delete, dependency metadata, test fixtures, or generated artifacts.
Git merge conflicts are reported separately from file overlap. A clean textual
merge does not prove API or behavioral compatibility; required combined tests
must catch those failures. Test, fixture, and `__tests__` paths are protected by
default, including changes made by the evaluated agent. Configure
`protectedPaths` for other policy oracles. If a task truly needs test changes,
approve exact paths out of band with `authorizedTestChanges`; never derive that
allowlist from an agent manifest or completion message.

`analyzeConflict` is an optional read-only adapter for an AI assistant. It sends
the competing diffs and an instruction to explain tradeoffs or propose a patch.
The returned proposal has `applied: false`; the coordinator never applies it or
allows it to establish readiness. Any operator resolution belongs in the
disposable candidate and requires the full combined checks.

## Recovery journal

Journals are atomically written under the Git common directory at
`wazir-integration/journals/<integrationId>.json`. Each successful candidate
merge records its branch, head, and resulting candidate head/tree. After a
process interruption, `inspectJournal` reads the last durable state and
`continueQualification` checks target identity, branch identities, candidate
location, and clean state. It detects already included commits by ancestry and
does not replay them. If the candidate directory is missing, it reconstructs
the disposable worktree from the last journaled candidate commit. An unresolved
conflict must be resolved and committed in the disposable candidate before
continuation. A changed target/branch is rejected or marked stale; agent
branches and protected target branches are retained.

The existing `WorktreeManager.mergeBranch` API remains available for backward
compatibility and now refuses to operate from a dirty target checkout. New
multi-agent orchestration should use plan and qualification first. No CLI merge
command currently promotes a candidate, and this workstream does not grant
merge authorization.
