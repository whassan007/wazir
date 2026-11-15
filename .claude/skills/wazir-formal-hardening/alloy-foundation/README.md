# Alloy Formal Modeling — portable LLM skill

A reusable **Alloy 6** skill to teach Claude Code, Codex, Wazir, and other tool-using LLMs to generate, interpret, and verify `.als` formal models.

## Contents

```text
alloy-formal-modeling/
  SKILL.md
  README.md
  references/
    language.md
    temporal.md
    workflow.md
    pitfalls.md
    sources.md
  examples/
    access-control.als
    filesystem-tree.als
    mutex-temporal.als
    self-approval-counterexample.als
    self-approval-fixed.als
  scripts/
    run-examples.sh
  evals/
    challenges.md
```

## Install in an agent

- **Claude Code:** copy the `alloy-formal-modeling/` directory under your project's `.claude/skills/`, preserving `SKILL.md` and relative reference paths. Activate with `Use the alloy-formal-modeling skill to ...`; Claude's skill discovery depends on the host configuration.
- **Other compatible agent skill hosts:** copy the directory into the host's `skills/` discovery path. Keep references/examples together so the agent can load them as needed.
- **Wazir or a generic LLM without automatic skill discovery:** instruct the model to read `SKILL.md` first, then relevant `references/*.md`; optionally provide examples as few-shot demonstrations. This bundle does **not** assume or claim a specific Wazir skill installation API.
- **Prompt-only LLM:** provide the contents of `SKILL.md` as an instruction layer and attach the corresponding reference documents when needed.

## Quick start prompt

> Use the Alloy 6 formal-modeling skill. Model this authorization workflow as an `.als` specification. Start with assumptions, include one satisfiable nontrivial scenario, state at least two independently checked invariants, declare scopes, and report any unexecuted analysis honestly. Do not convert assertions into facts to make them pass.

## Analyzer installation and validation

Use the official binary from https://alloytools.org/download.html or https://github.com/AlloyTools/org.alloytools.alloy/releases/tag/v6.2.0. The upstream project requires Java 17 or later.

```bash
java -jar /path/to/org.alloytools.alloy.dist.jar help
bash scripts/run-examples.sh /path/to/org.alloytools.alloy.dist.jar
```

**Expected intent (not locally executed in this authoring session):**

| Example | Expected run | Expected checks |
|---|---|---|
| `access-control.als` | Instance with group access | No counterexample for owner/group authorization |
| `filesystem-tree.als` | Nontrivial rooted tree | No counterexample for reachability |
| `mutex-temporal.als` | Trace that acquires a lock | No counterexample for mutual exclusion and guarded acquisition |
| `self-approval-counterexample.als` | Approved request exists | **Counterexample** to no-self-approval |
| `self-approval-fixed.als` | Valid approved request with 2 users | No counterexample under separation-of-duties assumption |

An assertion can be false while the Alloy CLI exits 0: inspect output and receipts. These expected outcomes are **analytical predictions, not recorded solver observations**.

## Scope of the skill

Focus: Alloy 6 relational logic, finite structural analysis, temporal behavior, common misinterpretations, and model-review discipline. No promise of correctness without Analyzer execution; finite scopes cannot establish unrestricted theorem validity. The skill does not include the Alloy binary (obtain that from the upstream project).

## Source and license note

Instructional content and examples were authored for this bundle, with citations and attribution in `references/sources.md`. This is independent educational material; it does not redistribute the original Alloy manual, book, or application.
