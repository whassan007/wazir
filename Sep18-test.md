# Wazir Test Plan — Sep 18

This adapts the generic distributed-control-plane test plan to the actual
Wazir codebase as of `PROGRESS.md` (2026-09-17, "Beta / internal-deployment
ready"). Where the generic plan assumed subsystems that don't exist yet
(full MCP execution, an OpenAI-compatible runtime, container sandboxing,
API auth), this plan tests what's real and turns the gaps into explicit,
tracked test debt instead of pretending they're covered.

The guiding question stays the same:

> **Can Wazir reliably take a task, determine the required capabilities,
> select an appropriate agent/model/runtime/computer, execute it under
> policy, recover from failures, preserve state, and provide an auditable
> explanation of what happened?**

---

## 0. What actually exists (ground truth for this plan)

```text
apps/
  api/      Express server (apps/api/src/server.ts, main.ts)
            SSE task stream: GET /computers/:id/tasks/stream
            TaskDispatcher, JobOrchestrator, JobManager
  cli/      `wa` binary (Commander-based, apps/cli/src/index.ts)
  worker/   worker process (packages/workers/src/worker.ts)
  web/      web app

packages/
  core/       domain types + services
    types/      agent, block, capability, computer, context, conversation,
                execution, job, model, policy, resource, runtime, scheduler,
                task, tool, worker
    services/   agentRegistry, approvalQueue, computerRegistry,
                contextCompiler, executionEngine, jobManager,
                jobOrchestrator, mcpClient (policy-only, unwired),
                modelRegistry, policyEngine, processManager,
                runtimeRegistry, scheduler, skillsRegistry, worktreeManager
  agents/     codingAgent, externalAgent (OpenCode adapter)
  scheduler/  matching/, policies/, scoring/
  registry/   database-backed registries
  policies/   policy engine package
  models/     model registry package
  runtimes/
    interfaces/   RuntimeAdapter contract
    ollama/       @wazir/runtimes-ollama
    lmstudio/     @wazir/runtimes-lmstudio
  workers/    worker package + tests
  tools/      process-tools.ts (script execution), paths.ts (traversal guard)
  database/   Postgres KeyValueStore (createPool, PostgresStore, migrations)
  shared/     JsonFileStore (cross-process file lock, stale-lock recovery)
  memory/, evaluation/, observability/

tests/
  fakes/runtime.ts          — fake RuntimeAdapter for deterministic tests
  integration/               execution.test.ts, policy.test.ts, worker.test.ts
  runtime/                    lmstudioAdapter.test.ts, ollamaAdapter.test.ts
per-package tests/ under packages/*/tests

Test runner: vitest (`npm test` = build + `vitest run`; `npm run test:watch`)
```

Real CLI surface (`wa <group> <subcommand>`), not the generic plan's
invented commands:

```text
wa init | doctor | status
wa task run | plan | status
wa exec list | inspect | replay
wa history list | inspect
wa context add | remove | list | clear
wa bench run
wa discover all
wa agents list
wa tools list
wa policy inspect
wa config show
wa jobs list | inspect | merge
wa computers list | inspect
wa workers list
wa runtimes list
wa models list
wa chat | ask
wa explain <ref>
```

There is **no `wa cancel` or `wa approve` CLI command yet** — cancellation
exists at the service layer (`JobOrchestrator.cancelJob` /
`cancelTask`) and approval exists via `approvalQueue.ts`, but neither is
exposed as a first-class CLI verb. Test the service-layer behavior directly;
flag the missing CLI surface rather than inventing a command to test against.

There is no explicit `JobGraph` type — the DAG-aware fan-out/fan-in,
retries, cancellation, and steering live in `JobManager` +
`JobOrchestrator` (`packages/core/src/services/jobOrchestrator.ts`), which
already supports `steerTask`/`steerJob`, `cancelTask`/`cancelJob`,
per-task retry counts, and abort-controller-based job cancellation. Section
5 below tests that machinery under its real name.

---

## 1. Test Objectives

| Property | What must be demonstrated | Status today |
| --- | --- | --- |
| Correctness | `wa` commands and API routes produce correct results | Core paths covered by `tests/integration/execution.test.ts` |
| Determinism | Same task/registry/policy → same scheduling decision | Scheduler has `matching/`, `policies/`, `scoring/` — needs property tests |
| Safety | Agents/tools cannot bypass `PolicyEngine` | Shell policy parser + symlink guard landed (Section 4); needs bypass-path sweep |
| Isolation | Jobs/agents/sessions don't leak state | Worktree manager exists; needs workspace-isolation tests |
| Recoverability | Crash/restart doesn't corrupt jobs or lose state | `JsonFileStore` has stale-lock recovery; `PostgresStore` is live — needs restart-mid-execution test |
| Distributed correctness | Work executes on the intended computer via `ComputerRegistry`/dispatcher | SSE dispatch (`TaskDispatcher`) works; multi-computer test still needed |
| Observability | Decisions/executions traceable via `wa explain`, `wa history` | In-memory ring buffer only — **no OpenTelemetry/Prometheus yet** (tracked gap) |
| Resource awareness | Scheduler respects RAM/VRAM/concurrency | `ComputerRegistry.health: 'degraded'` field exists but **nothing sets it** (tracked gap) |
| Runtime independence | Core doesn't depend on Ollama/LM Studio internals | Only 2 adapters exist; **no OpenAI-compatible adapter** (tracked gap) — contract suite should be written against the interface so a 3rd adapter is a drop-in |
| Extensibility | New agents pluggable | `ExternalAgentAdapter` (OpenCode) proves the pattern |
| UX correctness | `wa` terminal usable as operational shell | `wa history`/`wa context`/`@ref` resolution implemented |
| Security | Secrets/credentials/privileged ops protected | **No API auth/RBAC yet, permissive CORS** (tracked gap, see Section 15) |
| Performance | Scheduling/control-plane overhead acceptable | No perf baseline captured yet |
| Failure handling | Timeouts, worker loss, cancellation behave correctly | `worker.test.ts` exists; needs failure-injection expansion |

---

## 2. Test Pyramid

Same principle as the generic plan, tuned to what's here:

```text
                 ▲
                / \
               / E2E \        wa CLI against real API + fake or real worker
              /-------\
             /  Live   \      Ollama / LM Studio, OpenCode if installed
            / AI/Infra  \
           /-------------\
          / Integration   \   tests/integration/*.test.ts (existing)
         /-----------------\
        / Component/Contract\ RuntimeAdapter contract vs fake + Ollama + LM Studio
       /-----------------------\
      /     Unit / Property      \  packages/*/tests (vitest)
     /_____________________________\
```

Target distribution: 50–60% unit/property, 20–25% component/contract,
10–15% integration, 5–10% E2E, small real-model set. `tests/fakes/runtime.ts`
already gives a deterministic fake `RuntimeAdapter` — expand it rather than
building a second fake.

CI gap: `npm test` (build + vitest) is not currently enforced on PRs
(tracked gap in PROGRESS.md — "nothing enforces build/typecheck/test on pull
requests yet"). Closing that is a prerequisite for trusting this whole plan
over time, not just a nice-to-have — put it early in the implementation
order (see Section 20).

---

## 3. Test Environment Matrix

### Environment A — Fake runtime, in-process

```text
tests/fakes/runtime.ts (FakeRuntimeAdapter)
 + in-memory registries (agentRegistry, modelRegistry, computerRegistry)
 + JsonFileStore pointed at a tmp dir
```
Purpose: deterministic scheduler/policy/orchestrator tests, CI default.

### Environment B — Single real machine

```text
wa (API + CLI) on one machine
 + Ollama running locally
 + LM Studio running locally
 + Postgres (docker compose) OR JsonFileStore
```
Purpose: real runtime discovery, real model loading, streaming, context
limits, resource accounting against `packages/runtimes/ollama` and
`packages/runtimes/lmstudio`.

### Environment C — Distributed

```text
API (control plane) on machine 1
 ↓ SSE  GET /computers/:id/tasks/stream
Worker (packages/workers) on machine 2
 ↓
Ollama or LM Studio on machine 2
```
Purpose: exercise `TaskDispatcher` queuing-for-not-yet-connected-computers
behavior, worker reconnect-on-drop, and `ComputerRegistry` routing across a
real network boundary. This is the most valuable environment to build out
next — right now `tests/integration/worker.test.ts` likely runs
single-process; confirm and extend to a real second process/host.

### Environment D — Degraded infrastructure

Inject: runtime unavailable, model unavailable, worker offline, network
latency/partition, insufficient memory, corrupted `JsonFileStore` (kill mid
fsync — the store's stale-lock recovery path exists specifically for this;
write a test that actually triggers it), process crash mid-execution.

---

## 4. Security & Policy Regression Tests (highest priority — build on landed fixes)

These already shipped per `PROGRESS.md`; the job now is to lock them in as
permanent regressions and extend the bypass sweep, not to design them from
scratch.

**Shell policy parser** (`packages/core/src/services/policyEngine.ts`,
regression test `packages/core/tests/policyEngineShell.test.ts`):
- Full command line is parsed with `shell-quote`; every sub-command, pipe,
  redirect, and command substitution is classified independently.
- `node`/`npm`/`npx`/`yarn`/`pnpm`/`bun` require approval, not auto-allow.
- Add cases for: `&&`/`||` chains, backtick and `$()` substitution nesting,
  heredocs, and quoted strings that contain shell metacharacters — confirm
  none of these let a denied command slip through as an argument to an
  allowed one.

**Check-tool script allowlist** (`packages/tools/src/process-tools.ts`):
- Only a `script` name already present in the project's `package.json` can
  run — no free-form shell text. Test: script name that exists but has a
  malicious body (should still run — this gate is about *name*, not
  content, so don't conflate the two); script name that doesn't exist
  (deny); script name supplied via a reference/variable indirection.

**Symlink path traversal** (`packages/tools/src/paths.ts`,
`assertInsideProject`): checks both lexical and `fs.realpath`-canonicalized
path. Test: symlink created *after* the check but before use (TOCTOU —
confirm this is actually closed, not just the simple case); symlink chain
(A→B→C where C escapes); relative `..` combined with a symlink.

**Policy bypass sweep** — attempt the same denied action through every
entry point and confirm identical denial:
```text
CLI (`wa task run`) → API route directly → worker-dispatched execution
→ agent-invoked tool → resumed/replayed job (`wa exec replay`)
```
Critical invariant: there must be no privileged path around `PolicyEngine`
just because execution originated somewhere else. `wa exec replay`
specifically deserves its own test — replay must re-run under *current*
policy, not the policy that was active when the original execution happened.

---

## 5. Job / Orchestration Testing (the JobGraph-equivalent)

Target: `packages/core/src/services/jobManager.ts` +
`packages/core/src/services/jobOrchestrator.ts`.

### Lifecycle / status transitions
Test every `JobStatus` transition (`packages/core/src/types/job.ts`).
Invalid transitions must fail loudly, not silently succeed:
```text
completed → running
failed → running
cancelled → running
```

### Fan-out / fan-in
Wazir's E2E example in the generic plan (architecture + security + testing
agents → reviewer) is a real, testable shape here since `JobOrchestrator`
already runs multiple task nodes concurrently. Build a fake-agent fixture
graph and verify:
- independent task nodes execute concurrently, not serialized
- each gets an independent context (no cross-leak)
- a fan-in node does not start until all required predecessors reach a
  terminal state
- one branch failing doesn't silently mark the fan-in node as satisfied

### Steering (`steerTask` / `steerJob`)
This is Wazir-specific and not in the generic plan — test it directly:
- `steerTask(jobId, taskId, instruction)` enqueues into
  `steeringQueues`; verify the running task actually observes it via
  `getSteeringInstruction()` before its next step, and that instructions
  queued for a task that already finished are dropped, not leaked into the
  next job that reuses the id space.
- `steerJob` fans the instruction out to all live task ids in that job —
  verify a job with zero running tasks doesn't error.

### Cancellation
- `cancelTask` → task status becomes `cancelled`, agent state becomes
  `cancelled` with the "Cancelled by user" reason, `task:cancelled` event
  emitted.
- `cancelJob` → cancels all live tasks first, then the job itself; the
  `jobAbortController.signal.aborted` check must stop in-flight loop
  iterations (test that a long-running fake task actually observes the
  abort rather than running to completion anyway).
- Once `cancelled`, a job must never later transition to `completed` (this
  is exactly the kind of race a fake-clock + concurrent-cancel test catches
  — cancel while the last task is mid-completion).

### Retries
- Per-task `retryCount` is threaded through `failTask`; test `maxRetries =
  0, 1, 3` and confirm no infinite retry loop.
- Distinguish retryable (transient runtime failure) from non-retryable
  (policy denial, invalid task) — a policy denial must never trigger a
  retry attempt.

### Cycle / missing-dependency / deadlock
Even without a formal `JobGraph` type, the task-dependency structure the
orchestrator consumes should reject: a cycle, a reference to a nonexistent
node, duplicate node ids, and a graph that can never progress (deadlock).
If these aren't currently validated before execution starts, that's a gap
worth flagging explicitly rather than assuming it's handled.

---

## 6. Registries (Agent / Model / Computer / Runtime)

Target `packages/core/src/services/{agentRegistry,modelRegistry,
computerRegistry,runtimeRegistry}.ts` and `packages/registry`
(database-backed).

- registration / deregistration / discovery / capability lookup
- duplicate registration must not create two logical entries for one
  identity (matters most for `computerRegistry` given the SSE
  worker-reconnect path — a flaky network shouldn't double-register a
  computer)
- `ComputerRegistry.health: 'degraded'` — confirm this field is currently
  dead (per PROGRESS.md, nothing sets it). Either write the test that
  proves it's dead so it's caught the moment someone wires it up
  incorrectly, or treat wiring it as a prerequisite task before writing
  scheduler tests that depend on degraded-state routing.
- `ModelRecord.runtimeCompatibility` — same treatment: confirm the
  Scheduler doesn't currently read it, so a future scheduler test doesn't
  silently assume behavior that isn't implemented.

---

## 7. Scheduler Tests

Target `packages/scheduler/src/{matching,policies,scoring}`.

- Given two computers, one under-resourced for a task's requirements, the
  under-resourced one must never be selected.
- Determinism: same registries + same task + same policy → same computer,
  across repeated runs.
- **Explainability**: every scheduling decision must be reconstructable via
  `wa explain <ref>` — write a test that creates a job, then calls
  `wa explain` (or the underlying service call) and asserts the output
  names the selected computer/model/agent and at least one concrete reason
  (not selected because is just as important as selected because — assert
  rejected candidates show up too, if `wa explain` currently supports
  that; if it only explains the winner, note that as UX debt).
- Context-budget rejection: task requires more context than the selected
  model supports → reject before execution, never attempt-then-fail at the
  runtime layer. Trace this through `contextCompiler.ts`.

---

## 8. Runtime Adapter Contract Tests

`packages/runtimes/interfaces` defines the `RuntimeAdapter` contract. Run
one contract suite against all three implementations that exist today:

```text
FakeRuntimeAdapter (tests/fakes/runtime.ts)
@wazir/runtimes-ollama    (tests/runtime/ollamaAdapter.test.ts)
@wazir/runtimes-lmstudio  (tests/runtime/lmstudioAdapter.test.ts)
```

Confirm the three suites actually assert the *same* contract today (same
method surface: discover/health/load/unload/execute/stream/cancel) rather
than three independently-written test files that happen to cover similar
ground — if they've drifted, unify them into one parametrized contract
suite so a future OpenAI-compatible adapter (tracked gap) just plugs into
it.

Runtime failure injection: runtime down before dispatch (no execution
starts, reason recorded); runtime disappears mid-execution (execution
marked interrupted/failed, event persisted); model unloads unexpectedly
(must not silently switch models — assert explicitly).

---

## 9. Worker Tests

Target `packages/workers/src/worker.ts` + `tests/integration/worker.test.ts`
+ the SSE dispatch path in `apps/api/src/server.ts`.

- Registration: worker starts → discovers machine/runtimes/models →
  registers with the control plane.
- SSE stream (`GET /computers/:id/tasks/stream`): task dispatched while
  worker connected → immediate delivery; task dispatched while worker is
  *not yet connected* → `TaskDispatcher` queues it, delivers on connect
  (this queuing behavior is called out in PROGRESS.md as a specific fix —
  make sure it has a direct regression test, not just incidental coverage).
- Reconnect on drop: kill the SSE connection mid-task, worker reconnects,
  in-flight task state is reconciled (not silently duplicated or lost).
- Worker restart must re-register without duplicating itself in
  `ComputerRegistry`.
- Stale/offline detection: stop heartbeats, verify deterministic
  healthy → stale → offline thresholds (confirm these thresholds exist and
  are tested — if health tracking is currently minimal, this is where that
  shows up).

---

## 10. Persistence & Recovery

Two backends to test, not one:

**`JsonFileStore`** (`packages/shared/src/store.ts`):
- Cross-process file lock with stale-lock recovery — test with two real OS
  processes (`child_process.fork`), not simulated concurrency, since
  PROGRESS.md says this was "proven with real separate OS processes" —
  keep that as an actual regression, not a unit-test approximation.
- Parent-directory creation on fresh install.
- `Date` field revival after JSON round-trip — this was a real pre-existing
  bug per PROGRESS.md; the regression test should serialize an object with
  a `Date` field, reload it, and assert `instanceof Date`, not just that
  the value looks date-shaped.

**`PostgresStore`** (`packages/database`):
- `createPool`, `checkHealth`, `runKvMigration` against a real Postgres
  (docker compose service already exists — use it, don't mock the DB per
  the general engineering principle of not mocking the datastore in
  integration tests).
- Same `Date`-revival assertion as above, since PROGRESS.md notes the bug
  applied to both stores.

**Restart-mid-execution**: create job → start execution → kill the API
process → restart → assert job still exists, execution state is
recoverable, events/artifacts survive. This is listed as a property in
PROGRESS.md's "Done" section only at the store level, not yet as a full
job-level restart test — treat it as new coverage to add, not existing
coverage to confirm.

---

## 11. External Agent (OpenCode) Tests

`packages/agents/src/externalAgent.ts` + `ExternalAgentAdapter` wiring in
`apps/cli/src/engine.ts`. This is new and specifically called out in
PROGRESS.md as under-tested ("not exercised against a real OpenCode session
... invocation shape verified against `opencode --help`, not a live run").

- Detection: `opencode` binary present on `PATH` → agent registered;
  absent → not registered, no error.
- **Routing isolation** (critical invariant specific to this feature):
  `taskTypes: []` must keep it out of automatic routing. Write a test that
  registers the opencode agent, submits an un-pinned task that could
  plausibly match it, and asserts it is *never* selected without explicit
  `--agent opencode`.
- Explicit selection: `wa task run "..." --agent opencode` actually invokes
  `opencode run <message>` — if a real `opencode` binary is available in
  CI, add one live smoke test; otherwise fake the binary and assert the
  invocation shape only (argv, stdin/stdout wiring), and mark the live path
  explicitly as "not yet run against real OpenCode" rather than letting the
  fake test imply more coverage than it has.

---

## 12. Terminal / CLI Testing

Real command matrix (not the generic plan's invented commands — see
Section 0):

```text
wa init | doctor | status
wa task run | plan | status
wa exec list | inspect | replay
wa history list | inspect
wa context add | remove | list | clear
wa bench run
wa discover all
wa agents list
wa tools list
wa policy inspect
wa config show
wa jobs list | inspect | merge
wa computers list | inspect
wa workers list
wa runtimes list
wa models list
wa chat | ask
wa explain <ref>
```

For each: valid args, invalid args, missing args, nonexistent ids, exit
codes, stdout, stderr, TTY vs non-TTY.

`--json` coverage: PROGRESS.md explicitly says "Shell UX spec phase D
(`--json` everywhere) ... never started." Do **not** write tests asserting
`--json` output exists across the whole matrix — that would test against
an unbuilt feature. Instead: enumerate which commands currently support
`--json` (grep for it in `apps/cli/src/commands`), test those, and record
the rest as a tracked gap so phase D has a concrete checklist when it's
picked up.

`@ref` resolution (`apps/cli/src/references.ts`): `@block`, `@job:`,
`@agent:`, `@model:`, `@computer:`, `@file:` — test each resolves
correctly, plus nonexistent/ambiguous/stale reference handling, since this
shipped in phases A–C.

`wa exec replay` deserves focused testing beyond the policy-bypass angle in
Section 4: replaying with modified context, replaying a cancelled
execution (should this be allowed? — pin down the intended behavior and
test it, don't assume), replaying an execution whose original agent/model
is no longer registered.

Session export (Shell UX phase E) is explicitly not started per
PROGRESS.md — do not write tests for `wa session export`; it doesn't exist.

---

## 13. `wa doctor`

Build a deterministic check-by-check suite. For each check `wa doctor`
performs (enumerate from `apps/cli/src/doctor.ts`), test PASS / WARN / FAIL
/ NOT INSTALLED / UNAVAILABLE independently by faking the underlying
condition (e.g., point it at a Postgres that's down, an Ollama that isn't
running, a config file that's missing). Doctor output is a diagnostic
surface users will trust during onboarding — it needs to be as reliable as
anything in the control plane itself.

---

## 14. MCP Tests — scoped to what's actually wired

PROGRESS.md is explicit: `MCPClient`
(`packages/core/src/services/mcpClient.ts`) is fully implemented but
**never instantiated or called anywhere**. The only real MCP behavior today
is that `allowedMcpServers` policy denies unapproved servers.

Do not write tests assuming tool discovery, invocation, transport handling,
or reconnect logic are reachable end-to-end — they aren't yet. Test only
what's real:
- `PolicyEngine` denies a task/agent referencing an MCP server not in
  `allowedMcpServers`, with no code path that reaches `MCPClient` at all
  when denied.
- `MCPClient` itself can still get unit/contract tests in isolation
  (stdio/HTTP/SSE transport, message parsing, timeout handling) since it's
  fully implemented — just be explicit in the test file/suite name that
  this is testing an *unwired* component, so nobody reads green tests here
  as "MCP works end-to-end."

When `MCPClient` gets wired into the execution path, promote this section
to the full generic-plan MCP suite (connection, discovery, invocation,
policy-gated tool calls, cancellation) — track that as a follow-up rather
than writing it speculatively now.

---

## 15. Security Gaps as Explicit, Tracked Test Debt

PROGRESS.md's "Open work" list is effectively a pre-written list of things
that will fail if tested today. Rather than silently skip them, write
**explicit failing/skipped tests with a comment pointing at the gap**, so
the test suite documents its own coverage boundary and someone closing the
gap gets a test to turn green:

- **API auth/RBAC**: no API keys/JWT, permissive CORS. Write a test that
  hits a state-changing API route with no credentials and currently
  documents that it *succeeds* (red flag, intentionally). This becomes the
  regression test the moment auth is added — the expectation flips to
  "must be denied."
- **Container sandboxing**: agent tools run directly on the host today.
  Any "tool cannot escape its sandbox" test is currently untestable as
  stated — instead test the host-level guards that do exist (Section 4)
  and note sandboxing as a distinct, larger gap, not a small missing
  assertion.
- **Observability**: in-memory ring buffer only, no OTel/Prometheus. Don't
  write tests against metrics endpoints that don't exist.
- **CI enforcement**: nothing currently runs `build`/`typecheck`/`test` on
  PRs. This is infrastructure, not a test case — see Section 20.

---

## 16. Failure Handling Matrix

| Failure | Expected behavior | Test target |
| --- | --- | --- |
| Agent unavailable | Re-route or fail per policy | `agentRegistry` + `jobOrchestrator` |
| Model unavailable | Re-route or fail per policy | `modelRegistry` + scheduler |
| Runtime unavailable | No execution attempted | runtime adapter contract suite (Section 8) |
| Computer unavailable | Reschedule if allowed | `computerRegistry` + scheduler |
| Worker offline | Execution marked interrupted | `worker.test.ts` (Section 9) |
| Tool timeout | Tool failure, not hang | `packages/tools` |
| Job timeout | Job cancellation/failure | `jobOrchestrator` abort path |
| Policy denial | Immediate denial, non-retryable | Section 4 |
| Context too large | Rejected at compile time, not at runtime | `contextCompiler.ts` |
| Persistence failure | Halt unsafe state transition | `JsonFileStore`/`PostgresStore` |
| Process crash mid-execution | Recoverable, no duplicate/lost execution | Section 10 |
| SSE connection drop | Worker reconnects, no duplicate dispatch | Section 9 |

Every row should become an automated test; a bug fixed against any of these
rows gets a permanent regression test in the matching package's `tests/`
directory, not a one-off manual check.

---

## 17. Real Runtime / Model Matrix

Keep small and separate from the PR-gated suite (per Section 2 CI note):

| Runtime | Model | What it validates |
| --- | --- | --- |
| LM Studio | whatever's locally configured | coding-task execution, streaming |
| Ollama | whatever's locally configured | tool-use execution, context limits |
| Fake | FakeRuntimeAdapter | deterministic CI baseline |
| OpenCode (if installed) | n/a | external-agent invocation shape (Section 11) |

Do not assert exact natural-language output. Assert: response exists,
required structure present, tool calls valid, files modified appropriately
(via git diff in the workspace), execution completes, policy respected.

No OpenAI-compatible runtime exists yet (tracked gap) — nothing to test
here until an adapter is built; when it is, it should pass the same
contract suite from Section 8 with zero new test code beyond
adapter-specific fixtures.

---

## 18. Critical Invariants (non-negotiable automated assertions)

```text
No capability match           → no execution
Insufficient resources        → no execution
Policy DENY                   → no execution, at every entry point (Sec 4)
Context > model's hard limit  → rejected before runtime call (Sec 7)
Job/task CANCELLED             → cannot later become COMPLETED (Sec 5)
Fan-in dependency incomplete  → dependent task cannot start (Sec 5)
Worker offline                 → new work not dispatched there (Sec 9)
Restart                        → durable state survives (Sec 10)
Secret in any form             → never in persisted history/blocks/logs
opencode taskTypes: []          → never auto-selected, only explicit (Sec 11)
execution exists                → wa explain can reconstruct routing decision (Sec 7)
```

---

## 19. Golden Scenarios

Pin down a small set of canonical routing decisions as regression
baselines, in the same spirit as the generic plan but using real registry
shapes from `packages/core/src/types`:

```yaml
scenario: coding_task_local_only
task:
  capabilities: [coding]
policy:
  restricted: true   # local computers only
agents: [coder]
models: [locally-configured model]
computers: [local machine]
expected:
  agent: coder
  computer: local machine
  execution: allowed
```

```yaml
scenario: opencode_never_auto_routed
task:
  capabilities: [coding]
agents: [coder, opencode]   # opencode has taskTypes: []
expected:
  agent: coder   # never opencode, even though capable
  execution: allowed
```

Assert against the actual routing/explain output, not a hand-simulated
expectation — these should break loudly if scheduler behavior drifts.

---

## 20. Recommended Implementation Order

Unlike the generic plan's 16-phase list, this one is short because most of
the foundational work (security fixes, distributed dispatch, persistence,
shell UX phases A–C) is already done per PROGRESS.md. What's left:

```text
I0  Wire `npm test` (build + typecheck + vitest) into CI on every PR
     — nothing else here matters if regressions can merge silently
 ↓
I1  Lock in Section 4 (policy/security) as permanent regressions +
     extend the bypass sweep across all entry points
 ↓
I2  JobOrchestrator: steering, cancellation, retries, fan-out/fan-in
     (Section 5) — this is the least-tested critical subsystem right now
 ↓
I3  Runtime adapter contract unification (Section 8) — one suite,
     three adapters, ready for a 4th
 ↓
I4  Worker/SSE distributed tests on a real second host (Environment C)
 ↓
I5  Restart/recovery at the job level, not just the store level (Sec 10)
 ↓
I6  External agent (OpenCode) routing-isolation + live smoke test (Sec 11)
 ↓
I7  wa doctor check-by-check suite (Sec 13)
 ↓
I8  Explicit tracked-debt tests for auth/RBAC, sandboxing, MCP wiring
     (Sections 14–15) — document the gap, don't fake coverage
 ↓
I9  Golden scenarios (Sec 19) as scheduler regression baseline
 ↓
I10 Small real-model matrix (Sec 17), run separately from PR gate
```

The architectural principle from the generic plan still holds and is
already being followed here: `tests/fakes/runtime.ts` plus in-memory
registries should stay the primary way to test the scheduler, policy
engine, job orchestrator, and worker lifecycle. Real Ollama/LM
Studio/OpenCode runs validate the adapters and a handful of E2E paths —
they should never become the only way to exercise this code.
