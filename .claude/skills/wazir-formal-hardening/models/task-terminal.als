// Alloy 6 temporal abstraction: task cancellation must be terminal.
// MODEL TEMPLATE — run in Alloy Analyzer before treating it as validated.
// Wazir's actual job/task/execution state machines differ; specialize after inspection.
abstract sig Status {}
one sig Pending, Running, Completed, Cancelled extends Status {}
one sig Task { var status: one Status }

pred init { Task.status = Pending }
pred start { Task.status = Pending and Task.status' = Running }
pred finish { Task.status = Running and Task.status' = Completed }
pred cancel {
  Task.status in Pending + Running
  Task.status' = Cancelled
}
pred stutter { Task.status' = Task.status }

fact traces { init and always (start or finish or cancel or stutter) }

assert CancelledNeverResurrects {
  always ((Task.status = Cancelled) implies (after (Task.status = Cancelled)))
}
assert CompletedNeverResurrects {
  always ((Task.status = Completed) implies (after (Task.status = Completed)))
}
run { eventually (Task.status = Cancelled) } for 5 steps
run { eventually (Task.status = Completed) } for 5 steps
check CancelledNeverResurrects for 5 steps
check CompletedNeverResurrects for 5 steps
