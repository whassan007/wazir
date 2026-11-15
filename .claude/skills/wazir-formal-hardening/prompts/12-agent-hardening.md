# WAZIR — 12-AGENT FORMAL HARDENING CAMPAIGN

Repository: https://github.com/whassan007/wazir
Primary skill: `wazir-formal-hardening/SKILL.md`
Alloy foundation: `wazir-formal-hardening/alloy-foundation/SKILL.md`

MISSION: Uncover and fix subtle P0/P1 bugs using evidence-backed Alloy 6 modeling + deterministic tests. Work on current HEAD, capture exact SHA, preserve all existing behavior and safety policies. Do not repeat generic source review. No releases, merges or pushes without approval.

MANDATORY ORCHESTRATION: Spawn **12 real subagents** in isolated worktrees, using available native team orchestration, concurrently where supported. Divide ownership: A1 policy/authorization, A2 shell/path sandbox, A3 worker leases, A4 terminal status/cancellation, A5 unknown-outcome recovery, A6 evidence/revision truthfulness, A7 multi-agent workspace conflicts, A8 provider routing/privacy, A9 resource/model admission, A10 updater/rollback, A11 budget/retry consistency, A12 independent red-team review and model fidelity.

Assign simple exploration/model transcription to low-cost models (e.g. Haiku or Qwen local when available), multi-file reproduction/fixes to capable coding models, final high-risk adjudication to strongest approved model. Never route sensitive source or data to an unapproved provider. Model selection must not override policy.

EACH AGENT:
1. Read the skill and inspect exact current code and tests.
2. Write 3–5 **nontrivial, falsifiable** invariants for its area, including positive run witnesses and one mutant negative control.
3. Model at least one realistic 2-worker or crash/retry interleaving in Alloy 6; execute Analyzer and save artifact/results when available.
4. Generate minimized trace. Do not confuse an abstract counterexample with a real defect.
5. Translate credible traces into failing Vitest reproduction against actual code.
6. Fix only confirmed defects, with narrowly scoped patches and regression tests.
7. Mark remaining hypotheses explicitly. Avoid unbounded repetitive file reading; use a bounded investigation budget.
8. Log every result with SHA, steps, commands, scope, status and reproducible evidence.

ORCHESTRATOR:
- Assign disjoint code ownership and track progress in `docs/formal-hardening/`.
- Summarize confirmed issues by risk and code evidence; independently challenge all alleged P0s.
- Prioritize stale worker commits, cancellation races, double side effects, unauthorized delegated writes, and false success.
- Never water down permissions, tests, verification or fallback constraints.
- Require failing-before/passing-after tests for every fix.
- Keep pre-existing release v0.2.13 untouched; propose a patch release separately if needed.
- Finish with exact PASS/FAIL/BLOCKED outcomes, changed files, tests and remaining risks.

AUTONOMOUS EXECUTION: Investigate → model → analyze → reproduce → implement → test → verify. No routine confirmations; no destructive operations, live production changes or pushes. Continue safely when some workstreams are blocked.
