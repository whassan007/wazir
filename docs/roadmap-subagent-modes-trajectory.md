# Architecture Proposal & Implementation Plan: Subagent Dispatch, Runtime Presets, Trajectory Inspection

Scope: the three gaps identified against DeepSeek Harness / OpenCode / Claude Code / Codex CLI —
(1) in-task subagent dispatch, (2) preset runtime modes, (3) a dedicated trajectory/forensics view.
This document is grounded in the current code (`packages/agents/src/codingAgent.ts`,
`packages/core/src/services/{scheduler,executionEngine,policyEngine,agentRegistry}.ts`,
`apps/cli/src/{run,fleetRunner,commands,dashboardServer}.ts`), read in full before writing this.
Two corrections to the source prompt's premises are called out inline (marked **correction**) where
the code already covers more than the gap analysis assumed — implementing on top of a wrong baseline
would have duplicated existing functionality.

---

## 1. In-Task Subagent Dispatch (Critical Structural Gap)

### 1.1 Current state

`CodingAgent.run()` (`codingAgent.ts:471-1076`) is a single flat turn loop: PLAN → IMPLEMENT/TEST/REPAIR
→ VERIFY. The model emits one `{"action": ...}` JSON object per turn; `tool` actions run through
`runtime.executeTool()`. Parallelism exists only one level up, at the `Scheduler`/Fleet TUI, as
independent top-level jobs (`packages/core/src/services/scheduler.ts`) — there is no way for the model,
*inside* a running task, to spin off an isolated nested agent and get back a condensed result.

`runtime.executeTool()` (`apps/cli/src/run.ts:383-459`, mirrored in `fleetRunner.ts`) already has exactly
the shape this needs to reuse: it special-cases tool calls by provenance before running them —

```ts
if (engine.tools.get(name)?.descriptor.provenance?.source === 'mcp') {
  return executeMCPForAgent(engine, name, input, { projectRoot: engine.projectRoot, executionId });
}
```

Subagent dispatch is architecturally the same shape as this MCP special-case: a tool whose "execution"
is actually a call into a different subsystem, not the sandboxed process tools.

### 1.2 Design

**A new built-in tool, not a new agent action.** Add `dispatch_subagent` to `defaultTools`
(`packages/tools/src/registry.ts`) with `descriptor.provenance = { source: 'subagent' }`. This means
**zero changes to the turn loop itself** in `codingAgent.ts` — the model just sees one more tool in
`runtime.tools`, with a schema like:

```ts
{
  name: 'dispatch_subagent',
  description:
    'Delegate a self-contained subtask to a fresh agent with no memory of this conversation. ' +
    'Use for isolated exploration or a well-scoped subproblem whose full transcript you do not ' +
    'need. Returns only a condensed summary, not the raw transcript.',
  inputSchema: {
    description: 'string, required — the subtask, written so it is understandable with no other context',
    expectedArtifacts: 'string[], optional',
  },
}
```

**Execution path** (new function `runSubagent()` in `run.ts`/`fleetRunner.ts`, special-cased in
`executeTool` exactly like the MCP branch):

1. Create a **child execution record** via `engine.executions.create({ ...parentExecutionId: executionId })`
   — requires adding `parentExecutionId?: string` to `Execution` (`packages/core/src/types/execution.ts:16-29`)
   and threading it through `ExecutionEngine.create()` (`executionEngine.ts:70`).
2. Build a **fresh `messages[]` array** scoped only to the subtask description — deliberately *not*
   inheriting the parent's conversation. This is the entire point of the feature (protect the parent's
   context budget), so it must not leak the parent transcript in "for good measure."
3. Re-run the **same `CodingAgent` instance** (`engine.agents.get('wazir-coding')`) via `.run()` with a new
   `AgentRunRequest` reusing the parent's already-resolved `modelId`/`runtimeId` (no re-scheduling — the
   model is already loaded) and a `runtime: AgentRuntime` whose `executeTool` **delegates to the parent's
   own `executeTool`** — so policy authorization, sandboxing, and `ToolCallRecord` provenance are 100%
   reused, not reimplemented. Tag each delegated call's `provenance` with `{ subagentExecutionId,
   subagentDepth }`.
4. Consume the subagent's turn stream fully in-process; do not surface it as top-level TUI events unless
   an opt-in `--verbose-subagents` flag is set.
5. Condense into a single `ToolResult`: `{ ok, output: <final summary + files changed + check results>,
   error? }` — a few hundred tokens, not the transcript.
6. Persist the child `ExecutionRecord` normally, linked via `parentExecutionId` — this is what makes it
   inspectable later, and feeds directly into §3 (a child execution is just another node in the DAG).

**Guardrails (non-negotiable for a first cut, given this project's own live-test history of small local
models getting stuck in unproductive loops — see `buildcpp.e2e.test.ts`'s docstring):**

- **Depth ≤ 1.** A subagent's own `runtime.tools` omits `dispatch_subagent` entirely when
  `request.subagentDepth >= 1`. No recursive fork bombs.
- **Sequential, not concurrent**, for v1 — the parent awaits one subagent to completion before its next
  turn. Keeps rate limits and sandbox process accounting simple; concurrent dispatch is a clearly-labeled
  v2 stretch goal, not bundled here.
- **Hard turn ceiling** independent of anything the model requests (e.g. `min(requested, 12)`), and no new
  wall-clock budget — a subagent's time comes out of the parent's existing job timeout, it isn't additive.
- **Policy gate**: extend `PolicyRequirements` (`task.ts:43-63`) with `allowSubagentDispatch?: boolean`.
  Default true, but force `false` whenever `dataClassification` is `'sensitive'`/`'restricted'` — same
  "restricted data never gets a wider blast radius" rule `checkHostedEligibility()`
  (`policyEngine.ts:428`) already enforces for hosted-provider routing. No other new policy surface is
  needed: every tool call the subagent makes still goes through `engine.policy.authorize()` exactly as
  today, since it's the same delegated `executeTool`.
- The existing circuit breaker (`checkCircuitBreaker`, `codingAgent.ts:531`) already guards repeated
  identical calls generically by tool name + input — no changes needed there.

### 1.3 Step-by-step implementation plan

1. `packages/core/src/types/execution.ts`: add `parentExecutionId?: string` to `Execution`.
2. `packages/core/src/types/task.ts`: add `allowSubagentDispatch?: boolean` to `PolicyRequirements`.
3. `packages/core/src/services/executionEngine.ts`: thread `parentExecutionId` through `create()`; add
   `listChildren(executionId): Promise<ExecutionRecord[]>`.
4. `packages/core/src/services/policyEngine.ts`: add a `checkSubagentEligibility(policy)` mirroring
   `checkHostedEligibility`'s sensitive/restricted override.
5. `packages/tools/src/registry.ts`: add the `dispatch_subagent` `ToolDescriptor` (provenance-only, no
   `execute()` body — same as how MCP tools are registered today, since real execution happens in the
   `executeTool` special-case, not in the tool object itself).
6. `apps/cli/src/run.ts` and `apps/cli/src/fleetRunner.ts`: add `runSubagent()` and the
   `provenance?.source === 'subagent'` branch in `executeTool`, mirroring the existing MCP branch
   line-for-line in structure.
7. `apps/agents` or wherever `AgentRunRequest` is constructed: add `subagentDepth?: number` (default 0),
   propagated so `runtime.tools` filtering can omit `dispatch_subagent` at depth ≥ 1.
8. Tests: unit test for depth-limit enforcement and turn-ceiling clamping; e2e test (pattern-matching
   `executeTask.e2e.test.ts`'s scripted-reply fake adapter) where turn 1 dispatches a subagent whose own
   scripted replies write a file, asserting the parent's final `filesChanged` includes the subagent's file
   and the parent's own message history never contains the subagent's raw turns.

---

## 2. Preset Runtime Modes

### 2.1 Current state

`CodingAgentOptions` (`codingAgent.ts:21-61`) already exposes nearly every knob DSH's named modes would
tune: `maxTurns`, `maxRepairCycles`, `maxTokensPerTurn`, `temperature`, `toolRepeatLimit`,
`contextCompactionRatio`, `systemPromptExtra`. `ToolRegistry` (`packages/tools/src/registry.ts`) already
accepts an arbitrary tool subset in its constructor. **A "preset mode" is therefore mostly a named,
curated bundle of config that already exists — not new engine capability**, with one exception (Code
mode, below).

### 2.2 Design

Add `packages/agents/src/presets.ts`:

```ts
export interface RuntimePreset {
  name: string;
  description: string;
  tools: string[] | 'all';
  agentOptions: Partial<CodingAgentOptions>;
}

export const RUNTIME_PRESETS: Record<string, RuntimePreset> = {
  standard: { name: 'standard', description: 'default full toolset', tools: 'all', agentOptions: {} },
  minimal: {
    name: 'minimal',
    description: 'shell + edit only, for reproducible leaderboard-style benchmarking',
    tools: ['shell', 'edit'],
    agentOptions: { contextCompactionRatio: 1, maxRepairCycles: 1 },
  },
  // 'code' mode: see §2.3 — needs new tooling, not just config.
};
```

- `TaskRequirements`/`ExecutionPreferences` (`task.ts`): add `runtimePreset?: string` (default
  `'standard'`).
- `run.ts`/`fleetRunner.ts`: move `createCodingAgent(options)` construction from once-per-engine to
  once-per-task, resolving the preset and filtering the `ToolRegistry` view passed into `runtime.tools`.
- CLI: `wa task run --preset minimal "..."` / `wa chat --preset minimal`.
- **No PolicyEngine changes.** A preset only *narrows* which tools the model is shown; every call still
  goes through `engine.policy.authorize()`, so a preset can never grant something policy would otherwise
  deny.

### 2.3 Code mode (flagged as separate, higher-effort work)

DSH's Code mode — a TypeScript SDK the model writes one orchestration script against, batching several
tool calls into one round trip — needs genuinely new tooling: an `execute_script` tool that runs a
snippet in a sandboxed Node VM (reusing the existing bwrap boundary from `packages/tools/src/sandbox.ts`)
with the other tools pre-bound as callable functions. This is not config plumbing like `minimal`/
`standard` and should be scoped and estimated separately rather than bundled into this pass.

### 2.4 Step-by-step implementation plan

1. `packages/agents/src/presets.ts` (new): `standard`, `minimal` presets.
2. `packages/core/src/types/task.ts`: add `runtimePreset?: string`.
3. `apps/cli/src/run.ts` / `fleetRunner.ts`: per-task agent construction + tool-list filtering.
4. `apps/cli/src/index.ts` (or wherever CLI flags are parsed): `--preset` flag on `task run`/`chat`.
5. Test: e2e run with `preset: 'minimal'` asserting `runtime.tools` only contains `shell`/`edit` and that
   a `read`/`glob` action is rejected the same way an unregistered tool is today.

---

## 3. Trajectory / Forensics Inspection

### 3.1 Current state — **correction to the gap analysis**

The source prompt states Wazir "lacks a dedicated Trajectory UI." That's only partly true — checked
directly against the code:

- `ExecutionEngine.replay(executionId): AsyncIterable<ExecutionEvent>` **already exists**
  (`executionEngine.ts:615`), and `wa executions replay <id>` (`apps/cli/src/commands.ts:506-521`)
  **already renders a full chronological event trace** (phase transitions, tool calls, checks) — this is
  DSH's "append-only session log" concept, already implemented, just CLI-only.
- `wa executions inspect <id>` (`commands.ts:403`) already exists for structured single-execution detail.
- A web dashboard already exists (`apps/cli/src/dashboardServer.ts`, `apps/web/public/index.html`) serving
  `/api/v1/executions` (list, with filter/search) and `/api/v1/executions/:id` (detail) — but **not** a
  per-execution `/events` timeline route, and the HTML only renders a filterable table, not a
  timeline/tree view of one execution's trajectory.

So the real gap is narrower than "build a Trajectory UI from scratch": **expose the event stream over
HTTP, and add a detail view that renders it** — plus, once §1 lands, a parent/child tree instead of a
flat list.

### 3.2 Design (two tiers — ship the cheap one first)

**Tier 1 (already done):** `wa executions replay`/`inspect` cover the CLI forensics case today. Once §1's
`parentExecutionId` lands, extend `inspectExecution` to also print `listChildren()` recursively as an
indented tree.

**Tier 2 — web timeline view:**
1. `dashboardServer.ts`: add `GET /api/v1/executions/:id/events`, wrapping the existing
   `engine.executions.events()` (already used by the CLI — zero new engine code).
2. `apps/web/public/index.html`: add a detail view (click a row in the existing executions table) that
   fetches `/events` and renders a timeline: phase markers, tool calls with policy effect and duration,
   check pass/fail, files changed — all fields already present on `ExecutionEvent`/`ToolCallRecord`
   (`execution.ts:37-59, 182-188`), so this is presentation work, not new data capture.
3. Once §1 lands: render `parentExecutionId` children as nested rows under their parent.

**Explicitly out of scope for this pass — true fork/resume.** `ExecutionRecord` does not persist the
per-turn `messages[]` array today, only derived summaries (`filesChanged`, `checks`, `result`). "Resume
from turn N" would require persisting that array per turn, which is a separate, larger change (and a
storage-growth tradeoff worth its own design pass) — flagging it here rather than silently omitting it.
`Task.contextFrom` (`task.ts:85`) already exists and is threaded through `jobManager.ts` but isn't
resume-from-a-point semantics — worth checking what it's actually used for before building on it.

### 3.3 Step-by-step implementation plan

1. `dashboardServer.ts`: add the `/api/v1/executions/:id/events` route (thin wrapper, ~10 lines,
   matching the existing route style at lines 237-247).
2. `apps/web/public/index.html`: detail/timeline view component + fetch wiring.
3. After §1 ships: `listChildren()` wiring into both the CLI tree-print and the web detail view.
4. Test: dashboard server unit test hitting the new route against a fixture `ExecutionRecord` with a
   few events, asserting shape and ordering.

---

## 4. Sequencing recommendation

Preset modes (§2, minus Code mode) is the cheapest, lowest-risk, and has no dependency on the others —
good first slice. Trajectory Tier 2 (§3) is next-cheapest and directly benefits from whatever ships in §1
without blocking on it. Subagent dispatch (§1) is the highest-value and highest-risk piece — it touches
`Execution`'s shape and the policy surface, so it should land with its guardrails (depth limit, sequential
execution, turn ceiling) in the same PR as the feature itself, not as a follow-up.
