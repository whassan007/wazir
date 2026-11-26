# Agent 01 — host test triage (v0.4.3)

- **Starting SHA**: `d6ca44a02b286b718bcf0b373aeb3a1186b1e0e8`
- **Branch / worktree**: `fix/v043-host-tests` @ `/Users/wael/Code/Wazir-v043/agent-01` (not pushed)
- **Host**: macOS arm64. `command -v llama-server` → empty (exit 1). A llama-server exists at
  `/Applications/Ollama.app/Contents/Resources/llama-server` and the gitignored GGUF and runtime exist only in the
  main checkout (`/Users/wael/Code/Wazir/assets/...`). Agent 01 only read them there.

## Verdict on the "EPERM-only" claim: DISPROVED

The core suite was run inside the sandbox and again on the host (`dangerouslyDisableSandbox`). Both runs had the
**same 7 failures in 4 files**, and `grep -c EPERM` on the sandbox log gave **0**. This sandbox allows loopback
TCP: `checkpointTransport.test.ts` passed in both runs, and the live llama-server test passed in the sandbox once
the assets were provided. None of the failures came from a network permission.

## Files touched
| File | Kind |
|---|---|
| `packages/core/tests/jobOrchestratorCoordination.test.ts` | test |
| `packages/core/tests/policyEngine.test.ts` | test |
| `packages/core/tests/liquidShellOrchestrator.test.ts` | test |
| `packages/core/src/services/executionRecovery.ts` | source (genuine bug; not an Agent 05 file) |
| `reports/v0.4.3/agent-01.md`, `reports/v0.4.3/logs/agent-01-vitest*.json` | evidence |

`coordinationFabric.ts` and `types/coordination.ts` were not touched, so no change request was needed.

## Commands
| # | Command | Sandbox | Exit |
|---|---|---|---|
| 1 | `npm ci` | yes | 0 |
| 2 | `npm run build` | yes | 0 |
| 3 | `npx vitest run packages/core/tests --reporter=json` (before) | yes | 1 (1505 pass / 7 fail, 151 files) |
| 4 | `npx vitest run <4 failing files> checkpointTransport.test.ts` (before) | **no** | 1 (7 fail / 52 pass) |
| 5 | `jobOrchestratorCoordination.test.ts` ×8 after fix | yes | 0 ×8 |
| 6 | `policyEngine.test.ts` after fix | yes | 0 (23/23) |
| 7 | `formalHardeningGroupD, executionRecovery, crossHarnessRecoveryQualification, portableRecovery, recoveryManager*` after fix | yes | 0 (42/42) |
| 8 | `npx tsc --noEmit -p packages/core` | yes | 0 |
| 9 | `liquidShellOrchestrator.test.ts` (assets absent) | yes | 0 (6 pass, 2 skipped with reason) |
| 10 | same with `WAZIR_EMBEDDED_MODEL_PATH`/`WAZIR_EMBEDDED_RUNTIME_PATH` → main checkout assets | **no** | 0 (8/8, live test 15.7 s) |
| 11 | same as 10 | yes | 0 (8/8) |
| 12 | `npm run build` and `npm run typecheck` (after) | no | 0 / 0 |
| 13 | `npx vitest run packages/core/tests --reporter=json --outputFile=reports/v0.4.3/logs/agent-01-vitest.json` | **no** | **0** (151 files, 1510 pass, 0 fail, 2 skip) |
| 14 | `npx vitest run apps/*/tests packages/*/tests (non-core) packages/runtimes/*/tests` → `logs/agent-01-vitest-other-workspaces.json` | **no** | 1 (303 files, 2244 pass, 22 fail, 31 skip) |

## Per-file results, packages/core (before is sandbox run #3, confirmed identical on host by #4; after is #13)
| File | Before | After | Status |
|---|---|---|---|
| jobOrchestratorCoordination.test.ts | FAIL (1) | PASS | VERIFIED_OPERATIONAL (#13 exit 0) |
| policyEngine.test.ts | FAIL (3) | PASS | VERIFIED_OPERATIONAL (#13) |
| portableRecovery.test.ts | FAIL (1) | PASS | VERIFIED_OPERATIONAL (#13) |
| liquidShellOrchestrator.test.ts | FAIL (2) | 6 PASS / 2 SKIP | live tests **BLOCKED** in the worktree (assets absent); they passed in #10 with the main checkout's assets |
| checkpointTransport.test.ts | PASS | PASS | It was never failing on this host |

## Root causes
1. **jobOrchestratorCoordination**: race in the test, not EPERM. `JobOrchestrator.publishCoordinationEvent` publishes
   fire-and-forget (`void ...publish().catch()`), so `runJob()` can resolve before `resource.released` and
   `job.completed` are durable. The replay only saw 5 events. Fix: `vi.waitFor` polls `replayEvents` (5 s timeout).
   Note: by design, callers cannot assume terminal events are durable when `runJob` returns.
2. **policyEngine**: stale fixture. The three `authorize` "ask" tests used `git status`, which has always been in
   `GIT_ALLOW` (`git-read-allow`). They now use `git commit -m wip` (in `GIT_ASK`) and assert `classify()==='ask'`
   first, so the fixture cannot drift silently again.
3. **portableRecovery Scenario 4**: genuine source bug. A12/D-04 (commit 230690f) added a revision-independent
   dedupe key, so the same tool and args were blocked at **every** later workspace revision forever. That
   contradicts "same args at a new revision is a distinct operation". Fix: the key is removed and replaced by
   `coverPostReconcileRevision()`, a semantic alias for only the revision that an APPLIED reconciliation itself
   produced. It is applied both in `reconcileBeforeCrossHarnessResume` (inspection and operator paths) and in
   `fromExecutionRecord` (via the next `workspace.revision_changed` event). D-03/D-04 still pass, and
   `listReceipts` is unchanged.
4. **liquidShellOrchestrator §3**: environment. The GGUF is gitignored (`assets/models/**/*.gguf`), so a fresh
   worktree has no model ("Bundled model ... not found"). The tests now `it.skipIf` when the model or runtime is
   unresolved. The reason goes in the test title and a `console.warn`.

## Remaining blockers (other workspaces, run #14; not part of the 4-file claim and not fixed here, all outside packages/*/tests)
| File | Fails | First error |
|---|---|---|
| apps/api/tests/opsLifecycle.goalStudio.test.ts | 1 | 5000 ms timeout |
| apps/cli/tests/antigravityIntegration.test.ts | 1 | version '0.4.2' expected '0.3.2' (stale) |
| apps/cli/tests/canonicalVersion.test.ts | 1 | a manifest is still '0.4.1' vs '0.4.2' |
| apps/cli/tests/chatRoutingAndEligibility.test.ts | 1 | memory preflight expected false (host has enough RAM) |
| apps/cli/tests/fastOrchestrator.benchmark.test.ts | 1 | node-pty `posix_spawnp failed` |
| apps/cli/tests/liquidShellE2e.test.ts | 1 | exit 1 vs 0 (likely the same missing GGUF) |
| apps/cli/tests/liveCliE2EVerification.test.ts | 2 | banner text / 14 of 15 steps |
| apps/cli/tests/missionControlGates.test.ts | 1 | expects 'H100' in the map |
| apps/cli/tests/modelSelectorFullReproductionE2E.test.ts | 1 | missing '>' marker |
| apps/cli/tests/searchTreeNavigation.test.ts | 12 | `ConversationController` ctor `path.resolve(Object)`, an API signature drift |

These are IMPLEMENTED_NOT_VERIFIED / BLOCKED for v0.4.3 and need an owner for apps/cli.
