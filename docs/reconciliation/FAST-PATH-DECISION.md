# Fast-Path & Execution Architecture Decision

Two historical implementations of "skip the full coding-agent loop for simple requests" existed across `main` (`feat/ultra-low-latency-fast-path`) and `v0.2.11`. In Phase 4 of the `integration/v0.2.12-completion` reconciliation, we reassessed both implementations, verified their runtime behavior end to end, fixed a critical wiring gap in `apps/cli/src/run.ts` for deterministic commands, and confirmed a single authoritative boundary between deterministic and model-assisted execution.

## 1. The Two Historical Implementations

### `main` (`ed4f1d9`, `f7c97cf` — `feat/ultra-low-latency-fast-path`)

- Defined a single regex/keyword classifier `isDirectAnswerRequest(prompt, options)` inside `apps/cli/src/run.ts`.
- When matched, `executeTask()` took an inline bypass block that called `adapter.generate()` directly with no `tools` array, bypassing `AgentAdapter`, `Scheduler` agent selection, preflight probes, and standardized turn handling.
- Did **not** support zero-LLM deterministic command execution (`pwd`, `ls`, `git status`, `git diff`, `git log`).
- Also included two important infrastructure fixes in the same commit (`ed4f1d9`):
  1. Tiered `+30` (`READY`) / `+15` (`loaded`) residency bonus in `Scheduler`.
  2. Preserving `stillVerified` (`READY` state) across read-only `discoverAndReconcile({ verify: false })` passes in `ModelLifecycleService`.

### `v0.2.11` Lineage (`246d4cb`, `c7ea2ab`, `973111f`) + Phase 4 Completion (`3aad1af`, `3fda9b3`)

A unified, two-tier fast-path architecture governed by one authoritative classifier module (`packages/agents/src/codingAgent.ts`):

1. **Deterministic Command Fast-Path (`isDeterministicCommandRequest(input, options)`)**:
   - Strict, anchored allowlist matching only literal read-only commands: `pwd`, `ls [<path/flags>]`, `git status`, `git diff`, and `git log`.
   - Explicitly rejects shell metacharacters (`;`, `|`, `&`, `` ` ``, `$()`, `>`, `<`, newlines) and never infers shell commands from prose.
   - Executes directly through the policy-gated `shell` tool inside `CodingAgent.run()` with **zero LLM calls (`0` tokens)**.
   - **Phase 4 Fix (`3fda9b3`)**: `apps/cli/src/run.ts` previously only checked `isConversationalFastPathRequest` when computing `fastPath` in `planTask()` and `executeTask()`, leaving `taskAnalysis.mutationRequired = true` on `wa run "pwd"` and inadvertently disabling `isDeterministicCommandRequest` (`if (options?.mutationRequired) return null`). We wired `isDeterministicCommandRequest(description)` into `planTask()` and `executeTask()` so deterministic read-only commands set `mutationRequired: false`, bypass unnecessary preflight/verification overhead, and execute with zero model calls.
2. **Conversational Fast-Path (`isConversationalFastPathRequest(input, options)` + `ChatAgent`)**:
   - Handles pure arithmetic, factual Q&A, explanations, and self-contained snippet questions when no file references, workspace paths, or mutation requirements exist.
   - Routes through `Scheduler` (`task.type = 'chat'`) to `ChatAgent` (`packages/agents/src/chatAgent.ts`), a first-class `AgentAdapter`.
   - Enforces an explicit in-code security invariant: if a model hallucinates a `tool_call` event during conversational fast-path inference, `ChatAgent` immediately throws `'conversational inference cannot execute tools; use a coding task'`.

---

## 2. Side-by-Side Comparison

| Dimension | `main` (`isDirectAnswerRequest`) | Canonical `v0.2.12-completion` (`ChatAgent` + `isDeterministicCommandRequest`) |
|---|---|---|
| **Authoritative Classifier** | Inline regexes in `apps/cli/src/run.ts` | Single authoritative classifier module in `packages/agents/src/codingAgent.ts` (`isConversationalFastPathRequest` + `isDeterministicCommandRequest`) imported by `apps/cli/src/run.ts` |
| **Deterministic vs Model-Assisted Boundary** | None (all requests invoke the LLM) | Strict boundary: literal `pwd`/`ls`/`git status`/`git diff`/`git log` execute deterministically via policy-gated `shell` tool with **0 LLM calls**; conversational queries route to `ChatAgent` (1 LLM call, 0 tools); repo/file tasks route to `CodingAgent` |
| **Security & Policy Boundary** | Incidental (no tools passed to `adapter.generate()`) | Explicit in-code rejection of `tool_call` events in `ChatAgent`; full `PolicyEngine` + sandbox enforcement on deterministic `shell` calls |
| **Cancellation & Timeouts** | No dedicated wall-clock timeout or 25ms poll in inline bypass | 60s default wall-clock timeout, 25ms cancellation poll, `iterator.return()` cleanup |
| **Live Measured Performance (Phase 5)** | Historical only | Deterministic `wa run "pwd"`: **56–89ms tool execution** (`1141ms` full CLI E2E with snapshot), **0 LLM calls**, **0 tokens**. Conversational `wa run "What is 18 + 24?..."`: **1084ms E2E** on `nvidia/nemotron-3.5-super-vl-120b-a12b` (`392ms` TTFT) |
| **Unit & E2E Test Coverage** | 0 unit tests | `chatAgent.test.ts` (6 tests), `codingAgent.deterministicCommand.test.ts` (23 tests), `executeTask.e2e.test.ts` (10 tests including deterministic zero-LLM E2E check) |

---

## 3. Architectural Decision Summary

1. **One Authoritative Classifier**: `packages/agents/src/codingAgent.ts` exports `isConversationalFastPathRequest` and `isDeterministicCommandRequest`. No competing classifier exists in `apps/cli/src/run.ts`.
2. **Well-Defined Execution Boundary**:
   - **Tier 0 (Deterministic Tool Execution — 0 LLM calls)**: `isDeterministicCommandRequest` matches literal `pwd`, `ls`, `git status`, `git diff`, `git log` -> `CodingAgent` executes the policy-gated `shell` tool directly and returns.
   - **Tier 1 (Conversational Model Fast-Path — 1 LLM call, 0 tools)**: `isConversationalFastPathRequest` matches tool-free questions/arithmetic -> `Scheduler` selects `ChatAgent` (`task.type = 'chat'`).
   - **Tier 2 (Full Agentic Coding Loop — Multi-turn LLM + Tools + Verification)**: All file-referencing, repository-inspecting, or mutating tasks -> `Scheduler` selects `CodingAgent` (`task.type = 'coding'`) with full preflight, tool surface compilation, and verification gates.
3. **Model Readiness Preservation (`3aad1af`)**: Ported `ed4f1d9`'s `stillVerified` fix into `packages/core/src/services/modelLifecycleService.ts` so read-only CLI commands preserve `READY` state across invocations and benefit from the `+30` READY residency bonus in `Scheduler`.
