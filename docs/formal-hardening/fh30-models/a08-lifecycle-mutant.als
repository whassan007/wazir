module a08_lifecycle_mutant

/*
 * Formal Specification: Wazir Task & Job Lifecycle State Machine (Negative-Control Mutant)
 * Program: Wazir 30-Agent Cost-Optimized Formal Hardening Program
 * Agent: A08 (Gemini TIER 2 — Alloy Task Lifecycle State Machine Modeler)
 * Commit: 4661c33a6caeaca0639853463e4ccbbe3ebc63d8
 *
 * Negative-Control Mutation:
 *   1. Late Completion Callback / Unguarded Retry:
 *      A late completion callback or unguarded retry handler resurrects a Cancelled task
 *      (Cancelled -> Completed or Cancelled -> Pending), violating NoTerminalResurrection.
 *   2. Buggy Finalizer / Orchestrator Completion (reproducing jobOrchestrator.ts:894-897):
 *      When all tasks are finished (every task in completed/failed/cancelled), if anyFailed is false,
 *      the job is marked Completed, even if some task was Cancelled!
 *      Violates NoCompletedJobWithCancelledOrFailedTask.
 */

abstract sig Status {}
one sig Pending, Running, Completed, Failed, Cancelled extends Status {}

sig Job {
  var status: one Status
}

sig Task {
  job: one Job,
  var status: one Status
}

sig Execution {
  task: one Task,
  var status: one Status
}

fact StructuralHierarchy {
  all j: Job | some j.~job
  all t: Task | some t.~task
  all e: Execution | one e.task
  all t: Task | one t.job
}

pred init {
  all j: Job | j.status = Pending
  all t: Task | t.status = Pending
  all e: Execution | e.status = Pending
}

pred jobStart[j: Job] {
  j.status = Pending
  j.status' = Running

  all j2: Job - j | j2.status' = j2.status
  all t: Task | t.status' = t.status
  all e: Execution | e.status' = e.status
}

pred taskStart[t: Task, e: Execution] {
  e.task = t
  t.job.status = Running
  t.status = Pending
  e.status = Pending

  t.status' = Running
  e.status' = Running

  all j2: Job | j2.status' = j2.status
  all t2: Task - t | t2.status' = t2.status
  all e2: Execution - e | e2.status' = e2.status
}

pred executionComplete[e: Execution] {
  e.status = Running
  e.task.status = Running
  e.task.job.status = Running

  e.status' = Completed
  e.task.status' = Completed

  all j2: Job | j2.status' = j2.status
  all t2: Task - e.task | t2.status' = t2.status
  all e2: Execution - e | e2.status' = e2.status
}

pred executionFail[e: Execution] {
  e.status = Running
  e.task.status = Running

  e.status' = Failed
  e.task.status' = Failed

  all j2: Job | j2.status' = j2.status
  all t2: Task - e.task | t2.status' = t2.status
  all e2: Execution - e | e2.status' = e2.status
}

pred taskRetry[t: Task, e: Execution] {
  e.task = t
  t.job.status in (Pending + Running)
  t.status = Failed
  e.status = Failed

  t.status' = Pending
  e.status' = Pending

  all j2: Job | j2.status' = j2.status
  all t2: Task - t | t2.status' = t2.status
  all e2: Execution - e | e2.status' = e2.status
}

pred taskCancel[t: Task] {
  t.job.status in (Pending + Running)
  t.status in (Pending + Running)

  t.status' = Cancelled
  all e: t.~task | (e.status in (Pending + Running) implies e.status' = Cancelled else e.status' = e.status)

  all j2: Job | j2.status' = j2.status
  all t2: Task - t | t2.status' = t2.status
  all e2: Execution - t.~task | e2.status' = e2.status
}

pred jobCancel[j: Job] {
  j.status in (Pending + Running)
  j.status' = Cancelled

  all t: j.~job | (t.status in (Pending + Running) implies t.status' = Cancelled else t.status' = t.status)
  all e: (j.~job).~task | (e.status in (Pending + Running) implies e.status' = Cancelled else e.status' = e.status)

  all j2: Job - j | j2.status' = j2.status
  all t2: Task - j.~job | t2.status' = t2.status
  all e2: Execution - (j.~job).~task | e2.status' = e2.status
}

// ---------------------------------------------------------------------------
// MUTANT 1: Late completion callback resurrects a cancelled task
// ---------------------------------------------------------------------------
pred taskLateCompletionMutant[t: Task, e: Execution] {
  e.task = t
  // Defect: Task/Execution was already Cancelled by user/timeout,
  // but a late asynchronous completion callback from a worker writes Completed!
  t.status = Cancelled
  e.status = Cancelled

  t.status' = Completed
  e.status' = Completed

  all j2: Job | j2.status' = j2.status
  all t2: Task - t | t2.status' = t2.status
  all e2: Execution - e | e2.status' = e2.status
}

// ---------------------------------------------------------------------------
// MUTANT 2: Buggy job completion reproduces jobOrchestrator.ts:894-897
// ---------------------------------------------------------------------------
pred jobCompleteMutant[j: Job] {
  j.status = Running
  // All tasks in terminal states: completed, failed, or cancelled
  all t: j.~job | t.status in (Completed + Failed + Cancelled)
  // Defect: anyFailed is false, but some task is Cancelled!
  no t: j.~job | t.status = Failed
  some t: j.~job | t.status = Cancelled

  // Flawed logic: await finishJob(anyFailed ? 'failed' : 'completed') marks Job Completed!
  j.status' = Completed

  all j2: Job - j | j2.status' = j2.status
  all t: Task | t.status' = t.status
  all e: Execution | e.status' = e.status
}

pred jobComplete[j: Job] {
  j.status = Running
  all t: j.~job | t.status = Completed

  j.status' = Completed

  all j2: Job - j | j2.status' = j2.status
  all t: Task | t.status' = t.status
  all e: Execution | e.status' = e.status
}

pred jobFail[j: Job] {
  j.status = Running
  some t: j.~job | t.status = Failed
  no t: j.~job | t.status = Running

  j.status' = Failed
  all t: j.~job | (t.status = Pending implies t.status' = Failed else t.status' = t.status)
  all e: (j.~job).~task | (e.status = Pending implies e.status' = Failed else e.status' = e.status)

  all j2: Job - j | j2.status' = j2.status
  all t2: Task - j.~job | t2.status' = t2.status
  all e2: Execution - (j.~job).~task | e2.status' = e2.status
}

pred jobReconcile[j: Job] {
  j.status = Cancelled
  j.status' = Failed

  all t: j.~job | (t.status = Cancelled implies t.status' in (Cancelled + Failed) else t.status' = t.status)
  all e: (j.~job).~task | (e.status = Cancelled implies e.status' in (Cancelled + Failed) else e.status' = e.status)

  all j2: Job - j | j2.status' = j2.status
  all t2: Task - j.~job | t2.status' = t2.status
  all e2: Execution - (j.~job).~task | e2.status' = e2.status
}

pred stutter {
  all j: Job | j.status' = j.status
  all t: Task | t.status' = t.status
  all e: Execution | e.status' = e.status
}

fact traces {
  init
  always (
    (some j: Job | jobStart[j]) or
    (some t: Task, e: Execution | taskStart[t, e]) or
    (some e: Execution | executionComplete[e]) or
    (some e: Execution | executionFail[e]) or
    (some t: Task, e: Execution | taskRetry[t, e]) or
    (some t: Task | taskCancel[t]) or
    (some j: Job | jobCancel[j]) or
    (some j: Job | jobComplete[j]) or
    (some j: Job | jobFail[j]) or
    (some j: Job | jobReconcile[j]) or
    (some t: Task, e: Execution | taskLateCompletionMutant[t, e]) or
    (some j: Job | jobCompleteMutant[j]) or
    stutter
  )
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

assert NoTerminalResurrection {
  always (all j: Job | j.status = Completed implies after (j.status = Completed))
  always (all t: Task | t.status = Completed implies after (t.status = Completed))
  always (all e: Execution | e.status = Completed implies after (e.status = Completed))

  always (all j: Job | j.status = Cancelled implies after (j.status in (Cancelled + Failed)))
  always (all t: Task | t.status = Cancelled implies after (t.status in (Cancelled + Failed)))
  always (all e: Execution | e.status = Cancelled implies after (e.status in (Cancelled + Failed)))

  always (all j: Job | j.status = Failed implies after (j.status = Failed))

  always (all t: Task | (t.status = Failed and t.status' = Pending) implies t.job.status in (Pending + Running))
  always (all e: Execution | (e.status = Failed and e.status' = Pending) implies e.task.job.status in (Pending + Running))
}

assert NoCompletedJobWithCancelledOrFailedTask {
  always (all j: Job | j.status = Completed implies
    (no t: j.~job | t.status in (Cancelled + Failed)))
}

// ---------------------------------------------------------------------------
// Satisfiability Witnesses for Mutant Behaviors
// ---------------------------------------------------------------------------

run WitnessLateCompletionResurrection {
  eventually (some t: Task | once (t.status = Cancelled) and t.status = Completed)
} for 3 but 1 Job, 2 Task, 2 Execution, 8 steps

run WitnessPrematureJobCompletionWithCancelledTask {
  eventually (some j: Job | j.status = Completed and some t: j.~job | t.status = Cancelled)
} for 3 but 1 Job, 2 Task, 2 Execution, 8 steps

// ---------------------------------------------------------------------------
// Verification Checks (Expected to FAIL with Counterexamples)
// ---------------------------------------------------------------------------

check NoTerminalResurrection for 3 but 1 Job, 2 Task, 2 Execution, 10 steps
check NoCompletedJobWithCancelledOrFailedTask for 3 but 1 Job, 2 Task, 2 Execution, 10 steps
