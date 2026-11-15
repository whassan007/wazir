module a19_resource_scheduling_mutant

/*
 * Alloy 6 Formal Model: Mutant Model Reflecting Wazir Production Concurrency Defects
 * Target: packages/core/src/services/modelLifecycleService.ts, scheduler.ts, computerRegistry.ts
 */

abstract sig Model {
  ram: Int,
  vram: Int
}

one sig ModelA, ModelB extends Model {}

var sig Loaded in Model {}
var sig Pinned in Model {}
var sig ActiveExecution in Model {}
var sig TrackedExecution in Model {}
var sig Reserved in Model {}
var sig Settled in Model {}
var sig TelemetryReported in Model {}

// Resource limits
fun ramCap: Int { 6 }
fun vramCap: Int { 4 }

fun physicalCommittedVram: Int {
  (sum m: Loaded | m.vram) + (sum m: Reserved | m.vram)
}

// Scheduler view: scheduler.ts:865-868 uses computer.load.gpuMemoryAvailableGB (which excludes TelemetryReported)
// minus (r.settledAt ? 0 : r.vramBytes). Settled reservations not yet reported by telemetry are invisible!
fun schedulerPerceivedVram: Int {
  (sum m: TelemetryReported | m.vram) + (sum m: (Reserved - Settled) | m.vram)
}

pred init {
  no Loaded
  no Pinned
  no ActiveExecution
  no TrackedExecution
  no Reserved
  no Settled
  no TelemetryReported
}

fact ModelWeights {
  ModelA.ram = 2 and ModelA.vram = 3
  ModelB.ram = 2 and ModelB.vram = 3
}

// Scheduler admits model because settled reservation is ignored and telemetry has not refreshed
pred schedulerAdmission[m: Model] {
  m not in Loaded + Reserved
  plus[schedulerPerceivedVram, m.vram] =< vramCap
  Reserved' = Reserved + m
  Loaded' = Loaded
  Pinned' = Pinned
  ActiveExecution' = ActiveExecution
  TrackedExecution' = TrackedExecution
  Settled' = Settled
  TelemetryReported' = TelemetryReported
}

pred completeLoadAndSettle[m: Model] {
  m in Reserved
  Reserved' = Reserved - m
  Loaded' = Loaded + m
  Settled' = Settled + m
  Pinned' = Pinned
  ActiveExecution' = ActiveExecution
  TrackedExecution' = TrackedExecution
  TelemetryReported' = TelemetryReported // Telemetry lags behind!
}

pred receiveWorkerHeartbeat[m: Model] {
  m in Loaded
  m not in TelemetryReported
  TelemetryReported' = TelemetryReported + m
  Loaded' = Loaded
  Pinned' = Pinned
  ActiveExecution' = ActiveExecution
  TrackedExecution' = TrackedExecution
  Reserved' = Reserved
  Settled' = Settled
}

pred startUntrackedInference[m: Model] {
  m in Loaded
  m not in ActiveExecution
  ActiveExecution' = ActiveExecution + m
  TrackedExecution' = TrackedExecution
  Loaded' = Loaded
  Pinned' = Pinned
  Reserved' = Reserved
  Settled' = Settled
  TelemetryReported' = TelemetryReported
}

pred evictIgnoringUntracked[m: Model] {
  m in Loaded
  m not in Pinned
  m not in TrackedExecution
  Loaded' = Loaded - m
  Settled' = Settled - m
  TelemetryReported' = TelemetryReported - m
  Pinned' = Pinned
  Reserved' = Reserved
  ActiveExecution' = ActiveExecution
  TrackedExecution' = TrackedExecution
}

pred stutter {
  Loaded' = Loaded
  Pinned' = Pinned
  ActiveExecution' = ActiveExecution
  TrackedExecution' = TrackedExecution
  Reserved' = Reserved
  Settled' = Settled
  TelemetryReported' = TelemetryReported
}

fact Transitions {
  init
  always (
    (some m: Model | schedulerAdmission[m]) or
    (some m: Model | completeLoadAndSettle[m]) or
    (some m: Model | receiveWorkerHeartbeat[m]) or
    (some m: Model | startUntrackedInference[m]) or
    (some m: Model | evictIgnoringUntracked[m]) or
    stutter
  )
}

// Witness: Scheduler overcommits VRAM because settled reservations were discounted before telemetry refresh
run WitnessSchedulerVramOvercommit {
  eventually (physicalCommittedVram > vramCap)
} for 2 Model, 5 Int, 8 steps

// Witness: Active model evicted mid-stream
run WitnessActiveModelEvictedMidStream {
  eventually (some m: Model | m in ActiveExecution and m not in Loaded)
} for 2 Model, 5 Int, 8 steps

// Assertions expected to FAIL on production logic:
assert NoPhysicalOvercommit {
  always (physicalCommittedVram =< vramCap)
}

assert ActiveExecutionNeverEvicted {
  always (ActiveExecution in Loaded)
}

check NoPhysicalOvercommit for 2 Model, 5 Int, 8 steps
check ActiveExecutionNeverEvicted for 2 Model, 5 Int, 8 steps
