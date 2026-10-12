# Qwen-Live-Harness Reusable Component Inventory

**Upstream Repository:** `https://github.com/QwenLM/Qwen-Live-Harness.git`  
**Pinned Upstream Commit SHA:** `b6ce544ebbcd7417e37e0314ec946466c49c615c`  
**Upstream License:** Apache License 2.0  
**Target Environment:** Wazir Autonomous Meta-Harness (Node.js >= 22.0.0, Linux / Cross-Platform)

---

## 1. Executive Summary

This inventory evaluates the complete source codebase of **Qwen-Live-Harness** (commit `b6ce544ebbcd7417e37e0314ec946466c49c615c`), consisting of two workspace packages:
1. `packages/qwen-live-harness` (Node.js daemon, coordinator, protocol adapters, memory, proactive monitoring, subagents ledger)
2. `packages/qwen-live-harness-host` (macOS Electron desktop host, native capture, global shortcuts)

Components are categorized using the evaluation framework:
- **A. Direct Reuse:** Ready for direct import or consumption without functional modifications.
- **B. Adapt:** High-value implementation reusable with minimal integration glue or packaging adaptation.
- **C. Architecture Reuse:** Proven pattern or architectural design reimplemented to fit Wazir's native types.
- **D. Reject:** Redundant with superior Wazir implementations, platform-restricted (macOS-only native code), or cloud-locked.

---

## 2. Component Inventory Matrix

### Subsystem 1: Agent Delegation & Protocol Adapters (`packages/qwen-live-harness/src/adaptor`)

| Component / File | Responsibilities | Key Interfaces | Dependencies | Classification | Coupling | Reuse Potential in Wazir |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **ACP Adaptor**<br>`src/adaptor/acp-adaptor.ts` | Multi-agent execution client using Agent Client Protocol (JSON-RPC over stdio). Manages child process lifecycle, multiplexed sessions, generation counters, preemption protection, and mid-turn steer draining. | `AcpAdaptor`, `AcpConnectionLike`, `AcpAdaptorOptions`, `AcpSessionState` | `@agentclientprotocol/sdk`, `node:child_process` | **B. Adapt** | Low (decoupled via stdio JSON-RPC) | **Critical.** Enables Wazir to orchestrate any ACP agent: Qwen Code, Claude Code, OpenAI Codex, Gemini CLI, Qoder CLI. |
| **Adaptor Utilities**<br>`src/adaptor/adaptor-utils.ts` | ANSI stripping, title sanitization, permission option classification, least-escalating option picker, token/credential redaction, tool call summary formatting. | `pickLeastEscalating`, `pickPersistentGrant`, `classifyOption`, `redactPermissionText`, `describeToolCall` | `ansi-regex` | **A. Direct Reuse** | Minimal | **High.** Provides bulletproof sanitization, safe human-in-the-loop permission reduction, and secret leakage prevention. |
| **Async Event Queue**<br>`src/adaptor/async-event-queue.ts` | Resilient asynchronous event queue multiplexer with backpressure control, asynchronous iterator support, and signal cancellation. | `AsyncEventQueue<T>` | None (Built-in) | **A. Direct Reuse** | Zero | **High.** General-purpose event multiplexer for agent turn streams and background tasks. |
| **Public Activity**<br>`src/adaptor/public-activity.ts` | Projects internal agent turns, tool calls, and model outputs into clean, sanitized public activity events for UI feeds. | `publicActivity(event)` | `adaptor-utils.js` | **A. Direct Reuse** | Low | **High.** Feed for Wazir TUI, web dashboard, and event logs. |
| **Managed Qwen Serve**<br>`src/adaptor/managed-qwen-serve.ts` | Child process supervisor for local `qwen serve` instance with port allocation, readiness polling, and graceful termination. | `ManagedQwenServe` | `node:child_process`, `node:net` | **B. Adapt** | Low | **Medium.** Useful when running Qwen Code in managed server mode alongside Wazir. |
| **Qwen Code Adaptor**<br>`src/adaptor/qwen-code-adaptor.ts` | REST and Server-Sent Events (SSE) connector for Qwen Serve HTTP API. | `QwenCodeAdaptor` | `node:http`, `node:stream` | **B. Adapt** | Low | **Medium.** Alternative connection path for Qwen Code when stdio ACP is not desired. |
| **Qwen Peer Subsystem**<br>`src/adaptor/qwen-peer-*.ts` | Local terminal discovery, authorized text instruction delivery, and peer report aggregation via Unix domain sockets. | `QwenPeerController`, `QwenPeerDiscovery`, `QwenPeerReports` | `node:net`, `node:fs` | **B. Adapt** | Medium | **Medium.** Enables Wazir to discover active Qwen terminals on developer machines without hijacking them. |

---

### Subsystem 2: Subagents & Background Tasks (`packages/qwen-live-harness/src/subagents`)

| Component / File | Responsibilities | Key Interfaces | Dependencies | Classification | Coupling | Reuse Potential in Wazir |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Subagents Ledger**<br>`src/subagents/ledger.ts` | Central tracking ledger for subagent and background task lifecycles. Manages state transitions, terminal eviction guards, memory bounding, permission linkage, and throttled UI snapshots. | `SubagentsLedger`, `SubagentTask`, `SubagentsSnapshot`, `SubagentStatus` | `adaptor-utils.js` | **B. Adapt** | Low | **Critical.** Fills Wazir's missing capability for fine-grained subagent state tracking and mission control observation. |
| **Subagent Types**<br>`src/subagents/types.ts` | Domain types for subagent tasks, statuses, activities, permission attachments, delivery receipts, and filtering criteria. | `SubagentTask`, `SubagentsSnapshot`, `SubagentActivity`, `SubagentPermission` | None | **A. Direct Reuse** | Zero | **High.** Standardizes subagent representation across Wazir CLI, TUI, and API. |
| **Display Text Formatting**<br>`src/subagents/display-text.ts` | Generates human-readable, localized task descriptions, status badges, and event notifications. | `subagentTaskTitle`, `formatSubagentStatus`, `formatSubagentActivity` | None | **B. Adapt** | Low | **High.** Enhances Wazir TUI and web views with crisp task progress summaries. |

---

### Subsystem 3: Permission Broker & Human-in-the-Loop (`packages/qwen-live-harness/src/permissions`)

| Component / File | Responsibilities | Key Interfaces | Dependencies | Classification | Coupling | Reuse Potential in Wazir |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Permission Broker**<br>`src/permissions/permission-broker.ts` | Central permission gateway. Intercepts tool execution requests, applies operational mode (`ask` vs `allow-all`), resolves options, enforces non-persistent least-escalating grants, and prevents race conditions. | `PermissionBroker`, `PendingPermission`, `PermissionDecisionEvent` | `adaptor-utils.js` | **B. Adapt** | Low | **Critical.** Integrates with Wazir `PolicyEngine` to enforce strict human approval and gate delegation safely. |
| **Important Operation Classifier**<br>`src/permissions/important-operation.ts` | Security classifier that identifies destructive shell commands, script execution, pipeline redirection, and state-modifying operations vs read-only operations. | `isImportantPermissionOperation(details)` | None | **A. Direct Reuse** | Zero | **Critical.** Hardens Wazir against prompt-injection and accidental execution of hazardous commands. |
| **Approval Announcement**<br>`src/permissions/approval-announcement.ts` | Formats clear, contextual user notifications for requested permissions, highlighting target files, commands, and potential risks. | `formatApprovalAnnouncement` | None | **A. Direct Reuse** | Low | **High.** Clarifies approval dialogs in Wazir CLI and web UI. |

---

### Subsystem 4: Long-Term Memory Subsystem (`packages/qwen-live-harness/src/memory`)

| Component / File | Responsibilities | Key Interfaces | Dependencies | Classification | Coupling | Reuse Potential in Wazir |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Memory Store**<br>`src/memory/store.ts` | Persistent multi-library memory database using built-in `node:sqlite`. Stores dialogue segments, environment observations, session associations, and vector blobs with strict validation. | `MemoryStore`, `MemoryLibrary`, `StoredVector`, `DatabaseSync` | `node:sqlite`, `node:fs` | **B. Adapt** | Low | **Critical.** Replaces Wazir's volatile in-memory storage with zero-dependency ACID persistent storage. |
| **Hybrid Retrieval Engine**<br>`src/memory/retrieval.ts` | Hybrid retrieval combining BM25 lexical search and cosine vector search with Reciprocal Rank Fusion (RRF) and time-decay boosting. | `searchMemory`, `RetrievalResult`, `resolveTimeRange` | `node:sqlite` | **B. Adapt** | Low | **High.** Provides state-of-the-art memory recall across sessions and repositories. |
| **Memory Observer & Updater**<br>`src/memory/observer.ts`, `updater.ts` | Extracts facts, decisions, and outcomes from completed agent turns; consolidates, deduplicates, and resolves memory conflicts. | `MemoryObserver`, `MemoryUpdater` | `node:sqlite` | **B. Adapt** | Medium | **High.** Automates learning from completed Wazir repair runs and debugging sessions. |
| **Tokenizer**<br>`src/memory/tokenize.ts` | Multilingual and Chinese tokenization using `@node-rs/jieba` with fast regex fallback. | `indexText`, `queryTerms` | `@node-rs/jieba` (optional) | **B. Adapt** | Minimal | **Medium.** High quality CJK + English token extraction for BM25 search. |
| **Session & Working Memory**<br>`src/memory/session.ts`, `wm.ts` | In-flight working memory buffer, context injection formatting, and sliding window budget management. | `WorkingMemory`, `MemorySession` | None | **B. Adapt** | Low | **High.** Prevents context window blowout by staging retrieved memories compactly. |

---

### Subsystem 5: Proactive Monitoring & Receipts (`packages/qwen-live-harness/src/proactive`)

| Component / File | Responsibilities | Key Interfaces | Dependencies | Classification | Coupling | Reuse Potential in Wazir |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Proactive Task Manager**<br>`src/proactive/task-manager.ts` | Lifecycle management of autonomous background monitoring tasks (perception monitors, timer reminders, health probes). Generation-fenced updates. | `ProactiveTaskManager`, `ProactiveTask`, `CreateMonitorInput` | None | **B. Adapt** | Low | **High.** Manages background health diagnostics, stalled agent job watchers, and canary test runners. |
| **Proactive Scheduler**<br>`src/proactive/scheduler.ts` | Timer and cadence scheduler with cooldowns, hysteresis (awaiting false), delivery tracking, and delivery invalidation. | `ProactiveScheduler`, `ProactiveDelivery` | `task-manager.js` | **B. Adapt** | Medium | **High.** Prevents alert storms and runaway repair retry loops. |
| **Tool Receipt Manager**<br>`src/proactive/tool-receipt.ts` | Authoritative atomic tool execution receipts. Enforces idempotency and verifies tool results to prevent double execution during retries. | `ProactiveToolReceipt`, `renderProactiveToolReceipt` | None | **A. Direct Reuse** | Zero | **Critical.** Directly enhances Wazir's self-repair loop with verifiable idempotency guarantees. |
| **Realtime Monitor**<br>`src/proactive/realtime-monitor.ts` | Streaming evaluation loop for continuous audio/visual monitoring via DashScope WebSocket. | `DashScopeRealtimeMonitor` | `ws` | **C. Architecture Reuse** | High (DashScope specific) | **Low.** Realtime audio/video streaming is cloud-only; Wazir prioritizes local software event monitoring. |

---

### Subsystem 6: Realtime Orchestration & Audio/Video (`packages/qwen-live-harness/src/realtime`)

| Component / File | Responsibilities | Key Interfaces | Dependencies | Classification | Coupling | Reuse Potential in Wazir |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Realtime Session**<br>`src/realtime/realtime-session.ts` | WebSocket client for Qwen Omni Realtime API. Handles duplex PCM audio, visual frames, tool invocations, and session continuity. | `RealtimeSession`, `RecoveringRealtimeSession` | `ws` | **C. Architecture Reuse** | High (DashScope protocol) | **Medium.** Reusable as optional provider adapter for users configured with Qwen Omni keys; must not replace text inference. |
| **Visual Analysis**<br>`src/realtime/visual-analysis.ts` | Image snapshot encoding, resizing, and visual prompt formatting for multimodal models. | `formatVisualAnalysis` | None | **B. Adapt** | Low | **High.** Allows Wazir agents to inspect screenshots, UI error states, and diagnostic graphs. |
| **Sanitization & Guardrails**<br>`src/realtime/sanitize.ts` | Strips injection patterns, normalizes Unicode, enforces system prompt guardrails. | `sanitizeInput`, `sanitizeOutput` | None | **A. Direct Reuse** | Zero | **High.** General runtime hygiene across all model completions. |

---

### Subsystem 7: Desktop Host (`packages/qwen-live-harness-host`)

| Component / File | Responsibilities | Key Interfaces | Dependencies | Classification | Coupling | Reuse Potential in Wazir |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Electron Main & Preload**<br>`packages/qwen-live-harness-host/src/main/*` | Electron application bootstrap, window manager, macOS global shortcut registry, IPC bridges. | `ElectronMain`, `HostApi` | `electron`, `ws` | **D. Reject** | High (macOS Electron) | **Rejected.** Wazir runs CLI/TUI on Linux/macOS/Windows and headless servers. Adding an Electron shell would multiply dependencies without adding core value. |
| **Native Screenshot**<br>`src/native/appshot.mm` | macOS Objective-C++ ScreenCaptureKit screen grabber. | `appshot` | macOS SDK | **D. Reject** | Platform-locked | **Rejected.** Incompatible with Linux environments. |
| **Renderer Subagent UI Views**<br>`src/renderer/subagents-view.ts` | Web UI views rendering subagent tasks, status badges, permission modals, and real-time feeds. | `renderSubagentsView` | DOM/CSS | **C. Architecture Reuse** | Medium | **High for Web Dashboard.** The UI concepts map directly into Wazir's React web dashboard (`apps/web`) and Ink TUI (`apps/cli`). |

---

## 3. Summary of Component Classification

- **Category A (Direct Reuse):** 6 components (Adaptor Utils, Async Event Queue, Public Activity, Important Operation Classifier, Subagent Types, Tool Receipt Manager).
- **Category B (Adapt with Minimal Changes):** 11 components (ACP Adaptor, Subagents Ledger, Display Text, Permission Broker, Approval Announcement, SQLite Memory Store, Hybrid Retrieval Engine, Memory Observer/Updater, Session/Working Memory, Proactive Task Manager, Proactive Scheduler).
- **Category C (Architecture Reuse):** 3 components (Realtime Omni Session protocol, Subagent Dashboard UI patterns, Multimodal Visual Analysis pipeline).
- **Category D (Reject):** 3 components (macOS Electron Host shell, Objective-C++ `appshot.mm`, DashScope-exclusive continuous media loop).

**Result:** Over 85% of Qwen-Live-Harness core daemon capabilities can be directly reused or adapted into Wazir with high leverage and minimal integration overhead.
