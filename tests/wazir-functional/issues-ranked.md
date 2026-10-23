# Ranked issues

| Priority | Finding | Status |
|---|---|---|
| P1 | Task-insensitive output reservations and generation caps waste small windows | Corrected; deterministic tests pass; final live qualification reported separately |
| P1 | Placement rejection terminates AUTO before trying suitable alternatives | Corrected with bounded exclusion/retry and cost-aware selection; explicit restrictions retained |
| P1 | Late job promises can repaint a subsequent chat after stream unsubscribe | Corrected with per-job ownership fences and cleanup; deterministic stale completion/error checks pass |
| P1 | Resident context growth can be charged a new full model footprint | Corrected; full estimates remain for unloaded models |
| P1 | Live exploratory `Compute` arithmetic was classified as requiring file mutations | Corrected in c880b17 with planner regression; final live retest tracked separately |
| P2 | Importing ledger/memory modules initializes experimental SQLite | Deferred until actual use; warning suppression removed. Actual accounting can still legitimately emit Node's warning |
| P2 | Arithmetic models may add wording despite number-only request | Observed in the baseline; final exact-format result must be reported honestly |
| Unconfirmed | Original 8609 output reserve | Not reproduced in current source; no fabricated root cause |
| Unconfirmed | Historical 0.1 GiB telemetry | Immediately free memory can be low on this host; historical sample unavailable. Runtime, reservation and reclaimable-memory semantics tested separately |
| Unconfirmed | Natural-language shell suggestion | String absent in current source; narrow literal-command recognition regression remains |

Unit tests do not establish live success. See `FINAL-REPORT.md`, `execution-results.csv` and preserved evidence for runtime failures, code compilation/execution and remaining blockers.
