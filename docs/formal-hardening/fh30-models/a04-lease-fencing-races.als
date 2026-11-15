module a04_lease_fencing_races

sig Worker {}
sig Token {}

one sig ActiveLease {
  var holder: lone Worker,
  var epoch: Int,
  var token: lone Token
}

one sig InFlightOperation {
  var active: Bool,
  var worker: lone Worker,
  var epoch: Int,
  var token: lone Token
}

enum Bool { True, False }

var sig StaleCommitObserved in Worker {}

pred init {
  no ActiveLease.holder
  ActiveLease.epoch = 0
  no ActiveLease.token

  InFlightOperation.active = False
  no InFlightOperation.worker
  InFlightOperation.epoch = 0
  no InFlightOperation.token

  no StaleCommitObserved
}

pred acquireOrTakeover[w: Worker, t: Token] {
  (no ActiveLease.holder or ActiveLease.holder != w)
  ActiveLease.holder' = w
  ActiveLease.epoch' = plus[ActiveLease.epoch, 1]
  ActiveLease.token' = t

  InFlightOperation.active' = InFlightOperation.active
  InFlightOperation.worker' = InFlightOperation.worker
  InFlightOperation.epoch' = InFlightOperation.epoch
  InFlightOperation.token' = InFlightOperation.token

  StaleCommitObserved' = StaleCommitObserved
}

// Initial lease check passes, operation enters in-flight state
pred startOperation[w: Worker] {
  InFlightOperation.active = False
  ActiveLease.holder = w

  ActiveLease.holder' = ActiveLease.holder
  ActiveLease.epoch' = ActiveLease.epoch
  ActiveLease.token' = ActiveLease.token

  InFlightOperation.active' = True
  InFlightOperation.worker' = w
  InFlightOperation.epoch' = ActiveLease.epoch
  InFlightOperation.token' = ActiveLease.token

  StaleCommitObserved' = StaleCommitObserved
}

// Vulnerable commit: commits without verifying epoch/token at store flush time (Wazir TOCTOU implementation)
pred vulnerableFlushCommit {
  InFlightOperation.active = True

  (InFlightOperation.epoch != ActiveLease.epoch or
   InFlightOperation.worker != ActiveLease.holder or
   InFlightOperation.token != ActiveLease.token) => {
    StaleCommitObserved' = StaleCommitObserved + InFlightOperation.worker
  } else {
    StaleCommitObserved' = StaleCommitObserved
  }

  InFlightOperation.active' = False
  no InFlightOperation.worker'
  InFlightOperation.epoch' = 0
  no InFlightOperation.token'

  ActiveLease.holder' = ActiveLease.holder
  ActiveLease.epoch' = ActiveLease.epoch
  ActiveLease.token' = ActiveLease.token
}

pred stutter {
  ActiveLease.holder' = ActiveLease.holder
  ActiveLease.epoch' = ActiveLease.epoch
  ActiveLease.token' = ActiveLease.token

  InFlightOperation.active' = InFlightOperation.active
  InFlightOperation.worker' = InFlightOperation.worker
  InFlightOperation.epoch' = InFlightOperation.epoch
  InFlightOperation.token' = InFlightOperation.token

  StaleCommitObserved' = StaleCommitObserved
}

fact traces {
  init
  always (
    (some w: Worker, t: Token | acquireOrTakeover[w, t]) or
    (some w: Worker | startOperation[w]) or
    vulnerableFlushCommit or
    stutter
  )
}

// Witness run: worker starts and commits
run WitnessExecution {
  eventually (InFlightOperation.active = True)
} for 3 but 2 Worker, 2 Token, 4 Int, 5 steps

// Assert: Stale worker commit must NEVER occur
assert NoStaleWorkerCommit {
  always (no StaleCommitObserved)
}

// Check counterexample: vulnerable implementation yields counterexample!
check NoStaleWorkerCommit for 3 but 2 Worker, 2 Token, 4 Int, 6 steps
