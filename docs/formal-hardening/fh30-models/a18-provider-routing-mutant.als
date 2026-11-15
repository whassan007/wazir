// Wazir Hardening Campaign - Agent A18
// Negative Control Mutant: Provider Routing & Fallback
// File: tests/formal-hardening/models/a18-provider-routing-mutant.als
//
// MUTATION: In routeFallbackMutated, the locality/privacy and context constraints
// are omitted from fallback eligibility, reflecting a production defect where
// fallback routing relaxes task safety boundaries after primary failure.
// EXPECTED VERDICT: Counterexample found for FallbackSatisfiesAllTaskConstraints
// and FallbackPreservesLocalityAndPrivacy.

module a18_provider_routing_mutant

open util/ordering[BudgetTier] as bo
open util/ordering[ContextTier] as co

abstract sig Bool {}
one sig True, False extends Bool {}

abstract sig HealthState {}
one sig Healthy, Unavailable extends HealthState {}

abstract sig BudgetTier {}
one sig FreeTier, LowCostTier, HighCostTier extends BudgetTier {}

abstract sig ContextTier {}
one sig ContextSmall, ContextMedium, ContextLarge extends ContextTier {}

sig Endpoint {
  isLocal: one Bool,
  hasToolCalling: one Bool,
  cost: one BudgetTier,
  contextTier: one ContextTier,
  var health: one HealthState
}

sig Task {
  isLocalOnly: one Bool,
  isSensitive: one Bool,
  requiresToolCalling: one Bool,
  minContextTier: one ContextTier,
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
  and (co/gte[e.contextTier, t.minContextTier])
  and (e in t.allowedEndpoints)
  and (e.health = Healthy)
  and (bo/lte[e.cost, t.maxBudget])
}

// MUTATED: Relaxed fallback eligibility that ignores locality/privacy and context constraints!
pred mutatedFallbackEligible[e: Endpoint, t: Task] {
  // BUG: Locality/privacy and context constraints omitted on fallback!
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

// Action: Mutated Fallback Route Selection (violates locality/privacy and context)
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

assert FallbackSatisfiesAllTaskConstraints {
  always (
    all e: Endpoint |
      (RouterState.activeEndpoint = e) implies (
        ((RouterState.task.isLocalOnly = True or RouterState.task.isSensitive = True) implies e.isLocal = True)
        and (RouterState.task.requiresToolCalling = True implies e.hasToolCalling = True)
        and (co/gte[e.contextTier, RouterState.task.minContextTier])
        and (e in RouterState.task.allowedEndpoints)
        and (bo/lte[e.cost, RouterState.task.maxBudget])
        and (e.health = Healthy)
      )
  )
}

assert FallbackPreservesLocalityAndPrivacy {
  always (
    all e: Endpoint |
      (RouterState.activeEndpoint = e and (RouterState.task.isLocalOnly = True or RouterState.task.isSensitive = True))
        implies e.isLocal = True
  )
}

check FallbackSatisfiesAllTaskConstraints for 6 steps, 1 Task, 3 Endpoint
check FallbackPreservesLocalityAndPrivacy for 6 steps, 1 Task, 3 Endpoint
