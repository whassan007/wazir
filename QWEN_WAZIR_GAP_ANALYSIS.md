# Qwen-Live-Harness vs. Wazir: Reuse Gap Analysis

This document provides a subsystem-by-subsystem gap analysis between **Qwen-Live-Harness** (`b6ce544ebbcd7417e37e0314ec946466c49c615c`) and **Wazir** (v0.1.55, `feat/qwen-live-harness-integration`).

---

## 1. Subsystem-by-Subsystem Comparison Matrix

| Capability | Qwen Implementation | Wazir Implementation | Reuse Approach | Priority |
| :--- | :--- | :--- | :--- | :--- |
| **Agent Delegation** | `AcpAdaptor` driving external ACP child processes over stdio (Qwen Code, Codex, Claude Code, Gemini CLI, Qoder) with turn queues, preemption protection, and mid-turn steer draining. | `JobOrchestrator` & `CodingAgent` execute local turns and steps; no client for external ACP agent processes. | **Adapt** `AcpAdaptor` into `@wazir/agents/src/acp`. | **Critical (P0)** |
| **ACP Integration** | Full JSON-RPC stdio client (`@agentclientprotocol/sdk`) with session multiplexing, capability negotiation, and authentication retry. | Legacy REST HTTP Agent Protocol stub in `apps/api/src/server.ts` (`/ap/v1`); no stdio JSON-RPC client or external agent adapter. | **Adopt** upstream ACP architecture and client SDK. Retain REST endpoints for backwards compatibility. | **Critical (P0)** |
| **Realtime Interaction** | DashScope WebSocket duplex audio/video streaming with VAD and audio resampler. | Request/response streaming SSE for text/code; no native realtime audio/video socket. | **Architecture Reuse** as optional provider adapter; keep local inference text-first. | **Medium (P2)** |
| **Audio/Video Capture** | macOS-specific Electron Host (`appshot.mm`, Web Audio Worklet). | None (headless server & CLI focus). | **Reject** macOS native capture; accept on-demand file/image path ingestion for multimodal analysis. | **Low (P3)** |
| **Visual Analysis** | `formatVisualAnalysis`, on-demand snapshot ingestion, base64 framing for vision-capable models. | Vision capabilities declared in `ModelCapabilities` (`packages/runtimes/interfaces`), but lacking standardized visual snapshot pre-processing. | **Adapt** upstream visual snapshot analysis utilities into `@wazir/runtimes`. | **Medium (P1)** |
| **Proactive Monitoring** | `ProactiveTaskManager` + `ProactiveScheduler` with cadence timers, hysteresis (awaiting false), and delivery invalidation. | Periodic canary checks (`CanaryService`), health probes (`healthDiagnostics.ts`), but no event-driven proactive agent supervisor. | **Adapt** upstream proactive scheduler to watch agent execution loops, detect stalls, and flag repeated failures. | **High (P1)** |
| **Long-Term Memory** | Multi-library `node:sqlite` store, hybrid BM25 + cosine vector retrieval, RRF scoring, time-decay boosting, and memory observer. | In-memory `EpisodicRecord` / `ProceduralRecipe` store (`packages/memory`); in-memory `SemanticIndexService` (`packages/core`). | **Adapt** upstream `node:sqlite` store and hybrid BM25/vector search into `@wazir/memory`. | **Critical (P0)** |
| **Background Tasks** | `SubagentsLedger` tracking task lifecycles (`queued` -> `interrupted`), bounded terminal history, and throttled UI snapshots. | `JobOrchestrator` queues jobs; lacks fine-grained subagent state machine, eviction fencing, and throttled client snapshots. | **Adapt** `SubagentsLedger` into `@wazir/core` and `@wazir/agents`. | **Critical (P0)** |
| **Permission Requests** | `PermissionBroker` with mode switching (`ask` vs `allow-all`), least-escalating option negotiation, token/secret redaction, and `important-operation` classification. | `ApprovalQueue` (`packages/core/src/approvalQueue.ts`) and `PolicyEngine`; lacks automated option negotiation, secret redaction, and shell AST safety classification. | **Adapt** `PermissionBroker` and `important-operation` classifier to augment Wazir's `PolicyEngine`. | **Critical (P0)** |
| **Agent Status Tracking** | `SubagentTask` model with activity logs, progress text, permissions, and delivery revisions. | Basic `JobStatus` (`PENDING`, `RUNNING`, `COMPLETED`, `FAILED`); lacks rich activity event streams and delivery confirmations. | **Adapt** upstream subagent activity and status types. | **High (P1)** |
| **Desktop Host** | macOS Electron app (`packages/qwen-live-harness-host`) with tray icon, floating overlay, and global shortcuts. | Cross-platform Ink-based Terminal UI (`apps/cli/src/tui`) and React Web Dashboard (`apps/web`). | **Reject** Electron host; mirror subagent view and permission controls in Wazir TUI and Web UI. | **Low (P3)** |
| **Tool Orchestration** | Tool handles, schema dispatcher, authoritative atomic tool receipts (`tool-receipt.ts`). | `ToolExecutor` and sandbox runner (`packages/tools`); lacks atomic proof-of-delivery receipts for idempotency. | **Direct Reuse** of upstream atomic tool receipt pattern. | **High (P1)** |
| **Error Recovery** | `RecoveringSession` exponential backoff, generation fencing, and state replay fences. | Checkpoint snapshots (`CheckpointService`), MCTS search recovery (`DistributedSearchCoordinator`). | **Reuse & Synthesize**: Combine Qwen's generation fences with Wazir's MCTS checkpoint recovery. | **High (P1)** |
| **Model Routing** | Fixed DashScope Qwen Omni Realtime endpoint + ACP backend delegation. | Sophisticated provider-agnostic runtime matrix (LM Studio, Ollama, OpenAI, Anthropic, Google) with capability-weighted scheduling (G61/G62). | **Preserve Wazir's superior architecture.** Add capability detection for realtime and vision. | **Preserve (P0)** |

---

## 2. Detailed Capability Evaluation (Questions 1 to 7)

### 1. Agent Delegation & ACP Integration
1. **Can Wazir reuse the upstream implementation directly?**  
   Partially. The core logic of `AcpAdaptor` can be adapted cleanly into `@wazir/agents`. It uses `@agentclientprotocol/sdk` and standard Node.js `child_process`.
2. **What is the minimum integration work?**  
   Add `@agentclientprotocol/sdk` to `@wazir/agents`, adapt `AcpAdaptor` into a Wazir `AgentRunner` / `ProtocolAdapter`, map ACP events to Wazir's canonical `ActionEnvelope`, and implement session lifecycle bindings.
3. **Would reuse introduce new dependencies or operational costs?**  
   Only `@agentclientprotocol/sdk` (lightweight, zero native bindings). No operational cost beyond the spawned agent child process.
4. **Does Wazir already implement a better alternative?**  
   No. Wazir only has internal model-tag parsers and an older HTTP REST stub. It cannot currently communicate with external ACP tools like Claude Code, Codex, or Gemini CLI.
5. **Can the upstream component remain independently upgradeable?**  
   Yes. It connects via the stable ACP specification (`PROTOCOL_VERSION`).
6. **Is the component suitable for local models?**  
   Yes! ACP agents (e.g. `qwen --acp`, local Codex adapters) run entirely on local stdio.
7. **What tests establish compatibility?**  
   Mock ACP agent tests verifying `initialize`, `session/new`, `session/prompt`, `session/request_permission`, preemption fences, cancellation, and error recovery.

### 2. Long-Term Memory (Persistent SQLite & Hybrid Retrieval)
1. **Can Wazir reuse the upstream implementation directly?**  
   Yes. Qwen's `MemoryStore` relies on Node 22's built-in `node:sqlite` (`DatabaseSync`), requiring zero external native binaries.
2. **What is the minimum integration work?**  
   Adapt `MemoryStore`, `retrieval.ts`, and `observer.ts` into `@wazir/memory` as `SqliteMemoryStore`, implementing Wazir's `MemoryService` interface.
3. **Would reuse introduce new dependencies or operational costs?**  
   Zero external dependencies. Extremely low memory overhead and fast local disk I/O.
4. **Does Wazir already implement a better alternative?**  
   No. Wazir's existing memory is strictly in-memory (data is lost upon process restart).
5. **Can the upstream component remain independently upgradeable?**  
   Yes. Schema migrations are managed via versioned schema definitions.
6. **Is the component suitable for local models?**  
   Yes, 100% offline, local SQLite database stored in `~/.wazir/memory/`.
7. **What tests establish compatibility?**  
   Unit tests for ACID persistence, concurrent reads/writes, schema creation, BM25 text queries, time-decay scoring, and deduplication.

### 3. Permission Broker & Important Operation Classifier
1. **Can Wazir reuse the upstream implementation directly?**  
   Yes. `important-operation.ts` and `adaptor-utils.ts` are pure functions with zero third-party dependencies. `PermissionBroker` needs only lightweight options wiring.
2. **What is the minimum integration work?**  
   Import `isImportantPermissionOperation`, `pickLeastEscalating`, and `redactPermissionText` into `@wazir/core`. Wire them into `PolicyEngine` and CLI execution loops.
3. **Would reuse introduce new dependencies or operational costs?**  
   Zero new dependencies. Zero runtime cost.
4. **Does Wazir already implement a better alternative?**  
   Wazir has policy rules, but lacks AST-based shell inspection for pipe/redirection hazards and automated least-escalating permission resolution.
5. **Can the upstream component remain independently upgradeable?**  
   Yes. Pure modular utilities.
6. **Is the component suitable for local models?**  
   Yes, completely local and deterministic.
7. **What tests establish compatibility?**  
   Test suites covering shell command classification (`pwd`/`ls`/`git status` allowed vs `rm -rf`, pipes, evaluations flagged as important), credential redaction, and approval resolution.

### 4. Subagent Ledger & Task Lifecycle Tracking
1. **Can Wazir reuse the upstream implementation directly?**  
   Yes. `SubagentsLedger` is a pure TypeScript state machine.
2. **What is the minimum integration work?**  
   Integrate `SubagentsLedger` into `@wazir/core` / `@wazir/agents`, connecting job dispatch and completion events to update ledger entries and emit snapshot diffs.
3. **Would reuse introduce new dependencies or operational costs?**  
   Zero dependencies. Bounded in-memory footprint (<240 KB per snapshot).
4. **Does Wazir already implement a better alternative?**  
   Wazir's `JobOrchestrator` manages top-level jobs, but has no subagent activity stream, event history ring buffer, or terminal eviction protection.
5. **Can the upstream component remain independently upgradeable?**  
   Yes.
6. **Is the component suitable for local models?**  
   Yes.
7. **What tests establish compatibility?**  
   State transition tests, duplicate eviction tests, bounded snapshot tests, and change subscriber tests.

### 5. Proactive Monitoring & Atomic Tool Receipts
1. **Can Wazir reuse the upstream implementation directly?**  
   `tool-receipt.ts` can be reused directly. `ProactiveTaskManager` and `scheduler.ts` adapt to monitor Wazir internal software events.
2. **What is the minimum integration work?**  
   Incorporate `ToolReceiptManager` to wrap tool outputs. Connect `ProactiveTaskManager` to monitor execution engine job states and trigger bounded repair interventions.
3. **Would reuse introduce new dependencies or operational costs?**  
   Zero dependencies.
4. **Does Wazir already implement a better alternative?**  
   Wazir has canary services and MCTS tree search, but lacks atomic idempotency receipts for tool retries.
5. **Can the upstream component remain independently upgradeable?**  
   Yes.
6. **Is the component suitable for local models?**  
   Yes.
7. **What tests establish compatibility?**  
   Atomic receipt validation tests, duplicate execution prevention tests, and proactive timer tests.

### 6. Desktop Host vs CLI/TUI
1. **Can Wazir reuse the upstream implementation directly?**  
   **No.** Upstream host is macOS Electron with Objective-C++ screenshot code (`appshot.mm`). Wazir is cross-platform, CLI/TUI-first, and server-capable.
2. **Reuse approach:** Reject direct Electron host integration. Replicate the Subagent View and Permission Dialog concepts into Wazir's cross-platform Ink TUI and React Web Dashboard.

---

## 3. Preservation of Wazir's Core Strengths

Wazir possesses several advanced capabilities that **must be preserved** and not replaced by upstream components:
1. **Progressive Acceptance Gates (G0 through G100):** The 47 progressive release gates and validation harness must remain authoritative.
2. **Provider-Agnostic Runtime Matrix:** Wazir's native support for LM Studio, Ollama, OpenAI, Anthropic, and Google with capacity-weighted scheduling (G61/G62) and straggler detection is far more flexible than Qwen's fixed DashScope endpoint.
3. **MCTS Solution Search & Canary Verification:** Wazir's Monte Carlo Tree Search (`SolutionSearchService`), distributed coordinator, and Canary Stage Advisor (`CanaryService`) are preserved as the primary reasoning and repair engine.
4. **Policy Engine Hardening:** Wazir's workspace isolation, worktree fences, and symlink protection remain active.
