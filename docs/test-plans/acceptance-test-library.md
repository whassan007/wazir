# Wazir Acceptance Test Library & Release Gate Specification

Status: active · Owner: Wazir Core & Fleet Team · Applies to: Wazir Control Plane, Scheduler, Model Router, Agent Engine, Worker Runtime, Governance & TUI.

---

## 1. Purpose & Core Principles

The **Wazir Acceptance Test Library** is a formal, multi-gate acceptance harness designed to validate end-to-end control-plane properties rather than isolated LLM code generation.

The suite verifies that:
1. **Model → Tool Protocol** is stable and schema-compliant (no dropped arguments, no prose-over-action bailouts).
2. **Workspaces & Context** persist reliably across shell tool calls and maintain strict isolation between concurrent executions.
3. **Reactive Agent Repair** captures compiler errors and repairs defects deterministically without full-job restarts.
4. **Capability-Based Routing** enforces semantic requirements (e.g. reasoning, tool-calling) and strictly excludes non-generative/embedding models from generative execution.
5. **Fleet DAGs & Concurrency** correctly schedule parallel branches, enforce stage ordering, and isolate branch failures.
6. **Supervisor & Multi-Agent Collaboration** supports independent reviewers, competitive evaluation, and cross-model specification handoffs.
7. **Governance & Audit Trails** intercept untrusted binary executions, enforce policy denials without evasion, and record tamper-evident audit logs.
8. **Resilience & Fault Tolerance** gracefully recovers from worker crashes and cleans up all child processes on cancellation.
9. **Terminal Native Safety** prevents large paste floods and rapid burst submissions from corrupting the scheduler.
10. **Full Golden Path** integrates diagnosis, peer review, implementation, test verification, and complete provenance into a unified delivery pipeline.
11. **Tool-Execution Depth** enforces subprocess timeouts, edit-tool match uniqueness, windowed-read boundaries, and search-truncation signaling.
12. **Protocol Interoperability** enforces structured JSON schema output where advertised, and exercises MCP discovery/invocation and policy gating end-to-end rather than in isolation.
13. **Session & Fleet Hardening** recovers from empty model completions, preserves fidelity across repeated context-compaction rounds, and detects worktree merge conflicts safely.
14. **Terminal UX Depth** supports composer history recall and immediate Escape-key cancellation of an actively streaming turn.
15. **Performance Gates** bound PTY streaming latency/byte-loss and multi-turn orchestration overhead growth.
16. **Verification Integrity** binds task completion to externally-observed evidence (not self-report), invalidates stale build/test evidence the moment the workspace is edited again, records files-changed provenance from real disk mutation rather than tool-call arguments, and auto-approves workspace-confined build tools instead of stalling on interactive approval.

---

## 2. Progressive Release Gates

The suite is organized into **16 progressive release gates (G0 through G15)**. Releases must satisfy gates sequentially:

```text
G0 Protocol  ──→  G1 Runtime  ──→  G2 Agent  ──→  G3 Routing  ──→  G4 Fleet
     │
     └──→  G5 Multi-Agent  ──→  G6 Governance  ──→  G7 Resilience  ──→  G8 Terminal  ──→  G9 Golden
                                                                                               │
                                                                                       ★ FUNCTIONAL READY ★
                                                                                               │
     ┌─────────────────────────────────────────────────────────────────────────────────────────┘
     └──→  G10 Tool Depth  ──→  G11 Interop  ──→  G12 Session Hardening  ──→  G13 Terminal Depth  ──→  G14 Performance  ──→  G15 Verification Integrity
                                                                                               │
                                                                                       ★ WAZIR READY ★
```

### Strict Progression Rule
> **A later gate CANNOT compensate for an earlier prerequisite gate.**
> If workspace persistence or isolation fails in G1, for example, a successful multi-agent demonstration in G5 is irrelevant and the release is marked **NOT READY**.

G0–G9 validate that Wazir *works end to end* (the functional golden path). G10–G15 are an additive **hardening tier**. G10–G14 close gaps identified by cross-referencing [`docs/test_architecture.md`](../test_architecture.md), a generic testing-architecture reference catalog synthesized from unrelated projects (DeepSeek Harness, Opencode), against what Wazir actually has (see §8). G15 closes a distinct class of defect found by cross-referencing Wazir's own *observed* verifier behavior against how deepseek-harness and opencode solved the same problem (see §9). G9 remains the functional-readiness milestone; G10–G15 are required for full ★ WAZIR READY ★.

| Gate | Name | Tests Included | Core Verification Property |
| :--- | :--- | :--- | :--- |
| **G0 Protocol** | Protocol Reliability | Test 20 | Models reliably invoke tools without missing arguments or schema violations |
| **G1 Runtime** | Runtime & Workspaces | Tests 1, 17, 18, 19 | Workspace persistence across shell calls; filesystem & context isolation |
| **G2 Agent** | Agent & Repair | Tests 8, 9 | Reactive compiler error recovery and deterministic bug repair fixture |
| **G3 Routing** | Capability Routing | Tests 3, 4, 14, 29 | Reasoning selection, capability exclusion, computer vs model scheduling, explainability |
| **G4 Fleet** | Fleet & Concurrency | Tests 2, 5, 6, 7 | Distinct model fan-out/fan-in, concurrency bounds, DAG dependencies, branch failure isolation |
| **G5 Multi-Agent** | Multi-Agent Coordination | Tests 10, 11, 12, 13 | Reviewer model, competitive execution, cross-model handoff, artifact provenance |
| **G6 Governance** | Policy & Governance | Tests 15, 16, 24 | Interactive approval, denial enforcement, anti-bypass invariants, complete audit log |
| **G7 Resilience** | Resilience & Recovery | Tests 21, 22, 23 | Explicit model failover, worker crash heartbeat recovery, clean process cancellation |
| **G8 Terminal** | Terminal Safety | Tests 25, 26, 27, 28 | Block history integrity, semantic context referencing, large paste barrier, burst rate breaker |
| **G9 Golden** | Flagship Golden Path | Test 30 | Full end-to-end repository diagnosis, peer review, fix, test, evaluation, and provenance |
| **G10 Tool Depth** | Tool-Execution Depth | Tests 31, 32, 33, 34 | Subprocess timeout kill, edit-tool uniqueness guard, windowed-read boundaries, search truncation signaling |
| **G11 Interop** | Protocol Interoperability | Tests 35, 36, 37 | Structured JSON schema enforcement, MCP discovery/invocation and policy gating exercised live |
| **G12 Session Hardening** | Session & Fleet Hardening | Tests 38, 39, 40 | Empty-completion recovery, multi-round compaction fidelity, worktree merge-conflict safety |
| **G13 Terminal Depth** | Terminal UX Depth | Tests 41, 42 | Composer history recall, Escape-key cancellation mid-stream |
| **G14 Performance** | Performance Gates | Tests 43, 44 | PTY throughput/latency integrity, multi-turn orchestration overhead growth bounds |
| **G15 Verification Integrity** | Evidence-Bound Verification | Tests 45, 46, 47, 48 | Completion requires externally-observed evidence, stale build/test evidence is invalidated on edit, files-changed provenance reflects real disk mutation, workspace-confined build tools don't stall on approval |

---

## 3. Foundational Test Sequence

Before running complex DAGs or long multi-agent pipelines, the harness defines the **Foundational Sequence**:

$$\mathbf{20 \longrightarrow 17 \longrightarrow 18 \longrightarrow 1 \longrightarrow 9 \longrightarrow 3 \longrightarrow 4 \longrightarrow 2}$$

1. **Test 20 (Protocol Reliability):** Proves the model can format valid tool envelopes.
2. **Test 17 (Workspace Persistence):** Proves consecutive shell calls remain in the same working directory.
3. **Test 18 (Clean Workspace Isolation):** Proves concurrent tasks cannot see each other's temporary files.
4. **Test 1 (Basic Model → Tool → Artifact):** Proves the simplest real build/compile/run path works.
5. **Test 9 (Deterministic Bug Repair):** Proves compiler error feedback triggers minimal targeted code fixes.
6. **Test 3 (Reasoning Selection):** Proves the router prefers reasoning models for algorithmic design.
7. **Test 4 (Capability Exclusion):** Proves embedding-only models are never assigned generative coding tasks.
8. **Test 2 (Distinct Model Fan-Out + Fan-In):** Proves multi-model DAG orchestration and integration.

---

## 4. Test Catalog Matrix (48 Use Cases)

| ID | Gate | Priority | Title | Key Invariant / Verification | Associated Suites |
| :---: | :---: | :---: | :--- | :--- | :--- |
| **01** | G1 | P0 | Basic Model → Tool → Artifact | Write main.cpp, compile with g++, execute with args, verify output & sum 55 | `buildcpp.e2e.test.ts`, `jobLifecycleAndValidation.test.ts` |
| **02** | G4 | P0 | Distinct Model Fan-Out + Fan-In | Task A (Gemma QuickSort) \|\| Task B (Qwen MergeSort) -> Integration main.cpp -> verify | `jobOrchestrator.test.ts`, `jobLifecycleAndValidation.test.ts` |
| **03** | G3 | P0 | Reasoning-Based Model Selection | Route graph shortest path design to reasoning model (`qwen/qwen3.8-27b`), explain via `wa explain` | `planner.test.ts`, `liveModelMatrix.test.ts` |
| **04** | G3 | P0 | Capability Exclusion | Reject embedding models (`nomic-embed`) from tool-calling tasks with explicit capability explanation | `planner.test.ts`, `liveModelMatrix.test.ts` |
| **05** | G4 | P1 | Parallel Independent Tasks | Concurrently execute 4 independent utilities subject to agent limits (e.g. max 4) | `jobLifecycleAndValidation.test.ts`, `fleetTui.test.ts` |
| **06** | G4 | P0 | Dependency Enforcement | Stage 1 (math_utils) -> Stage 2 (analyzer) -> Stage 3 (tests); strict timestamp ordering | `jobLifecycleAndValidation.test.ts` |
| **07** | G4 | P0 | Failure Isolation | Failure in Branch B repairs B without invalidating or restarting successful sibling Branch A | `jobOrchestrator.test.ts`, `jobOrchestrator.replanning.test.ts` |
| **08** | G2 | P0 | Intentional Compile Failure → Repair | Reactive repair loop captures compiler stderr, classifies defect, preserves workspace, re-compiles | `jobOrchestrator.replanning.test.ts`, `codingAgent.circuitBreaker.test.ts` |
| **09** | G2 | P0 | Deterministic Bug Repair Fixture | Fixture with missing semicolon repaired minimally; transitions exit 1 to exit 0 and prints "Hello" | `expectedEvidence.test.ts`, `planner.test.ts` |
| **10** | G5 | P0 | Reviewer Model | Model A implements thread-safe queue; Model B reviews without mutating; repair upon defect | `stepAgent.test.ts`, `planner.test.ts` |
| **11** | G5 | P1 | Competitive Execution | Two models independently implement LRU cache; independent evaluator selects winner on metrics | `expectedEvidence.test.ts`, `planner.test.ts` |
| **12** | G5 | P1 | Cross-Model Handoff | Reasoning model writes specification artifact (no code); coding model implements from spec | `planner.test.ts`, `stepAgent.test.ts` |
| **13** | G5 | P0 | Artifact Provenance | `wa artifacts` inspects job, execution, agent, model, runtime, computer, timestamps, verification | `expectedEvidence.test.ts`, `jobLifecycleAndValidation.test.ts` |
| **14** | G3 | P0 | Explainable Routing | `wa explain <execution>` details requirements, candidate scores, eligibility, rejection reasons | `planner.test.ts`, `doctor.test.ts` |
| **15** | G6 | P0 | Policy Approval | Newly compiled binary execution intercepts with approval request; authorized via policy/audit | `policyEngineShell.test.ts`, `policyEngineHardening.test.ts` |
| **16** | G6 | P0 | Policy Denial & Anti-Bypass | Denying execution halts task; model is prevented from bypassing via shell wrappers (`sh ./hello`) | `policyEngineShell.test.ts`, `policyEngineHardening.test.ts` |
| **17** | G1 | P0 | Workspace Persistence | Consecutive shell calls (pwd, write, read, compile, verify binary, execute) share identical directory | `sandbox.test.ts`, `jobOrchestrator.test.ts` |
| **18** | G1 | P0 | Clean Workspace Isolation | Concurrent tasks Task A (`artifact-a.txt`) and Task B (`artifact-b.txt`) cannot cross-read files | `jobLifecycleAndValidation.test.ts`, `sandbox.test.ts` |
| **19** | G1 | P0 | Context Isolation | Concurrent agents given separate markers (`ALPHA` / `BETA`) never leak prompt tokens across streams | `jobLifecycleAndValidation.test.ts`, `fleetTui.test.ts` |
| **20** | G0 | P0 | Protocol Reliability & Error Rates | Diagnostic probe across glob, read, write, shell asserts >= 98% validity rate; classifies errors | `parseAction.test.ts`, `stepAgent.test.ts`, `codingAgent.proseBailout.test.ts` |
| **21** | G7 | P1 | Model Failover | Simulated model loss triggers explicit failover to backup model with audit event and preserved task ID | `jobOrchestrator.test.ts`, `codingAgent.circuitBreaker.test.ts` |
| **22** | G7 | P1 | Worker Failure Recovery | Worker process termination triggers heartbeat timeout; task resumes from last persisted step | `jobOrchestrator.test.ts` |
| **23** | G7 | P0 | Cancellation & Orphan Cleanup | Cancelling running job aborts model turns and kills child process groups with zero orphan leaks | `jobOrchestrator.test.ts`, `fleetTui.test.ts` |
| **24** | G6 | P0 | Audit Integrity | Submission -> routing -> write -> shell -> policy -> execution -> verify all emit immutable audit events | `policyEngineHardening.test.ts`, `jobLifecycleAndValidation.test.ts` |
| **25** | G8 | P0 | History / Block Integrity | CLI commands create discrete Block records with timestamps, exit codes, and structured JSON | `fleetTui.test.ts`, `tuiSessionLifecycle.test.ts` |
| **26** | G8 | P1 | Context Referencing | Referencing `@<block-id>` or `@job:<job-id>` extracts targeted context without full history dump | `fleetTui.test.ts`, `codingAgent.contextCompaction.test.ts` |
| **27** | G8 | P0 | Large Paste Safety | Pasting multiline text into interactive TUI enters review mode `[Submit] [Edit] [Discard]`; 0 jobs auto-run | `fleetTui.test.ts` |
| **28** | G8 | P0 | Submission Burst Protection | Rapid burst of 20 newline-delimited inputs clamped by rate limiter; launches at most 1 job | `fleetTui.test.ts` |
| **29** | G3 | P1 | Computer/Runtime Capability Routing | Separate computer hardware requirements (g++) from model runtime capabilities (reasoning) | `scheduler.test.ts`, `jobOrchestrator.test.ts` |
| **30** | G9 | P0 | Full Wazir Golden Path | End-to-end repository defect diagnosis, peer review, patch, regression test, audit, and provenance | `buildcpp.e2e.test.ts`, `fleetRunner.e2e.test.ts` |
| **31** | G10 | P0 | Subprocess Timeout Enforcement | `sleep 30` with `timeoutMs=1000` is SIGKILL'd on schedule, no hang, no orphan process | `sandbox.test.ts`, `processTimeout.test.ts` |
| **32** | G10 | P0 | Exact-Match Edit Uniqueness Guard | `edit` tool rejects a non-unique `oldString` without `replaceAll`; succeeds once context makes it unique | `security.test.ts`, `editUniqueness.test.ts` |
| **33** | G10 | P1 | Windowed Read Boundaries on Large Files | `read(offset=2001, limit=10)` on a 5,000-line file returns exactly that slice plus a separate total-line count | `security.test.ts`, `windowedRead.test.ts` |
| **34** | G10 | P1 | Search Result Truncation Signaling | 250-match search caps at `MAX_RESULTS` and explicitly flags truncation instead of implying completeness | `security.test.ts`, `searchTruncation.test.ts` |
| **35** | G11 | P1 | Structured JSON Schema Enforcement | Router prefers a `structuredOutput=true` runtime (LM Studio) for schema-constrained tasks; Ollama excluded or explicitly downgraded | `lmstudioAdapter.test.ts`, `ollamaAdapter.test.ts`, `scheduler.test.ts` |
| **36** | G11 | P2 | MCP Dynamic Tool Discovery & Invocation (E2E) | MCP handshake, tool discovery, and live invocation inside a real job — currently unwired; defines the target invariant | `mcpClient.unwired.test.ts`, `mcpClient.e2e.test.ts` |
| **37** | G11 | P1 | MCP Policy Gate Under Live Execution | Task referencing a non-allowlisted MCP server is denied end-to-end before any transport opens, and the denial is audited | `policyEngine.test.ts`, `mcpClient.unwired.test.ts` |
| **38** | G12 | P0 | Empty/Whitespace Completion Recovery | Blank model completion is never accepted; auto-retries with a corrective nudge rather than stalling or completing vacuously | `codingAgent.emptyCompletion.test.ts`, `parseAction.test.ts` |
| **39** | G12 | P1 | Context Compaction Fidelity Under Repeated Rounds | Task instructions and recent turns survive 2+ compaction rounds without loss or duplication | `codingAgent.contextCompaction.test.ts` |
| **40** | G12 | P0 | Fleet Worktree Merge-Conflict Safety | Two branches editing the same file in independent worktrees produce a detected, surfaced conflict at fan-in, never silent corruption | `worktreeManager.test.ts`, `jobOrchestrator.test.ts` |
| **41** | G13 | P1 | Composer History Recall via Up/Down Arrows | Up/Down recall steps through submitted history and restores the exact in-progress draft, never auto-submits | `fleetTui.test.ts`, `pasteBarrier.test.ts` |
| **42** | G13 | P0 | Escape Cancellation During Active Model Streaming | Escape aborts an actively streaming turn immediately (distinct from the timeout-triggered path in Test 23), zero dangling state | `fleetTui.test.ts` |
| **43** | G14 | P1 | PTY High-Throughput Streaming Latency & Zero Byte Loss | Multi-megabyte burst through the PTY: zero dropped bytes, bounded time-to-last-byte, terminal stays responsive | `sessionEof.test.ts`, `ptyThroughput.test.ts` |
| **44** | G14 | P1 | Multi-Turn Latency Growth Bound | Per-turn orchestration overhead across 20 turns stays within a bounded growth percentage, no step-function spikes | `codingAgent.maxTurns.test.ts`, `codingAgent.turnLatency.test.ts` |
| **45** | G15 | P0 | Evidence-Bound Completion Verification | Completion is refused without an externally-observed passing build for the current revision; agent self-report / file-write alone never suffices | `continuousVerification.test.ts`, `expectedEvidence.test.ts`, `evidenceBoundVerification.test.ts` |
| **46** | G15 | P0 | Workspace Revision Staleness Invalidation | A post-build edit (even to a header the build doesn't name directly) invalidates prior passing build/test evidence; completion is refused until re-verified against the new revision | `continuousVerification.test.ts`, `revisionStaleness.test.ts` |
| **47** | G15 | P0 | False files-changed Event Prevention on Failed Edits | A failed edit (oldString not found) leaves the file byte-identical, emits no files-changed event, and never advances the workspace revision | `security.test.ts`, `editProvenance.test.ts`, `expectedEvidence.test.ts` |
| **48** | G15 | P1 | Workspace-Scoped Build Tool Auto-Approval | `make`/`g++`/`cmake` confined to the project workspace run without an interactive approval stall; a command reaching outside the workspace still requires approval | `policyEngineShell.test.ts`, `policyEngineHardening.test.ts` |

---

## 5. Executable Test Harness Usage

The test harness is implemented in [`scripts/acceptance-test-harness.mjs`](file:///home/wael/Code/Wazir/scripts/acceptance-test-harness.mjs) and registered in `package.json`.

```bash
# 1. Run the foundational sequence (recommended first check)
npm run test:acceptance -- --foundational

# 2. Run a specific release gate (e.g. G0, G1, ... G15)
npm run test:acceptance -- --gate G0
npm run test:acceptance -- --gate G1
npm run test:acceptance -- --gate G10
npm run test:acceptance -- --gate G15

# 3. Run a specific acceptance test by ID (1..48)
npm run test:acceptance -- --test 20
npm run test:acceptance -- --test 27
npm run test:acceptance -- --test 42
npm run test:acceptance -- --test 46

# 4. Run the entire acceptance suite across all 16 gates (fail-fast rule)
npm run test:plan:acceptance
# or:
npm run test:acceptance -- --all

# 5. Interactive Mode (prompts user to pick gate, test, or probe)
npm run test:acceptance -- --interactive

# 6. Live Model Probe (checks LM Studio & Ollama endpoints)
npm run test:acceptance -- --live
```

---

## 6. Upgrade Protocol & Operational Rule

> **"Each time there is an upgrade, please ask what to test."**

Whenever Wazir is upgraded (version bump, new feature, architectural change, or release cut), the assistant or automation MUST interactively ask the user what to test:
- **Option 1 (Recommended):** Foundational Sequence (`20 -> 17 -> 18 -> 1 -> 9 -> 3 -> 4 -> 2`)
- **Option 2:** Target Release Gate (`G0 Protocol` through `G15 Verification Integrity`)
- **Option 3:** Specific Acceptance Test (`Test 1` through `Test 48`)
- **Option 4:** Full Progressive Acceptance Suite (`G0` through `G15` with strict fail-fast enforcement)
- **Option 5:** Live Model Runtime Probe (LM Studio & Ollama)

A release that only needs to prove Wazir *works* can stop at G9 (★ Functional Ready★). A release headed for GA should run the full suite through G15.

---

## 7. Artifacts & Reporting

Every harness run emits a structured report to `acceptance-test-report.json`:
- Timestamp, Wazir version, and execution mode (`deterministic` or `live`).
- Gate summary table with pass/fail counts.
- Case-by-case execution table with durations, assertion counts, and error details.
- Clear release verdict:
  - `★ RELEASE VERDICT: WAZIR READY FOR RELEASE ★`
  - `✖ RELEASE VERDICT: WAZIR NOT READY FOR RELEASE ✖` (listing blocking P0 failures).

---

## 8. Coverage Gaps Closed From the Reference Testing-Architecture Catalog

[`docs/test_architecture.md`](../test_architecture.md) is a generic scenario catalog synthesized from two *unrelated* projects (DeepSeek Harness, Opencode) as a reference blueprint for agentic-system testing in general. It is not a Wazir-specific spec — many of its scenarios describe infrastructure Wazir doesn't have (multi-cloud-provider chat APIs, a browser Playwright UI). Gates G10–G14 were added by walking every category in that catalog, checking it against Wazir's actual source (`packages/`, `apps/`), and porting only the scenarios that map onto something real.

### 8.1 Gaps ported (Tests 31–44)

| Reference Catalog ID | Wazir Test | Grounding |
| :--- | :--- | :--- |
| `TOOL-SH-03` (Subprocess Timeout) | Test 31 | Real `timeoutMs`/`SIGKILL` logic in `packages/tools/src/process.ts`, previously untested at acceptance level |
| `TOOL-FS-04` (Contiguous Block Replacement) | Test 32 | Real `edit` tool in `packages/tools/src/filesystem.ts`; the "errors on non-unique match" invariant was never verified |
| `TOOL-FS-02` (Windowed Reads) | Test 33 | Real `offset`/`limit` support in the `read` tool, untested on large files |
| `TOOL-AST-02` (Grep Truncation) | Test 34 | Real `MAX_RESULTS` cap in `packages/tools/src/search.ts`, with no truncation flag in tool metadata today |
| `LLM-PV-05` (Structured JSON Enforcement) | Test 35 | Real `structuredOutput` capability flag differs between the LM Studio and Ollama runtime adapters; never exercised end-to-end |
| `PROT-MCP-01` (MCP Discovery) | Test 36 | `packages/core/tests/mcpClient.unwired.test.ts` confirms MCPClient exists but is explicitly **unwired** from live job execution — this test defines the target invariant |
| `PROT-MCP-01`/policy | Test 37 | MCP policy gating exists only as an isolated `PolicyEngine.classify()` unit test; never exercised inside a real job |
| `SESS-CP-03` (Empty Completion Recovery) | Test 38 | No coverage found anywhere in the repo |
| `SESS-CP-01` (Compaction, extended) | Test 39 | `codingAgent.contextCompaction.test.ts` only covers a single trigger; multi-round fidelity was untested |
| *(Wazir-specific, not in reference catalog)* | Test 40 | `worktreeManager.test.ts` unit-tests merge-conflict detection; no acceptance-level job exercises it through a real fan-in |
| `TUI-INP-01` (History Navigation) | Test 41 | `pasteBarrier.test.ts` only covers paste-triggered COMPOSER mode, not general Up/Down history recall |
| `TUI-EVT-01` (Cancellation Race) | Test 42 | Existing cancellation test (`fleetTui.test.ts`) is timeout-triggered only; user-initiated Escape mid-stream was untested |
| `BENCH-PTY-LATENCY` | Test 43 | `ptyDriver.py` exists and is used for functional PTY tests only; no throughput/latency assertion existed |
| `BENCH-AGENT-CONT` | Test 44 | No latency-growth assertion exists anywhere in the multi-turn agent loop |

### 8.2 Categories intentionally not ported

- **Prompt caching, encrypted/thinking-block reasoning streams** (`LLM-PV-01/02/03`) — Wazir's hosted-provider adapters (`packages/runtimes/anthropic`, `-openai`, `-google`, added after this section was originally written) call each provider's plain HTTP API directly; none of the three exposes a `cache_control`/prompt-caching mechanism or a separated encrypted-reasoning-stream concept to Wazir's adapter layer today.
- **ACP handshake** (`PROT-ACP-01`) — no Agent Control Protocol implementation exists in this codebase.
- **Browser/Playwright UI stability** (`WEB-STAB-*`) — `apps/web` is a static served dashboard, not a live React/Playwright-tested SPA; Wazir's only interactive surface is the Ink TUI, already covered by G8 and G13.
- **Recursive subagent delegation** (`SUB-DEL-*`, foreground/background child-agent spawning, recursion-depth limits) — Wazir's concurrency model is DAG/fleet orchestration (Tests 2, 5, 6, 7) and git-worktree isolation (Test 18, 40), not a parent-spawns-child agent pattern; porting `SUB-DEL-*` verbatim would describe a capability Wazir doesn't have.
- **Session-open/stream-reconnect/240-turn-fold browser benchmarks** (`BENCH-SESS-OPEN`, `BENCH-STREAM-RECON`, `BENCH-CONV-FOLD`, `BENCH-BROWSER-LONG`) — these assume a browser chat timeline replaying committed JSONL sessions; Wazir persists job/task state, not a browsable session timeline, so only the PTY and multi-turn analogs (Tests 43, 44) were ported.
- **Compaction rollback/reversion** (`SESS-CP-02`) — Wazir's compaction (`packages/agents/src/codingAgent.ts`) collapses turns into a lossy summary with no snapshot retained; there is no rollback mechanism to test. Test 39 instead verifies fidelity across repeated compaction rounds, the invariant Wazir's actual design can support.

---

## 9. Gate G15: Verification Integrity — Closing a Distinct Defect Class

Unlike G10–G14 (gaps found by walking a generic external scenario catalog), G15 was added by cross-referencing **Wazir's own observed verifier behavior in a real session** against how `deepseek-harness` and `opencode` solved the identical architectural problem in their own test suites. Four concrete defects were identified from an actual failed run (a stale build being trusted, a failed edit being recorded as a change, and a routine `make` invocation stalling on a five-minute approval timeout):

| # | Defect | Priority | Wazir Test | Reference Pattern | Grounding |
| :---: | :--- | :---: | :---: | :--- | :--- |
| 1 | Unproven / false-positive completion — the verifier accepted a self-report or a bare `filesChanged > 0` check instead of requiring executable evidence | P0 | Test 45 | deepseek-harness's "World Verification" invariant (`testing.md`) and Independent Workspace Oracle (`AGENTS.md`) — "verify the world, not the self-report" | `packages/evaluation/src/continuousVerification.ts` and `evaluateExecution()` (`packages/evaluation/src/index.ts`) drive completion off recorded checks/files-changed; no test today asserts completion is *refused* when a build has never actually passed for the current revision |
| 2 | Missing workspace-revision staleness invalidation — an edit made after the last passing build was never checked against, so stale evidence kept validating a changed workspace | P0 | Test 46 | deepseek-harness's Goal State Revision Fencing (`README.md`) — mutations require an exact `{id, revision}` reference; any intervening change increments the revision and invalidates older references | No revision-fencing concept exists in `packages/evaluation`/`packages/core` today — this test defines the target invariant |
| 3 | False `files-changed` event provenance — a failed edit (`oldString` not found) still emitted a files-changed event for the untouched file | P0 | Test 47 | opencode's edit-failure invariance tests (`edit.test.ts`) assert disk content is untouched and events only publish on the success branch; deepseek-harness derives changes from a git write-tree diff, never from tool-call arguments | Wazir's `edit` tool (`packages/tools/src/filesystem.ts`) already returns `ok:false` on a non-matching `oldString` without writing — this test closes the gap of asserting no files-changed event/revision bump follows a failure, the actual regression observed |
| 4 | Policy starvation of build tools — `make` was classified as requiring interactive human approval, stalling the agent for a five-minute timeout on an ordinary in-workspace build step | P1 | Test 48 | opencode's workspace-path-scoping tests (`shell.test.ts`) auto-approve commands confined to the project directory and only prompt when a path escapes it; deepseek-harness's sandbox permission presets auto-approve build tools (`make`, `cargo`, `ninja`) whose writes stay under `$CWD` | `packages/core/src/services/policyEngine.ts`'s `SAFE_SHELL_COMMANDS` allowlist covers compilers (`gcc`, `g++`, `clang`, ...) but not build-orchestration tools like `make`/`cmake`, which fall through to `shell-unknown-ask` and stall exactly as observed |

None of the specific competitor test files above (`invariant.spec.ts`, `edit.test.ts`, `snapshot-tool-race.test.ts`, `shell.test.ts`) exist in Wazir's own tree — they are `deepseek-harness`/`opencode` source, cited here only as the pattern reference. Tests 45–48's `associatedSuites` name Wazir's own existing and to-be-written suites instead.
