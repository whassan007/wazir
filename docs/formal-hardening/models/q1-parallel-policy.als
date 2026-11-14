// Alloy 6 Formal Hardening Model: Q1 Parallel Tool Batch & Policy Serialization
// Subsystem: packages/agents/src/qwenCore/coreToolScheduler.ts & policyEngine.ts
// Verifies that WazirQwenAgent's CoreToolScheduler:
//   1. Never executes a DENIED tool call.
//   2. Never executes an ASK tool call without explicit human approval.
//   3. Allows parallel execution ONLY for pure read-only ALLOW tool calls.
//   4. Strictly serializes mutating tool calls (at most one mutating call Executing at once,
//      and never concurrently with any other Executing call).

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
    (c.policy = Deny implies Scheduler.status[c] = Rejected) and
    (c.policy = Ask implies Scheduler.status[c] = AwaitingApproval) and
    (c.policy = Allow implies Scheduler.status[c] = Queued)
  no Scheduler.approved
}

pred grantApproval[c: ToolCall] {
  Scheduler.status[c] = AwaitingApproval
  c.policy = Ask
  Scheduler.approved' = Scheduler.approved + c
  Scheduler.status' = Scheduler.status ++ (c -> Queued)
}

pred denyApproval[c: ToolCall] {
  Scheduler.status[c] = AwaitingApproval
  Scheduler.approved' = Scheduler.approved
  Scheduler.status' = Scheduler.status ++ (c -> Rejected)
}

// Launch one or more read-only calls concurrently ONLY when no mutating call is executing
pred startReadBatch[batch: set ToolCall] {
  some batch
  all c: batch | {
    c.isMutating = False
    c.policy != Deny
    (c.policy = Ask implies c in Scheduler.approved)
    Scheduler.status[c] = Queued
  }
  no c: ToolCall | Scheduler.status[c] = Executing and c.isMutating = True
  Scheduler.approved' = Scheduler.approved
  Scheduler.status' = Scheduler.status ++ (batch -> Executing)
}

// Launch a single mutating call ONLY when NO other call is currently executing
pred startMutatingExclusive[c: ToolCall] {
  c.isMutating = True
  c.policy != Deny
  (c.policy = Ask implies c in Scheduler.approved)
  Scheduler.status[c] = Queued
  no other: ToolCall | Scheduler.status[other] = Executing
  Scheduler.approved' = Scheduler.approved
  Scheduler.status' = Scheduler.status ++ (c -> Executing)
}

pred completeCalls[done: set ToolCall] {
  some done
  all c: done | Scheduler.status[c] = Executing
  Scheduler.approved' = Scheduler.approved
  Scheduler.status' = Scheduler.status ++ (done -> Completed)
}

pred stutter {
  Scheduler.status' = Scheduler.status
  Scheduler.approved' = Scheduler.approved
}

fact Trace {
  init
  always (
    (some c: ToolCall | grantApproval[c]) or
    (some c: ToolCall | denyApproval[c]) or
    (some c1, c2: ToolCall | startReadBatch[c1 + c2]) or
    (some c: ToolCall | startMutatingExclusive[c]) or
    (some d1, d2: ToolCall | completeCalls[d1 + d2]) or
    stutter
  )
}

assert NeverExecuteDenied {
  always (all c: ToolCall | c.policy = Deny implies Scheduler.status[c] not in (Executing + Completed))
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

assert NoConcurrentMutationAndUnapprovedAsk {
  always (
    (some c: ToolCall | Scheduler.status[c] = Executing and c.isMutating = True) implies
      (no u: ToolCall | Scheduler.status[u] = Executing and u.policy = Ask and u not in Scheduler.approved)
  )
}

// Positive non-vacuity witnesses
run WitnessParallelReadBatch {
  eventually (Scheduler.status[ReadCallA] = Executing and Scheduler.status[ReadCallB] = Executing)
} for 6 steps

run WitnessApprovedMutatingAfterReads {
  eventually (
    Scheduler.status[ReadCallA] = Completed and
    Scheduler.status[AskShellCall] = Completed
  )
} for 7 steps

check NeverExecuteDenied for 7 steps
check NeverExecuteUnapprovedAsk for 7 steps
check MutatingCallsStrictlySerialized for 7 steps
check NoConcurrentMutationAndUnapprovedAsk for 7 steps
