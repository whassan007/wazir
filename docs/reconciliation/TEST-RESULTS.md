# Test Results

All commands run from `/Users/wael/Code/Wazir/.claude/worktrees/agent-a89ea5348fd4e9717`
(an isolated git worktree checked out at `integration/v0.2.11-reconciliation`,
HEAD `ca78171` at time of writing), Node v22.23.3, macOS (darwin/arm64).

## 1. Baseline (v0.2.11 tag, before any integration work)

```
npx tsc --build --force
```
Result: **clean, 0 errors.**

## 2. Full typecheck after integration

```
npx tsc --build --force
```
Run after each integration step; **clean, 0 errors** at every checkpoint
(commits `353c1c9`, `14198ea`, `8c37ba1`, `ca78171`).

## 3. Full build

```
npm run build
```
Result: **success.** Builds every workspace including the Rust/Tauri desktop
app (`cargo` release build, 22.66s), the web dashboard, the worker daemon,
and bundles the CLI (`node scripts/bundle.mjs` → `bin/wa.js`, 18.4MB, 340ms).

## 4. Unit/integration test suite (by directory)

| Command | Files | Passed | Skipped | Failed |
|---|---|---|---|---|
| `npx vitest run packages/core/tests packages/tools/tests packages/agents/tests packages/shared/tests packages/scheduler/tests packages/policies/tests packages/registry/tests packages/database/tests packages/workers/tests packages/observability/tests packages/memory/tests packages/secrets/tests` | 179 | 1394 | 29 | **0** |
| `npx vitest run apps/cli/tests apps/api/tests` | 85 | 632 | 2 | **0** |
| `npx vitest run packages/evaluation/tests packages/database/tests packages/memory/tests` | 25 | 214 | 19 | **0** |
| `npx vitest run tests/live/realWorldAcceptance.test.ts` | 1 | 10 | 0 | **0** (after fixing one stale assertion, see below) |

**Totals: 290 test files, 2250 tests passed, 50 skipped, 0 failed.**

**Not run** (out of scope — nothing in this reconciliation touches them):
`apps/web`, `apps/worker`, `apps/desktop`, `apps/android`, `apps/ios`,
`apps/mobile` test suites, and `packages/runtimes/*` adapter-specific tests.
The repository has several thousand test files in total across these and
other directories not enumerated above; a full `npm test` (which also
rebuilds first) was not run to completion given this session's time budget.
Every directory this reconciliation actually modified was run in full.

## 5. Notable individual results (subsets of the totals above)

- **`packages/core/tests/resources.test.ts`** (39 tests, all pass) — includes
  the 2 new tests for the ported `quotaGroup` mechanism (shared-quota
  admission, paid-advisory labeling).
- **`packages/tools/tests/timeoutTermination.test.ts`** (5 tests, all pass)
  — this is the exact test my earlier (pre-reconciliation) session
  deterministically bisected to a bug in `WorkspaceMutationAttributor`. It
  passes here specifically *because* that component was deliberately
  **not** integrated (see FEATURE-MATRIX.md) — v0.2.11's original
  before/after snapshot diff in `executeTool()` is untouched. This is
  positive evidence the DEFER decision was correct, not just cautious.
- **`apps/cli/tests/nvidiaProviderSystem.test.ts`** (5 tests, 4 pass, 1
  skipped) — confirms v0.2.11's independently-evolved NVIDIA support is
  real and tested, supporting the DEFER decision on `12f8273` (don't
  overwrite working, tested code with an untested-on-this-baseline
  alternative).
- **`apps/cli/tests/missionControl.test.ts`** (2 tests, both pass) —
  confirms v0.2.11's mission-control TUI is real but smaller in scope than
  main's (which has a 621-line test file after `1c95e40`), supporting the
  DEFER decision there.
- **`apps/cli/tests/subagentFleetPlacement.test.ts`** (3 tests, all pass) —
  real Scheduler + ExecutionEngine (not mocked), two-computer fleet,
  verifies: default dispatch keeps the parent's model/computer unchanged;
  a `requirements: { vision: true }` dispatch is placed on the one model in
  the fleet that actually supports vision, with the `SchedulerDecision`
  recorded on the child execution; and an impossible requirement fails
  placement with a clear reason instead of silently falling back.
- **`packages/core/tests/handoffService.test.ts`** (1 test, passes) —
  persists, redacts secrets from, deduplicates, and restores a handoff
  record.
- **`packages/core/tests/fleetMemoryService.test.ts`** (6 tests),
  **`packages/tools/tests/memoryTools.test.ts`** (4 tests) — both fully
  passing; cross-instance sharing, project scoping, keyword ranking,
  retention, and the real `PolicyEngine` allow-rule are all exercised.

## 6. End-to-end CLI verification (real binary, not mocked)

### `tests/live/realWorldAcceptance.test.ts` — all 10 journeys, real `wa` subprocess

```
npx vitest run tests/live/realWorldAcceptance.test.ts
```
Journeys 1–7 and 10 (installation/init, `wa doctor`, model discovery, a
real pty-driven `wa chat` session, filesystem mutation verification,
build/test exit-code detection, unavailable-model handling, cancellation/
retry) — **10/10 pass.**

One bug found and fixed while running this for real: Journey 1 asserted
`wa --version` equals the literal string `'0.2.7'` (hardcoded when
`main@7133f16` wrote the suite against its own version). Fixed to read
`package.json`'s actual version (commit `ca78171`), matching the pattern
`apps/cli/tests/canonicalVersion.test.ts` already established. This is a
real pre-existing bug in the ported suite, not a reconciliation artifact —
flagged rather than silently patched around.

### Manual CLI smoke tests (handoff feature, since I had to fix its wiring)

```
cd /tmp/wazir-handoff-smoke && WAZIR_IN_MEMORY=1 node .../bin wa handoff --help
```
→ prints the `create`/`list`/`show`/`export`/`resume` subcommands correctly.

```
WAZIR_IN_MEMORY=1 wa handoff list
```
→ `No handoffs found.` (correct, empty store)

```
WAZIR_IN_MEMORY=1 wa handoff create --objective "test objective" --json
```
→ returns a fully-formed `HandoffRecord` JSON object with the objective,
empty completed/remaining sections, repository path, and provenance —
confirming `engine.handoffs` is a real, constructed `HandoffService`
instance end to end, not the dead `any`-typed stub it was before this
reconciliation's fix.

## 7. Benchmarks

Per the spec's explicit instruction — **"If tests cannot run because
required infrastructure is unavailable, explicitly report the blocked
verification. Never classify untested behavior as passing."** — this
environment has no live Ollama/LM Studio instance, so no fresh
time-to-first-token, end-to-end inference latency, or tokens/sec numbers
were measured against a real model. That verification is **BLOCKED**, not
passing, not skipped-and-assumed-fine.

What *was* measured, for real, in this environment:

- **CLI startup** (`node bin/wa.js --version`, 3 runs): 0.25s, 0.24s, 0.24s
  wall-clock.
- **`scripts/resource-routing-benchmark.mjs`** (ported in `353c1c9`), run
  against the integration branch's own code:
  ```
  node scripts/resource-routing-benchmark.mjs
  ```
  Produces a real (not fabricated) synthetic benchmark: 5 concurrent tasks,
  4 admitted, 1 correctly deferred on quota exhaustion, 0 shared-quota
  in-flight reservations left after settlement, 1 recovered reservation, 2
  duplicate-settlement checks both correctly `false`. 2.76ms for the whole
  synthetic run (no real model I/O — this benchmark exercises the
  admission/ledger logic only, by design; its own output says so).

**Historical, not re-measured here:** both lineages carry their own prior
self-reported latency data from live runs against `google/gemma-4-12b-qat`
on real hardware (`test/codex-execution-performance/{baseline,benchmark-after}.csv`
on v0.2.11's side; `test/codex-fast-path/latency-{baseline,after}.csv` on
main's side, not merged into this branch). These are cited in
FAST-PATH-DECISION.md as context for why each lineage believed its fast
path helped, but are explicitly **not** treated as a controlled head-to-head
comparison — they were measured by each author against their own version,
at different times, and I could not reproduce either live in this session.
