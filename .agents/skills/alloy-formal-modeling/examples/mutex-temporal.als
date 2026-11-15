// Alloy 6 — Behavioral lock model with native temporal state.
// Intended outcomes: acquiring a lock is possible; the holder is at
// most one Client in each state. Liveness is NOT guaranteed because
// stuttering forever is allowed.

sig Client {}
one sig Mutex { var holder: lone Client }

pred init {
  no Mutex.holder
}

pred acquire[c: Client] {
  no Mutex.holder
  Mutex.holder' = c
}

pred release[c: Client] {
  Mutex.holder = c
  no Mutex.holder'
}

pred stutter {
  Mutex.holder' = Mutex.holder
}

fact Transitions {
  init
  always (
    (some c: Client | acquire[c] or release[c])
    or stutter
  )
}

assert MutualExclusion {
  always lone Mutex.holder
}

// This is a stronger safety check on allowed next-state transitions.
assert NoSpontaneousAcquisition {
  always (
    (no Mutex.holder and some Mutex.holder') implies
    (some c: Client | acquire[c])
  )
}

run { eventually some Mutex.holder } for 3 but 6 steps
check MutualExclusion for 3 but 6 steps
check NoSpontaneousAcquisition for 3 but 6 steps
