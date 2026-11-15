// Intentionally broken negative control. `restart` permits cancelled task to run.
// A counterexample is expected at a sufficient step bound. DO NOT call a production bug.
abstract sig Status {}
one sig Pending, Running, Completed, Cancelled extends Status {}
one sig Task { var status: one Status }
pred init { Task.status = Pending }
pred start { Task.status = Pending and Task.status' = Running }
pred finish { Task.status = Running and Task.status' = Completed }
pred cancel { Task.status in Pending + Running and Task.status' = Cancelled }
pred restart { Task.status = Cancelled and Task.status' = Running }
pred stutter { Task.status' = Task.status }
fact traces { init and always (start or finish or cancel or restart or stutter) }
assert CancelledNeverResurrects {
  always ((Task.status = Cancelled) implies (after (Task.status = Cancelled)))
}
run { eventually (Task.status = Cancelled and after (Task.status = Running)) } for 5 steps
check CancelledNeverResurrects for 5 steps
