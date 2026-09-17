# Wazir: Features and Ecosystem Comparison
*(Comparison with OpenCode, Antigravity, and Codex)*

---

## 1. Overview of Wazir

**Wazir** is an open-source, local-first **AI Meta-Harness and Distributed Control Plane**. Rather than functioning merely as a standalone coding agent or model runner, Wazir operates as an orchestration layer above them: it manages and schedules tasks across multiple AI runtimes, models, developer tools, and heterogeneous target machines (such as local MacBooks, DGX servers, and remote workstation nodes).

### Architecture Flow

```
                    WAZIR META-HARNESS
                            │
                       Task Engine
                            │
                      Policy Engine (Security, Local-Only, Tool Boundaries)
                            │
               Capability Matching & Model Router
                            │
            Distributed Scheduler (Hardware, VRAM, Load)
                            │
             ┌──────────────┴──────────────┐
       Target Computer 1              Target Computer 2 (DGX / Worker)
             │                              │
      Runtime Adapter (Ollama/LM Studio)    Runtime Adapter
             │                              │
    Agent: native CodingAgent, or        Agent: native CodingAgent, or
    OpenCode (`--agent opencode`)        OpenCode (`--agent opencode`)
```

Agent choice is per-task, not per-computer: `--agent opencode` opts a task into
running through the installed `opencode` CLI as its reasoning loop instead of
the native agent, on whichever computer the Scheduler places it on.

---

## 2. Key Features of Wazir

1. **Meta-Harness & Control Plane Architecture**:
   - Decouples task definitions, safety policies, model routing, runtime adapters, and physical execution targets.
   - Core pipeline: `Task` $\rightarrow$ `Requirements` $\rightarrow$ `Policy Engine` $\rightarrow$ `Capability Matching` $\rightarrow$ `Scheduler` $\rightarrow$ `Runtime Adapter` $\rightarrow$ `Target Computer / Worker`.

2. **Distributed & Hardware-Aware Scheduling**:
   - Manages a pool of target computers executing worker agent daemons.
   - Dynamically selects target computers based on hardware specs (VRAM, system RAM, GPU capabilities, platform architecture) and real-time load.
   - Generates transparent, explainable scheduling decisions.

3. **Runtime-Agnostic Model Routing**:
   - Implements a standardized `RuntimeAdapter` interface.
   - Out-of-the-box support for local runtimes **Ollama** and **LM Studio**. The `RuntimeAdapter` interface is provider-agnostic, but no OpenAI-compatible adapter exists yet.
   - Features dynamic model discovery, health checks, and fallback mechanisms.

4. **Strict Policy Engine & Sandboxing**:
   - **Three-Tier Tool Authorization**:
     - `safe`: Auto-allowed (e.g., read-only shell commands, inspection tools).
     - `ask`: Interactive user confirmation required (e.g., file edits, write commands).
     - `deny`: Hard blocked (e.g., `sudo`, destructive system calls, forced git pushes).
   - Filesystem boundary enforcement restricts operations to project roots.
   - **Local-Only Guarantee**: Policy constraints enforce that sensitive code and data never leave local hardware.

5. **Dual-Agent Execution Paradigm**:
   - **Native Coding Agent**: Built-in turn-based agent loop with test/lint/typecheck repair cycles and configurable limits (`maxTurns`, `maxRepairCycles`).
   - **External Agent Adapter (`externalAgent.ts`)**: Invokes an external CLI harness — currently **OpenCode**, auto-detected on `PATH` — as the reasoning engine for a task that explicitly opts in via `--agent opencode`, while Wazir retains control-plane governance, scheduling, and logging. Never auto-selected, so installing OpenCode can't silently change where an un-pinned task lands.

6. **Model Context Protocol (MCP) — policy only, not yet wired**:
   - `MCPClient` is implemented (`packages/core/src/services/mcpClient.ts`) but nothing in the task-execution path calls it yet. The only real MCP behavior today is that unapproved MCP servers are denied by the policy engine's `allowedMcpServers` list — no task can currently reach an actual MCP server through it.

7. **Multi-Interface Delivery**:
   - Accessible via Command Line Interface (CLI: `wa ask`, `wa task plan`), REST API server, Web UI, and packaged desktop builds (macOS DMG).

---

## 3. Comparative Analysis

- **Wazir vs. OpenCode**:
  OpenCode is a terminal-based coding agent focused on multi-provider LLM coding assistance and autonomous code modification. Wazir operates at a higher abstraction level: a task can opt into running OpenCode as its reasoning engine (`--agent opencode`) while Wazir still handles cluster routing, hardware resource allocation, and policy — or it can use Wazir's own native coding agent instead.

- **Wazir vs. Antigravity (Google DeepMind)**:
  Antigravity is an enterprise-grade agentic development platform integrating deeply with IDEs, terminal workflows, subagent task trees (`research`, `self`), skills, and cloud frontier reasoning models. Wazir focuses on orchestrating local compute clusters, open-weight models, and local runtimes across multiple self-hosted machines.

- **Wazir vs. Codex (OpenAI / GitHub Copilot)**:
  Codex is a cloud-hosted foundational code-generation model / completion engine powering IDE autocomplete and inline chat. It does not manage compute nodes, schedule distributed jobs, or sandbox OS-level tools; Wazir can use Codex/OpenAI as one of many backend model providers.

---

## 4. Comprehensive Comparison Table

| Feature / Dimension | Wazir | OpenCode | Antigravity (AGY) | Codex / Copilot |
| :--- | :--- | :--- | :--- | :--- |
| **Primary Category** | Local AI Meta-Harness & Distributed Control Plane | Terminal / Repository Coding Agent | Agentic Pair Programming & Developer IDE/CLI Platform | Cloud Code Generation Model & Autocomplete Engine |
| **Architectural Role** | Meta-orchestrator across multiple machines & runtimes | Autonomous task runner & code editing agent | Full-lifecycle agentic dev environment with subagents | Token-level code generation & inline assistant |
| **Execution Topology** | **Distributed**: Central control plane + remote workers (DGX, Mac, PC) | **Local Single-Node**: Runs directly in local terminal/repo | **Host Environment**: Local CLI/IDE with cloud model orchestration | **Cloud SaaS**: Hosted API connected to IDE extensions |
| **Model / Runtime Backends** | Pluggable local runtimes (Ollama, LM Studio); no OpenAI-compatible adapter yet | Pluggable cloud/local providers (OpenAI, Anthropic, Ollama) | Frontier multimodal models (e.g. Gemini 3.8/2.0 series) | OpenAI cloud-hosted models (Codex / GPT-4o / o-series) |
| **Resource & Hardware Scheduling** | **Yes**: VRAM, GPU, platform-aware scheduler with explainability | No (relies on provider API or single host) | Cloud-managed compute & resource scaling | Cloud-managed infrastructure |
| **Agent Capabilities** | Native coding agent loop; can delegate a task to OpenCode instead (`--agent opencode`) | Autonomous multi-step code editing, bash tool execution | Multi-tier subagent delegation, persistent sessions, skills | Autocomplete, code fill-in-middle, single-turn/chat edits |
| **Tool Ecosystem & Extensibility** | Native tool registry; an MCP client exists but isn't wired into task execution yet (policy can only deny unapproved MCP servers) | Shell commands, file tools, git tools | Custom Skills (`SKILL.md`), Rules, MCP sidecars, bash tools | Fixed IDE integrations, limited function calling / plugins |
| **Security & Sandboxing** | Strict 3-tier policy engine (`safe`/`ask`/`deny`), local-only mode | Developer discretion / prompt confirmation | Permission prompts, workspace boundaries, secure telemetry | Enterprise privacy filters, copyright checkers |
| **User Interfaces** | CLI (`wa`), REST API, Web UI, macOS DMG app | Terminal TUI / CLI | IDE extension (VS Code/JetBrains), standalone IDE, CLI (`agy`) | IDE plugins (VS Code, JetBrains, Visual Studio, Neovim) |
| **Ideal Use Case** | Teams managing heterogeneous local GPUs, private compute, and multi-runtime pipelines | Developers wanting a lightweight CLI coding agent in terminal | Developers needing deep autonomous agentic pair programming | Fast inline code completions and snippet generation |
