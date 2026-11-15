// Wazir Hardening Campaign - Agent A8
// Negative Control Mutant: Provider Routing & Fallback
// File: /Users/wael/Code/Wazir/docs/formal-hardening/models/a8-routing-mutant.als
//
// MUTATION: In routeFallback, the locality/privacy constraint is omitted,
// reflecting the production bug where fallback routing fails to enforce
// local-only and data-classification constraints when primary local provider fails.
// EXPECTED VERDICT: Counterexample found for FallbackPreservesLocalityAndPrivacy.

module a8_routing_mutant

open util/ordering[BudgetTier] as bo

abstract sig Bool {}
one sig True, False extends Bool {}

abstract sig HealthState {}
one sig Healthy, Unavailable extends HealthState {}

abstract sig BudgetTier {}
one sig FreeTier, LowCostTier, HighCostTier extends BudgetTier {}

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

pred endpointEligibleForTask[e: Endpoint, t: Task] {
  ((t.isLocalOnly = True or t.isSensitive = True) implies e.isLocal = True)
  and (t.requiresToolCalling = True implies e.hasToolCalling = True)
  and (e in t.allowedEndpoints)
  and (e.health = Healthy)
  and (bo/lte[e.cost, t.maxBudget])
}

// MUTATED: Relaxed fallback eligibility that ignores locality/privacy constraints!
pred mutatedFallbackEligible[e: Endpoint, t: Task] {
  // BUG: Locality constraint omitted on fallback!
  (t.requiresToolCalling = True implies e.hasToolCalling = True)
  and (e in t.allowedEndpoints)
  and (e.health = Healthy)
  and (bo/lte[e.cost, t.maxBudget])
}

pred init {
  RouterState.activeEndpoint = none
  RouterState.triedEndpoints = none
  RouterState.dispatchPhase = Idle
  RouterState.shadowEndpoint = none
  RouterState.liveShadowDispatched = False
  all e: Endpoint | e.health in Healthy + Unavailable
}

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

pred executionFails {
  RouterState.dispatchPhase = Dispatched
  some RouterState.activeEndpoint
  
  RouterState.dispatchPhase' = Failed
  RouterState.activeEndpoint' = none
  RouterState.triedEndpoints' = RouterState.triedEndpoints
  RouterState.shadowEndpoint' = RouterState.shadowEndpoint
  RouterState.liveShadowDispatched' = RouterState.liveShadowDispatched
  all ep: Endpoint | ep.health' = ep.health
}

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

// Action: Mutated Fallback Route Selection (violates locality)
pred routeFallbackMutated[e: Endpoint] {
  RouterState.dispatchPhase = Failed
  e not in RouterState.triedEndpoints
  mutatedFallbackEligible[e, RouterState.task]
  
  RouterState.activeEndpoint' = e
  RouterState.triedEndpoints' = RouterState.triedEndpoints + e
  RouterState.dispatchPhase' = Dispatched
  RouterState.shadowEndpoint' = RouterState.shadowEndpoint
  RouterState.liveShadowDispatched' = RouterState.liveShadowDispatched
  all ep: Endpoint | ep.health' = ep.health
}

pred failClosed {
  RouterState.dispatchPhase = Failed
  no e: Endpoint - RouterState.triedEndpoints | mutatedFallbackEligible[e, RouterState.task]
  
  RouterState.dispatchPhase' = TerminatedExhausted
  RouterState.activeEndpoint' = none
  RouterState.triedEndpoints' = RouterState.triedEndpoints
  RouterState.shadowEndpoint' = RouterState.shadowEndpoint
  RouterState.liveShadowDispatched' = RouterState.liveShadowDispatched
  all ep: Endpoint | ep.health' = ep.health
}

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
    or (some e: Endpoint | routeFallbackMutated[e])
    or failClosed
    or stutter
  )
}

assert FallbackPreservesLocalityAndPrivacy {
  always (
    all e: Endpoint |
      (RouterState.activeEndpoint = e and (RouterState.task.isLocalOnly = True or RouterState.task.isSensitive = True))
        implies e.isLocal = True
  )
}

check FallbackPreservesLocalityAndPrivacy for 6 steps, 1 Task, 3 Endpoint
