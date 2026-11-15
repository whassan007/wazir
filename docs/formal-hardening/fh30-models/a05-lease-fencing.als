module a05_lease_fencing

sig Worker {}
sig Token {}

var sig ActiveLease {
  var holder: lone Worker,
  var epoch: Int,
  var token: lone Token
}

var sig CommittedWorker in Worker {}
var sig StaleCommitObserved in Worker {}

pred init {
  one ActiveLease
  no ActiveLease.holder
  ActiveLease.epoch = 0
  no ActiveLease.token
  no CommittedWorker
  no StaleCommitObserved
}

pred acquire[w: Worker, t: Token] {
  no ActiveLease.holder
  ActiveLease.holder' = w
  ActiveLease.epoch' = plus[ActiveLease.epoch, 1]
  ActiveLease.token' = t
  CommittedWorker' = CommittedWorker
  StaleCommitObserved' = StaleCommitObserved
}

pred takeoverAfterExpiry[w: Worker, t: Token] {
  some ActiveLease.holder
  ActiveLease.holder != w
  t != ActiveLease.token
  ActiveLease.holder' = w
  ActiveLease.epoch' = plus[ActiveLease.epoch, 1]
  ActiveLease.token' = t
  CommittedWorker' = CommittedWorker
  StaleCommitObserved' = StaleCommitObserved
}

pred fencedCommit[w: Worker, t: Token, e: Int] {
  ActiveLease.holder = w
  ActiveLease.token = t
  ActiveLease.epoch = e
  ActiveLease.holder' = ActiveLease.holder
  ActiveLease.epoch' = ActiveLease.epoch
  ActiveLease.token' = ActiveLease.token
  CommittedWorker' = CommittedWorker + w
  StaleCommitObserved' = StaleCommitObserved
}

pred stutter {
  ActiveLease.holder' = ActiveLease.holder
  ActiveLease.epoch' = ActiveLease.epoch
  ActiveLease.token' = ActiveLease.token
  CommittedWorker' = CommittedWorker
  StaleCommitObserved' = StaleCommitObserved
}

fact traces {
  init
  always (
    (some w: Worker, t: Token | acquire[w, t]) or
    (some w: Worker, t: Token | takeoverAfterExpiry[w, t]) or
    (some w: Worker, t: Token, e: Int | fencedCommit[w, t, e]) or
    stutter
  )
}

run WitnessTakeoverAndCommit {
  eventually (some w1, w2: Worker | w1 != w2 and w2 in CommittedWorker)
} for 3 but 1 ActiveLease, 5 Int, 6 steps

assert NoStaleWorkerCommit {
  always (no StaleCommitObserved and all w: Worker, t: Token, e: Int |
    fencedCommit[w, t, e] implies (ActiveLease.holder = w and ActiveLease.token = t and ActiveLease.epoch = e))
}

check NoStaleWorkerCommit for 3 but 1 ActiveLease, 5 Int, 6 steps
