// Alloy 6 Temporal Model: Execution Budgets, Ledger & Retry Conservation (A11)
// Formal model of Wazir token budget admission, atomic lease recovery,
// settlement, retries, and failure accounting.

module wazir/budget

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

// Initial state
pred init {
  all r: Request | r.status = Unadmitted
  no Ledger.inUsage
  no Ledger.billed
  all a: Account | a.limit > 0
  all t: Task | t.taskBudget > 0
  all r: Request | r.cost > 0
}

// Auxiliary definitions
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

// Current total committed (used in ledger + actively reserved)
fun currentAccountCommitted[a: Account]: Int {
  (sum r: (activeReservations[a] + ledgerUsage[a]) | r.cost)
}

fun currentTaskCommitted[t: Task]: Int {
  (sum r: (activeReservationsForTask[t] + ledgerUsageForTask[t]) | r.cost)
}

// ----------------------------------------------------------------------------
// Transition Actions
// ----------------------------------------------------------------------------

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

pred failPreDispatch[r: Request] {
  r.status = Active
  r not in Ledger.billed

  r.status' = Released
  all other: Request - r | other.status' = other.status
  Ledger.inUsage' = Ledger.inUsage
  Ledger.billed' = Ledger.billed
}

// Hardened failure handling: error with consumed tokens settles into usage ledger
pred failWithUsageAndSettle[r: Request] {
  r.status = Active
  r in Ledger.billed

  r.status' = Settled
  all other: Request - r | other.status' = other.status
  Ledger.inUsage' = Ledger.inUsage + r
  Ledger.billed' = Ledger.billed
}

// Hardened crash recovery: expired reservation settles atomically into ledger
pred recoverExpiredAtomic[r: Request] {
  r.status = Active

  r.status' = Settled
  all other: Request - r | other.status' = other.status
  Ledger.inUsage' = Ledger.inUsage + r
  Ledger.billed' = Ledger.billed + r
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
    (some r: Request | failPreDispatch[r]) or
    (some r: Request | failWithUsageAndSettle[r]) or
    (some r: Request | recoverExpiredAtomic[r]) or
    stutter
  )
}

// ----------------------------------------------------------------------------
// Safety Invariants
// ----------------------------------------------------------------------------

assert AccountLimitPreserved {
  always (all a: Account | currentAccountCommitted[a] <= a.limit)
}

assert TaskBudgetPreserved {
  always (all t: Task | currentTaskCommitted[t] <= t.taskBudget)
}

assert NoUnrecordedBilledConsumption {
  always (all r: Request |
    (r in Ledger.billed and r.status in (Settled + Released)) =>
      (r in Ledger.inUsage and r.status = Settled)
  )
}

assert AccountingCompleteness {
  always (all r: Request |
    (r.status = Settled => r in Ledger.inUsage) and
    (r in Ledger.inUsage => r.status = Settled)
  )
}

// ----------------------------------------------------------------------------
// Verification Commands & Witnesses
// ----------------------------------------------------------------------------

run WitnessNormalCompletion {
  eventually (some r: Request | r.status = Settled and r in Ledger.inUsage)
} for 3 Request, 1 Account, 1 Task, 5 Int, 6 steps

run WitnessRecoveryAndRetry {
  eventually (some r1, r2: Request |
    r1 != r2 and
    r1.task = r2.task and
    r1.status = Settled and
    r2.status = Settled
  )
} for 3 Request, 1 Account, 1 Task, 5 Int, 8 steps

check AccountLimitPreserved for 3 Request, 1 Account, 1 Task, 5 Int, 7 steps
check TaskBudgetPreserved for 3 Request, 1 Account, 1 Task, 5 Int, 7 steps
check NoUnrecordedBilledConsumption for 3 Request, 1 Account, 1 Task, 5 Int, 7 steps
check AccountingCompleteness for 3 Request, 1 Account, 1 Task, 5 Int, 7 steps
