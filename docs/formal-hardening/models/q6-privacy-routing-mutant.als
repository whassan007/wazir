// Alloy 6 Negative-Control Mutant: Q6 Pinned Agent & Local-Binary Cloud-Backend Leak
// Defects modeled:
//   1. pinnedTarget bypasses `forbidExternal` / `localOnly` check (checked before privacy gate!).
//   2. CloudQwenAcp treated as local solely because `qwen` binary spawns on localhost despite cloud API key.

open util/boolean

abstract sig DataClassification {}
one sig Public, Sensitive, Secret extends DataClassification {}

abstract sig ExecutionTarget {
  spawnsLocalProcess: one Bool,
  endpointIsLocalLoopback: one Bool
}

one sig LocalOllama, CloudQwenAcp, CodexCli extends ExecutionTarget {}

fact TargetCatalog {
  LocalOllama.spawnsLocalProcess = True
  LocalOllama.endpointIsLocalLoopback = True

  // Spawns local child process `qwen --acp`, but talks over HTTPS to DashScope cloud!
  CloudQwenAcp.spawnsLocalProcess = True
  CloudQwenAcp.endpointIsLocalLoopback = False

  CodexCli.spawnsLocalProcess = True
  CodexCli.endpointIsLocalLoopback = False
}

sig TaskRequest {
  localOnlyFlag: one Bool,
  classification: one DataClassification,
  pinnedTarget: lone ExecutionTarget
}

one sig RouterState {
  var dispatched: TaskRequest -> lone ExecutionTarget
}

pred requiresStrictLocal[req: TaskRequest] {
  req.localOnlyFlag = True or req.classification in (Sensitive + Secret)
}

pred init {
  no RouterState.dispatched
}

// DEFECT 1: Honors pinnedTarget unconditionally!
// DEFECT 2: Confuses spawnsLocalProcess with endpointIsLocalLoopback!
pred buggyRouteTask[req: TaskRequest, chosen: ExecutionTarget] {
  no RouterState.dispatched[req]
  (some req.pinnedTarget) implies {
    chosen = req.pinnedTarget
  } else {
    requiresStrictLocal[req] implies chosen.spawnsLocalProcess = True
  }
  RouterState.dispatched' = RouterState.dispatched + (req -> chosen)
}

pred stutter {
  RouterState.dispatched' = RouterState.dispatched
}

fact Trace {
  init
  always ((some req: TaskRequest, t: ExecutionTarget | buggyRouteTask[req, t]) or stutter)
}

assert NoCloudExfiltrationForSensitiveOrLocalOnly {
  always (
    all req: TaskRequest, t: ExecutionTarget |
      (req -> t in RouterState.dispatched and requiresStrictLocal[req]) implies
        t.endpointIsLocalLoopback = True
  )
}

run WitnessAnyDispatch {
  eventually (some RouterState.dispatched)
} for 2 TaskRequest, 3 steps

check NoCloudExfiltrationForSensitiveOrLocalOnly for 2 TaskRequest, 3 steps
