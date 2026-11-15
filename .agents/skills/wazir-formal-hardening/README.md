# Wazir Formal Hardening — Alloy 6 Skill Pack

Target: https://github.com/whassan007/wazir

Purpose: Detect high-impact **sequence bugs** rather than merely syntax errors—stale leases, unauthorized delegated tool use, cancelled-task resurrection, unknown side-effect replay, stale verification evidence, concurrent workspace updates, provider fallback constraints, resource oversubscription and interrupted updates.

- **Start:** `SKILL.md`
- **Formal language foundation:** `alloy-foundation/SKILL.md` (the previously created full Alloy 6 skill, bundled for portability)
- **Source mapping:** `references/source-map.md` (snapshot checked against GitHub; recheck at HEAD)
- **Invariants:** `references/invariants.md`
- **Model templates:** `models/` (not yet analyzer-executed here)
- **Prompt to orchestrator:** `prompts/12-agent-hardening.md`
- **Structured issue ledger:** `evals/issue-ledger-template.csv`
- **Review and verification gates:** `evals/review-checklist.md`

## Setup

Extract this folder to `.claude/skills/wazir-formal-hardening/` or to an equivalent skills directory for the intended agent. Then instruct the orchestrator to read `SKILL.md` and execute `prompts/12-agent-hardening.md` against its local Wazir checkout. Treat examples as templates; use the Alloy 6 Analyzer to run the checks. The build machine creating this bundle did not execute the Analyzer on the added models, so no proof/counterexample results are asserted.

## What it is not

It is not a formal proof that Wazir is secure. It is a repeatable model-driven discovery method; findings require reproduction against actual code. Only propose changes backed by evidence, and preserve the v0.2.13 release unless explicitly authorized to deploy a subsequent patch.
