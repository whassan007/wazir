// Alloy 6 Temporal Mutant: Defective Failure Accounting (A11 Negative Control)
// Models the unpatched bug where a provider error/timeout with consumed tokens
// is treated as unbilled/released when outputSeen was false, enabling budget bypass.

module wazir/budget_mutant

abstract sig ReservationStatus {}
one sig Unadmitted, Active, Settled, Released extends ReservationStatus {}

sig Account {
  limit: one Int
}

sig Task {
  taskBudget: one Int
}

sig Request {
  account: one Account,
  task: one Task,
  cost: one Int,
  var status: one ReservationStatus
}

one sig Ledger {
  var inUsage: set Request,
  var billed: set Request
}

pred init {
  all r: Request | r.status = Unadmitted
  no Ledger.inUsage
  no Ledger.billed
  all a: Account | a.limit > 0
  all t: Task | t.taskBudget > 0
  all r: Request | r.cost > 0
}

fun activeReservations[a: Account]: set Request {
  (status.Active) & account.a
}

fun activeReservationsForTask[t: Task]: set Request {
  (status.Active) & task.t
}

fun ledgerUsage[a: Account]: set Request {
  (Ledger.inUsage) & account.a
}

fun ledgerUsageForTask[t: Task]: set Request {
  (Ledger.inUsage) & task.t
}

fun currentAccountCommitted[a: Account]: Int {
  (sum r: (activeReservations[a] + ledgerUsage[a]) | r.cost)
}

fun currentTaskCommitted[t: Task]: Int {
  (sum r: (activeReservationsForTask[t] + ledgerUsageForTask[t]) | r.cost)
}

pred admit[r: Request] {
  r.status = Unadmitted
  add[currentAccountCommitted[r.account], r.cost] <= r.account.limit
  add[currentTaskCommitted[r.task], r.cost] <= r.task.taskBudget

  r.status' = Active
  all other: Request - r | other.status' = other.status
  Ledger.inUsage' = Ledger.inUsage
  Ledger.billed' = Ledger.billed
}

pred providerProcess[r: Request] {
  r.status = Active
  r not in Ledger.billed

  r.status' = r.status
  all other: Request - r | other.status' = other.status
  Ledger.inUsage' = Ledger.inUsage
  Ledger.billed' = Ledger.billed + r
}

pred completeAndReconcile[r: Request] {
  r.status = Active
  r in Ledger.billed

  r.status' = Settled
  all other: Request - r | other.status' = other.status
  Ledger.inUsage' = Ledger.inUsage + r
  Ledger.billed' = Ledger.billed
}

// MUTANT: unpatched bug where provider billed tokens, but request is released without ledger record!
pred failBuggyRelease[r: Request] {
  r.status = Active
  r in Ledger.billed

  r.status' = Released
  all other: Request - r | other.status' = other.status
  Ledger.inUsage' = Ledger.inUsage
  Ledger.billed' = Ledger.billed
}

pred stutter {
  status' = status
  Ledger.inUsage' = Ledger.inUsage
  Ledger.billed' = Ledger.billed
}

fact traces {
  init
  always (
    (some r: Request | admit[r]) or
    (some r: Request | providerProcess[r]) or
    (some r: Request | completeAndReconcile[r]) or
    (some r: Request | failBuggyRelease[r]) or
    stutter
  )
}

// Invariant: Any request billed by provider is never released without ledger record
assert NoUnrecordedBilledConsumption {
  always (all r: Request |
    (r in Ledger.billed and r.status in (Settled + Released)) =>
      (r in Ledger.inUsage and r.status = Settled)
  )
}

// Invariant: Total actual tokens billed by provider for a task must not exceed budget
assert RealProviderTokensWithinTaskBudget {
  always (all t: Task |
    (sum r: (Ledger.billed & task.t) | r.cost) <= t.taskBudget
  )
}

check NoUnrecordedBilledConsumption for 2 Request, 1 Account, 1 Task, 5 Int, 5 steps
check RealProviderTokensWithinTaskBudget for 2 Request, 1 Account, 1 Task, 5 Int, 6 steps
