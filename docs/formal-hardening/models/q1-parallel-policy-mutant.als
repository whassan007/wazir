// Alloy 6 Negative-Control Mutant: Q1 Parallel Tool Batch Defect
// Defect modeled: Naive Promise.all batch runner dispatches all non-denied calls in parallel
// before waiting for Ask approvals and without serializing mutating calls.

open util/boolean

abstract sig PolicyDecision {}
one sig Allow, Ask, Deny extends PolicyDecision {}

abstract sig CallStatus {}
one sig Queued, AwaitingApproval, Executing, Completed, Rejected extends CallStatus {}

abstract sig ToolCall {
  isMutating: one Bool,
  policy: one PolicyDecision
}

one sig ReadCallA, ReadCallB, EditCall, AskShellCall, DenyEscapeCall extends ToolCall {}

fact CallCatalog {
  ReadCallA.isMutating = False
  ReadCallA.policy = Allow
  ReadCallB.isMutating = False
  ReadCallB.policy = Allow
  EditCall.isMutating = True
  EditCall.policy = Allow
  AskShellCall.isMutating = True
  AskShellCall.policy = Ask
  DenyEscapeCall.isMutating = True
  DenyEscapeCall.policy = Deny
}

one sig Scheduler {
  var status: ToolCall -> one CallStatus,
  var approved: set ToolCall
}

pred init {
  all c: ToolCall |
    (c.policy = Deny implies Scheduler.status[c] = Rejected else Scheduler.status[c] = Queued)
  no Scheduler.approved
}

// DEFECT: Launches arbitrary batch of Queued calls via Promise.all without Ask gate or mutation lock!
pred buggyStartBatch[batch: set ToolCall] {
  some batch
  all c: batch | Scheduler.status[c] = Queued
  Scheduler.approved' = Scheduler.approved
  Scheduler.status' = Scheduler.status ++ (batch -> Executing)
}

pred stutter {
  Scheduler.status' = Scheduler.status
  Scheduler.approved' = Scheduler.approved
}

fact Trace {
  init
  always ((some c1, c2: ToolCall | buggyStartBatch[c1 + c2]) or stutter)
}

assert NeverExecuteUnapprovedAsk {
  always (all c: ToolCall |
    (c.policy = Ask and Scheduler.status[c] in (Executing + Completed)) implies c in Scheduler.approved)
}

assert MutatingCallsStrictlySerialized {
  always (all c: ToolCall |
    (Scheduler.status[c] = Executing and c.isMutating = True) implies
      (no other: ToolCall - c | Scheduler.status[other] = Executing))
}

run WitnessAnyExecution {
  eventually (Scheduler.status[EditCall] = Executing)
} for 4 steps

check NeverExecuteUnapprovedAsk for 4 steps
check MutatingCallsStrictlySerialized for 4 steps
