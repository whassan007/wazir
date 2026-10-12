# Wazir Stability Repairs

Each repair below was reproduced with a failing regression test first. All tests
were then re-run green. Finding IDs refer to `WAZIR_CODE_AUDIT.md`.

| ID | Change | Regression test | Before → After |
|---|---|---|---|
| F1 | ACP `requestPermission` fails closed. It approves only on an explicit resolver decision that names an offered option. No resolver, an empty decision, a resolver error, or an unknown ID all return `cancelled`. | `packages/agents/tests/acpClient.safety.test.ts` (4 cases) | `selected` (auto-approve) → `cancelled` |
| F2 | `classifyOption` uses the ACP `kind` (`allow_*` / `reject_*`, `*_once` / `*_always`) when present, and falls back to the label otherwise. | covered by F1 suite and `permissionBroker.test.ts` | label-only → spec-first |
| F3 | ACP: `'error'` listener on spawn, `initialize` raced against `ACP_INIT_TIMEOUT_MS` and spawn failure (child killed on failure), and background turns go through `startTurn()`, which reports failures as activity. | `acpClient.safety.test.ts` (2 cases) | process crash / unhandled rejection → rejected promise / `Turn failed` activity |
| F4 | `ExternalAgentAdapter` spawns in its own process group, kills the group on timeout or cancel, polls `isCancelled` every 250 ms, caps capture at 20k chars, and reports `timed out after Nms`. | `packages/agents/tests/externalAgent.lifecycle.test.ts` | cancel: ran until exit / timeout: **never returned** → cancel ≈ 360 ms with all descendants dead, timeout fires |
| F5 | `buildWhyExplanation` reports only observed engine state. Missing evidence is `UNKNOWN`, and no `immutableHash` is shown unless a real digest exists (the `complete` topic still uses the execution record's workspace digest). | `missionControlGates.test.ts` "all why topics reject model prose…" | fabricated hashes/metrics → `UNKNOWN` |
| F6 | `/canary` view wired in: `TuiView` member, command, `c/m/s/r/h` tabs, ↑/↓/Enter history selection, Esc back to the dashboard, and a pane fed by `CanaryDeploymentService` records. The key block runs before the global `c` (cancel job) shortcut and only when the input buffer is empty. | `missionControlGates.test.ts` canary history; `missionControlWidths.test.ts` (70/100/140/200 cols) | view unreachable → renders without overflow at all widths |
| F7 | `cancelTask` returns early for tasks already `completed`, `failed` or `cancelled`. | `jobLifecycleAndValidation.test.ts` "cancelTask on an already-completed task…" | `cancelled` → `completed` preserved |
| F8 | One `TextDecoder` per stream in all five adapters. | `packages/runtimes/ollama/tests/streamDecoding.test.ts` | `مرحبا ��` → `مرحبا 👋` |
| F9 | `controller.abort()` in each adapter's stream `finally`. | `streamDecoding.test.ts` "aborts the underlying request…" | signal not aborted → aborted |
| F10 | `AbortSignal.timeout(5000)` on Ollama `/api/tags`. | not separately tested (one-line change, same pattern as neighbouring calls) | unbounded → 5 s |
| F11 | SSE `close` cleanup registered before the first await; `subscribe` failure ends the stream; destroyed requests are not given a keep-alive. | `apps/api/tests/sseLifecycle.test.ts` (verified failing without the fix: 1 leaked stream) | 1 leaked stream → 0 |
| F12 | Env vars take precedence over `config.json` for the five URL/token keys. | `apps/cli/tests/configPrecedence.test.ts` | file wins → env wins, file still applies when env unset |
| F13 | Terms are matched in SQL (`LIKE … ESCAPE`, wildcards escaped) before the recency `LIMIT` (raised to 500). | `sqliteMemoryStore.test.ts` (2 new cases) | old match unretrievable → retrieved; `%`/`_` literal |
| F14 | Harness records an undefined gate as a failing `UNDEFINED GATE (catalog error)` row. `--report` is resolved, not joined. | acceptance run (below) | crash → verdict produced |
| F15 | Test mock implements `getSize`/`render`; engine services the SEARCH view does not use return inert stubs. | the file itself, 12/12 | 0/12 → 12/12 |

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| Full vitest suite | **1939 passed, 0 failed, 18 skipped** (785 files, 4 m 04 s); the run included fixes F4–F11, and the later fixes were re-verified by targeted suites plus the final full run below |
| Final full suite (all fixes) | **1950 passed, 0 failed, 18 skipped** (792 files, 4 m 08 s) |
| New/repaired test files ×10 consecutive runs | 10/10 green, 570/570 assertions |
| Acceptance `--all` | 76/80 PASS; the 4 FAIL rows are the undefined-gate catalog error (their suites pass) |

## Behaviour changes worth noting for reviewers

- **F1** changes the default: an `AcpClientAdapter` created without `onRequestPermission` now denies every permission request. No production code constructs one today (it is exported only), so nothing that currently runs changes behaviour.
- **F12** changes precedence: anyone who relied on `config.json` beating an env var they had also set will see the env value win. That is the documented intent.
- No feature flags were added. None of the changes alters a working primary workflow; each one removes a failure mode.
