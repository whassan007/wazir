# Fast-Path Architecture Decision

Two independent implementations of "skip the full coding-agent loop for
simple requests" exist across the two lineages. This document is the
required side-by-side comparison and the decision: **v0.2.11's architecture
is canonical. main's is not ported.**

## The two implementations

### main (`ed4f1d9`, `f7c97cf`, Oct 17 21:16–22:36)

A single regex/keyword classifier, `isDirectAnswerRequest(prompt, options)`,
living in `apps/cli/src/run.ts`. When it matches, `executeTask()` takes an
entirely separate code path: a raw `adapter.generate()` call with no `tools`
array, bypassing the `AgentAdapter`/`AgentRuntime` abstraction, coding-agent
planning, preflight probes, tool-surface compilation, and verification
entirely (comment: *"No checks expected or required on fast-path"*).

Classification logic: ~10 separate regexes/word-boundary checks for
arithmetic, string transforms, JSON/YAML requests, direct questions
(what/who/where/why/how), and code-snippet requests, with one negative
lookahead for mutation-indicating words (`edit|modify|fix|update|refactor|...`).

### v0.2.11 lineage (`246d4cb`, `c7ea2ab`, `973111f`, Oct 17 22:55 – Oct 19 20:09)

Two complementary mechanisms:

1. **`ChatAgent`** (`packages/agents/src/chatAgent.ts`) — a real
   `AgentAdapter` implementation, the same interface `CodingAgent`,
   `StepAgent`, and `AcpAgentAdapter` all implement. Selected through the
   existing `taskTypes: ['chat']` routing, so it goes through the normal
   `Scheduler`/`AgentRegistry`/execution-record pipeline like any other agent
   — not a special-cased bypass in the orchestration layer.
2. **`isDeterministicCommandRequest()`** (`packages/agents/src/codingAgent.ts`,
   added by `973111f`) — a stricter, exact-match, anchored allowlist for
   literal `ls`/`pwd`/`git status`/`git diff`/`git log` (and arguments),
   explicitly rejecting shell metacharacters and never inferring shell intent
   from prose. On match, the tool runs directly through the existing sandbox/
   authorization path with **zero model calls** — not even ChatAgent's single
   generation.

## Comparison (static code analysis — no live model available in this
environment; see TEST-RESULTS.md for what that limits)

| Dimension | main (`isDirectAnswerRequest`) | v0.2.11 (`ChatAgent` + classifiers) |
|---|---|---|
| **Command classification** | Regex/keyword heuristics on raw prompt text; one shared classifier for all "simple" cases | Two-tier: broad conversational classifier (keyword-gated, refined by `c7ea2ab` after it was found to over-block) + a separate, strict, anchored allowlist for literal deterministic commands |
| **Execution latency** | Single model call, no tool surface compiled — fast | ChatAgent: single model call, no tool surface — same order of latency. Deterministic path: zero model calls — strictly faster than either for its narrow case |
| **Model bypass behavior** | Bypasses `AgentAdapter` entirely; raw `adapter.generate()` call in the orchestration layer | ChatAgent *is* an `AgentAdapter` — bypass is at the agent-selection level, not a parallel code path |
| **Security/authorization boundaries** | No tools passed to `generate()`, so nothing can execute even if the model hallucinates a tool call — but this is an *absence of wiring*, not an enforced boundary; no explicit rejection path | ChatAgent explicitly throws `'conversational inference cannot execute tools; use a coding task'` if the model emits a `tool_call` event — a real, tested, in-code boundary (see `chatAgent.test.ts`) |
| **Shell command handling** | N/A (no shell path) | `isDeterministicCommandRequest` explicitly rejects shell metacharacters and requires literal, anchored matches — tested against 23 cases including arguments, invalid commands, and non-matches (`codingAgent.deterministicCommand.test.ts`) |
| **Error propagation** | Inline try/catch in the fast-path block, pushes to `directErrors[]`, manually constructs an `EvaluationResult` | ChatAgent: real error/timeout/cancellation handling inside `run()`, surfaced as a normal `AgentTurn` `{kind: 'error'}` — same shape every other agent produces |
| **Streaming behavior** | Manual token accumulation in the fast-path block | ChatAgent streams through the same `runtime.generate()` iterator contract every agent uses |
| **Cancellation and timeouts** | Not visible in the diffed code — no explicit wall-clock timeout or cancellation poll in the fast-path block | ChatAgent has an explicit wall-clock timeout (`maxWallClockMs` or a configured default, 60s), a cancellation poll every 25ms, and `finally`-block cleanup that calls `iterator.return()` so a broken adapter can't hang the CLI |
| **Scheduler integration** | Scheduling still happens via `planTask()` before the fast-path check (model/computer already chosen), but the fast-path's own generation call doesn't go through the same remote-dispatch-aware `runtime.generate()` used elsewhere in the file | ChatAgent is dispatched exactly like any other agent, inheriting whatever remote/local dispatch logic the runtime wiring already provides |
| **Test coverage** | None found for `isDirectAnswerRequest` itself in `ed4f1d9`'s diff (only narrative `test/codex-fast-path/*.md` reports, not unit tests) | `packages/agents/tests/chatAgent.test.ts` (6 tests) and `packages/agents/tests/codingAgent.deterministicCommand.test.ts` (23 tests) — both passing on this integration branch (see TEST-RESULTS.md) |
| **Duplicate-path risk** | Overlaps heavily with v0.2.11's own `isConversationalFastPathRequest` (arithmetic, direct Q&A, code snippets) — same problem, independently solved | N/A (is the canonical path) |

## Decision

**v0.2.11's `ChatAgent` + `isConversationalFastPathRequest` +
`isDeterministicCommandRequest` is the canonical fast-path architecture.**
main's `isDirectAnswerRequest` and its inline `executeTask()` bypass block
are **not ported**. Reasons, in order of weight:

1. **Explicit safety boundary vs. absence of wiring.** ChatAgent's in-code
   rejection of tool calls is a tested invariant; main's "no tools passed"
   is incidentally safe, not guaranteed safe by design.
2. **Architectural consistency.** ChatAgent reuses the exact abstraction
   every other agent in Wazir implements. main's approach is a parallel,
   special-cased code path bolted directly into `executeTask()` — harder to
   reason about, harder to test in isolation, and a second place future
   routing/scheduling changes must remember to touch.
3. **Test coverage.** v0.2.11's classifiers and agent both have dedicated
   unit tests (29 tests total between the two files). main's classifier has
   none.
4. **Duplicate effort.** Both solve materially the same problem
   (arithmetic/Q&A/code-snippet fast paths) — keeping both would be exactly
   the "duplicate competing execution paths" the reconciliation spec
   prohibits.
5. **v0.2.11's version is strictly more complete**: it additionally has the
   zero-model-call deterministic-command path (`ls`/`pwd`/`git status`/etc.),
   which main's lineage never built.

## What was NOT done

I did not run a live model to produce fresh time-to-first-token or
tokens/sec numbers for either implementation in this environment (no
Ollama/LM Studio instance available here). Both lineages' own prior,
self-reported benchmark data is cited as historical context in
TEST-RESULTS.md, but it was measured by each lineage against its own
version at a different time and is not a controlled head-to-head — it is
not treated as proof of the decision above, which rests on the static
code-quality comparison in this document.
