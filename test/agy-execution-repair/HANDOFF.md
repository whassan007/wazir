# HANDOFF — Wazir P0 Execution Reliability & Verification Repair

**Status:** IN PROGRESS
**Session budget:** 40 minutes (started 2026-10-17T20:30 local)
**Checkpoint:** 0001

## Objective
P0-A: scope VERIFY's build/test/lint/typecheck to the packages actually affected by changed files
(never build the Tauri desktop app for an unrelated Python/JS change; no network requirement for
unrelated verification; preserve full-build behavior when explicitly requested; never report success
when required verification actually fails; report skipped checks + justification).
P0-B: task classification — a pure Q&A/chat prompt should not run the full PLAN/IMPLEMENT/VERIFY coding
loop.
P0-C: preserve the 4 existing uncommitted fixes (READY-state retention, HEAD-integrity guard,
no-mutation check-skip, answer-visibility-on-failure) — confirmed present via `git status --short`,
matches exactly what the prior audit session (test/agy-mac-gemma/) left in place. Not touching those
files' existing logic except where P0-A/B require extending them.
P0-D: re-run the 10-task benchmark, separating response-only from file-mutating tasks, with timing.

## Evidence located
- test/agy-mac-gemma/FINAL-REPORT.md, issues-ranked.md, fixes-applied.md, execution-results.csv,
  HANDOFF.md — all present (written by the immediately-prior session on this same machine/repo).
- Confirms: P0-5 (unscoped build/test battery) is the dominant unfixed issue; P1-4 (memory-admission
  denial) is real/transient; G02-G06 all gave correct model answers.

## Plan
1. Investigate workspace layout (packages/apps boundaries, each package's own build/test scripts).
2. Implement P0-A: a file-to-package resolver + scoped check runner in the VERIFY phase
   (packages/agents/src/codingAgent.ts + wherever the `build`/`test`/`lint`/`typecheck` tools are
   implemented), with an explicit-full-build override and skip-with-reason reporting.
3. Implement P0-B: lightweight task-type auto-classification so a pure question doesn't enter
   PLAN/IMPLEMENT/VERIFY.
4. Rebuild (`npx tsc --build ...` + `npm run bundle` — required for live testing, see prior session's
   fixes-applied.md fix 4 note) and run the real benchmark sweep.
5. Write baseline.csv (pre-repair, from test/agy-mac-gemma data) / after.csv (post-repair, this session)
   and FINAL-REPORT.md.

## Next action
Read codingAgent.ts's current VERIFY implementation and the tool registry's build/test/lint/typecheck
tool implementations to design the scoping mechanism.
