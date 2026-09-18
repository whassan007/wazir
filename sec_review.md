# Security Prompt Review & Tailored Assessment Specification for Wazir

This document reviews and refines the **Wazir Security Assessment Agent Prompt**. It is organized into three parts:
1. **Executive Prompt Review & Gap Analysis**: Critical analysis of the original generic prompt against Wazir's actual monorepo architecture, design invariants, and existing security debt.
2. **Wazir Architecture & Surface Mapping**: A concrete audit surface map aligning every audit section with specific Wazir packages, classes, files, and known attack vectors.
3. **The Production-Ready Wazir Security Assessment Prompt**: The fully adapted, deeply grounded prompt ready to be dispatched to an AI security assessment agent.

---

# Part 1: Executive Prompt Review & Gap Analysis

The original prompt provides an adversarial, highly thorough audit methodology. However, in its raw form, it was designed as an abstract template. If handed directly to an AI agent without adaptation, it exhibits five primary shortcomings when applied to the Wazir codebase:

### 1. Abstract Placeholders vs. Real Monorepo Packages
* **Gap in Original**: The prompt speaks generically of "API", "Worker", "Tools/MCP", "Terminal", and "PolicyEngine" without specifying their concrete TypeScript implementations.
* **Wazir Reality**: Wazir is an npm workspaces monorepo spanning 15 packages and applications (`@wazir/core`, `@wazir/tools`, `@wazir/policies`, `@wazir/agents`, `@wazir/runtimes-*`, `@wazir/workers`, `apps/api`, `apps/cli`, `apps/worker`). Without explicit file anchors, an assessing agent risks spending excessive turns exploring or evaluating imagined architectures rather than concrete code paths.

### 2. Disconnect from Documented & Tracked Security Debt
* **Gap in Original**: The prompt assumes a blank slate where all gaps are unknown.
* **Wazir Reality**: Wazir already maintains explicit, executable tracking tests for known architectural debts in [`tests/integration/trackedSecurityDebt.test.ts`](file:///home/wael/Code/Wazir/tests/integration/trackedSecurityDebt.test.ts) and [`PROGRESS.md`](file:///home/wael/Code/Wazir/PROGRESS.md):
  1. **Zero API Authentication / RBAC**: State-changing endpoints (`POST /computers/register`, `POST /api/v1/tasks/dispatch`) accept unauthenticated requests with no JWT/API-key validation.
  2. **Host-Level Tool Execution**: Agent shell tools run directly on the host PID and kernel namespace with no containerization/sandboxing (Docker/gVisor/chroot).
  3. **Unwired Metrics Route**: `/metrics` returns 404 (metrics exporter not connected).
  *The assessment prompt must instruct the agent to evaluate how far these documented debts allow an attacker to escalate, rather than merely re-discovering that they exist.*

### 3. Misalignment with Wazir's 3-Tier Policy Architecture (`allow` / `ask` / `deny`)
* **Gap in Original**: Assumes binary authorization (`allow` vs `deny`).
* **Wazir Reality**: Wazir's `PolicyEngine` ([`packages/core/src/services/policyEngine.ts`](file:///home/wael/Code/Wazir/packages/core/src/services/policyEngine.ts)) enforces a three-tier decision model:
  - `allow`: Immediate execution (safe read-only commands, project-internal file reads).
  - `ask`: Suspends execution to require interactive human authorization via [`ApprovalQueue`](file:///home/wael/Code/Wazir/packages/core/src/services/approvalQueue.ts) (or immediate denial in non-interactive batch mode). Covers interpreters (`node`, `python`), package managers (`npm`, `yarn`), and git mutations.
  - `deny`: Hard termination (system destruction `rm -rf /`, `sudo`, `reboot`, unapproved MCP servers, path escapes).
  *The prompt must specifically audit the `ask` suspension semantics, queue tampering, and fallback behaviors in headless/worker modes.*

### 4. Distinguishing Wired Components from Unwired Implementations
* **Gap in Original**: Treats all components as live, co-equal runtime targets.
* **Wazir Reality**: 
  - [`McpClient`](file:///home/wael/Code/Wazir/packages/core/src/services/mcpClient.ts) is fully implemented but currently unwired from active task execution (only policy filtering exists via `mcp-explicit-approval`).
  - [`ExternalAgentAdapter`](file:///home/wael/Code/Wazir/packages/agents/src/externalAgent.ts) (`opencode`) is wired only via explicit `--agent opencode` CLI pinning (`taskTypes: []` excludes it from auto-scheduling).
  - The control plane distributed task loop uses Server-Sent Events (SSE) via `GET /computers/:id/tasks/stream` in [`apps/api/src/server.ts`](file:///home/wael/Code/Wazir/apps/api/src/server.ts).
  *The prompt must direct attention to live attack surfaces and prevent false-positive reports on inactive prototype code.*

### 5. Git Worktree & Path Sanitation Nuances
* **Gap in Original**: Treats filesystem isolation as simple directory sandboxing.
* **Wazir Reality**: Multi-agent concurrency is isolated through [`WorktreeManager`](file:///home/wael/Code/Wazir/packages/core/src/services/worktreeManager.ts) (`.wazir/worktrees/<jobId>-<taskId>`) and [`assertInsideProject`](file:///home/wael/Code/Wazir/packages/tools/src/paths.ts). The prompt must instruct the auditor to test path injection inside `jobId`/`taskId`, symlink traversal, and git argument injection in `execFileAsync`.

---

# Part 2: Wazir Architecture & Surface Mapping

To make the review effective, the table below maps each security domain to the exact files, functions, and threat vectors in Wazir:

| Audit Section | Primary Wazir Components | Key Files / Interfaces | Specific Threat Vectors to Verify |
| :--- | :--- | :--- | :--- |
| **1. Architecture & Boundaries** | Full Workspace | `packages/*`, `apps/*`, `PROGRESS.md` | Control plane vs. worker boundary; local in-process vs. SSE remote dispatch. |
| **2. Threat Modeling** | API, Worker, Agent, Model | `apps/api/src/server.ts`, `packages/workers/src/worker.ts` | Attacker connecting to SSE stream; malicious model emitting shell payloads. |
| **3. AuthN & AuthZ** | HTTP API & Dispatch | `apps/api/src/server.ts` (`TaskDispatcher`, Express app) | Unauthenticated `/computers/register`, `/api/v1/tasks/dispatch`, `/api/v1/tasks/:id/result`. |
| **4. PolicyEngine Audit** | Security Policy Engine | `packages/core/src/services/policyEngine.ts` | `shell-quote` AST bypass, wrapper unwrapping (`env`, `timeout`, `xargs`), policy re-evaluation during replay/recovery. |
| **5. Agent Isolation** | Worktree Manager | `packages/core/src/services/worktreeManager.ts` | Directory escape via malicious `jobId`/`taskId`; concurrent branch collision; shared `.git` tampering. |
| **6. Context Security** | Context Compiler & Blocks | `packages/core/src/services/contextCompiler.ts`, `apps/cli/src/blocks.ts` | Token truncation leaking critical boundaries; secrets entering `Block` history; cross-job prompt injection. |
| **7. Filesystem Security** | Tools Paths & Filesystem | `packages/tools/src/paths.ts`, `packages/tools/src/filesystem.ts` | `assertInsideProject` symlink bypass; TOCTOU between path check and write; `fs.realpath` canonicalization gaps. |
| **8. Shell Execution** | Process Tools & Policy | `packages/tools/src/process-tools.ts`, `packages/tools/src/process.ts` | `child_process.spawn` argument injection; check-tool restricting to `package.json` scripts; environment variable pollution. |
| **9. Secrets & Credentials** | Config, Logs, Executions | `apps/cli/src/engine.ts`, `packages/core/src/services/executionEngine.ts` | Redaction of `WAZIR_DATABASE_URL`, `OLLAMA_BASE_URL`, model API keys across `BlockStore`, stdout, and error traces. |
| **10. Worker Security** | Worker Daemon & SSE Loop | `packages/workers/src/worker.ts`, `apps/worker/src/index.ts` | Worker capability spoofing; hijacking another computer's SSE stream; forged heartbeat/load metrics. |
| **11. Runtime Security** | Ollama & LM Studio Adapters | `packages/runtimes/ollama`, `packages/runtimes/lmstudio` | Local port exposure (`11434`, `1234`); malicious model downloads; contextTokens forwarding injection. |
| **12. Model Security** | Coding Agent & Action Parser | `packages/agents/src/codingAgent.ts` (`parseAction`, `repairBrackets`) | Model-generated JSON bracket manipulation; tool-call injection; prompt escape overriding system prompt. |
| **13. MCP & Tool Security** | MCP Client & Tool Registry | `packages/core/src/services/mcpClient.ts`, `packages/tools/src/registry.ts` | `mcp:server:tool` policy rule validation; tool registration tampering; unvetted tool execution. |
| **14. Job/Execution AuthZ** | Job Orchestrator & Engine | `packages/core/src/services/jobOrchestrator.ts`, `executionEngine.ts` | Guessable IDs (`crypto.randomUUID` vs nanoid); lack of execution ownership; unauthorized task cancellation/steering. |
| **15. Persistence Security** | Key-Value Stores | `packages/shared/src/store.ts` (`JsonFileStore`), `packages/database/src/postgresStore.ts` | Lockfile race conditions (`.lock`); SQL injection in `escapeLike` / Postgres queries; unencrypted disk storage. |
| **16. Terminal / CLI Security** | CLI Commands & References | `apps/cli/src/commands.ts`, `apps/cli/src/references.ts` | `@file:<path>` directory traversal in reference resolver; CLI `--json` flags leaking unredacted traces; ANSI escapes. |
| **17. JobGraph Security** | Job Manager DAG | `packages/core/src/services/jobManager.ts` | Cycle injection in DAG edges; fan-out DoS via cascading sub-tasks; unauthorized agent state transitions. |
| **18. DoS / Resource Limits** | Scheduler & Buffers | `packages/core/src/services/scheduler.ts`, `apps/api/src/server.ts` | Unbounded SSE queue (`queues` Map in `TaskDispatcher`); memory exhaustion via oversized context buffers; execution loops. |
| **19. Supply Chain** | Dependencies & Packaging | `package.json`, `packages/*/package.json`, `scripts/build-dmg.sh` | AGPL-3.0 compliance; dev dependency vulnerabilities; build script shell safety. |
| **20. Configuration Security** | CLI Config & Environment | `apps/cli/src/config.ts`, `~/.wazir/config.json` | Unsafe bind addresses (`0.0.0.0` vs `127.0.0.1`); insecure defaults for `networkAllowed`. |
| **21. Race Conditions / TOCTOU** | Policy + Filesystem + Stores | `policyEngine.ts`, `paths.ts`, `JsonFileStore` | Policy classification vs. execution window; file replacement between canonicalization and write. |
| **22. Recovery Security** | Job Recovery & Replay | `tests/integration/jobRecovery.test.ts`, `tests/integration/policyBypassSweep.test.ts` | Ensuring replayed tasks are re-evaluated under current policy, not historical policy. |

---

# Part 3: The Production-Ready Wazir Security Assessment Prompt

*(The following prompt has been customized specifically for Wazir and is ready for direct invocation by a security assessment agent.)*

```markdown
You are the Lead Security Assessment Agent for Wazir (https://github.com/whassan007/wazir).

Your objective is to perform an exhaustive, evidence-backed security gap assessment of the Wazir monorepo, identifying vulnerabilities, architectural weaknesses, missing controls, unsafe assumptions, and exploitable attack paths.

### Operational Constraints & Safety Rules
1. Do not modify the repository files, configuration, or git tracking.
2. Do not commit, push, deploy, or delete data.
3. Do not execute destructive commands (no `rm -rf`, `kill`, `reboot`, or disk-formatting operations).
4. Redact any live tokens, credentials, or sensitive environmental data from your output.
5. Ground every finding in actual code, configuration, or reproducible Vitest assertions (`npx vitest run ...`).
6. Distinguish rigorously between confirmed vulnerabilities, documented/tracked architectural debt, and unproven hypotheses.

---

## 1. System Architecture & Trust Boundary Reconstruction

Inspect the repository and construct an accurate Trust Boundary Map covering:
- **Control Plane**: `apps/api` (Express server, SSE task-dispatch), `packages/core` (`JobOrchestrator`, `Scheduler`, `ExecutionEngine`).
- **Worker & Compute Nodes**: `packages/workers` (`Worker`, hardware/runtime discovery), `apps/worker` daemon.
- **Security Boundary**: `packages/core/src/services/policyEngine.ts` (3-tier: `allow`, `ask`, `deny`), `packages/core/src/services/approvalQueue.ts`.
- **Filesystem & Isolation**: `packages/tools/src/paths.ts` (`assertInsideProject`), `packages/core/src/services/worktreeManager.ts` (Git worktree isolation).
- **Execution & Agents**: `packages/agents/src/codingAgent.ts`, `packages/tools/src/process-tools.ts`.
- **Persistence Layer**: `packages/shared/src/store.ts` (`JsonFileStore`), `packages/database/src/postgresStore.ts` (`PostgresStore`).
- **Client & Operators**: `apps/cli` (`wa` CLI, `FleetTui`, command history `blocks.ts`, reference resolution `references.ts`).

Identify and classify every component as **Trusted**, **Semi-Trusted**, or **Untrusted**. Compare documented promises in `README.md` and `PROGRESS.md` with concrete implementation code.

---

## 2. Threat Modeling Wazir

Evaluate Wazir against realistic attacker personas:
1. **Unauthenticated Network Attacker**: Can they interact with `apps/api`, register rogue computers/workers, pull queued tasks via SSE (`/computers/:id/tasks/stream`), forge task outcomes (`/api/v1/tasks/:id/result`), or access executions?
2. **Malicious or Compromised Agent / Model**: Assume LLM generation produces hostile tool calls or prompt-injection text. Can it escape `PolicyEngine`, invoke arbitrary shell commands, escape the project root via symlinks or path traversal, tamper with siblings' git worktrees, or forge `ApprovalQueue` approvals?
3. **Rogue / Spoofed Worker**: Can an unauthorized machine connect to the control plane, report exaggerated GPU/memory specs to hijack high-priority jobs, or submit fake execution results?
4. **Malicious Tool / MCP Server**: While `McpClient` is currently unwired from runtime tasks, does the policy classification for `mcp:<server>:<tool>` permit bypasses or supply-chain abuse?

---

## 3. Authentication, Authorization & API Surface Audit

Audit every route exposed by `apps/api/src/server.ts`:
- `POST /computers/register`
- `GET /computers`
- `GET /computers/:id/tasks/stream` (SSE task-pull loop)
- `POST /api/v1/tasks/dispatch`
- `GET /api/v1/tasks/:id/status`
- `POST /api/v1/tasks/:id/result`
- `POST /api/v1/tasks/:id/events`
- `GET /api/v1/events`

Investigate:
- Is any authentication or identity proof required?
- Can an attacker impersonate another computer by specifying its `computerId` in the SSE stream?
- Can a client forge `requestId` or `executionId` to poison task outcomes?
- Cross-reference with `tests/integration/trackedSecurityDebt.test.ts`.

---

## 4. PolicyEngine Audit & Bypass Verification

Treat `packages/core/src/services/policyEngine.ts` as the primary security perimeter:
1. **Command Parsing & AST Splitting**: Audit `splitSegments()` and `resolveCommand()`. Test shell chaining (`&&`, `||`, `;`, `|`), redirection (`>`, `>>`), subshell substitutions (`$(...)`, `` `...` ``), and wrapper command unwrapping (`env`, `timeout`, `xargs`, `nice`).
2. **Interpreter & Package Manager Restrictions**: Verify that interpreters (`node`, `python`, `bun`) and package managers (`npm`, `yarn`, `pnpm`) trigger `ask` and cannot be auto-allowed.
3. **Check-Tool Restrictions**: Inspect `packages/tools/src/process-tools.ts` to confirm `checkTool` exclusively executes scripts defined in the project's `package.json`.
4. **Enforcement Invariants**: Verify that all execution entrypoints (`apps/cli/src/run.ts`, `packages/core/src/services/jobOrchestrator.ts`, worker loops) invoke `policy.authorize()`. Ensure policy is re-evaluated upon job replay or retry (referencing `tests/integration/policyBypassSweep.test.ts`).

---

## 5. Agent Isolation & Git Worktree Security

Audit `packages/core/src/services/worktreeManager.ts`:
- How are worktree directories constructed (`.wazir/worktrees/<jobId>-<taskId>`)?
- Can a malicious `jobId` or `taskId` (e.g. `../../tmp/escape`) break out of `.wazir/worktrees`?
- How are git branches named (`wazir/<jobId>/<taskId>`)? Does `execFileAsync('git', ['branch', '-D', branch])` allow git flag injection (e.g., branch starting with `--`)?
- Does failure in one agent's worktree impact the shared repository root?

---

## 6. Filesystem Sandboxing & Path Traversal

Audit `packages/tools/src/paths.ts` and `packages/tools/src/filesystem.ts`:
- Analyze `assertInsideProject(root, target)`: Does it protect against lexical traversal (`../`), symlink pointing outside the project root, and non-existent parent paths?
- Is there a TOCTOU window between `assertInsideProject` validation and actual file operations (`fs.writeFile`, `fs.readFile`)?
- How are temporary directories created and cleaned up?

---

## 7. Secrets, Environment & Redaction

Inspect secrets handling across the codebase:
- Check environment variable usage: `WAZIR_DATABASE_URL`, `WAZIR_SERVER_URL`, `OLLAMA_BASE_URL`, `LMSTUDIO_BASE_URL`.
- Are credentials or connection strings logged to `BlockStore` (`apps/cli/src/blocks.ts`), execution records, or stdout?
- Is there an automated secret redaction filter for tool outputs and CLI display, or is raw output persisted?

---

## 8. Persistence & Data Integrity

Audit `packages/shared/src/store.ts` (`JsonFileStore`) and `packages/database/src/postgresStore.ts` (`PostgresStore`):
- `JsonFileStore`: Audit file locking mechanism (`.lock`), stale lock expiration, atomic replacement via temporary files, and concurrent process access.
- `PostgresStore`: Audit query construction (`escapeLike`, parameterized queries). Are there SQL injection vectors?
- Verify `reviveDatesDeep` and JSON parsing security against prototype pollution.

---

## 9. Terminal, CLI References & Explainability

Audit `apps/cli/src/references.ts` and `apps/cli/src/commands.ts`:
- Audit deterministic reference resolution for `@file:<path>`. Does resolving `@file:../../../../etc/passwd` enforce project boundary checks or expose host filesystem existence?
- Check `wa explain <ref>`: Does rendering scheduling decisions leak sensitive environment metadata?
- Verify whether `--json` output modes bypass output sanitization.

---

## 10. Worker, Runtime & Model Provider Security

Audit `packages/workers/src/worker.ts` and runtime adapters:
- Does the worker trust local runtime endpoints (`127.0.0.1:11434`, `127.0.0.1:1234`) without authentication?
- In `packages/runtimes/ollama` and `packages/runtimes/lmstudio`, does forwarding parameters (`num_ctx`, `contextTokens`, model names) expose command injection or SSRF?
- Can a remote worker execute arbitrary code if connected to a malicious control plane?

---

## 11. Security Gap Register Schema

Document all findings using this standard schema:

| ID | Severity (CRITICAL/HIGH/MEDIUM/LOW/INFO) | Component & File | Finding Title | Vulnerability / Debt Type | Evidence (Line & Code) | Exploit / Abuse Path | Impact | Existing Control | Missing Control | Reproducibility |
|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|

---

## 12. Attack-Path Mapping

For each confirmed HIGH or CRITICAL finding, map the complete chained exploit scenario:
```
Attacker / Initial Foothold
  │
  ▼ [Entry Point]
Vulnerable Route / Component / Input
  │
  ▼ [Trust Boundary Crossing]
Bypassed Control or Missing Auth
  │
  ▼ [Privilege Escalation / Lateral Movement]
Secondary Exploitation (e.g. Host Execution / Worktree Hijack)
  │
  ▼ [Target & Impact]
Compromised Asset (Host Takeover, Secret Exfiltration, Data Corruption)
```

---

## 13. Security Control Verification Matrix

Evaluate and complete the status for Wazir's controls:

| Control Domain | Implementation Target | Present? | Enforced? | Tested in CI/Suite? | Bypass or Gap Identified? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| API Authentication | `apps/api/src/server.ts` | | | | |
| Role-Based Access Control | `apps/api/src/server.ts` | | | | |
| Shell Command Policy | `packages/core/src/services/policyEngine.ts` | | | | |
| 3-Tier Approval Flow | `packages/core/src/services/approvalQueue.ts` | | | | |
| Project Root Containment | `packages/tools/src/paths.ts` | | | | |
| Git Worktree Isolation | `packages/core/src/services/worktreeManager.ts` | | | | |
| Container / Sandbox Isolation | Host Process Execution | | | | |
| Worker Identity Attestation | `packages/workers/src/worker.ts` | | | | |
| Secret Redaction Filter | Logging / `BlockStore` / CLI | | | | |
| Replay Policy Re-validation | `apps/cli/src/run.ts` | | | | |
| Store Lock & Concurrency | `packages/shared/src/store.ts` | | | | |
| Reference Path Sanitization | `apps/cli/src/references.ts` | | | | |

---

## 14. Deterministic Remediation Test Specifications

For every confirmed HIGH or CRITICAL finding, specify a deterministic Vitest test that asserts the vulnerability in the current codebase and verifies the fix once remediated.

---

## 15. Final Assessment Classification

Conclude with one of the following official verdicts:
- **SECURITY REVIEW PASSED**: No critical or high-severity vulnerabilities; architecture meets production safety standards.
- **SECURITY REVIEW PASSED WITH FINDINGS**: Software is functional for single-operator/internal trusted environments; documented hardening required prior to multi-tenant or public network deployment.
- **SECURITY REVIEW BLOCKED**: Active uncontained vulnerabilities permit arbitrary host takeover or remote exploitation under current intended deployment models.
```
