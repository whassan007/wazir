# Changelog

## v0.1.64 — 2026-10-14

**Release**: `v0.1.64`
**Theme**: Cross-Process Protocol Transaction Integrity, Unknown-Outcome Reconciliation, Verification Provenance, and CLI/Runtime Defect Remediation

This release merges cross-process Agent Protocol and MCP transaction integrity hardening,
PostgreSQL and worker fault qualification (v0.1.63), and post-audit CLI and runtime defect
remediations with full live validation evidence.

### Cross-process task integrity

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

### Unknown outcomes are never guessed

- If an API process dies before dispatching a tool, the step is recovered as `ABANDONED` and the
  task continues. If it dies after dispatch, or a tool reports an unknown outcome, the step is
  `OUTCOME_UNKNOWN` and the task is **paused**. Nothing is retried.
- New `POST /ap/v1/agent/tasks/:task_id/steps/:step_id/reconcile` (operator only) resolves a paused
  step as `succeeded`, `failed` or `not_executed`, and requires evidence. Reconciling never
  completes a task.
- A step's result, its verification evidence and the task status are saved in one write. If that
  write fails, the caller gets HTTP 503 `PERSISTENCE_FAILED` stating whether the tool was dispatched.

### Verification provenance and audit

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

### CLI and runtime defect remediations

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

## v0.1.63 — 2026-10-14

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

### Added and verified

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

### Distributed safety limits

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

### Validation

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

## v0.1.61 — 2026-10-13

A security and reliability release. Network clients of the Agent Protocol and MCP endpoints can
no longer act beyond their credential, every tool they reach runs through the same policy path as
coding agents, and a task is reported successful only when there is evidence for it.

### Security

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

### Truthful completion

- A failed, denied, cancelled or timed-out tool fails its step and the parent task, whatever
  `is_last` says. Text-only steps are recorded as `RECORDED`, not as executed work.
- Verification runs the project's checks through the same tool path. PASS needs at least one
  check actually run, all passing, bound to the step, with a workspace revision hash.
  `wazir://verification/status` no longer reports `verified: true` without that evidence.
- Finished tasks reject late or duplicate steps (409); steps are serialized per task.

### Reliability

- Tool receipts fingerprint the tool name and input (previously every call hashed the same) and
  never cache failed attempts; duplicate worker result posts are recorded once.
- Model streams cut by a transport reset are re-requested (up to 2 times).
- Checkpoint boundary validation, provider fault tests, a recovery-process test and a reliability
  benchmark workflow.

**Verification:** locally on Linux ARM64 — build, typecheck, `npm test`, `test:agent`,
`test:plan:acceptance` (80/80) and `release:gate` pass; 35 black-box protocol security tests.

## v0.1.60 — 2026-10-12

A cross-platform fleet and distribution release. Wazir can run work across heterogeneous
machines with platform-aware process cleanup, and now ships release artifacts and native
install paths for more operating systems.

### Added

- **Cross-platform agent and worker execution** with Windows process-tree cleanup, executable
  resolution, filesystem handling and hardware discovery across Linux, macOS and Windows.
- **Heterogeneous fleet scheduling** that matches tasks to registered workers and their runtime
  capabilities.
- **Native package distribution** for npm, standalone archives, Homebrew, Scoop, WinGet,
  Debian and RPM, with package checks, release verification, SBOM generation and checksums.
- **Container and service support** with Docker Compose, Debian/RPM service integration and
  platform worker setup guides.
- **Agent configuration discovery** for local Codex, Claude Code and Antigravity CLIs, with
  configuration provenance, project trust boundaries and bounded connection checks.

### Security and compatibility

- Existing vendor CLI sessions are tested through their own executables; authentication tokens
  are not imported into Wazir.
- Codex uses its native CLI in a read-only sandbox because the pinned ACP bridge did not support
  the installed model. Write tasks through this fallback are unavailable.
- Release artifacts are built on Linux x64/ARM64, macOS ARM64/x64 and Windows x64/ARM64 runners.

**Verification:** CI passed on Linux x64, macOS ARM64 and Windows x64 (Node 22), including
build, typecheck, distribution/package checks, 2,138 unit and integration tests (18 skipped),
acceptance and agent execution plans, native installer smoke tests and standalone binary checks.
The full run is [CI #38357922769](https://github.com/whassan007/wazir/actions/runs/38357922769).
A local Linux run also passed the same 2,138-test suite. Agent discovery tests used controlled
CLI fixtures; provider live execution was not part of this release validation.

## v0.1.59 — 2026-10-12

A reliability release. Delegated agents are now judged on evidence Wazir gathers itself, not
on their exit code; agents no longer outlive a crashed `wa`; and budget reservations survive
long delegations. Full audit: `docs/audits/WAZIR_HARDENING_v0.1.58.md`.

**Verification:** locally 2072 tests pass, 0 fail (18 skipped); typecheck clean. Live on the
DGX Spark: an Antigravity delegation was verified by Wazir running the project's tests itself;
a Codex delegation failed correctly (codex-cli 0.157.1 is too old for its default model). New
multi-process tests race six real processes on one ledger. Not tested: benchmarks, network
partitions, GPU saturation, agent failover (not implemented).

### ⚠️ Behaviour changes

- **Delegated tasks are verified by Wazir.** After a delegated agent runs, Wazir records the
  files it changed and, when source changed, runs the project's npm `build`, `typecheck`,
  `lint` and `test` scripts itself. The task fails if a check fails, if no check exists, if
  the agent weakened tests (removed assertions or test cases, added skips, deleted tests), or
  if it edited a check script in `package.json`. Previously an exit code of 0 was enough.
  Projects without npm scripts that change source now fail with "no checks were executed".
- **Executions left running by a dead process are marked failed** (`INTERRUPTED`) when the
  next `wa` starts, instead of staying `running` forever.
- **An unknown limit with `unknownLimitPolicy: "deny"` is blocked**, not deferred: waiting
  never makes the limit known.

### Added

- `wa resources validate [--profile production] [--json]` checks policy, account mappings,
  unknown vs unlimited limits, pricing and spend ceilings, and previews admission per account
  without reserving anything. `--profile production` exits 1 unless enforcement is on and every
  non-local account is explicitly configured with known limits. It never changes policy.
- `wa agents check` reports **DEGRADED** when an agent answers the probe but its latest real
  task failed in the agent, and shows each agent's last task and last verified task.

### Fixed

- A delegated agent (and any command it started) is killed when `wa` itself dies (SIGKILL,
  OOM, closed terminal), for both CLI and ACP agents. Before, it kept editing the workspace.
- Budget reservations for delegations and silent generations renew on a timer, so a run
  longer than `leaseMs` (15 min) is no longer settled mid-flight and dropped from concurrency limits.
- Concurrent recovery of one expired reservation records one `expired` event, not one per process.
- The test-weakening detector counts `assert.strictEqual(...)`-style assertions.

## v0.1.58 — 2026-10-12

A delegation and resource-orchestration release. Wazir can hand a task to Claude Code, Codex,
Qwen Code, Gemini or Antigravity, checks those agents before use, and puts every model request
through one budget-aware gate with a persistent ledger and a resource dashboard.

**Verification:** CI (build, typecheck, test) passes on PR #3 and PR #4. Locally 2053 tests
pass, 0 fail (18 skipped: PostgreSQL, bwrap sandbox and live lifecycle infrastructure);
acceptance gates 80/80 PASS. Live on the DGX Spark: governed LM Studio requests recorded with
provider-reported usage; an Antigravity delegation fixed a bug end to end; governance overhead
+0.14 ms p50 per request. Not tested live: paid APIs, Claude Code and Codex subscriptions,
vLLM, Ollama.

### ⚠️ Behaviour changes

- **Every model request is recorded** in `~/.wazir/resources.db` (SQLite, WAL). Set
  `WAZIR_IN_MEMORY=1` to keep it in memory.
- **Limits are not enforced by default.** `policy.enforce` is `false`: usage is estimated,
  recorded, routed and shown, but nothing is refused for budget reasons. Set
  `"enforce": true` in `~/.wazir/resources.json` to enforce quotas, spend ceilings, GPU
  concurrency and cooldowns. The emergency stop (`wa resources stop`) applies either way.
- **Routing prefers already-loaded local models** over ones that need a load or a reload.

### Added

- **Delegation to external coding agents:** `wa run --agent <name>` for Claude Code, Codex,
  Qwen Code, Gemini and Antigravity, through their own CLIs and logins. Second logins run as
  instances such as `claude-code@work`.
- **`wa agents check`:** preflight for delegated agents (installed, version, signed in).
- **Resource orchestration:** account registry (local, API, subscription), token budget
  manager with advisory/conserve/critical/exhausted modes, reservations reconciled against
  provider-reported usage, idempotent settlement, lease recovery after a crash, and an
  append-only audit trail.
- **Resource-aware routing** inside the existing scheduler: quality, reliability, capacity,
  cost, latency and quota risk, weighted by mode (`balanced`, `local-first`,
  `quality-first`, `budget-first`).
- **DGX Spark capacity probe:** GPU, temperature, power, unified memory, LM Studio, Ollama
  and vLLM state.
- **`wa resources`:** dashboard (`--watch`, `--json`) plus `init`, `validate`, `stop`,
  `resume`, `reset`, `explain` and `events`.
- **Structured provider failures:** auth, quota, rate limit (with `Retry-After` and
  rate-limit headers), server and context overflow; cache and reasoning token usage.
- Docs: `docs/resources/` (architecture, runbook, test report, limitations) and
  `scripts/bench-resource-governor.mjs`.

### Fixed

- Delegating to an external agent no longer tries to load a local model first.
- External agent exit errors include the agent's last output.

### Known limitations

- `wa ask` is governed but bypasses resource-aware routing.
- Subscription usage is estimated: vendor CLIs report no token counts.


## v0.1.57 — 2026-10-12

A persistence release. Checkpoints and long-term memory now survive restarts, the coding
agent keeps native tool-call history, and the web dashboard is no longer exposed beyond
localhost by default.

**Verification:** from a clean checkout, every CI step passes: build, typecheck, dist
check; 1964 tests pass, 0 fail (18 skipped:
PostgreSQL, bwrap sandbox and live lifecycle infrastructure); acceptance gates
80/80 PASS, verdict READY FOR RELEASE. Live (LM Studio `qwen/qwen3.8-27b`): every
`wa run` outcome matched an independent `npm test`.

### ⚠️ Behaviour changes

- **Node.js ≥ 22.5 is now required** (was ≥ 20). `@wazir/memory` uses the built-in
  `node:sqlite`, first shipped in 22.5, and Node 20 reached end-of-life on 2026-04-30.
  The install script, `engines` field, CI matrix and Docker images (`node:22-alpine`)
  are updated to match.
- **Web dashboard binds `127.0.0.1` by default.** Set `WAZIR_WEB_HOST=0.0.0.0` to
  restore network access.
- **A corrupt or unsupported persisted checkpoint stops engine startup** with
  `INVALID_CHECKPOINT` or `CHECKPOINT_DIGEST_MISMATCH` naming the record. Wazir fails
  closed rather than overwrite evidence. Move the named record aside to recover.
- **`integrations/ai-test-harness/install.sh` requires the pinned upstream revision**
  listed in `upstream-revisions.json`.

### Added

- **Durable checkpoints:** persisted to the host store with a version and digest,
  restored and verified at startup.
- **Durable episodic and procedural memory** in the SQLite store, reloaded on startup.
- **Native tool-call history in the coding agent:** provider call IDs are kept through
  assistant and tool messages, and a plain-text final answer from a native
  function-calling provider is accepted, subject to the usual verification.
- **Pinned upstream revisions** for ai-test-harness and Qwen-Live-Harness.

### Fixed

- **Clean builds failed** (TS2307 `Cannot find module '@wazir/memory'`), breaking every
  CI run of `main`: `core` and `evaluation` imported `@wazir/memory` without declaring
  it. A stale local `dist/` hid this. CI now passes from a clean checkout.
- A parallel batch of tool calls (common with Qwen models) aborted the whole run. It
  is now rejected as one invalid attempt: nothing in it executes, and the model is
  asked to issue one call. Live runs with 3 and 6 batches completed.
- The web dashboard never timed out stalled API requests, and kept proxying after the
  client disconnected.
- Checkpoint digests could collide for different path/content pairs.

## v0.1.56 — 2026-10-12

A reliability release. It adds the Qwen-Live-Harness integrations and fixes 22 defects
found by a stability audit and by running Wazir through
[schubergphilis/ai-test-harness](https://github.com/schubergphilis/ai-test-harness)
against a live local model.

**Verification:** typecheck and build pass; 1957 tests pass, 0 fail (18 skipped:
PostgreSQL, bwrap sandbox and live lifecycle infrastructure); acceptance gates
80/80 PASS, verdict READY FOR RELEASE.

### ⚠️ Behaviour changes

- **ACP permission requests now fail closed.** An `AcpClientAdapter` without an
  `onRequestPermission` resolver denies every request; previously it auto-approved.
- **Environment variables override `config.json`** for `WAZIR_OLLAMA_URL`,
  `WAZIR_LMSTUDIO_URL`, `WAZIR_API_URL`, `WAZIR_API_TOKEN` and
  `WAZIR_REGISTRATION_TOKEN`.
- **Reasoning is no longer part of model answers.** OpenAI-compatible / LM Studio
  streams emit model thinking as separate `reasoning` events. A reasoning model that
  runs out of tokens while thinking now returns an empty answer with
  `finishReason: 'length'` instead of its chain-of-thought.

### Added

- **Qwen-Live-Harness integration:** ACP client adapter (stdio delegation to Qwen
  Code, Claude Code, Codex, Gemini CLI), Subagents Ledger, Permission Broker, Tool
  Receipts, and a SQLite memory store with lexical ranking and time decay.
- **ai-test-harness integration** (`integrations/ai-test-harness/`): runs Wazir under
  the same compat-contract, Inspect and behaviour-scenario suites as Strands and other
  reference harnesses.
- **`/canary` view** in Mission Control (tabs, history selection), which existed but
  was unreachable.
- **`WAZIR_LMSTUDIO_API_KEY`** for authenticated OpenAI-compatible endpoints (LiteLLM,
  vLLM `--api-key`, LM Studio with auth).
- **`finishReason`** on `completed` runtime events (`content_filter`, `length`, …,
  or `cancelled` when the stream was aborted).
- **Acceptance gates G97–G100** (semantic strategy retrieval, false-positive control,
  cross-language transfer, anti-strategy). The harness reports `UNDEFINED` and `ERROR`
  separately from `FAIL`.

### Fixed

**Security and safety**
- ACP delegated agents were auto-approved when no operator decided. ACP options are
  now classified by their protocol `kind`, so a reject option labelled "No" is no
  longer read as approve.
- Mission Control `why …` explanations showed fabricated hashes, benchmark scores and
  health values. They now report only observed state, or `UNKNOWN`.

**Lifecycle and cancellation**
- External agent harnesses ignored cancellation until exit (up to 10 min), and their
  timeout never ended the run because child processes held the output pipe open.
  Cancellation now takes about 360 ms and kills the whole process tree.
- `cancelTask` on a finished task overwrote `completed` with `cancelled`.
- Provider streams are aborted when the consumer stops reading, so local models no
  longer keep generating.
- ACP: a missing executable or a failed turn crashed the host process. `initialize`
  is now bounded by a timeout.
- A job deleted while running was re-added to the TUI when it finished.

**Accuracy**
- All five provider adapters corrupted multi-byte UTF-8 (emoji, Arabic, CJK) split
  across stream chunks.
- Model reasoning leaked into answers and corrupted them. Seen live: "Answer
  8888888." + "8888888" was read as `88888888888888`.
- Tool results are sent in the native tool-call format when call IDs are known,
  instead of always as user text.

**Persistence and availability**
- One model that could not be inspected (e.g. LM Studio holding two instances of it)
  took the whole runtime offline, so every `wa run` failed. Only that model is now
  marked unavailable.
- Worker task streams leaked (registration and keep-alive timer) when a worker
  disconnected during subscribe.
- SQLite memory search could never return segments older than the newest 100.
- `config.json` silently overrode `WAZIR_*` environment variables, which broke the
  documented container setup.
- Ollama model listing could hang without a timeout.
- The acceptance harness crashed on undefined gates and on an absolute `--report`
  path.

### Docs

- `docs/audits/`: baseline, code audit, repairs, functional tests, performance,
  remaining risks and external-harness results.

### Known issues

See `docs/audits/WAZIR_REMAINING_RISKS.md`. In short: API dispatch records have no
retention policy; ACP is not yet wired into any CLI path; the tool sandbox needs
unprivileged user namespaces (unavailable on some Ubuntu hosts).

## v0.1.55 — 2026-09-24

Canary stage transitions refined; TUI prompt hotkey handling fixed.

## v0.1.54

TUI navigation hotkeys refined.
