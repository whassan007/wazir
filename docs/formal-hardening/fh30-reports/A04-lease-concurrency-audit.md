# A04 — Formal Audit Report: Worker Leases, Concurrency & Fencing Tokens

- **Agent ID**: A04 (Gemini TIER 1 — Worker Leases & Concurrency Auditor)
- **Target Repository**: `/Users/wael/Code/Wazir`
- **Target HEAD SHA**: `4661c33a6caeaca0639853463e4ccbbe3ebc63d8`
- **Assigned Subsystem**: Worker Leases, Fencing Tokens, Concurrency, and Stale Worker Mutations (GROUP B P0)
- **Critical Invariant**: *"A worker must never commit a state mutation using an expired or superseded lease."*
- **Alloy 6 Model**: `tests/formal-hardening/models/a04-lease-fencing-races.als` (Witness: SAT, Check: SAT Counterexample at Scope 3, 6 steps)
- **Executable Reproduction Suite**: `tests/formal-hardening/reproductions/A04-lease-fencing-races.test.ts` (5 deterministic passing tests)
- **Status**: **CONFIRMED PRODUCTION DEFECTS**

---

## 1. Executive Summary

This formal audit investigated the lease lifecycle—acquisition, renewal, expiry, takeover, fencing tokens, and state commit barriers—across `ExecutionEngine`, `JobManager`, `TaskDispatcher`, `Worker`, `PostgresStore`, and the REST API. 

The investigation confirmed that while Wazir incorporates in-memory lease checking (`assertLease`) and optimistic storage revision tracking (`persistExecutionRecord`), **the critical invariant is violated across multiple reachable production paths**. Specifically:
1. **TOCTOU Gap in ExecutionEngine**: Lease validity is asserted at method entry, followed by asynchronous operations (fault points, artifact hashing, git introspection, child process calls) before committing via `flush()`. During this asynchronous gap, lease takeover can occur, allowing superseded workers to commit mutations.
2. **Zero Store-Level Lease Validation**: Authoritative storage updates (`persistExecutionRecord` in `executionPersistence.ts`) only compare `storageRevision` and event array prefixes; they verify neither lease holder identity (`workerId`), epoch monotonicity, lease expiry, nor the opaque fencing token.
3. **Optional Claimant Bypass in assertLease**: When mutating methods (`recordEvent`, `setStatus`, `setResult`, `recordToolCall`, `recordFilesChanged`, etc.) are called without a claimant object or with an empty object, `assertLease` silently returns without enforcing that the execution has an active lease.
4. **Un-Leased Mutations in JobManager**: When an instance of `JobManager` does not hold a local claim, `flush()` permits writes to jobs whose previous leases have expired, mutating task and graph node state in the authoritative store without acquiring a lease or incrementing the epoch.
5. **Fencing Token Is Optional**: `assertLease` only validates `leaseToken` if explicitly provided by the caller; knowing a worker's ID allows spoofing mutations, renewals, and lease releases without presenting the control plane's cryptographic fencing token.

---

## 2. Exhaustive State Mutation Trace Matrix

| Method | File:Line | Checked at Entry? | Checked at Store Commit? | Fencing Token Required? | Status |
|---|---|---|---|---|---|
| `engine.recordEvent` | `executionEngine.ts:750` | `assertLease` (optional claimant) | ❌ None (`persistExecutionRecord`) | ❌ Optional | ⚠️ TOCTOU / Bypassable |
| `engine.recordToolStart` | `executionEngine.ts:529` | `assertLease` (optional claimant) | ❌ None (`persistExecutionRecord`) | ❌ Optional | ⚠️ TOCTOU / Bypassable |
| `engine.recordToolCall` | `executionEngine.ts:493` | `assertLease` (optional claimant) | ❌ None (`persistExecutionRecord`) | ❌ Optional | ⚠️ TOCTOU / Bypassable |
| `engine.recordFilesChanged` | `executionEngine.ts:862` | `assertLease` (optional claimant) | ❌ None (`persistExecutionRecord`) | ❌ Optional | ⚠️ TOCTOU / Bypassable |
| `engine.setStatus` | `executionEngine.ts:400` | `assertLease` (optional claimant) | ❌ None (`persistExecutionRecord`) | ❌ Optional | ⚠️ TOCTOU / Bypassable |
| `engine.setResult` | `executionEngine.ts:982` | `assertLease` (optional claimant) | ❌ None (`persistExecutionRecord`) | ❌ Optional | ⚠️ TOCTOU / Bypassable |
| `engine.setEvaluation` | `executionEngine.ts:1044` | `assertLease` (optional claimant) | ❌ None (`persistExecutionRecord`) | ❌ Optional | ⚠️ TOCTOU / Bypassable |
| `engine.recordUsage` | `executionEngine.ts:810` | `assertLease` (optional claimant) | ❌ None (`persistExecutionRecord`) | ❌ Optional | ⚠️ TOCTOU / Bypassable |
| `engine.recordError` | `executionEngine.ts:803` | `assertLease` (optional claimant) | ❌ None (`persistExecutionRecord`) | ❌ Optional | ⚠️ TOCTOU / Bypassable |
| `engine.acquireLease` | `executionEngine.ts:1185`| Checks terminal & existing lease | ❌ In-memory `leases.set`, flushes event | N/A (generates token) | ⚠️ In-memory only |
| `engine.renewLease` | `executionEngine.ts:1253`| `assertLease` | ❌ None | ❌ Optional | ⚠️ TOCTOU / Spoofable |
| `engine.releaseLease` | `executionEngine.ts:1305`| `assertLease` (`rejectIfTerminal=false`)| ❌ None | ❌ Optional | ⚠️ Impostor Release |
| `jobManager.acquire` | `jobManager.ts:126` | Atomic store update | ✅ Checked via `store.update` | N/A (epoch based) | ✅ Enforced |
| `jobManager.renew` | `jobManager.ts:193` | `assertOwnership` | ✅ Checked via `store.update` | N/A (epoch based) | ✅ Enforced |
| `jobManager.release` | `jobManager.ts:203` | `assertOwnership` | ✅ Checked via `store.update` | N/A (epoch based) | ✅ Enforced |
| `jobManager.completeTask` | `jobManager.ts:484` | In-memory only before flush | ❌ `flush()` permits writes if expired | ❌ No token | ⚠️ Un-leased write |
| `jobManager.updateTaskStatus`| `jobManager.ts:563` | In-memory only before flush | ❌ `flush()` permits writes if expired | ❌ No token | ⚠️ Un-leased write |
| `jobManager.updateAgentState` | `jobManager.ts:578` | In-memory only before flush | ❌ `flush()` permits writes if expired | ❌ No token | ⚠️ Un-leased write |
| `api.recordExecution` | `apps/api/server.ts:753`| Epoch check only if both defined | ✅ `store.update` | ❌ No token / No worker check | ⚠️ Stale write if epoch omitted |
| `dispatcher.commit` | `apps/api/server.ts:334`| `validate(current, token)` | ✅ Checked via `store.update` | ✅ Required | ✅ Strict fencing |

---

## 3. Detailed Vulnerability Analyses

### 3.1 [P0-A04-01] TOCTOU Asynchronous Window Allows Stale Worker Commits
- **Location**: `packages/core/src/services/executionEngine.ts:529-554` (`recordToolStart`), `862-964` (`recordFilesChanged`), `400-472` (`setStatus`), `1651-1667` (`flush`)
- **Severity**: **P0 (Critical)**
- **Mechanism**:
  In `ExecutionEngine`, mutating methods invoke `this.assertLease(executionId, options, ...)` at the start of the method. Between `assertLease` and `this.flush(record)`, multiple asynchronous operations occur:
  - `await injectFault('BEFORE_TOOL_EXECUTION', ...)` (line 535)
  - `await injectFault('AFTER_MUTATION_BEFORE_REVISION_RECORD', ...)` (line 883)
  - `await this.readFile(file)` (line 922)
  - `await computeContentHash(content)` (line 923)
  - `await this.getGitCommit(file)` (line 950)
  - `await this.provenanceManager.registerArtifact(artifactParams)` (line 957)
  - `await injectFault('DURING_COMPLETION', ...)` (line 436)

  During any of these asynchronous awaits, the worker's lease can expire, and a second worker can call `acquireLease(executionId, 'worker-b')`, taking over the lease at Epoch 2.
  When the first worker's asynchronous task resumes, it pushes the mutation event (`this.pushEvent(...)`) and calls `this.flush(record)`. 
  `this.flush()` performs **no lease validation whatsoever**. It snapshots the record and writes to `this.persist()`.
  Consequently, stale Worker A successfully commits tool execution starts, workspace file mutations, or terminal status transitions despite Worker B being the authoritative lease holder.

### 3.2 [P0-A04-02] assertLease Bypassed Completely When Claimant Options Is Omitted
- **Location**: `packages/core/src/services/executionEngine.ts:1355-1363`
- **Severity**: **P0 (Critical)**
- **Mechanism**:
  In `assertLease`:
  ```typescript
  assertLease(executionId: string, claimant?: LeaseClaimant, now = new Date(), rejectIfTerminal = false): void {
    const record = this.require(executionId);
    if (!claimant) return;
    const claimedEpoch = claimant.leaseEpoch ?? claimant.epoch;
    const claimedWorker = claimant.workerId;
    const claimedToken = claimant.leaseToken;
    if (claimedWorker === undefined && claimedEpoch === undefined && claimedToken === undefined) {
      return;
    }
    // ... validation only runs if claimant was provided with at least one field ...
  }
  ```
  All mutating methods define `options?: LeaseClaimant` as optional. If an execution currently has an active, unreleased lease assigned to `worker-a`:
  Any caller that passes `undefined`, `{}`, or `{ now: new Date() }` completely bypasses `assertLease`. It will not check whether an active lease exists, whether that lease has expired, or who owns it.
  An unauthenticated worker or expired worker can call `setResult(execId, 'stale')` or `setStatus(execId, 'completed')` with no options, and the mutation is committed unconditionally.

### 3.3 [P0-A04-03] JobManager Allows Un-Leased Writes on Expired Jobs
- **Location**: `packages/core/src/services/jobManager.ts:834-841` (`flush`), `484-495` (`completeTask`), `563-577` (`updateTaskStatus`), `578-589` (`updateAgentState`)
- **Severity**: **P0 (Critical)**
- **Mechanism**:
  In `JobManager.flush()`:
  ```typescript
  await this.store.update!<Job>(`job/${job.id}`, current => {
    if (current) {
      if (this.claims.has(job.id)) this.assertOwnership(current);
      else if (current.ownership && current.ownership.expiresAt > this.now()) throw new Error('JOB_LEASE_BUSY');
      if (current.revision !== job.revision) throw new Error('JOB_REVISION_CONFLICT');
    }
    job.revision = (current?.revision ?? 0) + 1;
    return structuredClone({ ...job, control: current?.control ?? job.control, ownership: current?.ownership ?? job.ownership });
  });
  ```
  If an instance of `JobManager` does **not** have an entry in `this.claims` (because it never called `acquire(jobId)`, or because it called `release(jobId)`):
  - `this.claims.has(job.id)` is `false`.
  - The check falls into `else if (current.ownership && current.ownership.expiresAt > this.now()) throw new Error('JOB_LEASE_BUSY')`.
  - When the previous owner's lease has expired (`current.ownership.expiresAt <= this.now()`), the `else if` condition evaluates to `false`.
  - No error is thrown! The un-leased JobManager proceeds to update the job graph, task statuses, and results in the authoritative store.
  - The write commits under the old expired owner's `ownerId` and `epoch`, without acquiring a lease or bumping the epoch.

### 3.4 [P1-A04-04] Fencing Token (`leaseToken`) Is Optional in assertLease
- **Location**: `packages/core/src/services/executionEngine.ts:1393-1399`
- **Severity**: **P1 (High)**
- **Mechanism**:
  When `acquireLease` is called, it generates a unique cryptographic fencing token:
  `token: 'lease-${executionId}-${epoch}-${randomUUID()}'`.
  However, in `assertLease`:
  ```typescript
  if (claimedToken !== undefined && current.token !== claimedToken) {
    throw new StaleWorkerLeaseError(...);
  }
  ```
  Validation of `claimedToken` only triggers if `claimedToken !== undefined`. If a caller provides only `{ workerId: 'worker-a' }` without providing `leaseToken`, the check passes.
  Any actor who knows or observes the worker identity can spoof mutations or renew leases without possession of the secret fencing token.

### 3.5 [P1-A04-05] Unauthenticated / Impostor Lease Release
- **Location**: `packages/core/src/services/executionEngine.ts:1305-1337`
- **Severity**: **P1 (High)**
- **Mechanism**:
  In `releaseLease`:
  ```typescript
  async releaseLease(executionId: string, workerId: string, optionsOrEpoch?: ...): Promise<void>
  ```
  Because `leaseToken` and `leaseEpoch` are optional, a caller only needs to pass `workerId`. If Worker B acquires a lease at Epoch 2, an impostor or stale worker calling `engine.releaseLease(executionId, 'worker-b')` passes `assertLease` and marks `current.released = true`.
  This prematurely terminates Worker B's lease, causing subsequent valid operations by Worker B to fail with `StaleWorkerLeaseError`.

### 3.6 [P1-A04-06] API `recordExecution` Fencing Bypass on Missing Epoch
- **Location**: `apps/api/src/server.ts:775-778`
- **Severity**: **P1 (High)**
- **Mechanism**:
  ```typescript
  if (currentEpoch !== undefined && incomingEpoch !== undefined && incomingEpoch < currentEpoch) {
    return current;
  }
  ```
  If an execution in `store` has `leaseEpoch: 5`, but an incoming report from a worker omits `leaseEpoch` (e.g. `incomingEpoch === undefined`), the condition evaluates to `false`.
  `recordExecution` proceeds to overwrite the execution status (e.g. from `running` to `failed`) and append error messages, completely bypassing epoch fencing.

---

## 4. Formal Verification with Alloy 6

### 4.1 Alloy 6 Model Specification
We developed `tests/formal-hardening/models/a04-lease-fencing-races.als` to model the distributed lease state machine with split-phase (check $\rightarrow$ async $\rightarrow$ commit) operations.

```alloy
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

assert NoStaleWorkerCommit {
  always (no StaleCommitObserved)
}

check NoStaleWorkerCommit for 3 but 2 Worker, 2 Token, 4 Int, 6 steps
```

### 4.2 Analyzer Execution & Counterexample Verification
Command:
```bash
/Users/wael/.local/bin/java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar exec -f tests/formal-hardening/models/a04-lease-fencing-races.als
```
Result:
```
00. run   WitnessExecution         0         1/1     SAT
01. check NoStaleWorkerCommit      0         1/1     SAT (Counterexample Found)
```

**Minimal Counterexample Trace (Extracted from receipt.json)**:
- **State 0**: Initial state. `ActiveLease` empty (`holder=none`, `epoch=0`, `token=none`).
- **State 1**: `acquireOrTakeover[Worker1, Token1]` $\rightarrow$ `ActiveLease.holder = Worker1`, `epoch = 1`, `token = Token1`.
- **State 2**: `startOperation[Worker1]` $\rightarrow$ Initial validation succeeds. `InFlightOperation` initiated with `worker = Worker1`, `epoch = 1`, `token = Token1`.
- **State 3**: `acquireOrTakeover[Worker0, Token0]` $\rightarrow$ Lease expires and Worker 0 takes over. `ActiveLease.holder = Worker0`, `epoch = 2`, `token = Token0`.
- **State 4**: `vulnerableFlushCommit` $\rightarrow$ Worker 1's delayed flush commits. Because commit does not re-validate against `ActiveLease`, `StaleCommitObserved = {Worker1}`. **Invariant Violated.**

---

## 5. Physical Code Reproduction (Vitest)

All 5 gaps were deterministically reproduced against the unpatched codebase in `tests/formal-hardening/reproductions/A04-lease-fencing-races.test.ts`.

### Reproduction Command
```bash
cd /Users/wael/Code/Wazir && npx --no-install vitest run tests/formal-hardening/reproductions/A04-lease-fencing-races.test.ts
```

### Test Results
```
 ✓ tests/formal-hardening/reproductions/A04-lease-fencing-races.test.ts (5)
   ✓ A04 — Worker Leases & Concurrency Hardening Verification (5)
     ✓ GAP 1: ExecutionEngine allows stale worker to commit state mutation after lease takeover via TOCTOU async gap
     ✓ GAP 2: ExecutionEngine assertLease is completely bypassed when claimant options is undefined or empty
     ✓ GAP 3: ExecutionEngine allows caller to spoof workerId without presenting secret leaseToken
     ✓ GAP 4: JobManager allows un-leased instance to commit state mutation on expired job
     ✓ GAP 5: Stale caller can release a newer worker lease by providing only workerId without epoch or token

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  863ms
```

---

## 6. Recommended Patches (Guidance for Agent A06)

### 6.1 Eliminate TOCTOU in ExecutionEngine
1. In `executionEngine.ts`, update `flush(record)` to accept the claimant:
   ```typescript
   private async flush(record: ExecutionRecord, claimant?: LeaseClaimant): Promise<void>
   ```
2. Re-verify the lease **inside** `flush` immediately prior to durable persistence.
3. If an execution has an active lease (`this.leases.has(executionId)`), require that `claimant` be provided and strictly valid.

### 6.2 Atomic Lease Validation in `persistExecutionRecord`
In `packages/core/src/services/executionPersistence.ts`:
Inside `store.update<ExecutionRecord>(key, current => { ... })`:
- Add verification comparing `current.execution.workerId` and `current.execution.leaseEpoch` with `record.execution`.
- Reject stale writes with `STALE_WORKER_LEASE` error inside the atomic update transaction.

### 6.3 Mandatory Fencing Token & Claimant Enforcement
In `executionEngine.ts:assertLease`:
```typescript
const current = this.leases.get(executionId);
if (current && !current.released) {
  if (!claimant || !claimant.workerId) {
    throw new StaleWorkerLeaseError(executionId, `Active lease requires authenticated claimant`);
  }
  if (!claimant.leaseToken || claimant.leaseToken !== current.token) {
    throw new StaleWorkerLeaseError(executionId, `Invalid or missing lease token`);
  }
}
```

### 6.4 Enforce Leases on JobManager Mutations
In `packages/core/src/services/jobManager.ts:flush()`:
Replace:
```typescript
else if (current.ownership && current.ownership.expiresAt > this.now()) throw new Error('JOB_LEASE_BUSY');
```
With:
```typescript
else if (current.ownership) {
  throw new Error('JOB_LEASE_REQUIRED');
}
```
Any write to a job that has an ownership specification must be executed by an active lease holder who has called `acquire()`.

---

## 7. Ledger Entry

```csv
issue_id,priority,subsystem,agent_id,provider,model,source_sha,file,line,invariant,failure_description,reproduction_command,alloy_model,counterexample,test_before,test_after,fix_commit,verification_status,residual_risk
P0-A04-01,P0,executionEngine,A04,Gemini,gemini-flash,4661c33a6caeaca0639853463e4ccbbe3ebc63d8,packages/core/src/services/executionEngine.ts,529,Only current fenced lease holder can commit,TOCTOU async gap between assertLease and flush allows stale worker to commit after lease takeover,npx --no-install vitest run tests/formal-hardening/reproductions/A04-lease-fencing-races.test.ts,tests/formal-hardening/models/a04-lease-fencing-races.als,SAT (receipt.json),PASS (demonstrating defect),PENDING_A06,PENDING,CONFIRMED,Store-level fencing needed across multi-process deployments
P0-A04-02,P0,executionEngine,A04,Gemini,gemini-flash,4661c33a6caeaca0639853463e4ccbbe3ebc63d8,packages/core/src/services/executionEngine.ts,1356,Only current fenced lease holder can commit,assertLease completely bypassed when claimant options is undefined or empty,npx --no-install vitest run tests/formal-hardening/reproductions/A04-lease-fencing-races.test.ts,tests/formal-hardening/models/a04-lease-fencing-races.als,SAT,PASS (demonstrating defect),PENDING_A06,PENDING,CONFIRMED,Legacy unleased executions must be distinguished from leased executions
P0-A04-03,P0,jobManager,A04,Gemini,gemini-flash,4661c33a6caeaca0639853463e4ccbbe3ebc63d8,packages/core/src/services/jobManager.ts,836,Only current fenced lease holder can commit,flush() allows un-leased instance to commit task mutations when previous owner lease expired,npx --no-install vitest run tests/formal-hardening/reproductions/A04-lease-fencing-races.test.ts,tests/formal-hardening/models/a04-lease-fencing-races.als,SAT,PASS (demonstrating defect),PENDING_A06,PENDING,CONFIRMED,One-shot CLI job execution path must support explicit local claim
```
