# Wazir Security Audit & Policy Enforcement Findings

**Audit Date:** 2026-10-14  
**Auditor:** Principal Security Engineer & Reliability Architect  
**Scope:** Policy Engine, Sandbox Execution, Control Plane API Auth, Agent Protocol Auth, MCP Auth & Isolation  

---

## Executive Summary

Wazir demonstrates strong, defense-in-depth architectural security across policy authorization, API role-based access control (RBAC), and MCP tool boundaries.

- **Read-Only / Viewer Isolation:** Fully verified. A caller authenticated with a viewer token cannot dispatch tasks, cannot mutate state via Agent Protocol, and cannot invoke MCP mutating tools (`tools/call` returns HTTP 403 Forbidden with `{ "code": -32001, "message": "operator scope required" }`).
- **Policy Engine Authority:** Verified live. Models and agents cannot bypass the policy engine. Denied actions (outside project root, unauthorized tools, destructive commands like `sudo`/`kill`) produce zero physical filesystem mutations.
- **Human Approval Gate:** Verified live during end-to-end task execution. Shell commands invoking interpreters or non-whitelisted utilities trigger interactive prompts (`approve? [y/N]`) before execution.
- **Identified Security Vulnerabilities / Operational Hazards:**
  1. **SEC-VULN-01 (P1):** Bubblewrap container sandbox fails on hosts where Ubuntu kernel AppArmor restricts unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns=1`), causing Wazir to degrade to unconfined direct host execution with a warning log.

---

## Detailed Findings

### 1. SEC-VULN-01: Tool Sandbox Degradation on Ubuntu 24.04+ (Severity: P1)

- **Affected Component:** `packages/tools/src/sandbox.ts`
- **Observed Behavior:** During live task execution, Wazir emitted:
  ```
  [wazir] tool sandbox unavailable — running tool processes directly on the host
  (bwrap cannot start: bwrap: setting up uid map: Permission denied — unprivileged user namespaces
  are disabled (on Ubuntu: sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0,
  or install the bubblewrap AppArmor profile; inside a container, run with --security-opt seccomp=unconfined
  --cap-add SYS_ADMIN or rely on the container as the boundary with WAZIR_SANDBOX=none))
  ```
- **Impact:** When `bwrap` fails due to unprivileged user namespace restrictions in modern Linux distributions (default in Ubuntu 24.04 LTS), tool execution falls back to direct execution under the user's host credentials. While Wazir's policy engine still checks command prefixes and path arguments before execution, process-level kernel sandboxing (chroot, network isolation, private `/tmp`, mount namespaces) is absent.
- **Remediation:**
  1. Provide a packaged AppArmor profile for `bwrap` in `scripts/apparmor/` and instruct `setup-env.mjs` or `install.sh` to install it.
  2. Implement an explicit strict policy flag `WAZIR_STRICT_SANDBOX=1` that aborts execution rather than falling back to host execution if containerization fails.

---

### 2. SEC-VERIF-01: API Role-Based Access Control (RBAC) (Status: PASS)

Tested on a live API server running on an ephemeral port with distinct Operator and Viewer credentials:

- **Anonymous Caller:**
  - `GET /api/v1/overview` -> `401 Unauthorized`
  - `GET /ap/v1/agent/tasks` -> `401 Unauthorized`
- **Viewer Caller:**
  - `GET /api/v1/overview` -> `200 OK` (Can view system health, topology, and execution history)
  - `POST /api/v1/tasks/dispatch` -> `403 Forbidden` (`operator scope required (viewer token is read-only)`)
  - `POST /ap/v1/agent/tasks` -> `403 Forbidden` (`operator scope required`)
  - `GET /ap/v1/agent/tasks` -> `200 OK`
  - `POST /mcp tools/call` (`write`) -> `403 Forbidden`
- **Physical Side Effect Assertion:**
  - File `/tmp/wazir-unauthorized-write.txt` attempted via viewer `tools/call` was independently verified **NOT created**.

---

### 3. SEC-VERIF-02: Policy Engine Enforcement (Status: PASS)

Tested via live `PolicyEngine` evaluation in an isolated project root:

| Scenario | Evaluated Action | Policy Rule | Decision | Physical Effect |
|---|---|---|---|---|
| Project Root Read | `read(valid.txt)` | `filesystem-project-allow` | **ALLOW** | Read allowed |
| Whitelisted Shell | `shell(ls -la)` | `shell-safe-allow` | **ALLOW** | Command allowed |
| Path Traversal Escape | `read(../../../../etc/shadow)` | `filesystem-outside-deny` | **DENY** | No read performed |
| Out-of-Bounds Write | `write(/etc/evil.txt)` | `filesystem-outside-deny` | **DENY** | File not created |
| Destructive Shell | `shell(sudo whoami)` | `shell-dangerous-deny` | **DENY** | Command blocked |
| Unregistered Tool | `unregistered_hack_tool({})` | `unknown-tool` | **DENY** | Tool not dispatched |
| Protected Project Write | `write(package.json)` (user denied) | `filesystem-protected-ask` | **DENY** | File remained unchanged |

---

### 4. SEC-VERIF-03: Credential Redaction & Audit Integrity (Status: PASS)

- **Audit Log:** Checked `/tmp/wazir-test-home-eval/audit.jsonl` (126 KB generated).
- All decisions, tool calls, arguments, and outcomes are logged in an append-only JSONL format.
- No plaintext credentials, provider tokens, or private secrets were exposed in stdout, stderr, or stored audit records.
- Hazardous commands dumping environment variables (`env`, `printenv`) are specifically excluded from the safe shell command whitelist.
