// Wazir Hardening Campaign - Agent A8
// Formal Model: Provider Routing, Fallback & Privacy Boundaries
// File: /Users/wael/Code/Wazir/docs/formal-hardening/models/a8-routing.als

module a8_routing

open util/ordering[BudgetTier] as bo

abstract sig Bool {}
one sig True, False extends Bool {}

abstract sig HealthState {}
one sig Healthy, Unavailable extends HealthState {}

abstract sig BudgetTier {}
one sig FreeTier, LowCostTier, HighCostTier extends BudgetTier {}

abstract sig Capability {}
one sig ChatCap, ToolCallingCap, VisionCap extends Capability {}

sig Endpoint {
  isLocal: one Bool,
  hasToolCalling: one Bool,
  cost: one BudgetTier,
  var health: one HealthState
}

sig Task {
  isLocalOnly: one Bool,
  isSensitive: one Bool,
  requiresToolCalling: one Bool,
  allowedEndpoints: set Endpoint,
  maxBudget: one BudgetTier
}

abstract sig DispatchPhase {}
one sig Idle, Dispatched, Failed, Completed, TerminatedExhausted extends DispatchPhase {}

one sig RouterState {
  task: one Task,
  var activeEndpoint: lone Endpoint,
  var triedEndpoints: set Endpoint,
  var dispatchPhase: one DispatchPhase,
  var shadowEndpoint: lone Endpoint,
  var liveShadowDispatched: one Bool
}

// Well-formedness predicates
pred endpointEligibleForTask[e: Endpoint, t: Task] {
  // Locality & Privacy Constraint: local-only or sensitive tasks MUST route to local endpoints
  ((t.isLocalOnly = True or t.isSensitive = True) implies e.isLocal = True)
  // Capability Constraint: required tool calling must be supported
  and (t.requiresToolCalling = True implies e.hasToolCalling = True)
  // Authorization Constraint: endpoint must be in approved allowedEndpoints
  and (e in t.allowedEndpoints)
  // Health Constraint: endpoint must be healthy
  and (e.health = Healthy)
  // Budget Constraint: cost must not exceed task max budget
  and (bo/lte[e.cost, t.maxBudget])
}

pred init {
  RouterState.activeEndpoint = none
  RouterState.triedEndpoints = none
  RouterState.dispatchPhase = Idle
  RouterState.shadowEndpoint = none
  RouterState.liveShadowDispatched = False
  // Endpoints begin in valid health states
  all e: Endpoint | e.health in Healthy + Unavailable
}

// Action: Primary Route Selection
pred routePrimary[e: Endpoint] {
  RouterState.dispatchPhase = Idle
  endpointEligibleForTask[e, RouterState.task]
  
  RouterState.activeEndpoint' = e
  RouterState.triedEndpoints' = e
  RouterState.dispatchPhase' = Dispatched
  RouterState.shadowEndpoint' = RouterState.shadowEndpoint
  RouterState.liveShadowDispatched' = RouterState.liveShadowDispatched
  all ep: Endpoint | ep.health' = ep.health
}

// Action: Active Provider Execution Fails (e.g. timeout or infrastructure error)
pred executionFails {
  RouterState.dispatchPhase = Dispatched
  some RouterState.activeEndpoint
  
  // Transition to Failed state to trigger fallback evaluation
  RouterState.dispatchPhase' = Failed
  RouterState.activeEndpoint' = none
  RouterState.triedEndpoints' = RouterState.triedEndpoints
  RouterState.shadowEndpoint' = RouterState.shadowEndpoint
  RouterState.liveShadowDispatched' = RouterState.liveShadowDispatched
  all ep: Endpoint | ep.health' = ep.health
}

// Action: Active Provider Execution Succeeds
pred executionSucceeds {
  RouterState.dispatchPhase = Dispatched
  some RouterState.activeEndpoint
  
  RouterState.dispatchPhase' = Completed
  RouterState.activeEndpoint' = RouterState.activeEndpoint
  RouterState.triedEndpoints' = RouterState.triedEndpoints
  RouterState.shadowEndpoint' = RouterState.shadowEndpoint
  RouterState.liveShadowDispatched' = RouterState.liveShadowDispatched
  all ep: Endpoint | ep.health' = ep.health
}

// Action: Fallback Route Selection
// On primary failure, fallback candidate must be selected strictly enforcing
// the exact same locality, capability, authorization, health and budget constraints.
pred routeFallback[e: Endpoint] {
  RouterState.dispatchPhase = Failed
  e not in RouterState.triedEndpoints
  endpointEligibleForTask[e, RouterState.task]
  
  RouterState.activeEndpoint' = e
  RouterState.triedEndpoints' = RouterState.triedEndpoints + e
  RouterState.dispatchPhase' = Dispatched
  RouterState.shadowEndpoint' = RouterState.shadowEndpoint
  RouterState.liveShadowDispatched' = RouterState.liveShadowDispatched
  all ep: Endpoint | ep.health' = ep.health
}

// Action: Fail Closed when no eligible fallback endpoint remains
pred failClosed {
  RouterState.dispatchPhase = Failed
  no e: Endpoint - RouterState.triedEndpoints | endpointEligibleForTask[e, RouterState.task]
  
  RouterState.dispatchPhase' = TerminatedExhausted
  RouterState.activeEndpoint' = none
  RouterState.triedEndpoints' = RouterState.triedEndpoints
  RouterState.shadowEndpoint' = RouterState.shadowEndpoint
  RouterState.liveShadowDispatched' = RouterState.liveShadowDispatched
  all ep: Endpoint | ep.health' = ep.health
}

// Action: Stutter
pred stutter {
  RouterState.activeEndpoint' = RouterState.activeEndpoint
  RouterState.triedEndpoints' = RouterState.triedEndpoints
  RouterState.dispatchPhase' = RouterState.dispatchPhase
  RouterState.shadowEndpoint' = RouterState.shadowEndpoint
  RouterState.liveShadowDispatched' = RouterState.liveShadowDispatched
  all ep: Endpoint | ep.health' = ep.health
}

fact traces {
  init
  always (
    (some e: Endpoint | routePrimary[e])
    or executionFails
    or executionSucceeds
    or (some e: Endpoint | routeFallback[e])
    or failClosed
    or stutter
  )
}

// ==================== INVARIANTS ====================

// Invariant 1: Local-only / sensitive tasks NEVER route to remote endpoints (even on fallback)
assert FallbackPreservesLocalityAndPrivacy {
  always (
    all e: Endpoint |
      (RouterState.activeEndpoint = e and (RouterState.task.isLocalOnly = True or RouterState.task.isSensitive = True))
        implies e.isLocal = True
  )
}

// Invariant 2: Fallback candidates must satisfy all required task capabilities (e.g. tool calling)
assert FallbackPreservesRequiredCapabilities {
  always (
    all e: Endpoint |
      (RouterState.activeEndpoint = e and RouterState.task.requiresToolCalling = True)
        implies e.hasToolCalling = True
  )
}

// Invariant 3: Fallback candidates must NEVER exceed task maximum budget tier
assert FallbackWithinBudgetLimit {
  always (
    all e: Endpoint |
      (RouterState.activeEndpoint = e)
        implies bo/lte[e.cost, RouterState.task.maxBudget]
  )
}

// Invariant 4: Dispatched endpoints must always be explicitly authorized in task allowedEndpoints
assert RoutingRespectsAllowedEndpoints {
  always (
    all e: Endpoint |
      (RouterState.activeEndpoint = e)
        implies e in RouterState.task.allowedEndpoints
  )
}

// Invariant 5: Routing and fallback never dispatch to an unhealthy or unavailable endpoint
assert NoRoutingToUnhealthyEndpoints {
  always (
    all e: Endpoint |
      (RouterState.activeEndpoint = e)
        implies e.health = Healthy
  )
}

// ==================== WITNESS RUNS ====================

// Witness 1: Valid primary execution and completion
run WitnessHappyPath {
  eventually (RouterState.dispatchPhase = Completed)
} for 5 steps, 1 Task, 3 Endpoint

// Witness 2: Primary failure followed by successful local fallback
run WitnessFallbackSuccess {
  eventually (
    RouterState.dispatchPhase = Failed
    and after (RouterState.dispatchPhase = Dispatched and after (RouterState.dispatchPhase = Completed))
  )
} for 6 steps, 1 Task, 3 Endpoint

// Witness 3: Exhaustion and fail-closed when no fallback candidates satisfy constraints
run WitnessFailClosed {
  eventually (RouterState.dispatchPhase = TerminatedExhausted)
} for 6 steps, 1 Task, 3 Endpoint

// ==================== CHECKS ====================
check FallbackPreservesLocalityAndPrivacy for 6 steps, 1 Task, 3 Endpoint
check FallbackPreservesRequiredCapabilities for 6 steps, 1 Task, 3 Endpoint
check FallbackWithinBudgetLimit for 6 steps, 1 Task, 3 Endpoint
check RoutingRespectsAllowedEndpoints for 6 steps, 1 Task, 3 Endpoint
check NoRoutingToUnhealthyEndpoints for 6 steps, 1 Task, 3 Endpoint
