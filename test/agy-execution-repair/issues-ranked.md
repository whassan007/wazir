# Issues Ranked — P0 Execution Reliability & Verification Repair

## P0-5 (from prior session) — STATUS: FIXED (P0-A)
See fixes-applied.md. Root cause and original evidence: test/agy-mac-gemma/issues-ranked.md P0-5.
Scoped verification live-confirmed: T3 (file inside `@wazir/agents`) → scoped build/test/typecheck
actually PASS, task reports `success: true`. T2 (file in a brand-new top-level dir outside every
workspace) → correctly falls back to full scope rather than silently narrow verification, still hits
the unrelated Tauri/network issue — this is the safety fallback working as designed, not a regression.

## P0-B task classification — STATUS: PARTIALLY ADDRESSED
Two findings:
1. **Pre-existing capability, previously unused/undiscovered:** `wa run --type chat` already routes to
   a lightweight `wazir-step` agent (single inference, no PLAN/VERIFY loop) — confirmed live, T1:
   15.8s, `success: true`. Neither this nor the prior audit session had tried `--type chat` before.
   This alone resolves most of P0-B's intent for any caller willing to pass `--type chat`.
2. **Added this session:** a fast-answer prompt hint in `codingAgent.ts` (used when `wazir-coding` is
   selected regardless, e.g. no agent override, or `mutationRequired: false`) telling the model it may
   skip producing a plan and answer directly. This is additive/low-risk (reuses the EXISTING `done`
   acceptance in the PLAN loop — a prompt change, not a new control path) but does not, on its own,
   change which agent gets scheduled for an unqualified `wa run` with no `--type` (still defaults to
   `coding` → `wazir-coding`, not `wazir-step`).
**Not fixed:** `apps/cli/src/run.ts`'s default `type: options.type ?? 'coding'` still means a plain
`wa run "<question>"` with no `--type` goes to the heavier coding agent. Changing that default was
judged too large a behavior change to make safely within this session's time budget — it would affect
every caller of `wa run` that doesn't pass `--type`, including legitimate coding tasks phrased as
questions ("can you fix the bug where X?"). Recommend: a cheap classifier (or just defaulting
unqualified prompts under some token/verb heuristic to `chat`) as explicit follow-up work, not a quick
patch.

## P0-C (preserve existing fixes) — STATUS: CONFIRMED PRESERVED
All 4 fixes from the prior session (READY-state retention, HEAD-integrity guard, no-mutation
check-skip, answer-visibility-on-failure) still present and passing — full regression suite (296/297,
1 unrelated pre-existing skip) re-run after this session's changes. Did not touch any of those four
fixes' logic except to extend the no-mutation check-skip's surrounding VERIFY loop with scoping (purely
additive — the skip condition itself is untouched).

## New finding this session: a separate agent/tool session is actively modifying this repo right now
Mid-session, `packages/core/src/types/tool.ts` changed on disk from a source other than this session
(43 lines added: `FileMutationOrigin`, `FileMutationProvenance`, `FileMutationConflict`,
`WorktreeIdentity` types — a mutation-attribution system). `packages/core/src/types/execution.ts` also
newly appeared as modified. This is **live, real-time confirmation** of the pattern the prior session
only inferred after the fact (test/agy-mac-gemma/issues-ranked.md P0-1/P1-3): another agent session is
concurrently working on this exact repository, right now, on precisely the area (file-mutation
attribution) that prior session's FINAL-REPORT.md recommended as follow-up work. No collision with this
session's own edits occurred (the concurrent changes are pure additions to files this session didn't
touch), but it reinforces that this machine genuinely runs multiple concurrent agent sessions against
the same repo as routine practice, not a one-off anomaly. Flagged to the user directly, not acted on
further (not this session's task).
