---
name: wazir-formal-hardening
description: "Find subtle high-severity concurrency, authorization, recovery, verification, and release defects in Wazir by modeling state machines and invariants with Alloy 6, then reproducing violations against real TypeScript code. Use for Wazir hardening, race-condition audits, multi-agent safety, tool sandboxing, worker leases, durable execution recovery, provider routing, and false-success analysis."
license: Apache-2.0
metadata:
  target-repository: https://github.com/whassan007/wazir
  language: Alloy 6
  prerequisite: alloy-foundation/SKILL.md
  status: source-informed templates; analyzer execution required
---

# Wazir Formal Hardening — Alloy-Assisted Bug Discovery

## Objective

Find **real, reproducible, high-impact flaws** in Wazir, especially those involving an unlucky sequence of otherwise valid operations. The deliverable is **not** a collection of Alloy models or speculative vulnerabilities. It is a set of evidence-backed defects, minimized reproductions, patches, and regression tests. Start with 0-to-1 safety invariants and systematically increase concurrency and failure injection.

## Mandatory preparation

1. Read `alloy-foundation/SKILL.md` and the referenced language/temporal/pitfalls/workflow guides before writing Alloy 6.
2. Inspect the *current* Wazir checkout and record HEAD SHA, runtime configuration and relevant tests. Use `references/source-map.md` as **navigation hints**, not as a claim of current API behavior.
3. Build a requirements-to-code mapping for each safety property. Separate **claimed intent** (comments/docs), **enforcement** (production implementation), and **verification** (tests/physical evidence).
4. Capture a reproducible baseline; do not modify user data, live credentials, main branch, release tags or production deployment.
5. Prefer a small model with one executable invariant over a giant unreviewable system model.

## High-value priorities (independent workstreams)

| Area | Core safety invariant | Typical counterexample |
|---|---|---|
| Policy and delegated tools | No tool side effect without effective authorization at execution time | Approval checked for parent but not delegated child or at dispatch |
| Lease fencing | Only current fenced lease holder can commit | Expired worker commits after reassignment |
| Cancellation / terminal state | Terminal task never silently transitions to running | Cancellation races completion callback |
| Unknown tool outcome | Non-idempotent tool call with unknown outcome cannot replay automatically | Crash after side effect but before checkpoint |
| Verification | Completion requires authoritative passing checks for latest workspace revision | New file mutation after tests but old PASS is reused |
| Agent workspace isolation | Conflicting concurrent patches cannot overwrite silently | Two agents write same file from stale base |
| Provider routing | Fallback preserves privacy policy, required capabilities, budgets | Provider loss triggers unauthorized remote fallback |
| Scheduling/admission | Reservation totals cannot exceed resources and lease limits | Concurrent admissions see same capacity |
| Update/rollback | Activated artifact must match verified identity and supported state | Interrupted update activates partial binary |
| Budget/retries | Retried or resumed execution cannot exceed its hard budget | Budget counters reset at resume |

For expanded hypotheses, see `references/invariants.md`. These are **hypotheses to test**, not verified Wazir defects.

## Standard operating procedure — required

### 1. Select a concrete invariant
Write the invariant in plain language with quantifiers and explicit edge cases. Example: "For every execution and every worker, if the worker's lease is stale at commit time, the worker may not persist a side effect regardless of stale in-memory ownership."

### 2. Extract the actual state machine
Locate code paths, allowed transitions, authoritative persistent records, atomic boundaries, lock/lease epochs, and recovery handlers. Map operations into events, including process failure, timeout, lease expiry, resumed tasks, late callbacks, retries and concurrent mutation.

### 3. Model both intended and actual behavior
Build separate **reference policy** and **implementation abstraction** when necessary. Do not add a fact equivalent to the assertion solely to manufacture a PASS. Explicitly model untrusted actors, partial failures, event interleavings, and omitted assumptions. Write witness `run` commands and `check` commands with 3–6 entities and 4–10 steps as appropriate; increase bounds after useful small models. Guard against vacuity with positive witnesses and a deliberate negative-control mutation.

### 4. Execute Alloy
Use a real Alloy 6 Analyzer/JAR and collect command, analyzer version, model SHA, scope, solver results, traces and counterexamples. A no-counterexample result is **bounded assurance**, not an unrestricted proof. If Alloy cannot run, mark the model **UNVERIFIED** and never call the claim proved or the defect confirmed.

### 5. Bridge counterexample to production code
Translate the shortest relevant trace into a deterministic Vitest regression reproducing real implementation behavior. Prefer injected clocks, deferred Promises, fake provider failures, controllable persistence, and a test store with atomic operations. Verify the test fails **before** a patch. A counterexample in an over-permissive abstract model alone is not a code vulnerability.

### 6. Patch minimally and verify independently
Make the smallest justified production fix in isolated worktree. Run the failing regression, nearby unit/integration tests, then required build/typecheck. Confirm the regression passes after fix, then replay the original Alloy analysis with updated abstraction. Never disable guards or weaken assertions to force success.

### 7. Triage and report
Every finding must include: ID; P0/P1/P2 severity and impact; SHA; exact code paths/lines; violated invariant; minimal temporal trace; Alloy command + scope + result; TypeScript reproduction; pre-fix failure; patch; post-fix evidence; limitations. Distinguish **CONFIRMED**, **HYPOTHESIS**, **ABSTRACTION-ONLY**, **BLOCKED**, **ALREADY COVERED**, **FALSE POSITIVE**. Record everything in `evals/issue-ledger-template.csv` format and use `references/reporting.md`.

## Scope controls

- Prefer **small, critical kinks** over broad speculative architecture changes.
- Keep invariants scoped to actual responsibilities: policy checking, durable checkpoints, execution state, updater, etc.
- Test the awkward orders: cancel then finish; finish then mutate; expire then write; side effect then crash; approval then delegated tool; route then policy change; rollback then restart.
- Never infer a hidden bug from a comments-only audit or assume checks enforce security just because names indicate so.
- Never run destructive tests against the user's working repository or live systems. Use disposable worktrees, mocks, sandboxed fixtures, and fake secrets.
- Avoid infinite investigation loops; after the bounded analysis budget, label the result and move to another invariant.
- No pushes, merges, tags, deployment, or releases without explicit approval.

## Where to start

- `references/source-map.md`: Wazir's inspected key files and source references.
- `references/invariants.md`: ten major invariants and priority-specific adversarial scenarios.
- `references/reporting.md`: severity, evidence standards, and issue lifecycle.
- `models/task-terminal.als`: small Alloy 6 dynamic task status model.
- `models/task-terminal-mutant.als`: intentionally broken task model, expected counterexample.
- `models/delegated-policy.als`: structural permission-gate model (expected counterexample without enforcement).
- `prompts/12-agent-hardening.md`: ready-to-run parallel Qwen/Claude/Antigravity orchestration prompt.
- `alloy-foundation/`: self-contained Alloy 6 language reference, general examples, CLI and pitfalls.

## Non-negotiable distinction

**MODEL COUNTEREXAMPLE != CONFIRMED PRODUCTION BUG.** Require reproduction against the Wazir code at a recorded commit. **ALLOY NO COUNTEREXAMPLE != PROOF FOR ALL SIZES.** Require satisfiability, sufficient scopes, trace coverage, and code tests.
