// Wazir Hardening Campaign - Agent A17
// Model Availability & Routing Stickiness Formal Model (Defect Mutant Specification)
// File: tests/formal-hardening/models/a17-routing-stickiness-mutant.als
//
// Invariant: "A fallback model must satisfy the original task's authorization,
// capability, privacy, context, and resource constraints, and stickiness across
// turns and resumption must never revert to abandoned or failed models."
//
// This mutant model introduces the 4 verified production defects:
// 1. Unhandled turn timeout/stream abort crashes turn loop (PhaseCrashed)
// 2. Disallowed fallback guard bypassed when defaultModel omitted (Task.allowFallback = False violated)
// 3. Model escalation fails to persist to durable storage (durableModel is not updated on escalation)
// 4. Sub-requirement context model admitted on fallback without context expansion

module a17_routing_stickiness_mutant

open util/ordering[ContextTier] as co

abstract sig Bool {}
one sig True, False extends Bool {}

abstract sig HealthState {}
one sig Healthy, Failed, Unavailable extends HealthState {}

abstract sig ContextTier {}
one sig ContextSmall, ContextMedium, ContextLarge extends ContextTier {}

sig Model {
  isLocal: one Bool,
  toolCalling: one Bool,
  contextTier: one ContextTier,
  var health: one HealthState,
  var circuitOpen: one Bool
}

sig Task {
  localOnly: one Bool,
  toolCallingReq: one Bool,
  minContextTier: one ContextTier,
  allowFallback: one Bool,
  allowedModels: set Model
}

abstract sig Phase {}
one sig PhaseIdle, PhaseRunning, PhaseTimedOut, PhaseCompleted, PhaseFailedClosed, PhaseCrashed extends Phase {}

one sig ExecutionState {
  task: one Task,
  var phase: one Phase,
  var inMemoryModel: lone Model,
  var durableModel: lone Model,
  var triedModels: set Model
}

// Defect Mutant: Context tier requirement omitted on fallback (P1-A17-05)
pred modelSatisfiesTaskMutated[m: Model, t: Task] {
  // Authorization constraint
  (m in t.allowedModels)
  // Privacy & locality constraint
  and (t.localOnly = True implies m.isLocal = True)
  // Capability constraint
  and (t.toolCallingReq = True implies m.toolCalling = True)
  // BUG P1-A17-05: ContextTier check omitted because model is stamped READY_NOW!
  // and (co/gte[m.contextTier, t.minContextTier])  <-- OMITTED
  and (m.health = Healthy)
  and (m.circuitOpen = False)
}

pred modelSatisfiesTaskStrict[m: Model, t: Task] {
  (m in t.allowedModels)
  and (t.localOnly = True implies m.isLocal = True)
  and (t.toolCallingReq = True implies m.toolCalling = True)
  and (co/gte[m.contextTier, t.minContextTier])
  and (m.health = Healthy)
  and (m.circuitOpen = False)
}

pred frameModelsExcept[mModified: set Model] {
  all m: Model - mModified {
    m.health' = m.health
    m.circuitOpen' = m.circuitOpen
  }
}

pred init {
  ExecutionState.phase = PhaseIdle
  no ExecutionState.inMemoryModel
  no ExecutionState.durableModel
  no ExecutionState.triedModels
  all m: Model | m.circuitOpen = False
}

pred dispatchInitial[m: Model] {
  ExecutionState.phase = PhaseIdle
  no ExecutionState.inMemoryModel
  modelSatisfiesTaskStrict[m, ExecutionState.task]

  ExecutionState.phase' = PhaseRunning
  ExecutionState.inMemoryModel' = m
  ExecutionState.durableModel' = m
  ExecutionState.triedModels' = m

  frameModelsExcept[none]
}

pred turnSuccess {
  ExecutionState.phase = PhaseRunning
  some m: ExecutionState.inMemoryModel {
    ExecutionState.phase' = PhaseCompleted
    ExecutionState.inMemoryModel' = m
    ExecutionState.durableModel' = ExecutionState.durableModel
    ExecutionState.triedModels' = ExecutionState.triedModels
    frameModelsExcept[none]
  }
}

// BUG P1-A17-01: Turn timeout abort throws unhandled 'Request cancelled' error, crashing the turn loop
pred handleTimeoutMutated {
  ExecutionState.phase = PhaseRunning
  some m: ExecutionState.inMemoryModel {
    ExecutionState.phase' = PhaseCrashed
    ExecutionState.inMemoryModel' = m
    ExecutionState.durableModel' = ExecutionState.durableModel
    ExecutionState.triedModels' = ExecutionState.triedModels
    frameModelsExcept[none]
  }
}

pred markFailure {
  ExecutionState.phase = PhaseRunning
  some mCurr: ExecutionState.inMemoryModel {
    mCurr.health' = Failed
    mCurr.circuitOpen' = True
    all m: Model - mCurr {
      m.health' = m.health
      m.circuitOpen' = m.circuitOpen
    }
    ExecutionState.phase' = PhaseRunning
    ExecutionState.inMemoryModel' = mCurr
    ExecutionState.durableModel' = ExecutionState.durableModel
    ExecutionState.triedModels' = ExecutionState.triedModels
  }
}

// BUGS P1-A17-03, P1-A17-04, P1-A17-05:
// - allowFallback check omitted (P1-A17-03)
// - durableModel is NOT updated (P1-A17-04)
// - modelSatisfiesTaskMutated omits context check (P1-A17-05)
pred escalateModelMutated[mNext: Model] {
  ExecutionState.phase = PhaseRunning
  some mCurr: ExecutionState.inMemoryModel {
    (mCurr.health != Healthy or mCurr.circuitOpen = True)
    // BUG P1-A17-03: allowFallback constraint missing when defaultModel omitted!
    // ExecutionState.task.allowFallback = True  <-- OMITTED

    not (mNext in ExecutionState.triedModels)
    // BUG P1-A17-05: Context check omitted
    modelSatisfiesTaskMutated[mNext, ExecutionState.task]

    ExecutionState.phase' = PhaseRunning
    ExecutionState.inMemoryModel' = mNext
    // BUG P1-A17-04: durableModel is NOT updated on escalation (only in-memory route changes)
    ExecutionState.durableModel' = ExecutionState.durableModel
    ExecutionState.triedModels' = ExecutionState.triedModels + mNext

    frameModelsExcept[none]
  }
}

pred failClosed {
  ExecutionState.phase = PhaseRunning
  some mCurr: ExecutionState.inMemoryModel {
    (mCurr.health != Healthy or mCurr.circuitOpen = True)
    ExecutionState.phase' = PhaseFailedClosed
    ExecutionState.inMemoryModel' = mCurr
    ExecutionState.durableModel' = ExecutionState.durableModel
    ExecutionState.triedModels' = ExecutionState.triedModels
    frameModelsExcept[none]
  }
}

pred resumeFromDurable {
  ExecutionState.phase = PhaseRunning
  some mDurable: ExecutionState.durableModel {
    ExecutionState.phase' = PhaseRunning
    // Resume reinstantiates from stale durableModel!
    ExecutionState.inMemoryModel' = mDurable
    ExecutionState.durableModel' = mDurable
    ExecutionState.triedModels' = ExecutionState.triedModels
    frameModelsExcept[none]
  }
}

pred stutter {
  (ExecutionState.phase in PhaseCompleted + PhaseFailedClosed + PhaseCrashed)
  ExecutionState.phase' = ExecutionState.phase
  ExecutionState.inMemoryModel' = ExecutionState.inMemoryModel
  ExecutionState.durableModel' = ExecutionState.durableModel
  ExecutionState.triedModels' = ExecutionState.triedModels
  frameModelsExcept[none]
}

pred transitions {
  init
  and (always (
    (some m: Model | dispatchInitial[m])
    or turnSuccess
    or handleTimeoutMutated
    or markFailure
    or (some mNext: Model | escalateModelMutated[mNext])
    or failClosed
    or resumeFromDurable
    or stutter
  ))
}

// ==================== MUTANT VERIFICATION CHECKS ====================

// Check 1: Fallback Violates Context Constraint (P1-A17-05) -> EXPECT SAT (Counterexample Found)
assert FallbackPreservesAllConstraints {
  transitions implies always (
    all m: ExecutionState.inMemoryModel {
      (ExecutionState.phase = PhaseRunning or ExecutionState.phase = PhaseCompleted)
      implies (
        m in ExecutionState.task.allowedModels
        and (ExecutionState.task.localOnly = True implies m.isLocal = True)
        and (ExecutionState.task.toolCallingReq = True implies m.toolCalling = True)
        and co/gte[m.contextTier, ExecutionState.task.minContextTier]
      )
    }
  )
}

// Check 2: Routing Stickiness Violated on Resumption (P1-A17-04) -> EXPECT SAT (Counterexample Found)
assert RoutingStickinessPreserved {
  transitions implies always (
    all m: ExecutionState.triedModels {
      (m.health = Failed or m.circuitOpen = True) implies (
        always (
          (ExecutionState.inMemoryModel != m)
          implies always (ExecutionState.inMemoryModel != m)
        )
      )
    }
  )
}

// Check 3: Disallowed Fallback Violated (P1-A17-03) -> EXPECT SAT (Counterexample Found)
assert DisallowedFallbackFailsClosed {
  transitions implies always (
    (ExecutionState.task.allowFallback = False and some ExecutionState.inMemoryModel) implies (
      always (
        all m: ExecutionState.inMemoryModel |
          m in ExecutionState.triedModels - (ExecutionState.triedModels - ExecutionState.durableModel)
      )
    )
  )
}

// Check 4: Timeout Crashes Turn Loop (P1-A17-01) -> EXPECT SAT (Counterexample Found)
assert TimeoutDoesNotCrash {
  transitions implies always (
    ExecutionState.phase != PhaseCrashed
  )
}

check FallbackPreservesAllConstraints for 6 steps, 1 Task, 3 Model
check RoutingStickinessPreserved for 6 steps, 1 Task, 3 Model
check DisallowedFallbackFailsClosed for 6 steps, 1 Task, 3 Model
check TimeoutDoesNotCrash for 6 steps, 1 Task, 3 Model
