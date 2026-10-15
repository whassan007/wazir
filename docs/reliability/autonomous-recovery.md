# Autonomous recovery, verification and failure feedback

Branch `reliability/autonomous-recovery` (base `release/v0.1.64` @ `d0bd587`).

This builds on mechanisms that already existed rather than replacing them:

| Existing mechanism | Where | Status before this branch |
| --- | --- | --- |
| Failure taxonomy (`FailureClass`, `classifyFailure`) | `packages/shared/src/failure.ts` | Used by providers only; the job orchestrator ignored it |
| Provider retry/backoff | `packages/shared/src/retry.ts` | Per HTTP request only |
| Agent stop conditions, repair cycles, protocol budget, model escalation | `packages/agents/src/codingAgent.ts`, `stopConditions.ts` | Unchanged |
| Deterministic evaluation, completion evidence gate | `packages/evaluation/src/index.ts`, `ExecutionEngine.setStatus` | Unchanged; now surfaced per task and per job |
| Tool intent/receipt, unknown-outcome reconciliation | `executionEngine.ts`, `recoveryManager.ts`, `executionRecovery.ts` | Unchanged |
| Job ownership leases, crash re-claim | `jobManager.ts` (`acquire`/`renew`) | Extended (cancel-on-acquire) |
| Lifecycle transition guards, receipt fingerprint v3, worker result redelivery | branch `hardening/p1-durable-correctness` | **Never merged**; merged here |
| Dispatcher replay bound (D1) and token-fenced late commit (D2) | `tests/reliability/integration-patches/workstream1-dispatcher.patch` | **Never applied**; applied here |

## Recovery controller (job orchestrator)

`packages/core/src/services/taskRecoveryPolicy.ts` classifies every failed task attempt into
one of: `transient_infrastructure`, `model_protocol`, `code_or_test`, `tool_or_policy`,
`resource_budget`, `nonrecoverable`, `cancelled`, or `unclassified`. Structured fields
win over text, in this order: `terminationReason`, then `failureClass`, then `errorKind`.
For legacy executors it falls back to upper-case taxonomy tokens in the error text, and
then to the old "policy/denied" text sniffing.

| Category | Decision |
| --- | --- |
| transient_infrastructure | retry, exponential backoff with jitter (default 0.5s base, 30s cap), cancellable |
| model_protocol, code_or_test | immediate retry; stop early on no progress |
| unclassified | immediate retry (legacy behaviour, kept for compatibility) |
| tool_or_policy, resource_budget, nonrecoverable, cancelled | **stop**: never retried, never replanned |

Invariants:

- Every decision is bounded by `maxRetries`. Retry counts are persisted on the node, and
  `JobManager.acquire` counts an attempt interrupted by a crash, so a restart never resets
  the budget.
- A budget, policy, approval, auth or quota stop is never retried or replanned. Either
  would silently reset the boundary that stopped the task.
- No progress: when the same normalised failure signature repeats more than twice in a
  row (`maxIdenticalFailures`, default 2), the task stops with reason `no_progress`.
- Replanning is bounded by lineage depth (`JobRunOptions.maxReplanGeneration`, default 2).
  Previously, a repair task that failed could be replanned without limit.
- Each decision (`TaskAttemptRecovery`) is persisted on the attempt *before* the backoff
  wait, so a crash mid-wait keeps the diagnostics. It is also emitted as a `task:recovery`
  event.

The orchestrator's four copy-pasted retry blocks were replaced by one `handleFailedAttempt`.

## Verification lifecycle

The execution layer already refuses `completed` without current-revision evidence. The
gaps were at the task and job level:

- `buildTaskVerificationReport` (`verificationReport.ts`) turns the deterministic
  evaluation into a `TaskVerificationReport`. The report keeps four results separate:
  `modelReportedSuccess`, `toolExecutionSuccess`, `testSuccess` and `evaluationSuccess`.
  It also lists per-criterion results with their evidence, and gives a verdict of
  `VERIFIED`, `FAILED`, `INCONCLUSIVE` (nothing checkable) or `BLOCKED` (cancelled or
  policy).
- The fleet executor (`apps/cli/src/fleetRunner.ts`) attaches the report to the task
  outcome and records it as a `verification.report` execution event.
- `enforceVerification` (in the orchestrator): a `FAILED` or `BLOCKED` report always
  overrides `success: true`. `INCONCLUSIVE` passes by default, for compatibility with
  read-only tasks. With `JobRunOptions.requireVerifiedCompletion`, it fails instead.
- When a job settles, `job.verification` (a `JobVerificationReport`) is persisted with the
  final status. It covers every task: verdict, attempts, recovery decisions and whether
  the task was superseded by a repair plan. Executors that produce no report are shown as
  `UNVERIFIED`, never as `VERIFIED`.

CLI: `wa jobs verification <id>` prints the report. It exits 2 unless the verdict is
`VERIFIED`.

## Recovery fixes

- **Cancel during unowned window:** a cancel requested while the previous owner held the
  lease, if that owner died before acting on it, was ignored, and recovery ran the
  task anyway. `JobManager.acquire` now applies the request in the same atomic update and
  `runJob` returns the cancelled job.
- **Repair task id collision:** two replans in the same millisecond generated the same task
  id, so the second repair task reused an already settled node. Ids now include random bits,
  and a duplicate id is rejected.
- **Dispatcher (D1/D2):** remote redelivery stops after 5 attempts with
  `DELIVERY_ATTEMPTS_EXHAUSTED`. The holder of the latest lease token may commit a finished
  result after the lease lapses, as long as nobody claimed since.

## Controlled self-improvement feedback

`FailureFeedbackLog` (`failureFeedback.ts`) writes one record per task that failed at least
once, when its job settles. Each record holds: signature, category, failure class or
termination reason, model, runtime and computer, task type, the recovery strategies tried,
attempts, whether the task recovered, the verification verdict, whether it was regression
free (tests), and token usage. Retention is bounded (500 records) in the existing
`KeyValueStore`; no new database. Re-recording the same job and task is idempotent.

- `incidents()` returns `{source, kind, summary}`, the shape a self-improvement
  supervisor's `observe()` consumes.
- `proposeCandidates()` returns inert `ImprovementCandidate`s. Each has a measurable
  hypothesis (signature recurrence rate must drop below half its baseline). Its target
  prefers prompt, routing or retry-policy changes over core changes, and all five gates
  are required.
- `judgeImprovementCandidate()` rejects a candidate that is missing any gate (including
  protected-merge authorization), has fewer than 5 runs per arm, lowers the
  verified-completion rate, or does not reduce recurrence. It has no override.

The module never edits code, prompts, routing or policy, so it cannot bypass those gates.

CLI: `wa jobs feedback [--min N] [--candidates]`.

## Known limitations

- `INCONCLUSIVE` still completes a job unless `requireVerifiedCompletion` is set. Making it
  fail by default would break read-only and analysis tasks.
- Failure classification of free-text errors from legacy or custom executors stays
  `unclassified` and keeps the old bounded retry.
- `ApprovalQueue` is in memory. After a restart a pending approval is not restored: the
  recovered task goes back through the policy gate and asks again (fail closed). This is
  tested in-process, not with real process kills.
- Backoff holds the task's concurrency slot while it waits.
- Feedback is written when a job settles. A process killed before then leaves the evidence
  on the job's persisted attempts, not in the feedback log.
