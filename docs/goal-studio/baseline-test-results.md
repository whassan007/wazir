# Goal Studio baseline test results

Recorded by agent 12 (integration / acceptance) **before** any Goal Studio
workstream code landed, so the coordinator can tell regressions from failures
that already existed.

| Item | Value |
|---|---|
| Commit | `e20355e` (main `f7a4077` + coordinator scaffold `@wazir/goals`) |
| Worktree | `/Users/wael/Code/Wazir-gs/agent-12` (branch `feat/parallel-integration-validation`) |
| Host | macOS (darwin, arm64), Node v22.23.3, vitest 2.1.9 |
| Date | 2026-10-22 |
| Env | defaults from `vitest.config.ts` (`WAZIR_SECRETS_BACKEND=encrypted-file`, `WAZIR_LMS_DISABLE=1`); no `WAZIR_TEST_DATABASE_URL`; `bin/wa.js` bundle **not built** in the worktree |

## Type check

`npx tsc --build` — **exit 0**, ~5 s (incremental; no errors).

## Full suite

Command: `npx vitest run --reporter=json --outputFile=<scratch>/vitest.json` (exit 1).

| Metric | Count |
|---|---|
| Test files | 367 (365 passed, 2 failed) |
| Suites (describe blocks) | 1067 (1062 passed, 5 failed) |
| Tests total | **2792** |
| Passed | **2731** |
| Failed | **9** |
| Skipped | **52** |
| Todo | 0 |
| Wall-clock duration | **~317 s** (files run serially: `fileParallelism: false`) |

### Failing tests (all 9 are pre-existing, environment-caused)

All 9 failures share one root cause: they spawn the bundled CLI at
`bin/wa.js`, which is a build artifact produced by `npm run bundle` and is not
present in a fresh worktree. They are not caused by the Goal Studio scaffold.

| # | File | Test | Error summary |
|---|---|---|---|
| 1 | `test/packaging/serverDistribution.test.ts` | Server Distribution & Containerization › 4. Cross-Platform System Services (wa service) › wa service --help and status execute cleanly via CLI bundle | `expected false to be true` at line 134: `existsSync('bin/wa.js')` is false |
| 2 | `tests/live/realWorldAcceptance.test.ts` | Journey 1: First installation, initialization and launch in pristine isolated environment | `expected 1 to be +0` (`wa init` exit code 1, binary missing) |
| 3 | same | Journey 2: Running `wa doctor` health inspection under isolated environment | `SyntaxError: Unexpected end of JSON input` (no CLI output to parse) |
| 4 | same | Journey 3: Model discovery, registry inspection, and selection filtering | `expected 1 to be +0` |
| 5 | same | Journey 4: Driving `wa chat` using real pseudo-terminal with simulated keyboard inputs | `expected 1 to be +0` |
| 6 | same | Journey 5: Creating, modifying source files and verifying real observable filesystem mutations | `expected 1 to be +0` |
| 7 | same | Journey 6: Executing builds, tests and detecting non-zero exit codes & failures accurately | `expected 1 to be +0` |
| 8 | same | Journey 7: Handling unavailable models without false positives or silent hangs | `SyntaxError: Unexpected end of JSON input` |
| 9 | same | Journey 10: Cancellation and retry handling under real lifecycle controls | `expected 1 to be +0` |

To clear them: `npm run bundle` (creates `bin/wa.js`) before `npx vitest run`.

Side effect to know about: `tests/live/realWorldAcceptance.test.ts` rewrites
the tracked file `reports/e2e-acceptance-scorecard.json` on every run. Agents
should `git checkout -- reports/e2e-acceptance-scorecard.json` before
committing rather than commit that churn.

### Skipped tests (52, all opt-in by environment)

| File | Skipped | Gate |
|---|---|---|
| `packages/database/tests/postgresStore.test.ts` | 19 | needs `WAZIR_TEST_DATABASE_URL` |
| `packages/tools/tests/sandbox.test.ts` | 10 | Linux-only (bwrap) cases, `skipIf(platform !== 'linux')` |
| `test/distributed/leaseFencing.test.ts` | 5 | `WAZIR_DISTRIBUTED=1` |
| `test/distributed/races.test.ts` | 4 | `WAZIR_DISTRIBUTED=1` |
| `test/distributed/processSideEffect.test.ts` | 3 | `WAZIR_DISTRIBUTED=1` |
| `test/distributed/reconnect.test.ts` | 3 | `WAZIR_DISTRIBUTED=1` |
| `test/distributed/cancellation.test.ts` | 2 | `WAZIR_DISTRIBUTED=1` |
| `test/distributed/duplicateSideEffect.test.ts` | 2 | `WAZIR_DISTRIBUTED=1` |
| `test/distributed/crashRecovery.test.ts` | 1 | `WAZIR_DISTRIBUTED=1` |
| `test/runtime/liveModelLifecycle.test.ts` | 1 | `WAZIR_QUALIFY_MODEL_LIFECYCLE=1` |
| `apps/cli/tests/createStore.test.ts` | 1 | needs `WAZIR_TEST_DATABASE_URL` |
| `apps/cli/tests/nvidiaProviderSystem.test.ts` | 1 | `NVIDIA_API_KEY` + `WAZIR_LIVE_NVIDIA_SMOKE=1` |

### Slowest files (ms)

`apps/cli/tests/improveSupervisorE2E.test.ts` 20027 ·
`apps/api/tests/protocolSecurity.test.ts` 16284 ·
`apps/cli/tests/sessionEof.test.ts` 15278 ·
`packages/shared/tests/storeLockOwnership.test.ts` 10168 ·
`apps/cli/tests/fleetTui.test.ts` 8765.

## How to compare at integration time

```sh
npx tsc --build
npx vitest run --reporter=json --outputFile=/tmp/vitest.json
node scripts/goal-studio-baseline-diff.mjs /tmp/vitest.json
```

`scripts/goal-studio-baseline-diff.mjs` prints every failing test that is not
in the table above (a regression) and every baseline failure that now passes.
The known failure list it uses is embedded in that script.
