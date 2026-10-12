# Wazir Performance Baseline

All values were measured on this host (see `WAZIR_BASELINE.md`). "Unavailable"
means the value was not measured. It is never estimated.

| Metric | Before | After | Source |
|---|---|---|---|
| Typecheck | 4.4 s | exit 0 | `npm run typecheck` |
| Build | 2.9 s | exit 0 | `npm run build` |
| Full vitest wall time | 4 m 01 s | 4 m 08 s | `npx vitest run` |
| Tests passing | 1916 / 1952 (18 failed) | 1950 / 1968 (0 failed) | vitest JSON report |
| Acceptance harness | crashed, no verdict | 76 / 80 PASS, verdict produced | `acceptance-test-harness.mjs --all` (≈63 s) |
| Live task wall time (Workflow 1) | unavailable | P50 ≈ 41.6 s, max 55.6 s (n=6) | timed runs |
| Live task success | unavailable | 5 / 6 | independent `npm test` |
| Failure-path latency (endpoint down) | unavailable (override was ignored before F12) | 2.4 s to exit 1 | `time` |
| Peak RSS, one live task (incl. waited-for children) | unavailable | 1.32 GB | `/usr/bin/time -v` |
| CPU share, one live task | unavailable | 66 % | `/usr/bin/time -v` |
| GPU memory | unavailable | unavailable (`nvidia-smi` reports N/A) | — |
| External-agent cancel latency | did not terminate before process exit | ≈ 360 ms | lifecycle test |
| Leaked SSE streams after early disconnect | 1 per occurrence | 0 | `sseLifecycle.test.ts` |

No reliability regression was observed: no previously passing test or gate fails.
The 7 s difference in suite time comes from the 16 added tests (several spawn
processes or open sockets) and run-to-run noise.
