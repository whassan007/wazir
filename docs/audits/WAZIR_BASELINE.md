# Wazir Baseline (before repairs)

Captured 2026-10-11 on branch `repair/stability-audit`, created from
`feat/qwen-live-harness-integration` @ `d039231` with that branch's 79 uncommitted
files carried over unchanged (they are committed separately as the first commit of
this branch so the repairs can be reviewed on their own).

## Environment

| Item | Value |
|---|---|
| OS | Linux 7.0.0-1019-nvidia (Ubuntu) |
| Node | v22.22.3 (via nvm; `node` is not on the default non-interactive PATH) |
| Package manager | npm workspaces |
| LM Studio | running on `localhost:1234`, 2 models loaded (incl. `nvidia/nemotron-3-nano-omni`) |
| Ollama | **not running** (`localhost:11434` unreachable) |
| Hosted providers | none authenticated |
| Tool sandbox (bwrap) | **unavailable**: unprivileged user namespaces disabled; tools run directly on host |
| PostgreSQL | not available |
| GPU telemetry | `nvidia-smi` reports `[N/A]` for memory |

## Build and static checks

| Step | Result | Time |
|---|---|---|
| `npm run typecheck` (`tsc --build --force`) | exit 0 | 4.4 s |
| `npm run build` | exit 0 | 2.9 s |
| Lint | no lint script is configured at the root | n/a |

## Unit / integration suite (`npx vitest run`)

| Metric | Value |
|---|---|
| Test files | 780 |
| Tests | 1952 |
| Passed | 1916 |
| **Failed** | **18** |
| Skipped | 18 |
| Wall time | 4 m 01 s |

All 18 failures were in three new (untracked) test files:

| File | Failures | Cause found |
|---|---|---|
| `apps/cli/tests/searchTreeNavigation.test.ts` | 12 | Test defect: mock screen/engine written against a non-existent API (`getSize`, `computers.list` missing) |
| `apps/cli/tests/missionControlGates.test.ts` | 2 | **Product defect**: `why` explanations fabricated evidence and hashes; `/canary` view not wired |
| `apps/cli/tests/missionControlWidths.test.ts` | 4 | **Product defect**: `/canary` command not routed, so the view never opened |

### Skipped tests (environment-gated, not counted as passing)

| File | Skipped | Requires |
|---|---|---|
| `packages/database/tests/postgresStore.test.ts` | 10 | PostgreSQL |
| `packages/tools/tests/sandbox.test.ts` | 6 | working bwrap sandbox |
| `tests/runtime/liveModelLifecycle.test.ts` | 1 | live model lifecycle env |
| `apps/cli/tests/createStore.test.ts` | 1 | Postgres store |

## Acceptance gates (`scripts/acceptance-test-harness.mjs --all`)

Baseline run **crashed** before printing a verdict:
`TypeError: Cannot read properties of undefined (reading 'testCount')`. The catalog
defines tests 80–83 against gates `G97`–`G100`, which are not declared in
`tests/acceptance/acceptanceData.json`. No gate results were available at baseline.

## Live behaviour

Not measured before repairs. The live runs in `WAZIR_FUNCTIONAL_TESTS.md` were all
made after the fixes, so no before/after live comparison is available.
