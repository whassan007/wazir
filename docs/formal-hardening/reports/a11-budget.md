# Wazir Formal Hardening Report: Subagent A11
## Execution Budgets, Ledger & Retry Conservation

- **Subagent**: A11 (Execution Budgets, Ledger & Retry Conservation)
- **Campaign**: Wazir 12-Agent Formal Hardening Campaign
- **Base Commit HEAD SHA**: `4661c33a6caeaca0639853463e4ccbbe3ebc63d8`
- **Worktree**: `/Users/wael/Code/Wazir/.worktrees/fh-a11-budget`
- **Alloy JAR**: `/Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar` (Alloy 6.2.x, Sat4j)
- **Status**: **CONFIRMED & FIXED**

---

## 1. Executive Summary

Subagent A11 investigated and formally modeled resource accounting, ledger settlement, lease recovery, and budget conservation across retries, failures, and process restarts in Wazir:
- `packages/core/src/resources/governedAdapter.ts`
- `packages/core/src/resources/budgetManager.ts`
- `packages/core/src/resources/ledger.ts`
- `packages/core/src/resources/accounts.ts`
- `packages/core/src/resources/windows.ts`
- `packages/core/src/subagents/ledger.ts`

### Key Defects Discovered & Remediated:
1. **FH-A11-01 (P1 - Budget Conservation / Unrecorded Consumption)**: `governedAdapter.ts` ignored provider-reported `usage` when handling `{ type: 'error' }` events (e.g. context limit overflow, content filter, rate limits after prompt processing). When no output token was streamed (`outputSeen === false`), the adapter marked the failure as non-ambiguous (`ambiguous: false`) with no partial usage. In turn, `budgetManager.fail()` released the entire reservation to zero instead of settling the reported tokens. A retried task re-initialized its full token budget, completely bypassing `maxTaskTokens` and account quotas.
2. **FH-A11-02 (P1 - Durability / TOCTOU & Crash Recovery Incompleteness)**: `ResourceLedger.recoverExpired()` split the transition of reservations to `'expired'` and their settlement into `usage` across two separate transactions. If a process crashed between transactions, the reservation was left with `status = 'expired'` and no usage record. On restart, `recoverExpired()` queried only `WHERE status = 'active' AND lease_expires_at <= ?`, permanently ignoring orphaned `'expired'` reservations and losing consumed tokens from ledger calculations. In concurrent execution, this intermediate state created a TOCTOU window where reservations disappeared from `reservedNow` before appearing in `usedSince`, allowing concurrent requests to overcommit.
3. **FH-A11-03 (P1 - Quota Limit Bypass via Negative / Non-Finite Estimates)**: Neither `budgetManager.admit()` nor `evaluate()` validated that token and request estimates were non-negative finite numbers. Negative inputs (e.g. `estimatedInputTokens: -5000`) decreased `utilization` and subtracted from SQLite `reservedNow`, artificially creating phantom quota headroom for subsequent requests to exceed hard limits. In `reconcile()`, negative usage amounts were inserted into `usage`, decreasing `usedSince` and refunding spent quota. `NaN` values caused runtime SQLite constraint crashes.
4. **FH-A11-04 (P2 - State Consistency / Released Reservation Resurrected)**: `budgetManager.reconcile()` and `ledger.settle()` allowed late reconciliation on reservations whose status was `'released'`, inserting usage rows and creating an inconsistent state where a released reservation had attributed billing.

---

## 2. Alloy 6 Formal Modeling & Verification Evidence

### 2.1 Model Architecture

A behavioral temporal specification was authored in `/Users/wael/Code/Wazir/docs/formal-hardening/models/a11-budget.als`:
- **State Signatures**: `Account` (with `limit`), `Task` (with `taskBudget`), `Request` (with `cost`, `account`, `task`, `var status`).
- **Mutable Relations**: `Request.status` (`Unadmitted | Active | Settled | Released`), `Ledger.inUsage`, `Ledger.billed`.
- **Transitions**:
  - `admit[r]`: Atomically reserves capacity if `currentAccountCommitted + cost <= limit` and `currentTaskCommitted + cost <= taskBudget`.
  - `providerProcess[r]`: Provider receives prompt and bills tokens (`r in Ledger.billed`).
  - `completeAndReconcile[r]`: Normal stream completion settling reservation into `inUsage`.
  - `failPreDispatch[r]`: Failure before provider contact safely releases reservation (`status' = Released`).
  - `failWithUsageAndSettle[r]`: Failure after provider consumed tokens settles into `inUsage`.
  - `recoverExpiredAtomic[r]`: Expired lease recovery claims and settles in a single atomic step.
- **Invariants Formalized**:
  1. `AccountLimitPreserved`: Total committed usage and active reservations never exceed account limit.
  2. `TaskBudgetPreserved`: Total committed usage and active reservations for a task never exceed its budget.
  3. `NoUnrecordedBilledConsumption`: Any request billed by provider is never released without a ledger record.
  4. `AccountingCompleteness`: Reservations in status `Settled` are bijection-mapped to ledger usage.

A companion negative-control mutant was constructed in `/Users/wael/Code/Wazir/docs/formal-hardening/models/a11-budget-mutant.als`, modeling the unpatched bug where a provider-billed request is released without a ledger record (`failBuggyRelease`).

### 2.2 Analyzer Execution Results

#### Hardened Model (`a11-budget.als`):
```bash
java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar exec -n -f -t text -c '*' \
  -o /Users/wael/Code/Wazir/docs/formal-hardening/results/a11-budget \
  /Users/wael/Code/Wazir/docs/formal-hardening/models/a11-budget.als
```
Output:
```
00. run   WitnessNormalCompletion           0         1/1     SAT
01. run   WitnessRecoveryAndRetry           0         1/1     SAT
02. check AccountLimitPreserved             0       UNSAT
03. check TaskBudgetPreserved               0       UNSAT
04. check NoUnrecordedBilledConsumption     0       UNSAT
05. check AccountingCompleteness            0       UNSAT
```
*Verdict*: Both positive witnesses are satisfiable (`SAT`). All 4 safety invariants hold with zero counterexamples (`UNSAT`).

#### Negative Control Mutant (`a11-budget-mutant.als`):
```bash
java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar exec -n -f -t text -c '*' \
  -o /Users/wael/Code/Wazir/docs/formal-hardening/results/a11-budget-mutant \
  /Users/wael/Code/Wazir/docs/formal-hardening/models/a11-budget-mutant.als
```
Output:
```
00. check NoUnrecordedBilledConsumption     0         1/1     SAT
01. check RealProviderTokensWithinTaskBudget     0         1/1     SAT
```
*Verdict*: Both checks found counterexamples (`SAT`), proving that unrecorded failure releases directly cause budget invariant violation across retries.

### 2.3 Minimized Counterexample Trace (Mutant)

From `/Users/wael/Code/Wazir/docs/formal-hardening/results/a11-budget-mutant/NoUnrecordedBilledConsumption-solution-0.txt`:
1. **State 0**: `Task$0.taskBudget = 1`, `Request$0.cost = 1`, status is `Unadmitted`.
2. **State 1**: `admit[Request$0]` runs; `Request$0.status` becomes `Active`.
3. **State 2**: `providerProcess[Request$0]` runs; `Request$0` is added to `Ledger.billed`.
4. **State 3**: `failBuggyRelease[Request$0]` runs; `Request$0.status` becomes `Released`, but `Ledger.inUsage` remains empty.
5. **State 4**: Because `currentTaskCommitted` is 0, a retry request `Request$1` is admitted, consuming an additional token and exceeding the task budget of 1.

---

## 3. Production Code Defects & Root Cause Analysis

### 3.1 Defect 1: Unrecorded Consumption on Error with Reported Usage (`governedAdapter.ts`)
- **Location**: `packages/core/src/resources/governedAdapter.ts:107-115`
- **Root Cause**: `governedAdapter.ts` defined `const ambiguous = outputSeen;` and `partial: outputSeen ? estimatedUsage() : undefined`. When an adapter yielded `{ type: 'error', usage: { inputTokens: 4000 } }`, the `usage` property was ignored. Because no output token was emitted (`outputSeen === false`), `budget.fail()` received `ambiguous: false, partial: undefined` and called `ledger.release()`, deleting the reservation and charging 0 tokens.
- **Fix**: Check `event.usage` on error events; construct `partial` measurement with `source: 'provider-reported'`; set `ambiguous: outputSeen || reported`; and update `budgetManager.fail()` to reconcile provider-reported tokens without adding phantom estimated output tokens.

### 3.2 Defect 2: Crash Recovery Loss of Expired Reservations (`ledger.ts`)
- **Location**: `packages/core/src/resources/ledger.ts:267-285`
- **Root Cause**: `recoverExpired()` ran `UPDATE reservations SET status = 'expired'` in a separate transaction from `settle()`. A crash between the two left the reservation in `'expired'` status without a usage record. On restart, `recoverExpired()` filtered strictly on `status = 'active'`, permanently losing the reservation from all budget calculations.
- **Fix**: Unify claim and settlement into a single atomic transaction under SQLite's write lock, and expand the query to recover both active expired leases and orphaned `'expired'` reservations (`WHERE (status = 'active' AND lease_expires_at <= ?) OR (status = 'expired' AND request_id NOT IN (SELECT request_id FROM usage))`).

### 3.3 Defect 3: Negative / Non-Finite Budget Adjustments (`budgetManager.ts`)
- **Location**: `packages/core/src/resources/budgetManager.ts:170-185, 274-295`
- **Root Cause**: No validation of `estimatedInputTokens`, `estimatedOutputTokens`, or `requests` in `evaluate()` or `reconcile()`. Negative estimates decreased reservation sums, creating artificial headroom for other requests to blow past hard limits. Negative reconcile numbers reduced `usedSince`, refunding spent quota. `NaN` caused runtime SQLite constraint errors.
- **Fix**: Enforce `Number.isFinite(x) && x >= 0` guards in both `evaluate()` and `reconcile()`, returning `blocked` (`INVALID_RESOURCE_REQUEST`) or `false`.

### 3.4 Defect 4: Late Settlement of Released Reservations (`budgetManager.ts` & `ledger.ts`)
- **Location**: `packages/core/src/resources/budgetManager.ts:275`, `packages/core/src/resources/ledger.ts:228`
- **Root Cause**: `reconcile()` and `settle()` did not verify whether a reservation had already been released. A late callback or delayed event could settle a released reservation into `usage`.
- **Fix**: Check `if (!r || r.status === 'released') return false;` in `budgetManager.reconcile()` and reject `r.status === 'released'` inside `ledger.settle()`.

---

## 4. Deterministic Vitest Reproduction

Reproduction test suite written in:
`packages/core/tests/budgetHardening.test.ts`

### 4.1 Pre-Fix Failure Evidence:
```bash
$ vitest run packages/core/tests/budgetHardening.test.ts

 FAIL  packages/core/tests/budgetHardening.test.ts (5 failed)
  × records provider-reported usage on error event instead of releasing reservation to zero
    AssertionError: expected [] to have a length of 1 but got +0
  × recovers orphaned expired reservations across restart, preserving budget conservation
    AssertionError: expected +0 to be 1
  × rejects negative and NaN token estimates in admit() to prevent limit bypass
    AssertionError: expected 'admitted' to be 'blocked'
  × rejects negative and NaN token amounts in reconcile() to prevent quota replenishment
    AssertionError: expected true to be false
  × refuses to reconcile reservations that have been released
    AssertionError: expected true to be false

 Test Files  1 failed (1)
      Tests  5 failed (5)
```

### 4.2 Post-Fix Passing Evidence:
```bash
$ vitest run packages/core/tests/budgetHardening.test.ts

 ✓ packages/core/tests/budgetHardening.test.ts (5 passed)
   ✓ Formal Hardening A11: Budget, Ledger & Retry Conservation (5)
     ✓ records provider-reported usage on error event instead of releasing reservation to zero
     ✓ recovers orphaned expired reservations across restart, preserving budget conservation
     ✓ rejects negative and NaN token estimates in admit() to prevent limit bypass
     ✓ rejects negative and NaN token amounts in reconcile() to prevent quota replenishment
     ✓ refuses to reconcile reservations that have been released

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  256ms
```

---

## 5. Regression & Integration Testing

All related existing test suites were executed and verified passing:
1. `packages/core/tests/resources.test.ts`: 39 passed (39 total)
2. `packages/core/tests/phase3ReservationsAndQuota.test.ts`: 5 passed (5 total)
3. `packages/core/tests/subagentsLedger.test.ts`: 4 passed (4 total)
4. `packages/core/tests/resourceValidation.test.ts`: 5 passed (5 total)
5. `packages/core/tests/outcomeRouting.test.ts`: 15 passed (15 total)
6. Full TypeScript compilation (`tsc --build`): 0 errors

---

## 6. Summary of Changed Files

- `packages/core/src/resources/governedAdapter.ts`: Forward provider-reported `usage` on error events; mark ambiguous when usage reported.
- `packages/core/src/resources/budgetManager.ts`: Validate non-negative finite token estimates in `evaluate()` and `reconcile()`; prevent settling released reservations; settle provider-reported tokens without phantom output padding on error.
- `packages/core/src/resources/ledger.ts`: Atomic lease claim and settlement in `recoverExpired()`; recover orphaned `'expired'` reservations on restart; reject settling released reservations.
- `packages/core/tests/budgetHardening.test.ts`: Deterministic regression tests covering all 4 defects.
- `docs/formal-hardening/models/a11-budget.als`: Alloy 6 formal specification.
- `docs/formal-hardening/models/a11-budget-mutant.als`: Alloy 6 mutant model.
- `docs/formal-hardening/reports/a11-ledger.csv`: Structured issue ledger.
- `docs/formal-hardening/reports/a11-budget.md`: This comprehensive report.
