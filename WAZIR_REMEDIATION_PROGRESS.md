# Wazir PRR Remediation — Changelog & Remaining Work

Companion to `WAZIR_PRODUCTION_READINESS_REVIEW.md` (the audit). That document's checkboxes
and gate matrix have been updated in place to match what's actually in the tree; this file is
the narrative version — what changed, why, and what's genuinely still open.

**Status**: the Phase 1-3 work below was committed (`63d32e0`, then rewritten to `61a0ac9` to
use a GitHub noreply commit email) and is open as PR #1 (`rename-to-wazir` → `main`) at
https://github.com/whassan007/wazir/pull/1. The CLI rename in the section below this line is
uncommitted, on top of that PR branch.

---

## What changed

### Phase 1 — Security & sandboxing (P0 blockers)

These were already fixed in the working tree before this session started (verified, not
re-done):

| Vulnerability | Fix | Where |
| :--- | :--- | :--- |
| Check-tool arbitrary command execution | `makeCheckTool` only runs a `script` name that must already exist in the project's `package.json` `scripts` — no free-form shell text accepted | `packages/tools/src/process-tools.ts` |
| Shell command-chaining bypass (`firstToken` only checked the first word) | Full command line parsed with `shell-quote`; every sub-command, pipe, redirect and substitution is classified independently and the most restrictive verdict wins | `packages/core/src/services/policyEngine.ts` |
| `node`/`npm`/`npx`/`yarn`/`pnpm`/`bun` on the auto-allowed safe list | Moved to `ASK_SHELL_COMMANDS` (approval required) | `packages/core/src/services/policyEngine.ts` |
| Symlink path-traversal past the project root | `assertInsideProject` resolves both the lexical path and the `fs.realpath`-canonicalized path, rejects if either escapes | `packages/tools/src/paths.ts` |
| CLI `task run` was a hardcoded stub | `executeTask` now runs `planTask` (policy + context budget + real `Scheduler.plan()`), creates an execution record, and drives the agent loop through a policy-gated `AgentRuntime` | `apps/cli/src/run.ts` |

Real regression tests now exist for the security fixes: `packages/tools/tests/security.test.ts`
(11 tests: check-tool rejection, symlink escapes via file/directory/glob) and
`packages/core/tests/policyEngineShell.test.ts` (14 tests: shell chaining/classification).

### Phase 2 — Control plane & worker bridge (Pre-Alpha)

All four items closed this session:

1. **JobOrchestrator instance bug** (`packages/core/src/services/jobOrchestrator.ts`) — every
   method used to do `const { JobManager } = await import(...); const jobManager = new
   JobManager();` on each call, so state never persisted and `assignTask` on a previously
   created job always threw "not found." Fixed: `JobOrchestrator` now takes an optional
   `jobManager` in its constructor (defaults to one `new JobManager()` if omitted) and every
   method uses that single shared instance.

2. **API split-brain removed** — `apps/api/src/index.ts` (the old dummy prototype on port
   3000, stubbed empty arrays) is deleted. `apps/api/package.json` `main` already pointed at
   `dist/main.js`; all routing lives in `apps/api/src/server.ts` / `main.ts`.

3. **Full Rook/`mh` → Wazir branding sweep** — was untouched going into this session, despite
   the CLI binary already being `wazir`. Fixed:
   - Root `package.json`: `name: "rook"` → `"wazir"`, description reworded, added the missing
     `"dmg"` script (README already documented `npm run dmg`; no such script existed).
   - `README.md`: title, CLI examples (`mh ask`/`mh task plan` → `wazir ask`/`wazir task plan`
     — checked against the real Commander tree in `apps/cli/src/index.ts`, which only ever
     defined `wazir`), directory tree header, Postgres URL example.
   - `scripts/build-dmg.sh`: `Rook.app` → `Wazir.app`, DMG volume name, `Info.plist` strings,
     `PkgInfo` signature (`APPLROOK` → `APPLWZIR`), launcher and Terminal-launcher scripts;
     removed the `mh` alias/installed binary entirely (kept only `wazir`).
   - `apps/cli/src/config.ts` (+`init.ts`, `engine.ts`): `RookConfig` type → `WazirConfig`.
   - `packages/agents/src/codingAgent.ts`: agent id `'rook-coding'` → `'wazir-coding'`, plus the
     system-prompt string and doc comments.
   - All 10 `packages/*/package.json` descriptions mentioning "Rook meta-harness" → "Wazir
     meta-harness".
   - Scattered `Rook` mentions in comments/user-facing strings across `externalAgent.ts`,
     `runtimes/interfaces/src/index.ts`, `apps/cli/src/approve.ts`, `contextCompiler.ts`,
     `core/src/types/policy.ts`, `packages/workers/src/worker.ts`, `apps/cli/src/doctor.ts`,
     `apps/cli/src/status.ts`, and the API's `/overview` description string.
   - Removed a duplicate `Docs/` directory (byte-identical to `docs/`) and the redundant
     `docs/wazir_features_and_comparison.txt` (plaintext export superseded by the `.md`).
   - `WAZIR-RELEASE.md`: fixed stale `/home/wael/Code/Rook` path references. Did **not** touch
     the Hugging Face publish claims in that file — unverified, out of scope for a branding
     pass.
   - Left the `~/.rook` fallback in `configDir()` and the `ROOK_HOME`/`ROOK_OLLAMA_URL`/
     `ROOK_LMSTUDIO_URL` deprecation-warning env vars alone — that's a deliberate backward-
     compat migration shim, not stale branding.

4. **Worker task-pull loop** — the biggest gap: workers registered and heartbeated but had no
   way to receive dispatched tasks at all. Built the missing transport, no new dependencies:
   - `apps/api/src/server.ts`: a `TaskDispatcher` class holds one SSE stream per connected
     computer, queues requests for computers not yet connected, and tracks per-`requestId`
     event/outcome channels. New routes:
     - `GET /computers/:id/tasks/stream` — SSE; the worker holds this open.
     - `POST /api/v1/tasks/dispatch` — dispatch a `WorkerExecutionRequest`; `?wait=<ms>` blocks
       for the worker-reported result, otherwise returns `202` immediately.
     - `GET /api/v1/tasks/:requestId/status` — non-blocking poll for events/outcome.
     - `POST /computers/:id/executions/:requestId/events` and `.../result` — the worker
       reports lifecycle events and the final outcome back over plain HTTP POST.
   - `packages/workers/src/worker.ts`: after registering, `connectTaskStream()` opens the SSE
     connection with the built-in `fetch`, reads `response.body` as an async-iterable byte
     stream (native on Node 20+, no polyfill), parses `event: task\ndata: {...}\n\n` frames,
     and executes each request through the *already-implemented* `Worker.execute()` primitive
     (it simply had no caller before). Reports events/outcome back; reconnects with a 2s
     backoff on drop; stops cleanly via `AbortController` on `worker.stop()`.
   - Proven end-to-end by `apps/api/tests/taskDispatch.test.ts` (fake `RuntimeAdapter`): one
     test dispatches to an already-connected worker and gets the outcome back through
     `?wait=`; a second dispatches *before* the worker connects (asserts `connected: false`,
     proving the queuing path specifically), then starts the worker and polls `/status` until
     the queued task resolves. Both pass.
   - Adjacent fix found while in this file: `apps/api/package.json` was missing
     `@wazir/agents`, `@wazir/shared`, `@wazir/tools`, `@wazir/workers` as declared
     dependencies even though `server.ts` already imported all four (worked only by npm
     workspace hoisting). Added them; removed the declared-but-unused `cors` dependency.

### Verification (as of that point)

- `tsc --build --force` across the whole monorepo: clean, no errors.
- `vitest run`: 22 test files / 97 tests, all passing (was 21 files / 95 before that session's
  additions).

---

## Phase 2 remainder + all of Phase 3 (this session)

The user asked to continue into Phase 2's last item and all of Phase 3. All of it is now done.
The headline: **building this for real (running the Docker images, bringing up the full
Compose stack, writing tests that actually exercise the agent loop end-to-end instead of
checking object literals) surfaced ten real, previously-invisible bugs** — not hypothetical
ones. Each is listed below with what exposed it, since that's the useful part for judging how
much to trust the rest of the codebase that *hasn't* been exercised this way yet.

### 1. Scheduler → remote dispatch wiring (closes Phase 2)

The transport from the previous session (SSE task-pull loop) existed but nothing called it from
a scheduling decision — a caller had to already know a `computerId` and hand-build a
`WorkerExecutionRequest`.

- `packages/workers/src/remoteDispatch.ts` (new): `dispatchRemote(apiUrl, computerId, request)`
  — an async generator that dispatches, polls `/api/v1/tasks/:requestId/status`, and yields
  each `WorkerExecutionEvent` as it arrives.
- `apps/cli/src/remoteInventory.ts` (new): `syncRemoteInventory()` pulls the control plane's
  `/api/v1/computers`, `/api/v1/runtimes`, `/api/v1/models`, and a new
  `/api/v1/model-instances` endpoint into the CLI's own registries — without this, the
  `Scheduler` could never select a remote `computerId` in the first place, since it only ever
  knew about the one computer the CLI itself is running on. Skips any id matching the caller's
  own `localComputerId` so a remote's default `'local'` id can't clobber the real local entry.
  Also fixed on the API side: `createApiState()` registered discovered models but never called
  `models.upsertInstance()` for them — `Scheduler.routeModel()` rejects any model with zero
  registered instances regardless of the `ModelRecord` existing, so without this fix a remote
  computer's models could never actually be scheduled onto it.
- `apps/cli/src/run.ts`: `runtime.generate()` now branches — local computer → existing
  in-process adapter path; anything else → `dispatchRemote()`, translating
  `WorkerExecutionEvent`s to the `GenerationEvent` shape the agent loop already consumes.
- `apps/cli/src/config.ts`: new `apiUrl` field / `WAZIR_API_URL` env var gates all of this —
  unset, the CLI behaves exactly as before (local-only).
- Tests: `apps/api/tests/remoteDispatchClient.test.ts` (dispatch success + unknown-computer
  rejection), `apps/cli/tests/remoteInventory.test.ts` (sync + the local-id-collision guard +
  unreachable-API graceful degradation).

### 2. Real bug found: `CodingAgent.run()` ignored the per-request `maxTurns`

Writing a real end-to-end test (see item 6) meant actually driving the agent loop, which is how
this surfaced: `apps/cli`'s `--max-turns` flag threads all the way through `executeTask` →
`agent.run({..., maxTurns}, runtime)`, but `CodingAgent.run()` only ever read `this.maxTurns`
(the constructor-time default, 30) — the per-call value was received and silently discarded.
**Fixed** (`packages/agents/src/codingAgent.ts`): a local `const maxTurns = request.maxTurns ??
this.maxTurns` at the top of `run()`, used everywhere the loop previously read `this.maxTurns`.
Regression tests: `packages/agents/tests/codingAgent.maxTurns.test.ts` (4 tests, using a fake
runtime that never lets the model finish on its own, to actually count how many turns run).

### 3. Real bug found: policy filesystem check resolved relative paths against the wrong base

Also found via the real end-to-end test: a scripted `write` tool call with a perfectly normal
relative path (`"hello.txt"`) was denied as "outside the project root," even though it
plainly wasn't. `packages/core/src/services/policyEngine.ts`'s `isInside(projectRoot, rawPath)`
called `path.resolve(rawPath)` on the raw filesystem-tool `path` argument without ever joining
it against `projectRoot` first — `path.resolve` with one argument resolves against
`process.cwd()`, not the project root. This only "worked" when the CLI happened to be invoked
from a cwd identical to the project root (the common case, which is exactly why it went
unnoticed) and breaks the moment they differ (e.g. `--project` pointing elsewhere, or any
non-interactive invocation from a different working directory). The redirect-target check a
few lines below in the same file already did this correctly
(`isInside(projectRoot, path.resolve(projectRoot, redirect.target))`) — a plain call-site
inconsistency. **Fixed**: pre-resolve `rawPath` against `projectRoot` before the containment
check. Regression tests added directly (this file had *zero* filesystem-path test coverage
before now, for either tool): 7 new tests in `packages/core/tests/policyEngine.test.ts`
covering relative/absolute inside, relative escape via `..`, absolute outside, missing path,
the `file` alias, and a request-level `projectRoot` override.

### 4. Two dead fields found and documented, deliberately not fixed

Both surfaced while writing real replacements for ghost tests that had been asserting facts
about these fields without ever exercising the code that was supposed to use them:

- `ModelRecord.runtimeCompatibility` is never read anywhere in `Scheduler` — setting it to
  `'any'` vs `['ollama']` vs anything else has zero effect on scheduling today.
- `ComputerRegistry` has no method that can ever set a computer's `health` to `'degraded'` —
  `register()` always sets `'healthy'` on first registration and only ever carries forward
  `existing?.health` afterward. The Scheduler's `if (computer.health === 'degraded') score -=
  1` branch is real, working code with no way to reach it. (Runtime-level and model-instance-
  level degraded health *are* reachable and *are* now tested — see item 6 — it's specifically
  the computer-level field that's dead.)

Not fixed, on purpose: both need someone to decide *what should actually set these* (health
checks polling each runtime? a heartbeat payload field? an explicit admin action?), which is a
design question, not a mechanical fix — documented in
`WAZIR_PRODUCTION_READINESS_REVIEW.md` §6 instead of guessing at an implementation.

### 5. PostgreSQL client wiring (`packages/database`)

- `pool.ts`: `createPool()` (thin `pg.Pool` wrapper, throws a clear error if given neither a
  connection string nor a host) and `checkHealth()`.
- `migrate.ts`: `runKvMigration()` applies a new `kv-schema.sql` (idempotent — `CREATE TABLE
  IF NOT EXISTS`). Scoped deliberately as a `KeyValueStore` backend (one `wazir_kv_store`
  table), matching how the app already persists data (namespaced JSON blobs), rather than a
  full ORM mapping onto every table in the pre-existing `schema.sql` reference schema — that
  full mapping is a much larger, separate effort and `schema.sql` remains the reference design
  for it, untouched.
- `postgresStore.ts`: `PostgresStore implements KeyValueStore` — the exact same interface
  `JsonFileStore`/`MemoryStore` already implement, so anything taking a `KeyValueStore`
  (`ExecutionEngine`, the registries) works against Postgres with no other code changes.
- `apps/cli/src/engine.ts`: `createStore()` now checks `WAZIR_DATABASE_URL` first, then
  `WAZIR_IN_MEMORY=1`, then falls back to the local JSON file — actually wired in, not just
  built and left unused.
- **Real bug found and fixed while testing this**: `SCHEMA_FILE`/`KV_SCHEMA_FILE` were computed
  from `__dirname`, but `__dirname`'s distance from the package root differs depending on
  whether the module loads from compiled `dist/src/*.js` (two levels up) or is run directly
  from `src/*.ts` by vitest/ts-node (one level up) — a path that worked for one caller 404'd
  for the other. Fixed with a small existence-check fallback (`resolveSchemaFile()`) instead of
  hardcoding one depth; this is also the first time `SCHEMA_FILE` was ever actually resolved at
  runtime by anything, so the *original* one-level-off version (present before this session)
  was never truly exercised either.
- Tests: `packages/database/tests/postgresStore.test.ts` (10 tests) and
  `apps/cli/tests/createStore.test.ts` (3 tests) — **run against a real Postgres in a Docker
  container** (`docker run postgres:16-alpine`), not a mock; `describe.skipIf` skips cleanly
  when `WAZIR_TEST_DATABASE_URL` isn't set so CI/other machines without Postgres aren't broken.
- **Test-isolation bug found and fixed**: those two files, run concurrently by vitest's default
  file parallelism, raced each other's `TRUNCATE`/`clear()` calls against the one shared test
  database and intermittently wiped each other's in-flight assertions. Fixed with a new
  `vitest.config.ts` (`fileParallelism: false`) — the suite is small enough that serializing
  files costs a couple of seconds, which is worth it to remove a real flake source. Confirmed
  by running the full suite three times in a row against a live Postgres with zero failures.

### 6. Cross-process file locking for `JsonFileStore` (`packages/shared/src/store.ts`)

Previously only serialized writers *within one process* (an in-memory promise chain) — the
CLI, the API server, and any worker are separate OS processes that could race a read-modify-
write cycle on the shared JSON file and silently drop each other's update.

- Added a dependency-free, cross-process advisory lock (`fs.open(lockPath, 'wx')`, the same
  primitive libraries like `proper-lockfile` use) with stale-lock recovery (a lock older than
  30s is assumed to belong to a crashed process and is force-cleared).
- Every mutation (`put`/`delete`/`clear`) now reloads the freshest on-disk state while holding
  the lock, mutates, and persists. Reads stay lock-free (last-loaded snapshot) since only
  writes need strict ordering.
- Tests: `packages/shared/tests/store.test.ts` (7 tests), including one that spawns **three
  real separate Node child processes** (`child_process.execFile`, not just three objects in one
  process) racing 15 writes each into the same file and asserts all 45 survive, and one that
  manually back-dates a lock file to prove stale-lock recovery doesn't just hang for the full
  10s timeout.

### 7. Real end-to-end tests replacing all 9 ghost/tautological test files

See `WAZIR_PRODUCTION_READINESS_REVIEW.md` §6 for the full before/after table (which ghost test
was replaced by which real one, and which real bug each replacement caught — items 2 and 3
above came directly from this). Summary of what was deleted vs. added:

- Deleted (fully superseded by real coverage elsewhere, or provably testing a dead field):
  `tests/integration/{endToEnd,runtime,degraded,maxTurns,modelRecord,scheduler}.test.ts`,
  `tests/runtime/{maxTurns,modelRecord,cancellation}.test.ts`.
- Added: `apps/cli/tests/executeTask.e2e.test.ts` (a real `RookEngine` — real `PolicyEngine`,
  `Scheduler`, `ExecutionEngine`, `ToolRegistry` running real filesystem/check tools against a
  scratch directory — only the model itself faked; covers both a successful write-a-file run
  and a policy-denied path-escape attempt, end to end), `packages/agents/tests/
  codingAgent.maxTurns.test.ts`, new tests appended to `packages/core/tests/scheduler.test.ts`
  (degraded-runtime scheduling, healthy-vs-degraded instance preference) and
  `packages/workers/tests/worker.test.ts` (adapter selection, `cancel()` fan-out and
  no-cancel-support tolerance), and the 7 new `policyEngine.test.ts` filesystem tests from
  item 3.

### 8. Docker, Compose, systemd, launchd — built, run, and verified, not just written

- `Dockerfile` (root): multi-stage, one shared builder + four target stages (`api`, `worker`,
  `web`, `cli`). `docker-compose.yml`: all four wired together plus Postgres, with a `cli`
  profile for one-off commands. `.dockerignore` added.
- `scripts/systemd/wazir-api.service` + `wazir-worker.service` — validated with
  `systemd-analyze verify` (had to substitute a real node path to get past that check locally,
  but the unit syntax itself verifies clean). `scripts/launchd/ai.wazir.worker.plist` — a
  headless daemon variant, distinct from the DMG's GUI app launcher; validated as well-formed
  XML. Deployment instructions added to `README.md`.
- **This is the part that mattered most for finding real bugs** — a clean container build (no
  leftover local build artifacts) and actually running the images surfaced three more:
  1. `packages/runtimes/{interfaces,ollama,lmstudio}/package.json` all had `"main":
     "./dist/index.js"`, but the real compiled output (matching every other package's
     convention) is `dist/src/index.js`. This "worked" on the dev machine only because of a
     stale, untracked `dist/index.js` left over from some earlier build config — a clean
     checkout has no such leftover, and the container build failed with `MODULE_NOT_FOUND`.
     Fixed all three `main` fields; deleted the stale artifacts.
  2. `apps/api` defaults to binding `127.0.0.1` — unreachable from outside a container (Docker
     port-mapping forwards to the container's external interface, not its loopback). Fixed by
     setting `WAZIR_HOST=0.0.0.0` in the Dockerfile's `api` stage (and noted in the systemd
     unit for anyone binding it beyond localhost there too).
  3. `apps/worker`'s daemon entrypoint exited immediately (exit 0) when started with no
     `WAZIR_SERVER_URL` — registering `SIGINT`/`SIGTERM` handlers and awaiting an unresolved
     Promise doesn't keep Node's event loop alive by itself, and with no server configured
     `Worker.start()` sets up no heartbeat timer either, so there was nothing else holding the
     process open. Fixed with an explicit `setInterval` keep-alive, cleared on shutdown.
  4. Found only after bringing up the *full* `docker compose up` stack (not just individual
     containers) and checking `docker inspect --format='{{.RestartCount}}'`: it was `1`.
     `Worker.register()`'s initial registration `fetch()` had no retry, so the ordinary
     container-startup race (worker starting before the API's listener is ready) crashed it —
     Compose's `restart: unless-stopped` silently papered over a crash-loop instead of it
     actually working first try. Fixed with a 5-attempt bounded retry with backoff in
     `packages/workers/src/worker.ts`; re-verified `RestartCount=0` on a clean bring-up
     afterward, plus that the worker actually shows up in `GET /api/v1/computers` and the web
     dashboard's `/health` proxy works through the whole stack.
- Adjacent package.json fixes found while touching these files: `apps/worker/package.json`
  was missing `@wazir/workers` (imported by `src/index.ts`, same class of bug as `apps/api`
  last session); `packages/core/package.json` was missing `@wazir/shared` (imported by
  `mcpClient.ts`). Both worked only by npm workspace hoisting, same as before.
- Also fixed while in these files: a duplicated `this._hardware = hardware;` line in
  `packages/workers/src/worker.ts` (harmless, just sloppy); the `Rook` branding comment header
  in `apps/web/server.js` and `<title>Rook — meta-harness</title>` in `apps/web/public/
  index.html` (missed by the previous session's branding sweep); `.gitignore`'s `# Rook
  project` header and a missing `*.tsbuildinfo` entry.

### 9. Real bug found: worker event reports raced each other out of order

Found in the very last verification pass of this session — the full suite had been green
moments earlier, then failed on a rerun with events arriving as `['started', 'completed',
'token', 'token']` instead of `['started', 'token', 'token', 'completed']`. Cause: `Worker`'s
`onEvent` callback (passed into `execute()`) is synchronous by contract, but each call fires an
HTTP POST to report the event; the previous code did `void this.reportEvent(...)` — fire and
forget — so two events emitted back-to-back with no real delay between them (e.g. two token
events from a fast/local adapter) became two independent in-flight POSTs that could complete
in either order. This would be rare but not impossible with a real LLM under load or retries,
and was reliably reproducible with a synthetic adapter that yields events with no delay.
**Fixed** in `packages/workers/src/worker.ts`'s `handleDispatchedTask`: chain each reportEvent
call onto a local `reportChain` promise instead of firing it independently, and await that
chain before reporting the final outcome — serializes the POSTs without blocking the generator
loop that's driving them. Re-verified by running the affected tests 5 times in a row (was
reproducible roughly 1 in 3-4 runs before the fix; zero failures in 5 runs after).

### 10. Stale compiled output found sitting in `packages/shared/src/`

Noticed while reviewing `git status` for this handoff, not by running anything: `packages/
shared/src/` (the real `.ts` source directory) also contained `.js`/`.d.ts`/`.js.map`/
`.d.ts.map` files — compiled output that should only ever exist under `dist/`. The current
`packages/shared/tsconfig.json` correctly emits to `dist/src/` (confirmed by rebuilding after
deleting the stray files — they did not come back), so these were leftovers from some earlier,
different build configuration, never cleaned up. Same root cause category as the
`packages/runtimes/*` `main`-field bug from item 8 — untracked, uncommitted build debris
silently working around a real config issue instead of surfacing it. Deleted the stray files;
added a `.gitignore` rule (`**/src/**/*.{js,d.ts}` and their `.map` variants — note the
leading `**/` is required for it to match at any depth, a plain `src/**/*.js` is anchored to
repo root and silently matches nothing nested, confirmed with `git check-ignore -v` before and
after correcting it) so this can't quietly recur and get accidentally committed by a future
`git add -A`. No other package had this issue — checked repo-wide.

### Verification (this session)

- `tsc --build --force` across the whole monorepo: clean, no errors, after every change above.
- `vitest run` (with a live Postgres via `WAZIR_TEST_DATABASE_URL`, run repeatedly — including
  5 consecutive runs after the item 9 fix specifically, since that bug was itself only caught by
  not trusting a single green run): **20 test files / 125 tests, all passing**, up from 22
  files / 97 tests at the start of this session (files went down because 9 ghost files were
  deleted while several substantial real ones were added).
- `docker build` for all four targets; `docker run` for `api` (hit `/health` and
  `/api/v1/overview` over the mapped port), `worker` (confirmed it stays running, confirmed
  clean `SIGTERM` shutdown), `web` (hit `/`); full `docker compose up` (worker registered with
  the API, web dashboard proxied to the API, zero container restarts); all test
  containers/images removed afterward.

---

## Balance of work (what's genuinely still open)

**Phase 1, 2, and 3 are now fully closed.** Everything below is Phase 4, which has not been
started, plus two items that are explicitly out of scope for a mechanical fix:

- **API auth + CORS lockdown** (Vulnerability 5 — still open): `apps/api/src/server.ts` has no
  bearer/API-key/session auth on any route, and CORS isn't restricted.
- **Container/namespace sandboxing** for agent tool execution (currently runs directly on the
  host running the CLI/worker).
- **OpenTelemetry traces + Prometheus metrics** — observability is still an in-memory ring
  buffer only.
- **CI/CD** (GitHub Actions or similar) enforcing build/typecheck/test on PRs — nothing catches
  a regression today except running the commands by hand.
- **Two dead fields need a design decision, not a fix** (see item 4 above): what should set
  `ComputerRegistry`'s per-computer `health` to `'degraded'`, and what (if anything) should
  `ModelRecord.runtimeCompatibility` actually gate in the Scheduler.
- **macOS DMG path unverified this pass** — `scripts/build-dmg.sh` was branding-fixed and
  syntax-checked (`bash -n`) in the previous session, but actually building and opening a DMG
  requires macOS-specific tooling (`hdiutil`, `osascript`, icon generation) not available in
  this Linux sandbox. Everything else in this document was verified by actually running it;
  this one specific path was not, and shouldn't be assumed to work on that basis alone.

Each Phase 4 item is a standalone feature or infra decision (auth strategy, sandboxing
approach, CI provider, tracing backend) rather than a bug fix — worth scoping with the user
before starting rather than assuming an approach, same as before.

---

## CLI binary renamed: `wazir` → `wa`

Per explicit user request, replacing (not aliasing alongside) the invokable CLI command name.
The product/brand name ("Wazir"), the npm package scope (`@wazir/*`), and env var prefixes
(`WAZIR_*`) are all unchanged — only the thing you actually type at a shell prompt changed.

- `apps/cli/package.json`: `bin` field `"wazir"` → `"wa"`.
- `apps/cli/src/index.ts`: Commander `.name('wazir')` → `.name('wa')` (changes the `Usage:`
  line in `--help` output).
- `apps/cli/src/commands.ts` and `apps/cli/src/status.ts`: two hardcoded suggestion strings
  (`wazir executions inspect ...`, `run wazir doctor for details`) updated to say `wa`.
- `README.md`, `docker-compose.yml`, `Dockerfile` (comment only), `docs/
  wazir_features_and_comparison.md`, `scripts/build-dmg.sh` (alias, installed binary name,
  Terminal launcher, install script, generated README.txt) — every user-facing CLI invocation
  example updated.
- Deliberately **not** touched: `WAZIR_PRODUCTION_READINESS_REVIEW.md` and this file's own
  earlier sections — they're a historical record of what the CLI was called *at the time*,
  not living usage docs; rewriting past audit prose to match a later rename would misrepresent
  history. `mcpClient.ts`'s MCP `clientInfo.name: 'wazir'` and `server.ts`'s `/api/v1/overview`
  `name: 'wazir'` field are product self-identification, not the CLI command — left alone.
- **Found and fixed while verifying this**: after editing `package.json`, `npm install` alone
  left a stale `node_modules/.bin/wazir` symlink (and an even older stale `node_modules/.bin/
  rook` from before the original Rook→Wazir rename) — npm didn't prune the old bin symlink for
  a workspace package on its own. Had to `rm` both stale symlinks and reinstall for `wa` to
  actually appear. Confirmed working after: `node_modules/.bin/wa --help` shows `Usage: wa
  [options] [command]`, and the Docker `cli` target rebuilt and run standalone (`docker run
  --rm wazir-cli --help`) shows the same.
- `tsc --build --force` clean; `vitest run` still 20 files / 125 tests passing.

---

## How to continue

1. Run `git status` / `git diff --stat` first to see the uncommitted CLI-rename changes on top
   of the already-merged-into-PR Phase 1-3 work.
2. Cross-check `WAZIR_PRODUCTION_READINESS_REVIEW.md`'s checkboxes, gate matrix, and scorecard
   against the current code before trusting them; they were updated to match this session's
   changes but can drift again once more edits land.
3. Re-run `tsc --build --force` and `vitest run` after any further change. For the Postgres
   tests specifically: `docker run --rm -d -e POSTGRES_PASSWORD=wazir -e POSTGRES_DB=wazir_test
   -p 5432:5432 postgres:16-alpine`, then `WAZIR_TEST_DATABASE_URL=postgres://postgres:wazir@
   localhost:5432/wazir_test vitest run`.
4. For Docker changes: actually build and run the image, don't just read the Dockerfile — three
   of the eight bugs in this session were only found that way.
