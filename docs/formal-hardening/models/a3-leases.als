// ==============================================================================
// Wazir Formal Hardening Campaign — Subagent A3
// Model: a3-leases.als
// Domain: Worker Leases & Fenced Commits
// Target: packages/core/src/services/executionEngine.ts
//         packages/core/src/services/recoveryManager.ts
//         packages/core/src/services/jobManager.ts
// Invariants:
//   1. FencedCommitAuthoritativeOnly (Safety)
//   2. StaleWorkerFencedOut (Fencing / Mutual Exclusion)
//   3. ExactlyOneActiveLease (Isolation)
//   4. MonotonicEpochs (Epoch Monotonicity)
//   5. TakeoverBumpsEpoch (Takeover Progress)
// ==============================================================================

abstract sig Worker {}
one sig WorkerA, WorkerB extends Worker {}

abstract sig LeaseStatus {}
one sig Active, Expired, Released extends LeaseStatus {}

abstract sig CommitStatus {}
one sig Uncommitted, Committed extends CommitStatus {}

one sig Execution {
  var holder: lone Worker,
  var status: lone LeaseStatus,
  var epoch: one Int,
  var committedEpoch: one Int,
  var lastCommitter: lone Worker,
  var commitStatus: one CommitStatus,
  // Model in-flight asynchronous operations per worker
  var inFlightEpochA: lone Int,
  var inFlightEpochB: lone Int
}

pred init {
  no Execution.holder
  no Execution.status
  Execution.epoch = 0
  Execution.committedEpoch = 0
  no Execution.lastCommitter
  Execution.commitStatus = Uncommitted
  no Execution.inFlightEpochA
  no Execution.inFlightEpochB
}

// Worker A acquires lease for execution when unassigned or expired/released
pred acquireA {
  Execution.commitStatus = Uncommitted
  (no Execution.holder or Execution.status in Expired + Released)
  let nextEpoch = Execution.epoch.plus[1] {
    Execution.holder' = WorkerA
    Execution.status' = Active
    Execution.epoch' = nextEpoch
    Execution.inFlightEpochA' = nextEpoch
  }
  Execution.committedEpoch' = Execution.committedEpoch
  Execution.lastCommitter' = Execution.lastCommitter
  Execution.commitStatus' = Execution.commitStatus
  Execution.inFlightEpochB' = Execution.inFlightEpochB
}

// Worker B acquires lease for execution when unassigned or expired/released
pred acquireB {
  Execution.commitStatus = Uncommitted
  (no Execution.holder or Execution.status in Expired + Released)
  let nextEpoch = Execution.epoch.plus[1] {
    Execution.holder' = WorkerB
    Execution.status' = Active
    Execution.epoch' = nextEpoch
    Execution.inFlightEpochB' = nextEpoch
  }
  Execution.committedEpoch' = Execution.committedEpoch
  Execution.lastCommitter' = Execution.lastCommitter
  Execution.commitStatus' = Execution.commitStatus
  Execution.inFlightEpochA' = Execution.inFlightEpochA
}

// Active lease expires (e.g. heartbeat timeout or clock progression past TTL)
pred expireLease {
  some Execution.holder
  Execution.status = Active
  Execution.status' = Expired
  Execution.holder' = Execution.holder
  Execution.epoch' = Execution.epoch
  Execution.committedEpoch' = Execution.committedEpoch
  Execution.lastCommitter' = Execution.lastCommitter
  Execution.commitStatus' = Execution.commitStatus
  Execution.inFlightEpochA' = Execution.inFlightEpochA
  Execution.inFlightEpochB' = Execution.inFlightEpochB
}

// Worker A renews its active lease
pred renewA {
  Execution.holder = WorkerA
  Execution.status = Active
  Execution.status' = Active
  Execution.holder' = WorkerA
  Execution.epoch' = Execution.epoch
  Execution.committedEpoch' = Execution.committedEpoch
  Execution.lastCommitter' = Execution.lastCommitter
  Execution.commitStatus' = Execution.commitStatus
  Execution.inFlightEpochA' = Execution.inFlightEpochA
  Execution.inFlightEpochB' = Execution.inFlightEpochB
}

// Worker B renews its active lease
pred renewB {
  Execution.holder = WorkerB
  Execution.status = Active
  Execution.status' = Active
  Execution.holder' = WorkerB
  Execution.epoch' = Execution.epoch
  Execution.committedEpoch' = Execution.committedEpoch
  Execution.lastCommitter' = Execution.lastCommitter
  Execution.commitStatus' = Execution.commitStatus
  Execution.inFlightEpochA' = Execution.inFlightEpochA
  Execution.inFlightEpochB' = Execution.inFlightEpochB
}

// Worker A voluntarily releases its lease
pred releaseA {
  Execution.holder = WorkerA
  Execution.status in Active + Expired
  Execution.status' = Released
  Execution.holder' = WorkerA
  Execution.epoch' = Execution.epoch
  Execution.committedEpoch' = Execution.committedEpoch
  Execution.lastCommitter' = Execution.lastCommitter
  Execution.commitStatus' = Execution.commitStatus
  no Execution.inFlightEpochA'
  Execution.inFlightEpochB' = Execution.inFlightEpochB
}

// Worker B voluntarily releases its lease
pred releaseB {
  Execution.holder = WorkerB
  Execution.status in Active + Expired
  Execution.status' = Released
  Execution.holder' = WorkerB
  Execution.epoch' = Execution.epoch
  Execution.committedEpoch' = Execution.committedEpoch
  Execution.lastCommitter' = Execution.lastCommitter
  Execution.commitStatus' = Execution.commitStatus
  Execution.inFlightEpochA' = Execution.inFlightEpochA
  no Execution.inFlightEpochB'
}

// Worker A performs a lease-fenced commit of result/terminal state
pred fencedCommitA {
  Execution.commitStatus = Uncommitted
  some Execution.inFlightEpochA
  // Strict lease fencing guard: caller must hold current active lease at current epoch
  Execution.holder = WorkerA
  Execution.status = Active
  Execution.epoch = Execution.inFlightEpochA

  Execution.commitStatus' = Committed
  Execution.committedEpoch' = Execution.inFlightEpochA
  Execution.lastCommitter' = WorkerA
  no Execution.inFlightEpochA'
  Execution.holder' = Execution.holder
  Execution.status' = Execution.status
  Execution.epoch' = Execution.epoch
  Execution.inFlightEpochB' = Execution.inFlightEpochB
}

// Worker B performs a lease-fenced commit of result/terminal state
pred fencedCommitB {
  Execution.commitStatus = Uncommitted
  some Execution.inFlightEpochB
  // Strict lease fencing guard: caller must hold current active lease at current epoch
  Execution.holder = WorkerB
  Execution.status = Active
  Execution.epoch = Execution.inFlightEpochB

  Execution.commitStatus' = Committed
  Execution.committedEpoch' = Execution.inFlightEpochB
  Execution.lastCommitter' = WorkerB
  no Execution.inFlightEpochB'
  Execution.holder' = Execution.holder
  Execution.status' = Execution.status
  Execution.epoch' = Execution.epoch
  Execution.inFlightEpochA' = Execution.inFlightEpochA
}

pred stutter {
  Execution.holder' = Execution.holder
  Execution.status' = Execution.status
  Execution.epoch' = Execution.epoch
  Execution.committedEpoch' = Execution.committedEpoch
  Execution.lastCommitter' = Execution.lastCommitter
  Execution.commitStatus' = Execution.commitStatus
  Execution.inFlightEpochA' = Execution.inFlightEpochA
  Execution.inFlightEpochB' = Execution.inFlightEpochB
}

fact traces {
  init
  always (
    acquireA or acquireB or
    expireLease or
    renewA or renewB or
    releaseA or releaseB or
    fencedCommitA or fencedCommitB or
    stutter
  )
}

// --- Safety Invariants ---

// Invariant 1: Committed outcome is ALWAYS from the authoritative holder at that epoch
assert FencedCommitAuthoritativeOnly {
  always (Execution.commitStatus = Committed implies (
    Execution.lastCommitter = Execution.holder and
    Execution.committedEpoch = Execution.epoch
  ))
}

// Invariant 2: A stale worker whose epoch was superseded NEVER commits
assert StaleWorkerFencedOut {
  always (
    (some Execution.inFlightEpochA and Execution.inFlightEpochA < Execution.epoch) implies
    (Execution.lastCommitter != WorkerA or Execution.committedEpoch != Execution.inFlightEpochA)
  )
}

// Invariant 3: At most one worker holds an active lease at any instant
assert ExactlyOneActiveLease {
  always (Execution.status = Active implies one Execution.holder)
}

// Invariant 4: Epoch counter is strictly monotonic across lease acquisitions
assert MonotonicEpochs {
  always (Execution.epoch' >= Execution.epoch)
}

// Invariant 5: When another worker takes over, epoch strictly increments
assert TakeoverBumpsEpoch {
  always (
    (some Execution.holder and some Execution.holder' and Execution.holder != Execution.holder') implies
    (Execution.epoch' > Execution.epoch)
  )
}

// --- Positive Run Witnesses ---

// Witness 1: Happy path single-worker acquire and fenced commit
run WitnessHappyPath {
  eventually (Execution.commitStatus = Committed and Execution.lastCommitter = WorkerA)
} for 4 steps, 4 Int

// Witness 2: Two-worker lease expiry, takeover by B, and B commits
run WitnessExpiryTakeoverAndCommit {
  eventually (
    Execution.holder = WorkerA and
    eventually (
      Execution.status = Expired and
      eventually (
        Execution.holder = WorkerB and
        Execution.commitStatus = Committed and
        Execution.lastCommitter = WorkerB
      )
    )
  )
} for 7 steps, 4 Int

// --- Check Commands ---
check FencedCommitAuthoritativeOnly for 7 steps, 4 Int
check StaleWorkerFencedOut for 7 steps, 4 Int
check ExactlyOneActiveLease for 7 steps, 4 Int
check MonotonicEpochs for 7 steps, 4 Int
check TakeoverBumpsEpoch for 7 steps, 4 Int
