// ==============================================================================
// Wazir Formal Hardening Campaign — Subagent A3
// Model: a3-leases-mutant.als (NEGATIVE CONTROL MUTANT)
// Domain: Worker Leases & Fenced Commits (Unfenced Stale Commit Bug)
// Mutation:
//   Worker A's commit predicate lacks the epoch fence check (modeling the
//   bug where a stale worker's delayed callback commits after lease expiry
//   and takeover by Worker B).
// Expected: Counterexample found for FencedCommitAuthoritativeOnly and StaleWorkerFencedOut.
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

// BUGGY / MUTATED COMMIT: Fails to check that Worker A is still the active holder or at current epoch!
pred buggyCommitA {
  Execution.commitStatus = Uncommitted
  some Execution.inFlightEpochA
  // MUTATION: Missing checks:
  // Execution.holder = WorkerA
  // Execution.status = Active
  // Execution.epoch = Execution.inFlightEpochA

  Execution.commitStatus' = Committed
  Execution.committedEpoch' = Execution.inFlightEpochA
  Execution.lastCommitter' = WorkerA
  no Execution.inFlightEpochA'
  Execution.holder' = Execution.holder
  Execution.status' = Execution.status
  Execution.epoch' = Execution.epoch
  Execution.inFlightEpochB' = Execution.inFlightEpochB
}

pred fencedCommitB {
  Execution.commitStatus = Uncommitted
  some Execution.inFlightEpochB
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
    buggyCommitA or fencedCommitB or
    stutter
  )
}

assert FencedCommitAuthoritativeOnly {
  always (Execution.commitStatus = Committed implies (
    Execution.lastCommitter = Execution.holder and
    Execution.committedEpoch = Execution.epoch
  ))
}

assert StaleWorkerFencedOut {
  always (
    (some Execution.inFlightEpochA and Execution.inFlightEpochA < Execution.epoch) implies
    (Execution.lastCommitter != WorkerA or Execution.committedEpoch != Execution.inFlightEpochA)
  )
}

check FencedCommitAuthoritativeOnly for 7 steps, 4 Int
check StaleWorkerFencedOut for 7 steps, 4 Int
