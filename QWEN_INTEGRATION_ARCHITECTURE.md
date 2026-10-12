# Qwen-Live-Harness Integration Architecture for Wazir

This document defines the architectural integration of production-grade components adapted from **Qwen-Live-Harness** into **Wazir**.

---

## 1. System Context & Component Boundaries

The integration preserves Wazir's model- and runtime-agnostic meta-harness architecture while infusing Qwen's protocol interoperability, subagent visibility, permission brokering, and persistent memory.

```mermaid
flowchart TD
  subgraph User_Interfaces["User Interfaces"]
    cli["Wazir CLI / TUI"]
    web["Web Dashboard (React)"]
    api["Wazir API Server (REST/SSE)"]
  end

  subgraph Core_Orchestrator["Wazir Core Meta-Harness"]
    engine["ExecutionEngine / Planner"]
    search["SolutionSearchService (MCTS)"]
    policy["PolicyEngine & Sandboxing"]
    ledger["SubagentsLedger (Adapted)"]
    broker["PermissionBroker (Adapted)"]
    proactive["ProactiveTaskManager (Adapted)"]
    receipts["ToolReceiptManager (Adapted)"]
  end

  subgraph Subagent_Execution["Agent & Execution Layer"]
    nativeAgent["Wazir Native CodingAgent"]
    acpClient["AcpClientAdapter (Adapted)"]
  end

  subgraph External_ACP_Agents["External ACP Agents (Stdio JSON-RPC)"]
    qwenCode["Qwen Code (`qwen --acp`)"]
    claudeCode["Claude Code (`claude-code-acp`)"]
    codex["OpenAI Codex (`codex-acp`)"]
    geminiCli["Gemini CLI (`gemini --acp`)"]
  end

  subgraph Memory_Layer["Memory & Storage Layer"]
    memStore["SqliteMemoryStore (node:sqlite)"]
    retrieval["Hybrid BM25 + Vector Retrieval"]
    checkpoints["CheckpointService"]
  end

  subgraph Model_Runtimes["Model Runtimes"]
    lmstudio["LM Studio (Local)"]
    ollama["Ollama (Local)"]
    openai["OpenAI / Open-Router"]
    anthropic["Anthropic Claude"]
    google["Google Gemini"]
    qwenOmni["Qwen Omni Realtime (Optional)"]
  end

  User_Interfaces --> engine
  engine --> search
  engine --> policy
  policy --> broker
  engine --> ledger
  engine --> proactive
  engine --> receipts
  engine --> nativeAgent
  engine --> acpClient

  acpClient <-->|ACP JSON-RPC| External_ACP_Agents
  nativeAgent --> Model_Runtimes
  engine --> memStore
  memStore --> retrieval
  engine --> checkpoints
```

---

## 2. Subsystem Integrations

### A. ACP Agent Client Integration (`@wazir/agents/src/acp`)

Wazir can delegate tasks to any external autonomous agent supporting the standard Agent Client Protocol (ACP) over stdio:

```mermaid
sequenceDiagram
  autonumber
  participant Wazir as Wazir Orchestrator
  participant ACP as AcpClientAdapter
  participant Agent as External ACP Agent (Child Process)
  participant Policy as PermissionBroker / PolicyEngine

  Wazir->>ACP: delegateTask(prompt, cwd, mode)
  ACP->>Agent: spawn stdio & initialize(clientCapabilities)
  Agent-->>ACP: initialized(agentCapabilities)
  ACP->>Agent: session/new({ cwd })
  Agent-->>ACP: { sessionId, availableModes }
  ACP->>Agent: session/prompt({ sessionId, prompt })
  
  loop Execution Turn
    Agent->>ACP: session/update (tool call / activity)
    ACP->>Wazir: updateSubagentLedger(activity)
    opt Permission Request
      Agent->>ACP: session/request_permission({ options, details })
      ACP->>Policy: evaluatePermission(request)
      Policy-->>ACP: permissionDecision('allow' | 'deny')
      ACP->>Agent: respondPermission({ outcome: 'selected', optionId })
    end
  end

  Agent-->>ACP: prompt completed ({ stopReason: 'end_turn' })
  ACP-->>Wazir: TaskCompleted(result, receipts)
```

**Key Architectural Invariants:**
1. **Preemption Safety:** `AcpClientAdapter` enforces a strict one-turn-in-flight latch (`sendPromptNow`). Successive tasks are queued (`pendingPrompts`) rather than aborting active turns.
2. **Steer Mid-Turn Draining:** For agents supporting mid-turn guidance (`craft/drainMidTurnQueue`), steer instructions are delivered synchronously without breaking current execution.
3. **Graceful Subprocess Lifecycle:** Spawns child processes with isolated pipes, generation counters to fence stale sessions, and SIGTERM/SIGKILL escalation deadlines.

---

### B. Subagents Ledger & Lifecycle Management (`@wazir/core/src/subagents`)

The `SubagentsLedger` maintains an in-memory, bounded, authoritative state machine for all background jobs, canary evaluations, and subagent sessions.

```mermaid
stateDiagram-v2
  [*] --> queued: Enqueued
  queued --> starting: Worker / Agent Spawning
  starting --> running: Prompt Accepted
  running --> monitoring: Background Monitoring
  running --> waiting: Awaiting User Permission
  waiting --> running: Permission Granted
  running --> delivering: Result Serialization
  delivering --> completed: Verified by Evidence
  
  running --> failed: Execution / Gate Failure
  running --> cancelled: User / Controller Cancel
  running --> interrupted: Subprocess Crash / Timeout

  completed --> [*]
  failed --> [*]
  cancelled --> [*]
  interrupted --> [*]
```

**Key Architectural Invariants:**
1. **Bounded Memory:** Enforces `MAX_SUBAGENT_TASKS = 32`, `MAX_TERMINAL_DETAILS = 32`, and a maximum snapshot payload size of 240 KB to prevent memory leaks in long-running daemons.
2. **Eviction Fencing:** Retains terminal counts while evicting details; prevents re-entry or double counting if stale terminal events arrive.
3. **Throttled Snapshots:** Debounces high-frequency activity updates, notifying UI subscribers at bounded rates (e.g. 50ms) to ensure butter-smooth rendering.

---

### C. Permission Broker & AST Operation Classifier (`@wazir/core/src/permissions`)

The `PermissionBroker` acts as an intelligent intermediary between autonomous agents and Wazir's `PolicyEngine`:

```mermaid
flowchart TD
  req["Agent Requests Tool Execution"] --> inspect["isImportantPermissionOperation(details)"]
  inspect -->|Safe: pwd, ls, git log/status/diff, read| autoAllow["Safe Operation Check"]
  inspect -->|Important: bash scripts, rm, git push, net, mutations| classify["Classify Risk & Mode"]
  
  classify --> mode{"Broker Mode"}
  mode -->|"allow-all"| grantAuto["Issue Auto-Grant (Audit Logged)"]
  mode -->|"ask"| redact["Redact Credentials & Tokens"]
  
  redact --> present["Format Human Announcement"]
  present --> waitDecision["Wait for Operator Decision (UI / CLI)"]
  waitDecision --> pickOption["pickLeastEscalating(options, wanted)"]
  pickOption --> reply["Respond to Agent with OptionId"]
```

**Key Architectural Invariants:**
1. **Least-Escalating Preference:** When resolving approvals, the broker selects the least-escalating option offered by the agent (e.g. single execution over permanent grants unless explicit).
2. **Deterministic Redaction:** Strips API tokens, private keys, and passwords before presenting approval requests to the user or logging.
3. **AST Command Filtering:** Inspects shell command structures, flagging any commands containing semicolons, pipes, redirects, or variable expansions as dangerous regardless of the command name.

---

### D. Multi-Library SQLite Memory Subsystem (`@wazir/memory`)

Wazir integrates Qwen's persistent SQLite memory engine using Node.js 22 built-in `node:sqlite`:

```mermaid
flowchart LR
  subgraph Storage_Engine["Local SQLite Database (~/.wazir/memory/)"]
    libs["libraries (version, id, name)"]
    dialogue["dialogue_segments (turn_id, speaker, text, timestamp)"]
    env["env_observations (scope, observation, evidence)"]
    vectors["stored_vectors (ref_id, float32_blob)"]
  end

  subgraph Retrieval_Pipeline["Hybrid Retrieval Pipeline"]
    query["User / Agent Query"]
    bm25["BM25 Lexical Scorer (Multilingual Tokenizer)"]
    cosine["Cosine Vector Similarity"]
    rrf["Reciprocal Rank Fusion (RRF)"]
    timeDecay["Time-Decay & Epoch Boosting"]
    ranked["Top-K Relevant Segments"]
  end

  query --> bm25
  query --> cosine
  libs --> dialogue
  dialogue --> bm25
  vectors --> cosine
  bm25 --> rrf
  cosine --> rrf
  rrf --> timeDecay
  timeDecay --> ranked
```

**Key Architectural Invariants:**
1. **Zero External Native Dependencies:** Uses Node.js 22's native `DatabaseSync` (`node:sqlite`), eliminating native compilation issues, node-gyp failures, and platform incompatibilities.
2. **ACID Transactions:** Full write-ahead logging (WAL), fsync durability, and strict schema versioning.
3. **Hybrid Search:** Combines BM25 keyword matching with dense embedding cosine similarity, fused via RRF, weighted with time recency decay.

---

### E. Proactive Task Manager & Atomic Tool Receipts (`@wazir/core/src/proactive`)

Connects background health monitoring with tool execution idempotency:

```mermaid
flowchart TD
  toolCall["Agent Invokes Tool (e.g. patch, runTests, deploy)"]
  receiptMgr["ToolReceiptManager"]
  idempotency{"Idempotency Key / Fingerprint"}
  
  toolCall --> receiptMgr
  receiptMgr --> idempotency
  idempotency -->|Already Executed & Valid| cachedReceipt["Return Authoritative Receipt (No-Op)"]
  idempotency -->|New Mutation| execute["Execute Tool in Sandbox"]
  
  execute --> verify["Collect Execution Evidence"]
  verify --> commitReceipt["Commit Atomic Tool Receipt"]
  commitReceipt --> publish["Return Result to Agent"]
```

**Key Architectural Invariants:**
1. **Idempotency Guarantees:** Ensures that agent retry loops cannot execute duplicate side-effects (e.g., re-applying patches, duplicating git commits, or double-allocating resources).
2. **Atomic Receipts:** Every tool operation yields a structured `ProactiveToolReceipt` containing operation type, active task snapshot, and authoritative outcome.
3. **Hysteresis Scheduling:** Proactive background monitors require an "awaiting false" state transition before re-alerting, preventing notification cascades.
