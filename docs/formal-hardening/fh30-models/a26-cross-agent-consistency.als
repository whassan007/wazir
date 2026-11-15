module a26_cross_agent_consistency

/*
 * Alloy 6 Formal Model: Cross-Agent Consistency, Context Propagation & Delegation
 * Agent A26 (Gemini TIER 1 — Context Propagation & Cross-Agent Consistency Auditor)
 *
 * Target Repository: Wazir (packages/core, packages/agents, apps/cli)
 * Critical Invariant: "One agent must not silently overwrite another agent's confirmed work."
 */

sig File {}
sig Agent {
  capabilities: set Capability
}
enum Capability { ReadOnly, MutateFiles, ShellExec }

sig Task {
  agent: one Agent,
  dependencies: set Task,
  modifiedFiles: set File
}

enum TaskStatus { Pending, Running, Completed, Failed, Cancelled }

var sig TaskState in Task -> TaskStatus {}
var sig TargetHeadFiles in File {}
var sig TaskBranchFiles in Task -> File {}
var sig ActiveTasks in Task {}
var sig UnverifiedFiles in File {}

// Initial State
pred init {
  all t: Task | TaskState.t = Pending
  no TargetHeadFiles
  no TaskBranchFiles
  no ActiveTasks
  no UnverifiedFiles
}

// Dispatch task: becomes active and running if dependencies satisfied
pred dispatchTask [t: Task] {
  TaskState.t = Pending
  all dep: t.dependencies | TaskState.dep = Completed
  
  TaskState' = TaskState ++ (t -> Running)
  ActiveTasks' = ActiveTasks + t
  TargetHeadFiles' = TargetHeadFiles
  TaskBranchFiles' = TaskBranchFiles
  UnverifiedFiles' = UnverifiedFiles
}

// Agent mutates files during execution
pred agentMutate [t: Task, f: File] {
  t in ActiveTasks
  TaskState.t = Running
  
  // Under defective delegation, ReadOnly agent can spawn subagent with MutateFiles
  TaskBranchFiles' = TaskBranchFiles + (t -> f)
  UnverifiedFiles' = UnverifiedFiles + f
  TaskState' = TaskState
  ActiveTasks' = ActiveTasks
  TargetHeadFiles' = TargetHeadFiles
}

// Task completes with isolated worktree and autoMerge
// ACTUAL DEFECTIVE SEMANTICS (fleetRunner.ts:648-650):
// If merge conflict occurs with TargetHeadFiles, merge aborts, but task STILL marks Completed!
pred defectiveAutoMergeComplete [t: Task] {
  t in ActiveTasks
  TaskState.t = Running
  
  // Conflict condition: target head already has files modified by another task
  some conflict: (t.TaskBranchFiles & TargetHeadFiles) | {
    // Merge aborts: TargetHeadFiles is NOT updated with t's files!
    TargetHeadFiles' = TargetHeadFiles
  } else {
    // Clean merge: target head gets files
    TargetHeadFiles' = TargetHeadFiles + t.TaskBranchFiles
  }
  
  // DEFECT: Task is marked Completed regardless of merge success!
  TaskState' = TaskState ++ (t -> Completed)
  ActiveTasks' = ActiveTasks - t
  TaskBranchFiles' = TaskBranchFiles
  UnverifiedFiles' = UnverifiedFiles - t.TaskBranchFiles
}

// Shared Worktree Defect (fleetRunner.ts:109-112, worktreeManager.ts:385)
// Concurrent task commits all files in worktree via `git add -A`, including unverified files
pred sharedWorktreeCommit [t: Task] {
  t in ActiveTasks
  TaskState.t = Running
  
  // Commits all unverified files in shared directory into target head
  TargetHeadFiles' = TargetHeadFiles + UnverifiedFiles
  TaskState' = TaskState ++ (t -> Completed)
  ActiveTasks' = ActiveTasks - t
  TaskBranchFiles' = TaskBranchFiles
  UnverifiedFiles' = none
}

// State transitions
pred step {
  (some t: Task | dispatchTask[t]) or
  (some t: Task, f: File | agentMutate[t, f]) or
  (some t: Task | defectiveAutoMergeComplete[t]) or
  (some t: Task | sharedWorktreeCommit[t]) or
  (TaskState' = TaskState and TargetHeadFiles' = TargetHeadFiles and
   TaskBranchFiles' = TaskBranchFiles and ActiveTasks' = ActiveTasks and
   UnverifiedFiles' = UnverifiedFiles)
}

fact Traces {
  init
  always step
}

// INVARIANT 1: No Silent Lost Update
// If a task is confirmed Completed, its modified files MUST be in TargetHeadFiles
// when a downstream dependent task starts executing.
assert NoSilentLostUpdate {
  always (
    all t: Task, dep: Task |
      (dep in t.dependencies and TaskState.t = Running and TaskState.dep = Completed) =>
        dep.modifiedFiles in TargetHeadFiles
  )
}

// INVARIANT 2: No Unverified Commits
// TargetHeadFiles must never contain unverified files from concurrently running tasks
assert NoUnverifiedCommits {
  always (
    all f: File | (f in TargetHeadFiles) => f not in UnverifiedFiles
  )
}

// INVARIANT 3: Delegated Capability Containment
// A ReadOnly agent must never cause file mutations
assert DelegatedCapabilityContainment {
  always (
    all t: Task |
      (ReadOnly in t.agent.capabilities and MutateFiles not in t.agent.capabilities) =>
        no t.TaskBranchFiles
  )
}

check NoSilentLostUpdate for 3 Task, 3 File, 6 steps
check NoUnverifiedCommits for 3 Task, 3 File, 6 steps
check DelegatedCapabilityContainment for 3 Task, 3 File, 6 steps
