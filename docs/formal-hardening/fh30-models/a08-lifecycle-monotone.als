module a08_lifecycle_monotone

/*
 * Formal Specification: Wazir Task & Job Lifecycle State Machine (Monotone Safety)
 * Program: Wazir 30-Agent Cost-Optimized Formal Hardening Program
 * Agent: A08 (Gemini TIER 2 — Alloy Task Lifecycle State Machine Modeler)
 * Commit: 4661c33a6caeaca0639853463e4ccbbe3ebc63d8
 *
 * Critical Invariant:
 *   "Completed or cancelled work must not silently re-enter execution
 *    or be reported under a contradictory terminal status."
 *
 * Monotone Transitions:
 *   - Normal completion: Pending -> Running -> Completed
 *   - Cancellation: Pending / Running -> Cancelled (terminal)
 *   - Failure: Running -> Failed
 *   - Permitted retry: Failed -> Pending (ONLY if Job is not terminal)
 *   - Finalizer reconciliation: Job Cancelled -> Failed (timeout abort finalizer)
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
  // Every Job owns at least one Task
  all j: Job | some j.~job
  // Every Task owns at least one Execution
  all t: Task | some t.~task
  // Each execution belongs to one task, each task to one job
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
  // Permitted ONLY when parent Job is NOT in a terminal status!
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

  // In-flight / pending tasks and executions become Cancelled; already terminal ones remain unchanged
  all t: j.~job | (t.status in (Pending + Running) implies t.status' = Cancelled else t.status' = t.status)
  all e: (j.~job).~task | (e.status in (Pending + Running) implies e.status' = Cancelled else e.status' = e.status)

  all j2: Job - j | j2.status' = j2.status
  all t2: Task - j.~job | t2.status' = t2.status
  all e2: Execution - (j.~job).~task | e2.status' = e2.status
}

pred jobComplete[j: Job] {
  j.status = Running
  // Monotone rule: A Job can ONLY complete when ALL tasks are Completed!
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
  // Documented finalizer reconciliation: Job Cancelled -> Failed (statusTransitions.ts line 59)
  j.status = Cancelled
  j.status' = Failed

  // Tasks and executions stay in terminal state (may reconcile Cancelled -> Failed)
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
    stutter
  )
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

assert NoTerminalResurrection {
  // 1. Completed work stays Completed forever (no resurrection or mutation)
  always (all j: Job | j.status = Completed implies after (j.status = Completed))
  always (all t: Task | t.status = Completed implies after (t.status = Completed))
  always (all e: Execution | e.status = Completed implies after (e.status = Completed))

  // 2. Cancelled work never resurrects to active execution (Pending or Running) or Completed
  always (all j: Job | j.status = Cancelled implies after (j.status in (Cancelled + Failed)))
  always (all t: Task | t.status = Cancelled implies after (t.status in (Cancelled + Failed)))
  always (all e: Execution | e.status = Cancelled implies after (e.status in (Cancelled + Failed)))

  // 3. Failed job stays Failed forever
  always (all j: Job | j.status = Failed implies after (j.status = Failed))

  // 4. Failed task/execution retry is strictly forbidden when parent Job is terminal
  always (all t: Task | (t.status = Failed and t.status' = Pending) implies t.job.status in (Pending + Running))
  always (all e: Execution | (e.status = Failed and e.status' = Pending) implies e.task.job.status in (Pending + Running))
}

assert NoCompletedJobWithCancelledOrFailedTask {
  // A Job reported as Completed MUST NOT have any Task in Cancelled or Failed state
  always (all j: Job | j.status = Completed implies
    (no t: j.~job | t.status in (Cancelled + Failed)))
}

// ---------------------------------------------------------------------------
// Satisfiability Witnesses
// ---------------------------------------------------------------------------

run WitnessNormalJobCompletion {
  eventually (some j: Job | j.status = Completed and all t: j.~job | t.status = Completed)
} for 3 but 1 Job, 2 Task, 2 Execution, 8 steps

run WitnessTaskRetryAndComplete {
  eventually (some t: Task | once (t.status = Failed) and once (t.status = Pending) and t.status = Completed)
} for 3 but 1 Job, 2 Task, 2 Execution, 10 steps

run WitnessJobCancellation {
  eventually (some j: Job | j.status = Cancelled and all t: j.~job | t.status = Cancelled)
} for 3 but 1 Job, 2 Task, 2 Execution, 6 steps

run WitnessFinalizerReconciliation {
  eventually (some j: Job | once (j.status = Cancelled) and j.status = Failed)
} for 3 but 1 Job, 2 Task, 2 Execution, 8 steps

// ---------------------------------------------------------------------------
// Verification Checks
// ---------------------------------------------------------------------------

check NoTerminalResurrection for 3 but 1 Job, 2 Task, 2 Execution, 10 steps
check NoCompletedJobWithCancelledOrFailedTask for 3 but 1 Job, 2 Task, 2 Execution, 10 steps
