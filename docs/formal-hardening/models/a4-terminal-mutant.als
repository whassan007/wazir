// Alloy 6 negative control mutant for Wazir Terminal Status (A4)
// Introduces the EXACT production bug found in packages/core/src/services/jobOrchestrator.ts lines 891-897:
// When all active tasks finish, the orchestrator only checks whether `anyFailed` is true.
// If any task was cancelled (e.g. via cancelTask), but none failed, it blindly calls `finishJob('completed')`.
// This violates the safety invariant `NoCompletedJobWithCancelledTasks`.

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
  Job.jobStatus = JobRunning
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

// Flawed mutant transition corresponding to production bug in jobOrchestrator.ts
pred finishJobActionMutant {
  Job.jobStatus = JobRunning
  all t: Job.tasks | t.taskStatus in TaskCompleted + TaskFailed + TaskCancelled
  // Production flaw: ignores TaskCancelled!
  (some t: Job.tasks | t.taskStatus = TaskFailed) implies {
    Job.jobStatus' = JobFailed
  } else {
    Job.jobStatus' = JobCompleted
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
    finishJobActionMutant or
    stutter
  )
}

assert NoCompletedJobWithCancelledTasks {
  always (
    Job.jobStatus = JobCompleted implies
      (no t: Job.tasks | t.taskStatus in TaskCancelled + TaskFailed)
  )
}

// Expect counterexample demonstrating false completion when task is cancelled
check NoCompletedJobWithCancelledTasks for 2 Task, 6 steps
