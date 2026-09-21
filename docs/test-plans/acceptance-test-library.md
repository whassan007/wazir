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

---

## 2. Progressive Release Gates

The suite is organized into **10 progressive release gates (G0 through G9)**. Releases must satisfy gates sequentially:

```text
G0 Protocol  ──→  G1 Runtime  ──→  G2 Agent  ──→  G3 Routing  ──→  G4 Fleet
     │
     └──→  G5 Multi-Agent  ──→  G6 Governance  ──→  G7 Resilience  ──→  G8 Terminal  ──→  G9 Golden
                                                                                               │
                                                                                       ★ WAZIR READY ★
```

### Strict Progression Rule
> **A later gate CANNOT compensate for an earlier prerequisite gate.**
> If workspace persistence or isolation fails in G1, for example, a successful multi-agent demonstration in G5 is irrelevant and the release is marked **NOT READY**.

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

## 4. Test Catalog Matrix (30 Use Cases)

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

---

## 5. Executable Test Harness Usage

The test harness is implemented in [`scripts/acceptance-test-harness.mjs`](file:///home/wael/Code/Wazir/scripts/acceptance-test-harness.mjs) and registered in `package.json`.

```bash
# 1. Run the foundational sequence (recommended first check)
npm run test:acceptance -- --foundational

# 2. Run a specific release gate (e.g. G0, G1, ... G9)
npm run test:acceptance -- --gate G0
npm run test:acceptance -- --gate G1

# 3. Run a specific acceptance test by ID (1..30)
npm run test:acceptance -- --test 20
npm run test:acceptance -- --test 27

# 4. Run the entire acceptance suite across all 10 gates (fail-fast rule)
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
- **Option 2:** Target Release Gate (`G0 Protocol` through `G9 Golden`)
- **Option 3:** Specific Acceptance Test (`Test 1` through `Test 30`)
- **Option 4:** Full Progressive Acceptance Suite (`G0` through `G9` with strict fail-fast enforcement)
- **Option 5:** Live Model Runtime Probe (LM Studio & Ollama)

---

## 7. Artifacts & Reporting

Every harness run emits a structured report to `acceptance-test-report.json`:
- Timestamp, Wazir version, and execution mode (`deterministic` or `live`).
- Gate summary table with pass/fail counts.
- Case-by-case execution table with durations, assertion counts, and error details.
- Clear release verdict:
  - `★ RELEASE VERDICT: WAZIR READY FOR RELEASE ★`
  - `✖ RELEASE VERDICT: WAZIR NOT READY FOR RELEASE ✖` (listing blocking P0 failures).
