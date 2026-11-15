// Wazir Hardening Campaign - Agent A17
// Model Availability & Routing Stickiness Formal Model (Reference Specification)
// File: tests/formal-hardening/models/a17-routing-stickiness.als
//
// Invariant: "A fallback model must satisfy the original task's authorization,
// capability, privacy, context, and resource constraints, and stickiness across
// turns and resumption must never revert to abandoned or failed models."

module a17_routing_stickiness

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

// Model M satisfies all constraints of Task T
pred modelSatisfiesTask[m: Model, t: Task] {
  // Authorization constraint
  (m in t.allowedModels)
  // Privacy & locality constraint
  and (t.localOnly = True implies m.isLocal = True)
  // Capability constraint
  and (t.toolCallingReq = True implies m.toolCalling = True)
  // Context window capacity constraint
  and (co/gte[m.contextTier, t.minContextTier])
  // Health & Circuit Breaker availability
  and (m.health = Healthy)
  and (m.circuitOpen = False)
}

// Frame condition: models preserve health and circuit state unless explicitly modified
pred frameModelsExcept[mModified: set Model] {
  all m: Model - mModified {
    m.health' = m.health
    m.circuitOpen' = m.circuitOpen
  }
}

// Initial state: system is idle, no models tried or bound
pred init {
  ExecutionState.phase = PhaseIdle
  no ExecutionState.inMemoryModel
  no ExecutionState.durableModel
  no ExecutionState.triedModels
  all m: Model | m.circuitOpen = False
}

// Action: Initial Dispatch of primary model
pred dispatchInitial[m: Model] {
  ExecutionState.phase = PhaseIdle
  no ExecutionState.inMemoryModel
  modelSatisfiesTask[m, ExecutionState.task]

  ExecutionState.phase' = PhaseRunning
  ExecutionState.inMemoryModel' = m
  ExecutionState.durableModel' = m
  ExecutionState.triedModels' = m

  frameModelsExcept[none]
}

// Action: Model Turn completes successfully
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

// Action: Handled Timeout - correction prompt injected, engine remains non-crashed
pred handleTimeoutGracefully {
  ExecutionState.phase = PhaseRunning
  some m: ExecutionState.inMemoryModel {
    ExecutionState.phase' = PhaseTimedOut
    ExecutionState.inMemoryModel' = m
    ExecutionState.durableModel' = ExecutionState.durableModel
    ExecutionState.triedModels' = ExecutionState.triedModels
    frameModelsExcept[none]
  }
}

// Action: Resume after handled timeout
pred resumeAfterTimeout {
  ExecutionState.phase = PhaseTimedOut
  some m: ExecutionState.inMemoryModel {
    ExecutionState.phase' = PhaseRunning
    ExecutionState.inMemoryModel' = m
    ExecutionState.durableModel' = ExecutionState.durableModel
    ExecutionState.triedModels' = ExecutionState.triedModels
    frameModelsExcept[none]
  }
}

// Action: Primary or current model fails (stream reset, 5xx, or provider exhaustion)
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

// Action: Escalate / Fallback to compliant alternate model
pred escalateModel[mNext: Model] {
  ExecutionState.phase = PhaseRunning
  some mCurr: ExecutionState.inMemoryModel {
    // Current model is failed or tripped
    (mCurr.health != Healthy or mCurr.circuitOpen = True)
    // Fallback must be explicitly permitted by task policy
    ExecutionState.task.allowFallback = True
    // New model must not have been already tried
    not (mNext in ExecutionState.triedModels)
    // New candidate MUST satisfy all original task constraints
    modelSatisfiesTask[mNext, ExecutionState.task]

    // State transitions:
    ExecutionState.phase' = PhaseRunning
    ExecutionState.inMemoryModel' = mNext
    // In compliant engine: durableModel is updated synchronously to preserve stickiness
    ExecutionState.durableModel' = mNext
    ExecutionState.triedModels' = ExecutionState.triedModels + mNext

    frameModelsExcept[none]
  }
}

// Action: Fail closed when no valid fallback exists or fallback disallowed
pred failClosed {
  ExecutionState.phase = PhaseRunning
  some mCurr: ExecutionState.inMemoryModel {
    (mCurr.health != Healthy or mCurr.circuitOpen = True)
    (
      ExecutionState.task.allowFallback = False
      or (all m: Model - ExecutionState.triedModels | not modelSatisfiesTask[m, ExecutionState.task])
    )
    ExecutionState.phase' = PhaseFailedClosed
    ExecutionState.inMemoryModel' = mCurr
    ExecutionState.durableModel' = ExecutionState.durableModel
    ExecutionState.triedModels' = ExecutionState.triedModels
    frameModelsExcept[none]
  }
}

// Action: Checkpoint Resume / Process Restart
pred resumeFromDurable {
  (ExecutionState.phase = PhaseRunning or ExecutionState.phase = PhaseTimedOut)
  some mDurable: ExecutionState.durableModel {
    ExecutionState.phase' = PhaseRunning
    // Memory model re-instantiated from durable model
    ExecutionState.inMemoryModel' = mDurable
    ExecutionState.durableModel' = mDurable
    ExecutionState.triedModels' = ExecutionState.triedModels
    frameModelsExcept[none]
  }
}

// Stuttering step on terminal states
pred stutter {
  (ExecutionState.phase in PhaseCompleted + PhaseFailedClosed + PhaseCrashed)
  ExecutionState.phase' = ExecutionState.phase
  ExecutionState.inMemoryModel' = ExecutionState.inMemoryModel
  ExecutionState.durableModel' = ExecutionState.durableModel
  ExecutionState.triedModels' = ExecutionState.triedModels
  frameModelsExcept[none]
}

// Transitions relation
pred transitions {
  init
  and (always (
    (some m: Model | dispatchInitial[m])
    or turnSuccess
    or handleTimeoutGracefully
    or resumeAfterTimeout
    or markFailure
    or (some mNext: Model | escalateModel[mNext])
    or failClosed
    or resumeFromDurable
    or stutter
  ))
}

// ==================== WITNESSES ====================

// Witness 1: Happy path completion
run WitnessHappyPath {
  transitions
  and eventually (ExecutionState.phase = PhaseCompleted)
} for 5 steps, 1 Task, 3 Model

// Witness 2: Failure followed by valid fallback escalation and completion
run WitnessFallbackSuccess {
  transitions
  and eventually (
    some m1, m2: Model |
      m1 != m2
      and ExecutionState.inMemoryModel = m1
      and eventually (
        ExecutionState.inMemoryModel = m2
        and eventually (ExecutionState.phase = PhaseCompleted)
      )
  )
} for 7 steps, 1 Task, 3 Model

// Witness 3: Fail closed when allowFallback is False or no models satisfy
run WitnessFailClosed {
  transitions
  and eventually (ExecutionState.phase = PhaseFailedClosed)
} for 6 steps, 1 Task, 3 Model

// ==================== FORMAL INVARIANTS ====================

// Invariant 1: Fallback Preserves All Constraints
assert FallbackPreservesAllConstraints {
  transitions implies always (
    all m: ExecutionState.inMemoryModel {
      (ExecutionState.phase = PhaseRunning or ExecutionState.phase = PhaseCompleted)
      implies (
        // Authorization
        m in ExecutionState.task.allowedModels
        // Privacy / Locality
        and (ExecutionState.task.localOnly = True implies m.isLocal = True)
        // Capability
        and (ExecutionState.task.toolCallingReq = True implies m.toolCalling = True)
        // Context Capacity
        and co/gte[m.contextTier, ExecutionState.task.minContextTier]
      )
    }
  )
}

// Invariant 2: Routing Stickiness Across Resumption
// A resumed execution must never revert to a failed or abandoned model
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

// Invariant 3: Disallowed Fallback Never Dispatches Alternate Model
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

// Invariant 4: No Timeout Induced Turn-Loop Crashes
assert TimeoutDoesNotCrash {
  transitions implies always (
    ExecutionState.phase != PhaseCrashed
  )
}

check FallbackPreservesAllConstraints for 6 steps, 1 Task, 3 Model
check RoutingStickinessPreserved for 6 steps, 1 Task, 3 Model
check DisallowedFallbackFailsClosed for 6 steps, 1 Task, 3 Model
check TimeoutDoesNotCrash for 6 steps, 1 Task, 3 Model
