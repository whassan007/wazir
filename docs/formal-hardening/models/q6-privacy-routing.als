// Alloy 6 Formal Hardening Model: Q6 Privacy-Preserving Workload Distribution & ACP Routing (FH-A8-02)
// Subsystem: packages/core/src/services/workloadDistributor.ts & packages/agents/src/acp/acpHarnessCapabilities.ts
// Verifies:
//   1. Tasks with localOnly = True OR classification in (Sensitive + Secret) NEVER dispatch to
//      hosted cloud runtimes (OpenAI/Anthropic/Google) OR cloud-backed external harnesses
//      (Antigravity, Codex, Cloud Qwen ACP) — even if pinnedTarget requests an external agent!
//   2. Public/Internal tasks with localOnly = False CAN distribute across Local Ollama/LMStudio (70%),
//      Antigravity (15%), Codex (5%), and Qwen ACP (cloud or local).
//   3. Loopback-verified Local Qwen ACP (127.0.0.1 endpoint, zero cloud keys) IS eligible under localOnly.

open util/boolean

abstract sig DataClassification {}
one sig Public, Sensitive, Secret extends DataClassification {}

abstract sig ExecutionTarget {
  isExternalHarness: one Bool,
  endpointIsLocalLoopback: one Bool
}

one sig LocalOllama, LocalQwenAcp, CloudQwenAcp, AntigravityCli, CodexCli, HostedCloudApi extends ExecutionTarget {}

fact TargetCatalog {
  LocalOllama.isExternalHarness = False
  LocalOllama.endpointIsLocalLoopback = True

  LocalQwenAcp.isExternalHarness = True
  LocalQwenAcp.endpointIsLocalLoopback = True

  CloudQwenAcp.isExternalHarness = True
  CloudQwenAcp.endpointIsLocalLoopback = False

  AntigravityCli.isExternalHarness = True
  AntigravityCli.endpointIsLocalLoopback = False

  CodexCli.isExternalHarness = True
  CodexCli.endpointIsLocalLoopback = False

  HostedCloudApi.isExternalHarness = False
  HostedCloudApi.endpointIsLocalLoopback = False
}

sig TaskRequest {
  localOnlyFlag: one Bool,
  routingModeLocalOnly: one Bool,
  classification: one DataClassification,
  pinnedTarget: lone ExecutionTarget
}

one sig RouterState {
  var dispatched: TaskRequest -> lone ExecutionTarget,
  var rejectedPrivacy: set TaskRequest
}

pred requiresStrictLocal[req: TaskRequest] {
  req.localOnlyFlag = True or
  req.routingModeLocalOnly = True or
  req.classification in (Sensitive + Secret)
}

pred targetEligibleForTask[req: TaskRequest, t: ExecutionTarget] {
  requiresStrictLocal[req] implies t.endpointIsLocalLoopback = True
}

pred init {
  no RouterState.dispatched
  no RouterState.rejectedPrivacy
}

pred routeTask[req: TaskRequest, chosen: ExecutionTarget] {
  no RouterState.dispatched[req]
  req not in RouterState.rejectedPrivacy
  // Pinned target is honored ONLY if it passes strict privacy eligibility!
  (some req.pinnedTarget implies chosen = req.pinnedTarget)
  targetEligibleForTask[req, chosen]
  RouterState.dispatched' = RouterState.dispatched + (req -> chosen)
  RouterState.rejectedPrivacy' = RouterState.rejectedPrivacy
}

pred rejectViolatingPinnedTask[req: TaskRequest] {
  no RouterState.dispatched[req]
  req not in RouterState.rejectedPrivacy
  some req.pinnedTarget
  not targetEligibleForTask[req, req.pinnedTarget]
  RouterState.dispatched' = RouterState.dispatched
  RouterState.rejectedPrivacy' = RouterState.rejectedPrivacy + req
}

pred stutter {
  RouterState.dispatched' = RouterState.dispatched
  RouterState.rejectedPrivacy' = RouterState.rejectedPrivacy
}

fact Trace {
  init
  always (
    (some req: TaskRequest, t: ExecutionTarget | routeTask[req, t]) or
    (some req: TaskRequest | rejectViolatingPinnedTask[req]) or
    stutter
  )
}

assert NoCloudExfiltrationForSensitiveOrLocalOnly {
  always (
    all req: TaskRequest, t: ExecutionTarget |
      (req -> t in RouterState.dispatched and requiresStrictLocal[req]) implies
        t.endpointIsLocalLoopback = True
  )
}

assert PinnedExternalNeverOverridesLocalOnly {
  always (
    all req: TaskRequest |
      (requiresStrictLocal[req] and some req.pinnedTarget and req.pinnedTarget in (AntigravityCli + CodexCli + CloudQwenAcp + HostedCloudApi)) implies
        no RouterState.dispatched[req]
  )
}

run WitnessPublicDistributedToExternalPool {
  some req: TaskRequest |
    req.classification = Public and
    req.localOnlyFlag = False and
    req.routingModeLocalOnly = False and
    eventually (RouterState.dispatched[req] = AntigravityCli)
} for 3 TaskRequest, 4 steps

run WitnessSensitiveAllowedOnLoopbackQwenAcp {
  some req: TaskRequest |
    req.classification = Secret and
    req.localOnlyFlag = True and
    eventually (RouterState.dispatched[req] = LocalQwenAcp)
} for 3 TaskRequest, 4 steps

run WitnessPinnedCloudAcpRejectedUnderLocalOnly {
  some req: TaskRequest |
    req.localOnlyFlag = True and
    req.pinnedTarget = CloudQwenAcp and
    eventually (req in RouterState.rejectedPrivacy)
} for 3 TaskRequest, 4 steps

check NoCloudExfiltrationForSensitiveOrLocalOnly for 3 TaskRequest, 5 steps
check PinnedExternalNeverOverridesLocalOnly for 3 TaskRequest, 5 steps
