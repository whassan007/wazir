# Wazir Release Notes - v0.1.62

**Release**: `v0.1.62`  
**Theme**: Cross-Process Protocol Integrity, Unknown-Outcome Reconciliation, and Verification Provenance

A reliability release for the Agent Protocol and MCP endpoints when several API processes share
one store. It also includes everything listed under v0.1.61, which was never published separately.

## Cross-process task integrity

- **One authoritative task record.** Steps, artifacts and task status live in the task record and
  change only through one atomic store update (a file lock across processes for the JSON store, a
  locked transaction for Postgres). Two API processes no longer lose steps or artifacts, complete
  the same task twice, or let a long-running step overwrite changes made meanwhile. A store
  without atomic update is refused (`UNSUPPORTED_STORE`, HTTP 501).
- **One step in flight per task.** A step holds a heartbeat-renewed lease
  (`WAZIR_PROTOCOL_STEP_LEASE_MS`, default 120s). Another request waits up to
  `WAZIR_PROTOCOL_ADMISSION_WAIT_MS` (default 30s) and then gets HTTP 409 `TASK_BUSY`.
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

## Verification provenance

- Verification records the workspace change counter, the requested checks and the principal. The
  global status reports `STALE` after any later mutating protocol tool call, and is never
  `verified: true` without a configured engine. A PASS is rejected if a requested check did not
  run or the workspace changed while checks ran.
- Viewers get verification statuses without check output.

## Audit

- Every controlled tool result reports `dispatched` and `audit.recorded`. An audit write that fails
  after a tool ran is reported on the result and to stderr instead of being dropped. A failed
  pre-dispatch audit write is `AUDIT_UNAVAILABLE` and the tool does not run.

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
- Fencing of stale / expired leases (`LEASE_LOST`), strictly preventing duplicate execution side effects.
- Automatic orphan sweep and safe re-dispatch when workers crash or disconnect.

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
