# Initial live session results

Local model: `gemma-4-26b-a4b-it-qat`, LM Studio. These runs used real Wazir
execution, filesystem mutations, g++ compilation and tests. No gate qualified.

| Session | Latest observed result | Finding |
| --- | --- | --- |
| LS-01 | FAIL | Protected verification file changed; final execution did not qualify. |
| LS-02 | PASS | Two compiler failures were repaired and the final revision verified. |
| LS-03 | PASS | Implementation repaired with protected tests intact. |
| LS-04 | PASS | External source change caused a stale edit failure, followed by reread, repair and current verification. |
| LS-05 | FAIL | Follow-up after successful verification fired; protected verification file changed. |
| LS-16 | FAIL | Numeric path was blocked by filesystem policy, without the required schema-validation correction. Repair and external verification passed. |
| LS-17 | FAIL | Unknown tool was denied without dispatch, but subsequent repair did not complete with current verification. |
| LS-31 | PASS | Repaired repository verified using the configured verification command despite stale README instructions. |
| LS-32 | FAIL | Protected verification file changed; no meaningful added regression test. |

Aggregate scorecards and full per-run artifacts are retained at:

- `/tmp/wazir-live-qualified/scorecard-1790240413453-1565406.json` (LS-01, 02, 03, 31, 32)
- `/tmp/wazir-live-stale/scorecard-1790241104278-1640344.json` (LS-04)
- `/tmp/wazir-live-injection/scorecard-1790240616543-1582675.json` (LS-05 and earlier protocol attempts)
- `/tmp/wazir-live-protocol/scorecard-1790241228193-1645430.json` (corrected LS-16 and LS-17 injection)

Earlier harness attempts are retained rather than overwritten. The first LS-01
attempt incorrectly failed provenance because the harness expected `callId` instead
of the production record's `id`. Protocol injection initially occurred during
planning, which tested phase rejection instead of malformed argument handling.
These harness defects were corrected before the corresponding later runs. Results
above are individual observations, not statistical success-rate estimates.

Coverage remains nine executable scenarios out of 36. The remaining 27 return
`BLOCKED`; their objectives, fault schedules and assertions are catalogued. See
[qualification documentation](live-session-qualification.md) for measurement limits.
