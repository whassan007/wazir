# Wazir — Progress

Single source of truth for where the project stands. Supersedes the old
`WAZIR_PRODUCTION_READINESS_REVIEW.md`, `WAZIR_REMEDIATION_PROGRESS.md`, and
`WAZIR-RELEASE.md` (all deleted — their content is folded in below; full detail
is still in git history if needed: `git log --all --full-history -- '*READINESS_REVIEW*' '*REMEDIATION_PROGRESS*'`).

**Status as of 2026-09-18**: Beta / internal-deployment ready. Safe for a
single trusted operator or internal team on hardware they already control,
and — after the security remediation pass (`sec_review_results.md`, Part 4)
— for a distributed deployment behind a TLS proxy with `WAZIR_API_TOKEN` and
`WAZIR_REGISTRATION_TOKEN` set. **Not** safe for untrusted multi-tenant use
or public-internet exposure yet — see "Open work" below.

## Done

**Security & execution (was Phase 1)**
- Shell policy parser (`packages/core/src/services/policyEngine.ts`) parses the
  full command line with `shell-quote` and classifies every sub-command,
  pipe, redirect, and substitution independently, closing a command-chaining
  bypass. `node`/`npm`/`npx`/`yarn`/`pnpm`/`bun` require approval instead of
  being auto-allowed.
- Check-tool (`packages/tools/src/process-tools.ts`) only runs a `script` name
  that already exists in the project's `package.json`; no free-form shell text.
- Symlink path-traversal past the project root closed (`assertInsideProject`
  in `packages/tools/src/paths.ts` checks both the lexical and
  `fs.realpath`-canonicalized path).
- `wa task run` actually executes: `planTask` → policy + context budget +
  `Scheduler.plan()` → real execution record → policy-gated agent loop.
- Regression tests: `packages/tools/tests/security.test.ts`,
  `packages/core/tests/policyEngineShell.test.ts`.

**Distributed control plane (was Phase 2)**
- Real worker task-pull loop: `GET /computers/:id/tasks/stream` (SSE) +
  dispatch/status/report routes in `apps/api/src/server.ts`, backed by a
  `TaskDispatcher` that queues for not-yet-connected computers and delivers
  immediately to open streams. `packages/workers/src/worker.ts` executes
  dispatched work and reports events/outcome back, with reconnect on drop.
- Removed the dead duplicate API entrypoint (old `apps/api/src/index.ts`
  prototype); all routing lives in `main.ts` / `server.ts`.
- Fixed `JobOrchestrator` creating a fresh `JobManager` per call (state never
  persisted); it now holds one shared instance.
- Full Rook → Wazir rebrand across code, docs, and packaging.
- CLI binary renamed `wazir` → `wa` (product name, `@wazir/*` package scope,
  and `WAZIR_*` env vars unchanged — only the invoked command changed).

**Persistence & testing (was Phase 3)**
- Postgres-backed `KeyValueStore` (`packages/database`: `createPool`,
  `checkHealth`, `runKvMigration`, `PostgresStore`), verified live.
- `JsonFileStore` (`packages/shared/src/store.ts`): dependency-free
  cross-process file lock with stale-lock recovery, proven with real separate
  OS processes; parent-directory creation fixed for fresh installs; `Date`
  fields now revived after JSON round-trips (both this store and
  `PostgresStore` — this was a real pre-existing bug, not a remediation item).
- Real end-to-end agent test suite (fake `RuntimeAdapter`, real policy
  denials, real deterministic verification loop) replacing tautological
  placeholder tests.
- Docker (4 targets) + Compose, systemd units, launchd plist — all actually
  built and run, not just reviewed as text.

**Shell UX — command history, context, references (phases A–C of a separate spec)**
- `wa history` / `wa doctor` persist `Block` records
  (`apps/cli/src/blocks.ts`, `packages/core/src/types/block.ts`).
- `wa context add/remove/list/clear` — active context feeds into
  `planTask()`'s token budget (`apps/cli/src/commands.ts`, `apps/cli/src/run.ts`).
- `@block` / `@job:` / `@agent:` / `@model:` / `@computer:` / `@file:`
  reference resolution (`apps/cli/src/references.ts`) and `wa explain <ref>`.
- Fleet TUI (`wa chat` / `wa fleet`) and DAG-aware concurrent job execution
  with retries, cancellation, and steering (`packages/core/src/services/jobOrchestrator.ts`).

**External agents**
- `ExternalAgentAdapter` (`packages/agents/src/externalAgent.ts`) is now wired
  in: `apps/cli/src/engine.ts` registers an `opencode` agent when the
  `opencode` binary is detected on `PATH`, reachable only via explicit
  selection (`wa task run "..." --agent opencode`) — `taskTypes: []` keeps it
  out of automatic routing, so installing OpenCode can't silently change
  where an un-pinned task lands. Not exercised against a real OpenCode
  session in this pass (would require live provider credentials); the
  invocation shape (`opencode run <message>`) is verified against
  `opencode --help`, not a live run.

**Licensing & docs**
- Relicensed MIT → AGPL-3.0 (network-use copyleft).
- Root `README.md` rewritten for accuracy (e.g. `apps/api` is Express, not
  Fastify; `packages/database` is hand-written SQL + `pg`, not Prisma), plus
  per-package READMEs for `apps/api`, `apps/cli`, `apps/worker`,
  `packages/agents`, `packages/core`, `packages/database`, `packages/workers`.

**Security remediation (2026-09-18)** — `sec_review.md` → `sec_review_results.md`
(28 findings, 2 CRITICAL) → all fixed/hardened/accepted; results in Part 4 of
that file. Highlights: per-computer + operator bearer tokens on the control
plane, loopback-only Compose with required tokens, policy engine hardened
against newline injection / host reads / exec & output flags / git config
tricks / protected-path writes, approval queue timeout and env-gating, minimal
child env + secret redaction + escape stripping, `0600` store, crypto ids,
`npm run check-dist` in CI. 48 test files / 470 tests green.

## Open work

Remaining work centers on runtime isolation and second-pass verification.

### Completed Hardening Steps

1. **Mandatory API Tokens & Worker Token Persistence** (Done).
   - Tokens are required on API endpoints unless `WAZIR_ALLOW_UNAUTHENTICATED=1` is explicitly set.
   - Worker token hashes (SHA-256) are persisted via `KeyValueStore` under `auth:computer:<id>` so workers survive API restarts without re-registration.
   - `wa doctor` inspects cluster tokens and warns if running unauthenticated.
   - `tests/integration/trackedSecurityDebt.test.ts` asserts 401 on unauthenticated access.
2. **RBAC Operator vs Viewer Scopes** (Done).
   - Scopes split into `operator` (dispatch, write) and `viewer` (read inventory, history, metrics).
   - `WAZIR_API_VIEWER_TOKEN` configured and enforced; viewer tokens are rejected with 403 on task dispatch.
3. **Native TLS** (Done).
   - Native HTTPS support in `apps/api/src/main.ts` via `WAZIR_TLS_CERT` and `WAZIR_TLS_KEY`.
4. **Append-Only JSONL Audit Log & Policy Command** (Done).
   - `appendAuditEvent` and `readAuditEvents` in `@wazir/shared` enforcing file mode `0600` and directory mode `0700`.
   - Wired into `ExecutionEngine.recordPolicy()`, `ApprovalQueue`, and `PolicyEngine` interactive approver.
   - Added `wa audit` command to CLI (`--limit`, `--tool`, `--decision`, `--json`).
5. **Observability: Prometheus `/metrics` Exporter** (Done).
   - Prometheus exporter on `GET /metrics` reporting `wazir_auth_failures_total`, `wazir_dispatched_tasks_total`, `wazir_completed_tasks_total`, `wazir_failed_tasks_total`, `wazir_dispatch_queue_depth`, `wazir_registered_computers`, `wazir_online_computers`, `wazir_active_sse_streams`.
6. **Policy UX Follow-ups** (Done).
   - Added `wa policy explain "<command>"` sub-command and `PolicyEngine.explainCommand()` displaying decision, rule, and reasons.
   - Added `WAZIR_CHILD_ENV` documentation and token check in `wa doctor`.
7. **Model Cycle M0 Implementation** (Done).
   - `ModelRegistry.setInstanceLoaded()` added.
   - `apps/cli/src/engine.ts` queries `adapter.getLoadedModels()` to mark resident instances `loaded: true` instead of dead state `loaded: false`.
   - Dynamic memory sizing `estimateModelMemory()` implemented based on parameter scale (e.g. 137M -> 2GB, 120B -> 92GB) rather than hardcoded 8GB.
   - `Scheduler.scheduleComputer()` honors `computer.load?.memoryAvailableGB` and rejects under-resourced nodes when free memory is insufficient.
   - `Scheduler.scheduleComputer()` reads and enforces `ModelRecord.runtimeCompatibility`.
   - LM Studio reasoning streaming support (`reasoning_content` delta parsing).

### Next steps (planned order)

1. **Container/namespace sandbox for tool execution — F-27** (L). The
   remaining structural risk: `shell` still runs `sh -c` on the host, so the
   safe-binary flag tables are a deny list by nature. Plan: `bwrap` (Linux)
   / `sandbox-exec` (macOS) wrapper in `packages/tools/src/process.ts` with
   project-only writable mount, read-only `/usr`, no network unless
   `networkAllowed`, and the already-minimal env. Keep host mode as an
   explicit fallback (`WAZIR_SANDBOX=none`) and pin the mode in the
   execution record. Then shrink the policy tables to "allow inside sandbox".
2. **Second-pass security review** (S). Re-run the `sec_review.md` Part 3
   prompt against the remediated tree with a different model, focused on the
   new surface: `apps/api/src/auth.ts`, the safe-command argument classifier,
   redaction false negatives, and the sandbox once (1) lands.

### Other open items

- **CI** — `.github/workflows/ci.yml` runs build/typecheck/check-dist/test on
  push and PR; branch protection on `main` is not yet enabled in GitHub.
- **MCP is policy-only** — `MCPClient` (`packages/core/src/services/mcpClient.ts`)
  is fully implemented but never instantiated or called anywhere; the only
  real MCP behavior today is that unapproved MCP servers are denied by the
  policy engine (`allowedMcpServers`). No task can currently reach an actual
  MCP server through it.
- **No OpenAI-compatible runtime adapter** — only `@wazir/runtimes-ollama` and
  `@wazir/runtimes-lmstudio` exist; despite the `RuntimeAdapter` interface
  being provider-agnostic, nothing implements it against an OpenAI-compatible
  HTTP API yet.
- macOS DMG packaging (`scripts/build-dmg.sh`) is branding-correct and
  syntax-checked but has never actually been run on macOS — everything else
  in this file was verified by running it, this one path was not.
- Shell UX spec phases D (`--json` everywhere) and E (session export) were
  never started (only A–C above are done).

