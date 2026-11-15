module a19_resource_scheduling

/*
 * Alloy 6 Formal Model: Resource Admission, Reservations & Concurrent Scheduling
 * Workstream: GROUP G (P1)
 * Target: ModelLifecycleService, ComputerRegistry, Scheduler
 */

abstract sig Model {
  ram: Int,
  vram: Int
}

one sig ModelA, ModelB, ModelVictim extends Model {}

var sig Loaded in Model {}
var sig Pinned in Model {}
var sig ActiveExecution in Model {}
var sig Reserved in Model {}
var sig Settled in Model {}

// Resource bounds (in normalized discrete units)
fun ramCap: Int { 6 }
fun vramCap: Int { 4 }

fun committedRam: Int {
  (sum m: Loaded | m.ram) + (sum m: Reserved | m.ram)
}

fun committedVram: Int {
  (sum m: Loaded | m.vram) + (sum m: Reserved | m.vram)
}

pred init {
  no Loaded
  no Pinned
  no ActiveExecution
  no Reserved
  no Settled
}

// Model weights specification
fact ModelWeights {
  ModelA.ram = 2 and ModelA.vram = 3
  ModelB.ram = 2 and ModelB.vram = 3
  ModelVictim.ram = 2 and ModelVictim.vram = 2
}

// Synchronous safe load (ideal reference)
pred safeReserveAndLoad[m: Model] {
  m not in Loaded + Reserved
  // Must respect both RAM and VRAM capacity
  plus[committedRam, m.ram] =< ramCap
  plus[committedVram, m.vram] =< vramCap
  Reserved' = Reserved + m
  Loaded' = Loaded
  Pinned' = Pinned
  ActiveExecution' = ActiveExecution
  Settled' = Settled
}

pred completeLoad[m: Model] {
  m in Reserved
  Reserved' = Reserved - m
  Loaded' = Loaded + m
  Settled' = Settled + m
  Pinned' = Pinned
  ActiveExecution' = ActiveExecution
}

pred pin[m: Model] {
  m in Loaded
  Pinned' = Pinned + m
  Loaded' = Loaded
  Reserved' = Reserved
  ActiveExecution' = ActiveExecution
  Settled' = Settled
}

pred startExecution[m: Model] {
  m in Loaded
  ActiveExecution' = ActiveExecution + m
  Loaded' = Loaded
  Pinned' = Pinned
  Reserved' = Reserved
  Settled' = Settled
}

pred finishExecution[m: Model] {
  m in ActiveExecution
  ActiveExecution' = ActiveExecution - m
  Loaded' = Loaded
  Pinned' = Pinned
  Reserved' = Reserved
  Settled' = Settled
}

pred safeEvict[m: Model] {
  m in Loaded
  m not in Pinned
  m not in ActiveExecution
  Loaded' = Loaded - m
  Settled' = Settled - m
  Pinned' = Pinned
  Reserved' = Reserved
  ActiveExecution' = ActiveExecution
}

pred stutter {
  Loaded' = Loaded
  Pinned' = Pinned
  ActiveExecution' = ActiveExecution
  Reserved' = Reserved
  Settled' = Settled
}

fact SystemTransitions {
  init
  always (
    (some m: Model | safeReserveAndLoad[m]) or
    (some m: Model | completeLoad[m]) or
    (some m: Model | pin[m]) or
    (some m: Model | startExecution[m]) or
    (some m: Model | finishExecution[m]) or
    (some m: Model | safeEvict[m]) or
    stutter
  )
}

// Safety Invariant: Total committed resources must never exceed capacity
assert TotalCommittedWithinCapacity {
  always (committedRam =< ramCap and committedVram =< vramCap)
}

// Safety Invariant: Active models must never be evicted
assert ActiveModelNeverEvicted {
  always (ActiveExecution in Loaded)
}

// Safety Invariant: Pinned models remain loaded
assert PinnedModelRemainsLoaded {
  always (Pinned in Loaded)
}

run WitnessNormalLifecycle {
  eventually (some ActiveExecution and some Pinned)
} for 3 Model, 5 Int, 8 steps

check TotalCommittedWithinCapacity for 3 Model, 5 Int, 8 steps
check ActiveModelNeverEvicted for 3 Model, 5 Int, 8 steps
check PinnedModelRemainsLoaded for 3 Model, 5 Int, 8 steps
