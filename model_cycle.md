# Wazir Model-Cycle Test Plan

A companion to `Sep18-test.md`, which covers the system broadly (security,
job orchestration, persistence, CLI, distributed dispatch). This document
narrows to one slice: the **model cycle** —

```text
Task → Context sizing → Model selection → Computer selection → Runtime
     → Model load → Inference → Tool execution → Code generation
     → Validation → Model unload → Resource reclamation → Next task
```

The source material for this plan was a generic hardware-fleet test plan
(M4 Max / DGX / GB10, `wazir run`, automatic context-window renegotiation,
memory-aware concurrent model residency). None of that hardware exists in
this repo, and — more importantly — **several of the behaviors the generic
plan assumed are not implemented in Wazir today**. Rather than write tests
against a system that doesn't exist yet, this plan is grounded in the
actual code (file/line references throughout) and is explicit about which
parts of "the model cycle" are real and testable now versus tracked gaps.

---

## 0. Findings from grounding this plan (read this first)

These came out of reading the actual scheduler, registries, and runtime
adapters while adapting the generic plan. They change what "test the model
cycle" can mean today, so they're listed up front rather than buried.

**F1 — `ModelInstance.loaded` is dead state.**
`apps/cli/src/engine.ts:366` hardcodes `loaded: false` at discovery time,
regardless of what the runtime actually reports. The only method that can
ever flip it (`ModelRegistry.setInstanceHealth`,
`packages/core/src/services/modelRegistry.ts:24`) is never called anywhere
outside that file. So `loaded` is always `false`, forever, for every
instance. Any test premised on "Wazir knows a model is already resident and
avoids reloading it" will currently fail — not because reuse logic is
broken, but because the state it reads never updates.

**F2 — `loadModel`/`unloadModel` are declared but not implemented.**
`OllamaAdapter.getCapabilities()` (`packages/runtimes/ollama/src/index.ts`)
reports `modelLoad: true, modelUnload: true`, but the class has no
`loadModel()`/`unloadModel()` methods — only `getLoadedModels()` and
`estimateResources()`. `LMStudioAdapter` is at least honest about it
(`modelLoad: false, modelUnload: false`) and also doesn't implement them.
This is a capability/implementation mismatch worth a regression test on its
own (Section 8).

**F3 — Context is a static per-model ceiling, not a negotiated/resizable
window.** `Scheduler.scoreModel()` (`packages/core/src/services/
scheduler.ts:179`) checks `effectiveContextTokens(record) >=
requiredContext` and rejects the model outright if not — reason text is
literally *"select a model with a larger context window"*. There is no
"try 8K, escalate to 16K, escalate to 32K" negotiation anywhere. Separately,
`GenerationRequest.contextTokens` **is** forwarded per-request as Ollama's
`num_ctx` (`packages/runtimes/ollama/src/index.ts`, the `options` block in
`generate()`), which is a real, testable per-call context hint — but
`LMStudioAdapter.generate()` never reads `request.contextTokens` at all, so
the same field is honored by one adapter and silently ignored by the other.

**F4 — Memory-awareness is static and inaccurate.** Every discovered model
gets `memory: { minSystemGB: 8, minGpuGB: undefined }` hardcoded at
discovery (`apps/cli/src/engine.ts:348-351`), regardless of whether it's a
1B embedding model or a 120B MoE. `Scheduler.scheduleComputer()` compares
that fixed 8GB against `computer.hardware.memoryGB` — total installed RAM,
not free RAM. `ResourceState` (`packages/core/src/types/resource.ts`) has
`memoryAvailableGB`/`gpuMemoryAvailableGB` fields, but the scheduler never
reads them (only `computer.load?.cpuPercent` factors into placement
scoring). Concurrent-model memory pressure is not modeled today.

**F5 — `wa bench run` measures one `generate()` call, not a lifecycle.**
`runBenchmark()` (`apps/cli/src/commands.ts:371`) reports first-token
latency, total time, input/output tokens, and throughput for a single
haiku-length completion. It does not measure cold load, warm load, or
unload — there's no code path that currently could, given F2.

**F6 — The event schema anticipates model-lifecycle observability that
nothing emits.** `ExecutionEventType` (`packages/core/src/types/
execution.ts`) includes `'model.loading'` and `'model.loaded'` variants,
but a repo-wide search finds them only in that type declaration — no
service ever constructs an event with either type. `wa exec replay` can
never show a model load phase today, even though the schema has a slot for
it.

**F7 — Two more dead fields already tracked in `PROGRESS.md`, relevant
here:** `ComputerRegistry`'s `health: 'degraded'` (nothing sets it) and
`ModelRecord.runtimeCompatibility` (scheduler never reads it). Both matter
for model-cycle tests specifically because the generic plan's "computer
selection" tests lean on exactly this kind of signal.

None of this means the model cycle is untestable — the discovery →
model-routing → computer-routing → context-budget → generate → evaluate
pipeline is real and does work end-to-end (`wa task run`). It means the
*elastic* parts of the generic plan (auto-resize, residency-aware
thrashing avoidance, memory-pressure-aware concurrent loading) are design
targets, not current behavior, and the tests below are written to say so
explicitly rather than assert against fiction.

---

## 1. The real pipeline, stage by stage

```text
wa task run "<description>"
  apps/cli/src/run.ts: planTask() / executeTask()
       │
       ▼
  PolicyEngine.evaluateTask()                    packages/core/src/services/policyEngine.ts
       │  (deny -> stop here, no execution created)
       ▼
  ContextCompiler.compile()                      packages/core/src/services/contextCompiler.ts
       │  budgets parts, compacts (drop optional -> trim -> fail),
       │  produces requiredContextTokens
       ▼
  Scheduler.plan()                                packages/core/src/services/scheduler.ts
       │  Phase 1 — routeModel(): capability match, context ceiling check,
       │            "already loaded" scoring bonus (F1: bonus is currently
       │            unreachable), explicit targetModelId pin support
       │  Phase 2 — scheduleComputer(): policy filters (allowedComputers,
       │            localOnly, allowedRuntimes), static memory check (F4),
       │            CPU-load + locality + health scoring
       ▼
  RuntimeAdapter.generate()                       packages/runtimes/{ollama,lmstudio}
       │  Ollama forwards contextTokens as num_ctx (F3); LM Studio ignores it
       │  streams token / tool_call / completed / error events
       ▼
  CodingAgent turn loop                           packages/agents/src/codingAgent.ts
       │  phases: plan -> implement -> (test/lint/typecheck/build) -> repair -> verify
       │  bounded by maxTurns (default 30) and maxRepairCycles
       ▼
  evaluateExecution()                              packages/evaluation/src/index.ts
       │  success = expected files changed AND all checks passed AND no fatal errors
       │  — the model's own claim of success is never the source of truth
       ▼
  ExecutionRecord persisted, events recorded        packages/core/src/types/execution.ts
       │  (model.loading / model.loaded event types exist but are unused — F6)
       ▼
  wa executions inspect <id> / wa explain <id>
```

There is no explicit "unload" or "reclaim" stage in this pipeline today —
that's F2/F6 again. Test Section 8 below treats that gap directly instead
of assuming a reclamation step exists.

---

## 2. Test environments

Reuses the Environment A–D naming from `Sep18-test.md` so the two documents
stay consistent; this plan only needs A, B, and (optionally) C.

**Environment A — Fake runtime, in-process.**
`tests/fakes/runtime.ts` (`FakeRuntimeAdapter`) + in-memory registries.
Deterministic; this is where Scheduler/ContextCompiler/registry unit tests
in Sections 4–7 below belong. Already the CI default per Section 2 of
`Sep18-test.md`.

**Environment B — One real machine.**
Whatever machine this plan is actually run on, with Ollama and/or LM
Studio running locally. `tests/runtime/liveModelMatrix.test.ts` already
probes for both and skips gracefully when absent — extend that file rather
than writing a parallel probe. If the operator has a beefier box (more
RAM/VRAM, larger local models) available, it's still "Environment B" — it
just changes which models are realistic to load, not which code paths get
exercised. Record actual hardware (CPU, RAM, GPU/VRAM if any) at the top of
any benchmark output so results are comparable later.

**Environment C — Two real machines (optional).**
Only relevant to Section 13's cross-computer routing tests. Needs a second
host running a worker (`packages/workers`) reachable from the API over the
SSE task-pull loop (`GET /computers/:id/tasks/stream`) — see
`Sep18-test.md` Section 3, Environment C for the full setup. Skip this tier
entirely if only one machine is available; everything in Sections 4–12
still applies on a single box.

---

## 3. Discovery (`wa discover all`, `wa runtimes list`, `wa models list`)

- Runtime discovery against a live Ollama and a live LM Studio: confirm
  `RuntimeInfo.id/name/version/url`, and that `health` reflects a real
  probe (kill one daemon, rerun `wa discover all`, confirm it flips to
  `unavailable` — not cached as `healthy`).
- Model discovery: confirm every discovered model gets a `ModelRecord` with
  `contextMax` sourced from `discovered.contextWindow ?? configured ??
  DEFAULT_CONTEXT` (`apps/cli/src/engine.ts:329`) — write a case where the
  runtime *does* report a context window and one where it doesn't, and
  assert which source won.
- **Regression test for F4**: assert every newly discovered `ModelRecord`
  currently gets `memory.minSystemGB === 8` regardless of model size. This
  test should fail loudly (in the "this asserts a bug exists" sense used in
  `Sep18-test.md` Section 15) the moment someone makes this size-aware —
  that's the point of writing it as an explicit, named assertion now.
- **Regression test for F1**: after discovery, assert every `ModelInstance`
  has `loaded === false`, even for a model LM Studio or Ollama currently
  reports as loaded via `getLoadedModels()`/`/api/ps`. Same intent as
  above — document the gap as a test, not a comment.
- Re-run discovery twice in a row; confirm no duplicate `ModelRecord`/
  `ModelInstance` entries (registries key by id, but confirm the id
  construction — `` `${discovered.id}::${computerId}::${provider}` `` in
  `engine.ts:361` — is actually stable across repeated discovery, not
  regenerated with a new suffix each time).

---

## 4. Model Routing (Scheduler Phase 1 — `routeModel`/`scoreModel`)

Environment A (fake registries), extended with Environment B spot-checks.

- Capability rejection: task requires a capability no registered model has
  → `SchedulingError`, listing every rejected model and its specific
  rejection reason (not just "no model found").
- Context ceiling rejection: task's `requiredContextTokens` exceeds every
  registered model's `effectiveContextTokens()` → rejected with the exact
  reason string Wazir produces today (assert the literal reason substring,
  since that's the user-facing explanation via `wa task plan`).
- Explicit pin (`task.execution.targetModelId`): pinning an eligible model
  bypasses scoring and is selected with `strategy: 'explicit'`; pinning an
  *ineligible* model throws `SchedulingError` with **no silent fallback** —
  this "no silent fallback" behavior is a named invariant in the scheduler
  code (`scheduler.ts:118`) and deserves a test asserting Wazir never picks
  a different model than the one explicitly requested.
- Scoring order: two eligible models, one with 2x context headroom over the
  requirement — assert it scores higher (`scheduler.ts:195-198`) and wins
  ties are broken lexicographically by model id (assert this specifically,
  since it's what makes scheduling deterministic — same registries + same
  task = same model, every run).
- **F1 interaction test**: construct a fake registry where one instance has
  `loaded: true, health: 'healthy'` set directly (bypassing the dead
  `setInstanceHealth` path, since this is testing the *scoring* logic in
  isolation) and confirm the `+2` "already loaded" bonus and its reason
  string do fire correctly at the unit level — this isolates "is the
  scoring math right" from "does anything ever set `loaded: true` in
  practice" (which is F1, tested separately in Section 3).

---

## 5. Computer Routing (Scheduler Phase 2 — `scheduleComputer`)

- Two computers, one with `hardware.memoryGB` below `record.memory
  .minSystemGB` → the under-resourced one is never selected, and its
  rejection reason names the actual GB shortfall
  (`scheduler.ts:271-275`).
- Policy filters: `allowedComputers`, `localOnly`, `allowedRuntimes` — one
  test per filter, confirming a computer that fails the filter never
  appears in `placements` at all (not just scored low).
- Runtime/instance health gates: runtime `health: 'unavailable'` or
  instance `health: 'unavailable'` excludes that placement, with a
  specific failure reason, not a generic rejection.
- Determinism: same registries + same task + same policy, run 20 times →
  identical `computerId` every time (property test, not a single
  assertion — scoring ties especially need this since tie-break is
  lexicographic on `computer.id`).
- **F4 interaction test**: two computers both individually satisfy the
  static `minSystemGB` check for a model, but *combined* with another
  already-running job's memory footprint neither actually has room — assert
  today's Scheduler has no way to see this (it doesn't read `computer.load
  .memoryAvailableGB`) and will happily place the job anyway. Write this as
  a documented-gap test per the `Sep18-test.md` Section 15 pattern: it
  currently "succeeds" in a way that's actually wrong, and the assertion
  should flip the day real-time memory awareness is added.

---

## 6. Context Budgeting (`ContextCompiler`)

Already grounded well by existing type tests if any exist under
`packages/core/tests/` — extend, confirm compaction order specifically:

- Compaction order is `retrieved → mcp → memory → conversation →
  repository` (`contextCompiler.ts:22-28`), and within that, "drop
  optional parts entirely" happens before "trim remaining parts to
  `trimFraction`" (default 0.5) — write a fixture with parts in every
  `kind` and confirm the *order* compaction removes them in matches this
  list exactly, not just that the total shrinks.
- `priority: 'critical'` parts (system, task) are never dropped or
  trimmed, even when the budget still doesn't fit after compacting
  everything else — confirm `fits: false` is returned rather than the
  compiler silently trimming a critical part as a last resort.
- Overflow case (draft's "Test 12"): construct parts whose critical-only
  total already exceeds every registered model's max context. Assert
  `fits: false`, the reasons array explicitly says "select a model with a
  larger context window" (or whatever the current string is — pin the
  exact text so drift is caught), and **no partial/truncated context is
  ever sent to a runtime** — trace this through to `Scheduler.plan()` to
  confirm the `SchedulingError` actually stops execution before any
  `generate()` call, not just before returning a decision object.
- `wa task plan` should show the real compaction result (`context:
  finalRequiredTokens / available.tokens (source)` per
  `commands.ts:467-474`) — assert the CLI output and the underlying
  `ContextDecision` agree, since `wa task plan` is the operator-facing
  surface for exactly this.

**What NOT to test here** (per the F3 finding): do not write tests
asserting Wazir escalates from 8K → 16K → 32K mid-session, negotiates a
larger `n_ctx` and reloads a model to fit a bigger prompt, or shrinks
context back down under memory pressure. None of that exists. If/when a
resize-and-reload mechanism is built, this section is where its tests
belong — until then, the only "context sizing" behavior to test is the
static ceiling check above plus the two adapters' divergent handling of
`contextTokens` (Section 8).

---

## 7. `@wazir/runtimes-*` Adapter Contract (build on what already exists)

`tests/runtime/adapterContract.suite.ts` already exists and runs a
parametrized contract suite (interface shape, `discover`, `healthCheck`,
`listModels`, `getCapabilities`, `generate` streaming, `executeRequest`,
plus optional offline/disconnect failure injection) against any adapter
passed in. `tests/runtime/liveModelMatrix.test.ts` already wires this up
against the fake adapter, LM Studio (if live), Ollama (if live), and
probes for an OpenCode binary. **Do not rebuild this — extend it** with
model-cycle-specific cases:

- Add a case to the contract suite: call `generate()` twice in a row with
  a low `contextTokens` then a high one, against the **same** `modelId`.
  For Ollama, assert the second `/api/chat` request body actually carries
  `options.num_ctx` equal to the second value (this is the one real,
  per-call "context resize" signal that exists today — verify it's not a
  no-op). For LM Studio, assert the request body **never** contains a
  context-length field regardless of `contextTokens` (F3) — this is a
  genuine adapter-parity gap worth a permanent regression so nobody
  "fixes" LM Studio silently without anyone noticing the prior behavior.
- `getCapabilities()` vs actual implemented methods (F2): add a contract
  assertion that if `capabilities.modelLoad === true`, `adapter.loadModel`
  must be a function, and same for `modelUnload`/`unloadModel`. This should
  **currently fail for `OllamaAdapter`** — write it as a known-failing/
  skipped test with a comment pointing at F2, exactly the `Sep18-test.md`
  Section 15 pattern for tracked debt, so it flips green the moment someone
  either implements the methods or (more honestly) sets the capability
  flags to `false` to match reality.
- `estimateResources()`: Ollama implements it from `/api/tags` model sizes
  (`packages/runtimes/ollama/src/index.ts:161`) — test that it returns
  `undefined`/empty for a model never seen via `listModels()` (cold-start
  case, size map not yet populated) rather than throwing. LM Studio doesn't
  implement this method at all — confirm the contract suite's
  `if (adapter.estimateResources)` guard actually skips it cleanly rather
  than assuming every adapter has it.
- Runtime failure injection (already supported by
  `ContractSuiteOptions.simulateFailure`): use it for both adapters —
  runtime down before dispatch, runtime disconnects mid-stream. Confirm
  `outcome.ok === false` and a reason is recorded in both cases, and that
  no `ExecutionRecord` is ever left in a `running` state forever.

---

## 8. Model Load/Unload — what's real vs. what needs building first

This is the section the generic plan spent the most space on (Tests 4, 5,
13, 14, 15, 23, 24 in the source draft), and where F1/F2/F5/F6 bite
hardest. Split it explicitly into "testable now" and "needs code before it
can be tested meaningfully."

### 8a. Testable now

- `getLoadedModels()` against a live Ollama/LM Studio: confirm it reflects
  reality by loading a model through each tool's own UI/CLI outside of
  Wazir, then calling `getLoadedModels()` and asserting the loaded model
  id appears. This exercises the adapter method in isolation from the
  (broken) registry-sync path.
- Implicit load-on-first-use: call `adapter.generate()` for a model that
  isn't currently loaded in Ollama; confirm the call still succeeds
  (Ollama loads on demand) and note the extra latency on that first call
  versus a second call to the same model — this is the closest real
  analog to "cold load vs. warm execution" available today, and it's
  adapter-driven, not Wazir-orchestrated.
- `wa bench run <modelId>`: run it twice back-to-back against the same
  model and confirm the second run's `first token` latency is lower than
  the first (evidence of the runtime's own warm-cache behavior) — this is
  the honest version of the generic plan's "cold load / warm execution /
  unload / reload" benchmark table (F5): Wazir can observe the effect
  through timing, even though it can't orchestrate load/unload directly.

### 8b. Needs a design decision + implementation before it's meaningfully testable

Write these as explicit skipped/documented-gap tests (per `Sep18-test.md`
Section 15 style) rather than skipping silently:

- **Registry sync** (F1): nothing today calls `setInstanceHealth` after a
  real `generate()` call, a worker heartbeat, or a periodic
  `getLoadedModels()` poll. Until something does, "avoid double-loading
  the same model for two sequential jobs" (generic plan's Test 5) and
  "detect load/unload thrashing across a job sequence" (Test 14) cannot be
  tested against real behavior — only against the isolated scoring math in
  Section 4's last bullet. Flag this as the single highest-leverage fix to
  unlock the rest of this section.
- **Explicit unload/reclaim** (F2): there is no code path, adapter method,
  or CLI verb that unloads a model or reclaims memory today. "Model unload
  after failure" (generic plan's Test 23) and "crash during model loading"
  (Test 24) can't be tested as lifecycle events — they *can* be tested at
  the level that already exists: does a failed `ExecutionRecord` correctly
  record `status: 'failed'` and errors (yes, testable now via
  `evaluateExecution`), just not "and then the model was unloaded" (no,
  not yet a thing).
- **`model.loading`/`model.loaded` events** (F6): once something starts
  emitting these, add tests that `wa exec replay` renders them in the
  correct position in the timeline relative to `generation.started`. Not
  testable today because nothing produces them.

---

## 9. Model Switching Across Agents

This one *is* fully real today via explicit pins, no new code needed.

- Run a task with `--agent coder --model <model-a>` immediately followed by
  `--agent reviewer --model <model-b>` (two different `targetModelId`
  pins). Confirm via `wa exec inspect` on both executions that
  `scheduling.modelId` differs as pinned, and that both scheduling
  decisions are independently explainable via `wa explain <execId>`.
- Confirm pinning a model not registered on any computer throws
  `SchedulingError` before any generation is attempted (no execution
  record with a `running` status left dangling) — this reuses the
  "explicit pin, no silent fallback" invariant from Section 4, exercised
  through the actual CLI this time instead of the scheduler in isolation.

---

## 10. Concurrent / Cross-Computer Placement

- **Single machine, two models requested close together**: submit two
  `wa task run` calls back to back requiring different models that both
  fit the static memory check individually. Given F1/F4, expect Wazir to
  schedule both without any real awareness of whether the machine can
  actually hold both models loaded simultaneously — this is the practical
  consequence of Section 5's last bullet; if it causes an actual OOM on
  Environment B, that's the finding, not a false alarm.
- **Cross-computer (Environment C only)**: register a model only on
  computer B (per `apps/cli/src/remoteInventory.ts`'s inventory pull, or
  direct registration), submit a task with `policy.allowedComputers`
  unset, confirm the Scheduler picks computer B and the API's SSE
  dispatcher (`GET /computers/:id/tasks/stream`) actually delivers the
  work there — this reuses `Sep18-test.md` Section 9's worker tests but
  asserts specifically on the *model-routing reason*, not just "the task
  ran somewhere."
- Remove that model's only instance (deregister or stop the runtime on
  computer B) mid-way and resubmit: confirm `SchedulingError` with a clear
  "no computer can host model X" reason (`scheduler.ts:319`), not a hang
  or a silent reroute to a different model.

---

## 11. End-to-End Task Lifecycle (flagship test)

The most direct real analog to the generic plan's "Test 1" and final
flagship scenario, using the actual CLI:

```bash
wa task run "Create a TypeScript implementation of an LRU cache with unit tests."
```

Assert, from the resulting `ExecutionRecord` (`wa exec inspect <id>
--json`):

```text
✓ scheduling.modelId / runtimeId / computerId all recorded
✓ context.finalRequiredTokens / available / fits recorded
✓ agent phases progressed: plan -> implement -> verify (or repair -> verify)
✓ checks include at least 'test' and 'typecheck', each with ok + durationMs
✓ filesChanged non-empty and matches actual `git diff` in the workspace
✓ usage.input / usage.output / usage.total populated
✓ evaluation.success reflects checks/errors, not the model's own claim
✓ wa explain <id> reconstructs the same model/computer/runtime + reasons
```

Then repeat with an intentionally-broken fixture repo (compile errors,
failing tests) and confirm the agent's bounded repair loop
(`codingAgent.ts` — `maxRepairCycles`, `repairLimit = min(8, max(4,
maxTurns - turnsUsed))`) actually attempts repair before giving up, and
that exceeding the repair budget produces `evaluation.success: false` with
the specific failing-check output in `errors`/`checks`, not a false
"completed."

---

## 12. Failure & Recovery Across the Model Cycle

Cross-reference `Sep18-test.md` Section 16 (the failure matrix) for the
general cases; these are the model-cycle-specific additions:

| Failure injected | Expected | Where to look |
| --- | --- | --- |
| Runtime stopped before `wa task run` | `SchedulingError` before any execution row created (no running/orphaned execution) | `scheduler.ts:261-265` |
| Runtime killed mid-`generate()` | Execution marked `failed`, error recorded, no partial file writes left uncommitted | `executeRequest` in `@wazir/workers` |
| Model deregistered mid-job (job has 2+ tasks pinned to it) | Already-scheduled task for that model either completes (if already dispatched) or fails cleanly for later tasks — pin down which, don't assume | `jobOrchestrator.ts` + Scheduler |
| Wazir process restarted mid-generation | Execution recoverable per `Sep18-test.md` Section 10; specifically confirm the recovered record does **not** claim `status: 'completed'` for work that never finished | `JsonFileStore`/`PostgresStore` |
| Two computers claim the same model instance id (flaky reconnect) | No duplicate `ModelInstance` registered — id construction is `` `${modelId}::${computerId}::${provider}` ``, so this should be structurally impossible; write the test that proves it | `engine.ts:361`, `modelRegistry.ts` |

---

## 13. Explainability of the Full Cycle

- `wa explain <executionId>`: for every execution created in Sections
  9–11, confirm the rendered output names the selected model, computer,
  and runtime plus at least one concrete reason each
  (`renderExecutionExplain` in `commands.ts:727`) — and confirm **rejected
  candidates** are visible somewhere in the record too, not just the
  winner (check `scheduling.modelDecision`/`computerDecision` structure;
  if only the winner's reasons are persisted today, that's UX debt worth
  naming explicitly, same as `Sep18-test.md` Section 7 already flags).
- `wa explain @job:<id>`: aggregate rollup across a multi-task job
  (tokens, duration, cost, per-task scheduling reasons) —
  `renderJobExplain` in `commands.ts:784`. Confirm the rollup's
  `computersUsed`/`modelsUsed` lists match what actually ran, not what was
  merely eligible.
- Never recompute a decision after the fact — every assertion in this
  section should read from the persisted `SchedulerDecision`/
  `ContextDecision`, never re-run the scheduler/compiler live to check
  "would it still pick the same thing" (that's a different, also useful,
  determinism test — Section 4/5 already cover it separately).

---

## 14. Metrics actually available today (vs. proposed)

Grounded against `ExecutionRecord`, `TokenUsage`, `CheckRunRecord`,
`SchedulerDecision`, `ContextDecision` (`packages/core/src/types/
execution.ts`, `scheduler.ts`, `context.ts`):

**Captured today, per execution:**
```text
execution: id, status, agentId, modelId, runtimeId, computerId,
           createdAt, startedAt, completedAt
scheduling: modelId/computerId/runtimeId + reasons (both phases)
context: requiredTokens, available.tokens, available.source, fits,
         compactions (part, action, savedTokens, reason)
usage: input, output, total tokens
checks: name (test|lint|typecheck|build), ok, durationMs, output
toolCalls: tool, ok, durationMs, policyEffect, policyRule
filesChanged, errors, evaluation.success + reasons
```

**Not captured today (proposed, blocked on F1/F2/F5/F6):**
```text
model load_time_ms / unload_time_ms          (needs F2 + F6)
runtime queue_time_ms                         (no queueing concept observed yet)
hardware RAM/VRAM before/peak/after           (needs live ResourceState sampling wired
                                                into execution, not just Computer.load)
tokens_per_second                             (derivable today from usage + durationMs —
                                                @wazir/shared already exports
                                                tokensPerSecond(), used by `wa bench run`
                                                and job rollups; just not persisted
                                                per-execution yet)
```

Don't build dashboards or benchmark suites against the "not captured
today" list until F1/F2/F6 are addressed — that's the actual prerequisite
work, not a testing gap.

---

## 15. Recommended order

```text
M0  Decide + fix F1 (registry sync) and F4 (real memory sizing) —
     everything about "residency-aware scheduling" and "concurrent model
     safety" is untestable-as-intended until these are real
 ↓
M1  Write the documented-gap tests in Sections 3, 5, 7, 8b now, before
     M0 — they're cheap, and they're what makes M0's fix verifiable
     (green flip) instead of just trusted
 ↓
M2  Extend tests/runtime/adapterContract.suite.ts + liveModelMatrix.test.ts
     per Section 7 — reuse existing infrastructure, don't fork it
 ↓
M3  Section 11's flagship end-to-end test — this is the one that proves
     the whole pipeline holds together and should be the first thing that
     runs in Environment B against a real Ollama/LM Studio
 ↓
M4  Section 10/12 — concurrent placement + failure injection, once M0
     lands (before that, Section 10's single-machine case is a known-gap
     test, not a real safety net)
 ↓
M5  Section 13 explainability regressions, then Section 14's "captured
     today" metrics as permanent per-execution assertions
 ↓
M6  Only after M0–M5: revisit F2/F6 as a real design task (should Wazir
     implement loadModel/unloadModel against Ollama's keep_alive param and
     LM Studio's REST load API, and start emitting model.loading/
     model.loaded?) — at that point Section 8b's tests stop being
     documented gaps and become the real regression suite for model
     lifecycle orchestration, which is what the original generic plan was
     actually asking for.
```
