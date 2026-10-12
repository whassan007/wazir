# Worker 11 integration checkpoint

Status: awaiting stable final deltas from Workers 1–8. No commits made.

The shared checkout changed during validation. In particular, `fleetTui.ts`
was replaced after integration fixes, removing the canary pane, context why
explanation, controller-grounded why fixes, and canary selection fix. Do not
interpret results from earlier snapshots as certification of the final checkout.

## Retained integration changes

- Added tests covering all eight why topics without controller evidence, canary
  history selection, and 300 mixed streaming/search/canary/cache/health cycles.
- Corrected the G74 assertion that previously required a fabricated AST PASS.
- Kept the experiment decision ahead of the expanded canary widget so it remains
  visible in the terminal viewport.
- Removed fabricated passing correctness/guard defaults from the canary widget.
- Corrected ANSI truncation escape-state handling.
- Added `/model-intelligence` for the observability view; retained `/models` for
  the existing model manager. Updated the width sweep to use the distinct route.

## Latest complete regression run (2026-09-24)

Command: `npx vitest run apps/cli/tests/observabilityGates.test.ts apps/cli/tests/missionControlGates.test.ts apps/cli/tests/canaryTui.test.ts apps/cli/tests/canaryOperator.test.ts apps/cli/tests/promptCacheView.test.ts apps/cli/tests/missionControlWidths.test.ts packages/core/tests/distributedSearchCoordinator.test.ts tests/acceptance/distributedMctsGate.test.ts tests/acceptance/canaryGates.test.ts packages/evaluation/tests/canaryDeployment.test.ts packages/core/tests/hierarchicalMctsUnit.test.ts`

Result: 57 passed, 8 failed, across 11 files.

| Gate | Result |
| --- | --- |
| G57 | PASS |
| G58 | PASS |
| G59 | PASS |
| G60 | PASS |
| G74 | FAIL: Mission Control header/tabs removed by concurrent write |
| G75 | PASS |
| G76 | PASS |
| G77 | PASS |

Additional failures: absent-proof why test, canary history selection, four
terminal-width cases unable to enter the removed canary view, and why context.
Canary CLI JSON checks, operator controls, deployment tests, distributed MCTS
tests and hierarchical MCTS unit tests passed.

Latest `tsc --build`: failed because concurrently added
`packages/evaluation/src/liveSessionScenarios.ts` imports missing
`./types/liveSession.js`. An earlier build passed. `git diff --check` passed.

## Stress evidence and limitations

300 interleaved cycles, 1,500 producer updates: streaming, MCTS tree fixture,
real canary pause/resume, normalized cache samples and worker heartbeats.
Latest measured redraw mean 0.43 ms, p95 0.63 ms; both below 50 ms.
No crash or input corruption; context retained exactly 100 samples and streaming
retained 12,000 characters. One keypress listener remained registered. Rendering
did not create executions. Mock output history was cleared each iteration.

This verifies bounded TUI buffers, not a heap/RSS plateau or long-duration
controller retention. After the concurrent overwrite removed the canary pane,
the stress fixture still delivered canary events but could no longer validate its
rendering. Re-run on the final integrated checkout.

## Conflicts to resolve once the checkout is stable

1. Restore final worker features in `fleetTui.ts` before applying integration fixes.
   Do not replace the entire file with an older snapshot.
2. Why topics must use controller fields or UNKNOWN. Current hardcoded benchmark
   confidence, PASS results, policy approval, rollback success and audit hashes
   are not evidence. A controller task status does not prove verification.
3. Canary history Enter must store the chosen ID; detail rendering and rollback
   explanations must resolve that ID through the existing deployment service.
4. `SearchNodeInspection` is duplicated in core and the TUI. Import/re-export the
   core type and remove the duplicate once Worker 2's contract is final.
5. Cache types and source/reuse helpers are duplicated in runtime interfaces and
   the TUI. Consume the runtime interface contract and remove the UI definitions
   after Workers 5/6 finalize it. Runtime adapter propagation is not yet certified.
6. Verify widget shortcuts against existing experiment actions. Header labels
   must agree with the one existing key handler; avoid introducing another handler.
7. Review remaining synthetic fallbacks in task, search, fleet, improvement and
   evidence projections. These cannot be certified as authoritative controller data.
8. Re-run all gates and new worker tests after final deltas arrive. Circular
   dependencies, complete runtime-to-TUI cache flow, and final declutter behavior
   remain uncertified on the moving checkout.
