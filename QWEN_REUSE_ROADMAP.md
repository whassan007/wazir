# Qwen-Live-Harness Reuse Roadmap for Wazir

This roadmap outlines the prioritized integration plan for incorporating upstream capabilities from **Qwen-Live-Harness** into **Wazir**.

---

## 1. Prioritization Methodology

Candidates are prioritized using the objective quantitative scoring formula:

$$\text{Priority Score} = \frac{\text{Capability Improvement (1–10)} \times \text{Reuse Feasibility (1–10)} \times \text{Reliability Gain (1–10)}}{\text{Integration Effort (1–10)} + \text{Maintenance Burden (1–10)} + \text{Operational Risk (1–10)}}$$

### Normalized Scoring Table

| Rank | Candidate Integration | Improvement | Feasibility | Reliability | Effort | Maint. | Risk | Score | Implementation Phase |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **1** | **Subagents Ledger & Lifecycle State Machine** | 9 | 10 | 9 | 2 | 2 | 1 | **162.0** | **Phase 1 (Immediate)** |
| **2** | **Permission Broker & Operation Risk Classifier** | 9 | 10 | 9 | 2 | 2 | 1 | **162.0** | **Phase 1 (Immediate)** |
| **3** | **ACP Client Adapter (External Agent Delegation)** | 10 | 9 | 9 | 3 | 2 | 2 | **115.7** | **Phase 2 (Core Adapter)** |
| **4** | **Authoritative Tool Receipts (Idempotency)** | 8 | 9 | 9 | 2 | 2 | 1 | **129.6** | **Phase 2 (Core Adapter)** |
| **5** | **Persistent SQLite Memory & Hybrid Retrieval** | 9 | 8 | 8 | 4 | 3 | 2 | **64.0** | **Phase 3 (Persistence)** |
| **6** | **Proactive Background Task Manager & Scheduler** | 8 | 8 | 8 | 3 | 3 | 2 | **64.0** | **Phase 3 (Persistence)** |
| **7** | **Multimodal Snapshot Analysis Utility** | 7 | 8 | 7 | 3 | 2 | 2 | **56.0** | **Phase 4 (Expansion)** |
| **8** | **Qwen Code Peer Protocol Client** | 6 | 7 | 6 | 4 | 3 | 2 | **28.0** | **Phase 4 (Expansion)** |
| **9** | **Electron Host Desktop Shell** | 4 | 2 | 3 | 9 | 9 | 8 | **0.9** | **Rejected** |

---

## 2. Phased Implementation Roadmap

### Phase 1: Operational Safety, Visibility & Ledger (Target: Immediate)
**Focus:** Non-invasive, high-impact core utilities for subagent tracking and permission safety.

1. **Subagents Ledger Integration (`@wazir/core/src/subagents`)**
   - Adapt `SubagentsLedger`, `SubagentTask`, `SubagentsSnapshot`, and `display-text`.
   - Implement bounded ring buffer for activity history, terminal state eviction protections, and throttled snapshot emissions.
   - *Acceptance Criteria:*
     - All 10 subagent status transitions properly enforced (`queued` through `interrupted`).
     - Terminal eviction prevents duplicate state replays.
     - Snapshot serialization conforms to `< 240 KB` constraint.

2. **Permission Broker & Important Operation Classifier (`@wazir/core/src/permissions`)**
   - Adapt `PermissionBroker`, `isImportantPermissionOperation`, `pickLeastEscalating`, and `redactPermissionText`.
   - Wire into Wazir `PolicyEngine` to intercept tool execution requests.
   - *Acceptance Criteria:*
     - Safe read-only commands (`pwd`, `ls`, `git status`, `git diff`) pass without unnecessary prompts.
     - Destructive commands, shell redirects, pipes, and file edits are classified as `important`.
     - Credentials (Bearer tokens, AWS keys, passwords) are automatically redacted from approval dialogues and logs.

---

### Phase 2: Interoperable ACP Delegation & Tool Idempotency (Target: Core Adapter)
**Focus:** Connect Wazir to external autonomous coding agents via Agent Client Protocol (ACP).

1. **ACP Client Adapter (`@wazir/agents/src/acp`)**
   - Implement `AcpClientAdapter` wrapping `@agentclientprotocol/sdk`.
   - Multiplex sessions over a single stdio child process per agent backend.
   - Implement preemption safety latch (`sendPromptNow`) and queued prompt buffers.
   - Wire steer queue draining (`craft/drainMidTurnQueue`) and permission forwarding.
   - *Acceptance Criteria:*
     - Successful handshake and session creation with ACP agents (e.g. Qwen Code, Claude Code, Codex).
     - Concurrent prompt calls queue safely without aborting active turns.
     - Process exit/crash triggers clean generation increment and session recovery.

2. **Authoritative Tool Receipts (`@wazir/core/src/proactive`)**
   - Implement `ToolReceiptManager` and `ProactiveToolReceipt` generation.
   - Enforce atomic commit and idempotency hashing on tool outputs.
   - *Acceptance Criteria:*
     - Retrying an identical tool call returns the cached authoritative receipt with zero duplicate side-effects.

---

### Phase 3: Persistent Multi-Library Memory & Proactive Monitoring (Target: Storage & Health)
**Focus:** Production-grade persistence and self-monitoring agent loops.

1. **Persistent SQLite Memory Store (`@wazir/memory/src/sqlite`)**
   - Adapt `MemoryStore` using built-in `node:sqlite` (`DatabaseSync`).
   - Implement schema migrations, multi-library support, and segment indexing.
   - Implement hybrid BM25 + cosine vector retrieval with Reciprocal Rank Fusion.
   - *Acceptance Criteria:*
     - Data persists across process restarts in `~/.wazir/memory/`.
     - Zero native compilation dependencies (100% pure Node.js 22 built-in).
     - BM25 retrieval correctly scores keyword matches with time-decay recency weighting.

2. **Proactive Task Manager & Hysteresis Scheduler (`@wazir/core/src/proactive`)**
   - Adapt `ProactiveTaskManager` and `ProactiveScheduler`.
   - Monitor agent loop stalls, repetitive repair failures, and disconnected runtimes.
   - *Acceptance Criteria:*
     - Awaiting false hysteresis prevents alert flooding when an error persists.
     - Stalled agent detection triggers bounded repair escalation.

---

### Phase 4: Multimodal Analysis & Terminal Peer Integration (Target: Future Expansion)
**Focus:** Visual context and local terminal discovery.

1. **Visual Analysis Utilities (`@wazir/runtimes`)**
   - Add image snapshot pre-processing and multimodal prompt formatting for vision models.
2. **Qwen Terminal Peer Discovery**
   - Support optional discovery of existing Qwen Code terminal sessions via local Unix sockets.
