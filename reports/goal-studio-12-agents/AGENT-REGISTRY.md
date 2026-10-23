# Agent registry

All agents launched concurrently at 2026-10-22 ~18:45 local, from contract commit `e20355e`.
Concurrency: 12 of 12 running at the same time (no queueing needed).

**Model note:** the request asked for Qwen coding models where supported. The agent-launch tool in
this environment runs Claude models only, so every development agent runs on Claude Opus 5.5.
Local Qwen/other models are used only as Wazir execution targets in the end-to-end demo, if one is ready.

| Agent | Workstream | Worktree | Branch | Status | Latest commit | Tests | Blockers |
|---|---|---|---|---|---|---|---|
| 01 | Execution engine reliability | `../agent-01` | `feat/parallel-execution-reliability` | running | e20355e | — | — |
| 02 | Goal graph & data model | `../agent-02` | `feat/parallel-goal-graph` | running | e20355e | — | — |
| 03 | Continuous goal controller | `../agent-03` | `feat/parallel-goal-controller` | running | e20355e | — | — |
| 04 | Independent verification | `../agent-04` | `feat/parallel-verification` | running | e20355e | — | — |
| 05 | Recovery & repair | `../agent-05` | `feat/parallel-recovery` | running | e20355e | — | — |
| 06 | Goal Studio graph UI | `../agent-06` | `feat/parallel-goal-ui` | running | e20355e | — | — |
| 07 | Execution control center | `../agent-07` | `feat/parallel-execution-control` | running | e20355e | — | — |
| 08 | Prompt Studio | `../agent-08` | `feat/parallel-prompt-studio` | running | e20355e | — | — |
| 09 | Model routing & fleet | `../agent-09` | `feat/parallel-model-fleet` | running | e20355e | — | — |
| 10 | Security & governance | `../agent-10` | `feat/parallel-security-governance` | running | e20355e | — | — |
| 11 | TUI/CLI/startup | `../agent-11` | `feat/parallel-tui-performance` | running | e20355e | — | — |
| 12 | Integration & release readiness | `../agent-12` | `feat/parallel-integration-validation` | running | e20355e | — | — |

Worktree paths are relative to `/Users/wael/Code/Wazir-gs/`. Status is updated from actual agent
completion notifications and from `git log` on each branch, not from agent self-reports.
