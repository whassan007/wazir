// Alloy 6 negative control mutant for Wazir Resource Reservation & Model Admission Control (A9)
// Deliberately introduces production flaws:
// 1. Eviction ignores pinning status (reproducing async pin gap bug where pinned model is evicted)
// 2. Aborted drain leaves model trapped in StateDraining (reproducing drain timeout bug)

module a9_admission_mutant

abstract sig ModelState {}
one sig StateUnloaded, StateLoading, StateReady, StateDraining, StateUnloading, StateFailed extends ModelState {}

abstract sig CapacityUnit {}
one sig CapA, CapB extends CapacityUnit {}

sig Model {
  reqUnits: some CapacityUnit,
  var currentState: one ModelState
}

one sig Computer {
  totalUnits: set CapacityUnit,
  models: set Model
}

sig Reservation {
  resModel: one Model,
  resUnits: some CapacityUnit
}

sig Execution {
  execModel: one Model
}

var sig Pinned in Model {}
var sig ActiveExecutions in Execution {}
var sig ActiveReservations in Reservation {}
var sig SettledReservations in Reservation {}
var sig ReleasedReservations in Reservation {}

fact StaticTopology {
  Computer.models = Model
  Computer.totalUnits = CapA + CapB
  all r: Reservation | r.resUnits = r.resModel.reqUnits
  all e: Execution | e.execModel in Model
}

pred init {
  no Pinned
  no ActiveExecutions
  no ActiveReservations
  no SettledReservations
  no ReleasedReservations
  all m: Model | m.currentState = StateUnloaded
}

fun committedUnits: set CapacityUnit {
  { u: CapacityUnit | some m: Model | u in m.reqUnits and m.currentState in (StateReady + StateDraining + StateUnloading) }
  +
  { u: CapacityUnit | some r: ActiveReservations - SettledReservations | u in r.resUnits }
}

pred pinModel [m: Model] {
  m not in Pinned
  m.currentState in (StateReady + StateDraining)
  
  Pinned' = Pinned + m
  currentState' = currentState
  ActiveExecutions' = ActiveExecutions
  ActiveReservations' = ActiveReservations
  SettledReservations' = SettledReservations
  ReleasedReservations' = ReleasedReservations
}

pred unpinModel [m: Model] {
  m in Pinned
  
  Pinned' = Pinned - m
  currentState' = currentState
  ActiveExecutions' = ActiveExecutions
  ActiveReservations' = ActiveReservations
  SettledReservations' = SettledReservations
  ReleasedReservations' = ReleasedReservations
}

pred admitAndReserve [m: Model, r: Reservation] {
  m.currentState in (StateUnloaded + StateFailed)
  r.resModel = m
  r not in (ActiveReservations + ReleasedReservations)
  no (committedUnits & r.resUnits)
  r.resUnits in Computer.totalUnits
  
  ActiveReservations' = ActiveReservations + r
  m.currentState' = StateLoading
  all other: Model - m | other.currentState' = other.currentState
  Pinned' = Pinned
  ActiveExecutions' = ActiveExecutions
  SettledReservations' = SettledReservations
  ReleasedReservations' = ReleasedReservations
}

pred loadSuccess [m: Model, r: Reservation] {
  m.currentState = StateLoading
  r in ActiveReservations
  r not in SettledReservations
  r.resModel = m
  
  SettledReservations' = SettledReservations + r
  m.currentState' = StateReady
  all other: Model - m | other.currentState' = other.currentState
  Pinned' = Pinned
  ActiveExecutions' = ActiveExecutions
  ActiveReservations' = ActiveReservations
  ReleasedReservations' = ReleasedReservations
}

pred loadFailure [m: Model, r: Reservation] {
  m.currentState = StateLoading
  r in ActiveReservations
  r not in SettledReservations
  r.resModel = m
  
  ActiveReservations' = ActiveReservations - r
  ReleasedReservations' = ReleasedReservations + r
  m.currentState' = StateFailed
  all other: Model - m | other.currentState' = other.currentState
  Pinned' = Pinned
  ActiveExecutions' = ActiveExecutions
  SettledReservations' = SettledReservations
}

pred startExecution [e: Execution, m: Model] {
  m.currentState = StateReady
  e.execModel = m
  e not in ActiveExecutions
  
  ActiveExecutions' = ActiveExecutions + e
  Pinned' = Pinned
  currentState' = currentState
  ActiveReservations' = ActiveReservations
  SettledReservations' = SettledReservations
  ReleasedReservations' = ReleasedReservations
}

pred completeExecution [e: Execution] {
  e in ActiveExecutions
  
  ActiveExecutions' = ActiveExecutions - e
  Pinned' = Pinned
  currentState' = currentState
  ActiveReservations' = ActiveReservations
  SettledReservations' = SettledReservations
  ReleasedReservations' = ReleasedReservations
}

pred startDrain [m: Model] {
  m.currentState = StateReady
  m not in Pinned
  some e: ActiveExecutions | e.execModel = m
  
  m.currentState' = StateDraining
  all other: Model - m | other.currentState' = other.currentState
  Pinned' = Pinned
  ActiveExecutions' = ActiveExecutions
  ActiveReservations' = ActiveReservations
  SettledReservations' = SettledReservations
  ReleasedReservations' = ReleasedReservations
}

// MUTANT: Drain timeout fails to restore StateReady, leaving model stuck in StateDraining
pred abortDrainTimeoutMutant [m: Model] {
  m.currentState = StateDraining
  some e: ActiveExecutions | e.execModel = m
  
  // Buggy: stays in StateDraining!
  m.currentState' = StateDraining
  all other: Model - m | other.currentState' = other.currentState
  Pinned' = Pinned
  ActiveExecutions' = ActiveExecutions
  ActiveReservations' = ActiveReservations
  SettledReservations' = SettledReservations
  ReleasedReservations' = ReleasedReservations
}

pred completeDrain [m: Model] {
  m.currentState = StateDraining
  no e: ActiveExecutions | e.execModel = m
  
  m.currentState' = StateUnloading
  all other: Model - m | other.currentState' = other.currentState
  Pinned' = Pinned
  ActiveExecutions' = ActiveExecutions
  ActiveReservations' = ActiveReservations
  SettledReservations' = SettledReservations
  ReleasedReservations' = ReleasedReservations
}

pred startUnloadImmediate [m: Model] {
  m.currentState = StateReady
  m not in Pinned
  no e: ActiveExecutions | e.execModel = m
  
  m.currentState' = StateUnloading
  all other: Model - m | other.currentState' = other.currentState
  Pinned' = Pinned
  ActiveExecutions' = ActiveExecutions
  ActiveReservations' = ActiveReservations
  SettledReservations' = SettledReservations
  ReleasedReservations' = ReleasedReservations
}

pred completeUnload [m: Model, r: Reservation] {
  m.currentState = StateUnloading
  no e: ActiveExecutions | e.execModel = m
  r in ActiveReservations
  r.resModel = m
  
  m.currentState' = StateUnloaded
  all other: Model - m | other.currentState' = other.currentState
  ActiveReservations' = ActiveReservations - r
  SettledReservations' = SettledReservations - r
  ReleasedReservations' = ReleasedReservations + r
  Pinned' = Pinned - m
  ActiveExecutions' = ActiveExecutions
}

// MUTANT: Eviction allows evicting a Pinned model!
pred evictModelMutant [victim: Model, r: Reservation] {
  victim.currentState = StateReady
  // Buggy: victim not in Pinned check is omitted!
  no e: ActiveExecutions | e.execModel = victim
  r in ActiveReservations
  r.resModel = victim
  
  victim.currentState' = StateUnloaded
  all other: Model - victim | other.currentState' = other.currentState
  ActiveReservations' = ActiveReservations - r
  SettledReservations' = SettledReservations - r
  ReleasedReservations' = ReleasedReservations + r
  Pinned' = Pinned // model remains pinned in intent, but evicted from runtime!
  ActiveExecutions' = ActiveExecutions
}

pred stutter {
  Pinned' = Pinned
  currentState' = currentState
  ActiveExecutions' = ActiveExecutions
  ActiveReservations' = ActiveReservations
  SettledReservations' = SettledReservations
  ReleasedReservations' = ReleasedReservations
}

fact Transitions {
  init
  always (
    stutter or
    (some m: Model | pinModel[m]) or
    (some m: Model | unpinModel[m]) or
    (some m: Model, r: Reservation | admitAndReserve[m, r]) or
    (some m: Model, r: Reservation | loadSuccess[m, r]) or
    (some m: Model, r: Reservation | loadFailure[m, r]) or
    (some e: Execution, m: Model | startExecution[e, m]) or
    (some e: Execution | completeExecution[e]) or
    (some m: Model | startDrain[m]) or
    (some m: Model | abortDrainTimeoutMutant[m]) or
    (some m: Model | completeDrain[m]) or
    (some m: Model | startUnloadImmediate[m]) or
    (some m: Model, r: Reservation | completeUnload[m, r]) or
    (some victim: Model, r: Reservation | evictModelMutant[victim, r])
  )
}

// Inv-2: Pinned Model Eviction Safety (Expected to FAIL in mutant)
assert NoPinnedModelEviction {
  always (all m: Pinned | m.currentState != StateUnloaded)
}

check NoPinnedModelEviction for 2 Model, 2 Reservation, 2 Execution, 8 steps
