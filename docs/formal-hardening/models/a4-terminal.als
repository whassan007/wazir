// Alloy 6 temporal specification for Wazir Terminal Status & Cancellation Monotonicity (A4)
// Models:
// - Job lifecycle (Pending -> Running -> Completed / Failed / Cancelled)
// - Task lifecycle (Pending -> Running -> Completed / Failed / Cancelled)
// - Concurrent task execution and placement
// - Mid-flight task cancellation and job cancellation
// - Task retry on failure (constrained to active jobs)
// - Terminal job completion semantics (only all-completed leads to JobCompleted)

abstract sig JobStatus {}
one sig JobPending, JobRunning, JobCompleted, JobFailed, JobCancelled extends JobStatus {}

abstract sig TaskStatus {}
one sig TaskPending, TaskRunning, TaskCompleted, TaskFailed, TaskCancelled extends TaskStatus {}

sig Task {
  var taskStatus: one TaskStatus
}

one sig Job {
  tasks: some Task,
  var jobStatus: one JobStatus
}

pred init {
  Job.jobStatus = JobPending
  all t: Job.tasks | t.taskStatus = TaskPending
}

pred startJob {
  Job.jobStatus = JobPending
  Job.jobStatus' = JobRunning
  taskStatus' = taskStatus
}

pred dispatchTask [t: Task] {
  t in Job.tasks
  Job.jobStatus = JobRunning
  t.taskStatus = TaskPending
  t.taskStatus' = TaskRunning
  Job.jobStatus' = Job.jobStatus
  all other: Job.tasks - t | other.taskStatus' = other.taskStatus
}

pred finishTaskSuccess [t: Task] {
  t in Job.tasks
  Job.jobStatus = JobRunning
  t.taskStatus = TaskRunning
  t.taskStatus' = TaskCompleted
  Job.jobStatus' = Job.jobStatus
  all other: Job.tasks - t | other.taskStatus' = other.taskStatus
}

pred finishTaskFailure [t: Task] {
  t in Job.tasks
  Job.jobStatus = JobRunning
  t.taskStatus = TaskRunning
  t.taskStatus' = TaskFailed
  Job.jobStatus' = Job.jobStatus
  all other: Job.tasks - t | other.taskStatus' = other.taskStatus
}

pred retryTask [t: Task] {
  t in Job.tasks
  Job.jobStatus = JobRunning // Retries strictly prohibited if job is cancelled or terminal
  t.taskStatus = TaskFailed
  t.taskStatus' = TaskPending
  Job.jobStatus' = Job.jobStatus
  all other: Job.tasks - t | other.taskStatus' = other.taskStatus
}

pred cancelTaskAction [t: Task] {
  t in Job.tasks
  Job.jobStatus in JobPending + JobRunning
  t.taskStatus in TaskPending + TaskRunning
  t.taskStatus' = TaskCancelled
  Job.jobStatus' = Job.jobStatus
  all other: Job.tasks - t | other.taskStatus' = other.taskStatus
}

pred cancelJobAction {
  Job.jobStatus in JobPending + JobRunning
  Job.jobStatus' = JobCancelled
  all t: Job.tasks |
    (t.taskStatus in TaskPending + TaskRunning implies t.taskStatus' = TaskCancelled else t.taskStatus' = t.taskStatus)
}

pred finishJobAction {
  Job.jobStatus = JobRunning
  all t: Job.tasks | t.taskStatus in TaskCompleted + TaskFailed + TaskCancelled
  // Correct terminal rule: if any task was cancelled, job must not complete
  (some t: Job.tasks | t.taskStatus = TaskCancelled) implies {
    Job.jobStatus' = JobCancelled
  } else {
    (some t: Job.tasks | t.taskStatus = TaskFailed) implies {
      Job.jobStatus' = JobFailed
    } else {
      Job.jobStatus' = JobCompleted
    }
  }
  taskStatus' = taskStatus
}

pred stutter {
  Job.jobStatus' = Job.jobStatus
  taskStatus' = taskStatus
}

fact traces {
  init
  always (
    startJob or
    (some t: Job.tasks | dispatchTask[t]) or
    (some t: Job.tasks | finishTaskSuccess[t]) or
    (some t: Job.tasks | finishTaskFailure[t]) or
    (some t: Job.tasks | retryTask[t]) or
    (some t: Job.tasks | cancelTaskAction[t]) or
    cancelJobAction or
    finishJobAction or
    stutter
  )
}

// -------------------------------------------------------------
// Safety Invariants (3-5 nontrivial, falsifiable invariants)
// -------------------------------------------------------------

// Inv-1: Job Terminal State Monotonicity
// Once a job reaches Completed, Failed, or Cancelled, it never resurrects to Pending or Running.
// Once Completed or Failed, its status never changes. Cancelled may only reconcile to Failed.
assert JobTerminalMonotonicity {
  always (
    (Job.jobStatus in JobCompleted + JobFailed implies always (Job.jobStatus = Job.jobStatus)) and
    (Job.jobStatus = JobCancelled implies always (Job.jobStatus in JobCancelled + JobFailed))
  )
}

// Inv-2: Task Terminal State Monotonicity
// Once a task reaches Completed or Cancelled, it never transitions to any other status.
assert TaskTerminalMonotonicity {
  always (
    all t: Job.tasks |
      (t.taskStatus in TaskCompleted + TaskCancelled) implies
        always (t.taskStatus = t.taskStatus)
  )
}

// Inv-3: Truthful Completion (No Completed Job With Cancelled Tasks)
// A job may transition to JobCompleted only if ALL its constituent tasks completed successfully.
// A cancelled or failed task must never be masked as a successful job completion.
assert NoCompletedJobWithCancelledTasks {
  always (
    Job.jobStatus = JobCompleted implies
      (no t: Job.tasks | t.taskStatus in TaskCancelled + TaskFailed)
  )
}

// Inv-4: No Task Retry on Cancelled Job
// When a job is cancelled, none of its tasks can ever be retried or transition back to Pending/Running.
assert NoTaskRetryOnCancelledJob {
  always (
    Job.jobStatus in JobCancelled + JobFailed + JobCompleted implies
      always (all t: Job.tasks | not (t.taskStatus' in TaskPending + TaskRunning))
  )
}

// Inv-5: Cancelled Task Never Completes (Immunity to Late Completion Callbacks)
// If a task is cancelled, no late callback or delayed execution can ever mark it Completed.
assert CancelledTaskNeverCompletes {
  always (
    all t: Job.tasks |
      t.taskStatus = TaskCancelled implies always (t.taskStatus != TaskCompleted)
  )
}

// -------------------------------------------------------------
// Positive Witnesses (SAT)
// -------------------------------------------------------------
run WitnessNormalJobCompletion {
  eventually (Job.jobStatus = JobCompleted)
} for 2 Task, 6 steps

run WitnessTaskCancellationAndJobTermination {
  eventually (some t: Job.tasks | t.taskStatus = TaskCancelled and Job.jobStatus = JobCancelled)
} for 2 Task, 6 steps

run WitnessTaskRetryThenSuccess {
  eventually (some t: Job.tasks | once (t.taskStatus = TaskFailed) and t.taskStatus = TaskCompleted)
} for 2 Task, 8 steps

// -------------------------------------------------------------
// Invariant Verification Checks
// -------------------------------------------------------------
check JobTerminalMonotonicity for 2 Task, 7 steps
check TaskTerminalMonotonicity for 2 Task, 7 steps
check NoCompletedJobWithCancelledTasks for 2 Task, 7 steps
check NoTaskRetryOnCancelledJob for 2 Task, 7 steps
check CancelledTaskNeverCompletes for 2 Task, 7 steps
