# Wazir Release Notes - v0.1.64

**Release**: `v0.1.64`  
**Theme**: Cross-Process Protocol Transaction Integrity, Unknown-Outcome Reconciliation, Verification Provenance, and CLI/Runtime Defect Remediation

This release merges cross-process Agent Protocol and MCP transaction integrity hardening,
PostgreSQL and worker fault qualification (v0.1.63), and post-audit CLI and runtime defect
remediations with full live validation evidence.

## Cross-process task integrity

- **One authoritative task record.** Steps, artifacts and task status live in the task record and
  change only through one atomic store update (a file lock across processes for the JSON store, a
  locked transaction for Postgres). Two API processes no longer lose steps or artifacts, complete
  the same task twice, or let a long-running step overwrite changes made meanwhile. A store
  without atomic update is refused (`UNSUPPORTED_STORE`, HTTP 501).
- **One step in flight per task.** A step holds a heartbeat-renewed lease
  (`WAZIR_PROTOCOL_STEP_LEASE_MS`, default 120s). Another request waits up to
  `WAZIR_PROTOCOL_ADMISSION_WAIT_MS` (default 30s) and then gets HTTP 409 `TASK_BUSY`.
- A step held by a process that has died on the same host is recovered immediately; leases held
  from other hosts still expire after the lease period.
- **Optional `idempotency_key`** on a step request returns the original step instead of running
  the tool again.

## Unknown outcomes are never guessed

- If an API process dies before dispatching a tool, the step is recovered as `ABANDONED` and the
  task continues. If it dies after dispatch, or a tool reports an unknown outcome, the step is
  `OUTCOME_UNKNOWN` and the task is **paused**. Nothing is retried.
- New `POST /ap/v1/agent/tasks/:task_id/steps/:step_id/reconcile` (operator only) resolves a paused
  step as `succeeded`, `failed` or `not_executed`, and requires evidence. Reconciling never
  completes a task.
- A step's result, its verification evidence and the task status are saved in one write. If that
  write fails, the caller gets HTTP 503 `PERSISTENCE_FAILED` stating whether the tool was dispatched.

## Verification provenance and audit

- Verification records the workspace change counter, the requested checks and the principal. The
  global status reports `STALE` after any later mutating protocol tool call, and is never
  `verified: true` without a configured engine. A PASS is rejected if a requested check did not
  run or the workspace changed while checks ran.
- Verification is also bound to a fingerprint of the workspace's contents, so changes made outside
  the protocol (CLI agents, editors, git) make a PASS `STALE`. Calls refused by policy no longer
  count as workspace changes.
- Viewers reading tasks and steps see outcomes and statuses, but not tool inputs, tool output or
  check output. Viewers get verification statuses without check output.
- Every controlled tool result reports `dispatched` and `audit.recorded`. An audit write that fails
  after a tool ran is reported on the result and to stderr instead of being dropped. A failed
  pre-dispatch audit write is `AUDIT_UNAVAILABLE` and the tool does not run.

## CLI and runtime defect remediations

- **DEF-01 (`wa policy inspect`):** Fixed `TypeError` when policy rules omit optional `scope` or
  `pattern` fields by falling back to `rule.id` and `''`.
- **DEF-02 (`wa task status <id>`):** Look up real execution records instead of returning a stub
  `queued` status; exit with code `1` when the task ID is not found.
- **DEF-04 (`LMStudioAdapter`):** Default base URL now honors `WAZIR_LMSTUDIO_URL` and falls back to
  standard LM Studio port `http://localhost:1234/v1` (instead of port `1235`).
- **DEF-05 (CLI entity inspection exit codes):** `wa computers inspect`, `wa executions inspect`,
  `wa artifacts inspect`, `wa runtimes inspect`, and `wa models inspect` now exit with code `1` when
  the requested entity does not exist (`apps/cli/tests/cliDefectRemediation.test.ts`).
- Recorded live hardware & operational audit evidence under `test-results/live-audit-20261013/`.

---

# Wazir Release Notes - v0.1.63

**Release**: `v0.1.63`
**Theme**: PostgreSQL integration and production worker fault qualification

This release adds real PostgreSQL and production-process verification, with explicit
limits on distributed recovery guarantees. It includes the security and reliability
changes documented below for the previously unpublished v0.1.61 candidate.

Inherited security changes enforce operator/viewer authorization on Agent Protocol
and MCP mutations, route protocol tools through shared policy enforcement, persist
worker credentials before returning them, and require evidence for successful
completion. Provider stream resets have bounded retries and terminal worker result
posts are recorded once.

## Added and verified

- Mandatory Ubuntu PostgreSQL 16 CI integration in `postgres-distributed.yml`,
  using a disposable dedicated database. Missing configuration or an unreachable
  database fails the job. Tests refuse database names outside `wazir_*_test`.
- `npm run test:postgres`, `npm run test:distributed`, and dedicated test typechecks.
- Production API and two independent worker processes exercise registration,
  authentication, heartbeat, SSE dispatch, claims, SIGKILL, durable controller restart,
  and same-computer recovery. Retained evidence includes PID logs, exit signals,
  task IDs, lease attempts/deadlines, responses, and final outcomes.
- Authenticated stale results are rejected with HTTP 409 `LEASE_LOST` after expiry
  and replacement. Competing claims select one winner; duplicate result submissions
  preserve the first authoritative outcome, including acknowledgment loss/restart.
- Expired-renewal/claim races, surviving-worker reconnect, tasks running beyond the
  original lease deadline, and observable mutation-before-acknowledgment replay.

## Distributed safety limits

The production API does not automatically sweep missing workers or mark abandoned
expired dispatches failed/orphaned. A different computer cannot take over a dispatch;
recovery requires a replacement worker with the original computer identity.

Lease fencing protects result authority, **not exactly-once external execution**.
A crash after mutation but before acknowledgment can replay an opaque provider
request. The live test observes two effects without external idempotency and one
with it, in both cases with two executions and one authoritative result.
Known-tool `UNKNOWN_OUTCOME` unit handling remains covered, but is not automatic
physical reconciliation for opaque API dispatch. Distributed cancellation has no
public API, so its completion race is not qualified.

## Validation

Local Linux ARM64: build and repository/test typechecks passed; PostgreSQL 16.15
integration passed 20 tests; the complete distributed suite passed 17 tests.
Strengthened reconnect and beyond-original-deadline scenarios also passed.
The broad regression run passed 2,210 tests and found seven missing-native-PTY
failures; rebuilding `node-pty` resolved them and all eight affected tests passed
on rerun. Ordinary CI dependency installation builds the native module.

**CI verification:** [Release workflow](https://github.com/whassan007/wazir/actions/runs/38561969821)
passed all quality gates (2,217 tests passed; 44 intentional skips) and built all
six native targets. [PostgreSQL/distributed workflow](https://github.com/whassan007/wazir/actions/runs/38561969750)
passed 20 real PostgreSQL tests, 17 distributed tests, and 2,217 regression tests
(27 intentional skips). All eight release assets matched `SHA256SUMS.txt`; the
Linux ARM64 standalone binary reported `0.1.63`. Native manifests contain the
verified artifact hashes on `release/v0.1.63`.

Full report and reproduction: `tests/distributed/evidence-report.md` and
`tests/distributed/README.md`; actual traces: `tests/distributed/evidence/`.
No universal distributed-safety or exactly-once claim is made.

---

# Wazir Release Notes - v0.1.61

**Release**: `v0.1.61`  
**Theme**: Protocol Authorization, Unified Policy-Enforced Execution, and Evidence-Based Completion

A security and reliability release. Network clients of the Agent Protocol and MCP endpoints can
no longer act beyond their credential, every tool they reach runs through the same policy path as
coding agents, and a task is reported successful only when there is evidence for it.

## Security

- **Protocol authorization.** Viewer tokens are read-only on `/ap/v1` and `/mcp`. Creating
  tasks, executing steps, creating artifacts, `tools/call`, unknown JSON-RPC methods and batches
  containing them need operator scope (HTTP 403, JSON-RPC `-32001`). Caller identity comes only
  from the credential, never from the request body.
- **One policy-enforced tool path.** MCP and Agent Protocol tool calls now go through scope
  checks, a fixed protocol tool surface, schema validation, PolicyEngine with human approval
  (`ask` is denied when no approver is configured), test-file protection, workspace snapshots,
  timeout, cancellation on client disconnect, and a durable audit record written before dispatch.
  The direct `tool.execute()` fallback is removed.
- **Worker credentials** are persisted before they are returned; revocation and unreadable
  credential stores fail closed.

## Truthful completion

- A failed, denied, cancelled or timed-out tool fails its step and the parent task, whatever
  `is_last` says. Text-only steps are recorded as `RECORDED`, not as executed work.
- Verification runs the project's checks through the same tool path. PASS needs at least one
  check actually run, all passing, bound to the step, with a workspace revision hash.
  `wazir://verification/status` no longer reports `verified: true` without that evidence.
- Finished tasks reject late or duplicate steps (409); steps are serialized per task.

## Reliability

- Tool receipts fingerprint the tool name and input (previously every call hashed the same) and
  never cache failed attempts; duplicate worker result posts are recorded once.
- Model streams cut by a transport reset are re-requested (up to 2 times).
- Checkpoint boundary validation, provider fault tests, a recovery-process test and a reliability
  benchmark workflow.

**Verification:** locally on Linux ARM64 — build, typecheck, `npm test`, `test:agent`,
`test:plan:acceptance` (80/80) and `release:gate` pass; 35 black-box protocol security tests.


---

# Wazir Release Notes - v0.1.59

**Release**: `v0.1.59`  
**Theme**: Heterogeneous Fleet Execution, Durable Recovery, and Production Cross-Platform Release Validation

---

## Highlights

### 1. Heterogeneous Fleet Execution Across 6 Platform Pairs
- Validated distributed controller-to-worker dispatch and streaming execution across all cross-platform permutations:
  - macOS controller -> Linux worker (including ARM64 DGX Spark)
  - Windows controller -> Linux worker
  - Linux controller -> Windows worker
  - macOS controller -> Windows worker
  - Windows controller -> macOS worker
  - Linux controller -> macOS worker
- Full token-authenticated SSE streaming, remote cancellation, and outcome collection.

### 2. Linux ARM64 NVIDIA DGX Spark Support
- Hardware discovery engine hardened for ARM64 Cortex-X925/A725 CPUs without traditional `/proc/cpuinfo` `model name` fields using `lscpu`.
- Deep integration for the NVIDIA GB10 Blackwell GPU with Address Translation Services (ATS), GPU Chip-to-Chip (C2C) interconnect, and 122 GB host-GPU unified memory.

### 3. Resource-Aware Heterogeneous Scheduling
- OS platform and CPU architecture affinity (+1.5 OS match, +1.0 architecture match).
- CUDA accelerator routing (+2.0 for NVIDIA CUDA capability match, +0.5 for unified memory).
- Hard rejection of incompatible workloads (preventing CUDA tasks from routing to non-CUDA machines or macOS tasks to Windows machines).

### 4. Durable Recovery and Split-Brain Fencing
- WAL-backed durable task dispatch and claim leases with unique cryptographically random tokens.
- Fencing of stale / expired leases (`LEASE_LOST`), preventing stale result commitments; external effects require idempotency or reconciliation.
- RecoveryManager provides orphan handling for known executions; the production API dispatcher still requires integration for automatic abandoned-task reconciliation.

### 5. Automated Release Validation Gate
- `scripts/release-gate.mjs` provides strict validation across all 8 capability categories: Installation, Build, CLI, Agents, Persistence, TUI, Fleet, and Recovery.
- Multi-platform matrix reporting with strict no-false-PASS semantics.

---

## Upgrade Instructions

### Linux / macOS
```bash
npm install -g wazir@0.1.59
# Or download native standalone binary
curl -LO https://github.com/whassan007/wazir/releases/download/v0.1.59/wazir-v0.1.59-linux-arm64.tar.gz
```

### Windows
```powershell
npm install -g wazir@0.1.59
# Or download native wa.exe
Invoke-WebRequest https://github.com/whassan007/wazir/releases/download/v0.1.59/wazir-v0.1.59-windows-x64.zip -OutFile wazir.zip
```
