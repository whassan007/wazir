# Wazir Security Qualification & Architecture Review

**Reviewer:** Google Antigravity (Coordinator) with OpenAI Codex (Subagents 01, 02) & Claude Code (Subagents 04, 05)  
**Target Candidate Commit:** `4f86340cc82cbb8b19e9cb3045cc4f282e5a01dc`  
**Security Status:** QUALIFIED / ZERO BLOCKING DEFECTS  
**Date:** 2026-10-28  

---

## 1. Executive Summary

A comprehensive security review was performed across the Wazir meta-harness architecture. Specific focus was placed on shell command authorization boundaries, subshell escapes, API endpoint privilege classifications, OS process sandbox isolation, seccomp BPF filters, credential storage, and MCP tool execution security.

Two critical vulnerabilities were identified during early qualification phases and remediated:
1. **Shell Command Wrapper Bypass (`ISSUE-01`):** Subshell wrappers (e.g. `bash -c ./binary`) could bypass policy gates if the outer binary (`bash`) was permitted while the target binary was unapproved. Remediated by `codex-01`.
2. **API Route Privilege Classification Gaps (`ISSUE-02`):** 57 API endpoints lacked explicit entries in the authorization route matrix, risking unauthorized operator or viewer actions. Remediated by `codex-02`.

Both issues have been remediated with full negative test coverage and confirmed in consolidated release verification.

---

## 2. PolicyEngine Shell Authorization Hardening

### Threat Model & Vulnerability Analysis
The Wazir `PolicyEngine` enforces developer-defined security policies regarding tool invocations and system command execution (Allow, Ask, Deny). Prior to remediation, command classification evaluated the primary executable name in isolation. When an agent invoked commands using execution wrappers or subshells such as:
```bash
bash -c ./unapproved_executable
sh -e script.sh
eval "dangerous_cmd"
```
The policy engine recognized `bash` or `sh` as system shells, but failed to recursively parse and classify the nested command line or payload. If artifact execution was restricted, an agent could bypass confirmation by invoking through subshells.

### Remediation Details (`codex-01`)
Commit `28f1773e` in `packages/core/src/services/policyEngine.ts`:
- Added recursive AST/token inspection for subshell commands (`bash -c`, `sh -c`, `zsh -c`, `env`, `xargs`).
- Enforced `allowArtifactExecution = false` across all wrapped subshell payloads when the target executable has not received explicit operator grant.
- Hardened quote stripping and whitespace normalization to prevent command substitution attacks (e.g. `$(...)` and backticks).

### Verification
Verified via `packages/core/tests/policyEngineShell.test.ts` (25 tests passed):
- Positive cases: legitimate system commands (`git status`, `npm test`) allowed.
- Negative cases: wrapped unapproved artifacts (`bash -c ./real`) reliably prompt with `ask` status.
- Zero authorization bypasses observed under fuzzing and combinatorial command flags.

---

## 3. API Authentication & Authorization Matrix

### Threat Model & Exposure
The Wazir API exposes endpoints for task orchestration, fleet telemetry, goal studio interactions, checkpoint persistence, and worker coordination. Endpoints must be strictly partitioned into:
- **Public / Unauthenticated:** Health checks (`/health`, `/ready`), version info.
- **Viewer Scope:** Read-only telemetry, job status, event logs, model listings.
- **Operator Scope:** Job cancellation, task creation, policy approvals, secret injection.
- **Checkpoint Transport Scope:** Low-level durable state reconciliation across worker nodes.

During initial CI audits, 57 newly introduced endpoints were missing from the centralized route matrix in `apps/api/tests/p0Remediation.test.ts`.

### Remediation Details (`codex-02`)
Commit `749bbb2d`:
- Every exposed route was mapped into the authoritative matrix with explicit scopes.
- Unauthenticated requests to viewer/operator endpoints strictly return `401 Unauthorized`.
- Scoped token violations strictly return `403 Forbidden`.
- Checkpoint transport endpoints require dedicated mutual authentication tokens.

### Verification
Verified via `apps/api/tests/p0Remediation.test.ts` (12 tests passed):
- Total classified routes: 100% (0 unclassified routes remaining).
- Authorization matrices validated for role-based access control (RBAC).

---

## 4. Sandbox Isolation & OS Hardening

Wazir features a multi-tiered execution sandbox (`packages/tools/src/sandbox/`):
- **Linux PID & Mount Namespaces:** Agents execute in dedicated Linux namespaces where filesystem mutations outside the workspace and `/tmp` are blocked.
- **Seccomp BPF Assembly:** Live kernel syscall filtering denies `mount`, `ptrace`, and nested namespace creation.
- **Network Boundaries:** Network access is denied by default unless explicitly granted by task capability requirements.
- **Workspace Git Isolation:** Agent worktrees operate safely even when `.git` resides in the root repository.

### Verification
Verified via `packages/tools/tests/sandbox.test.ts` (20 tests passed):
- BPF assembly syntax verified.
- Live enforcement confirmed: writes outside project directory denied with `EPERM`.
- Seccomp filters confirmed functional on supported Linux kernels.

---

## 5. Credential Storage & Secret Hygiene

- **OS Keyring Integration:** Secure storage of model provider keys (OpenAI, Anthropic, Gemini) uses `@napi-rs/keyring` (Secret Service on Linux, Keychain on macOS, Credential Manager on Windows).
- **Graceful Degradation:** If the native keyring is unavailable (e.g. headless CI environments or minimal Docker containers), Wazir falls back to encrypted file storage or memory-only environment variables with explicit warning banners.
- **Release Verification Secrets Scan:** Automated 9-pattern secret scanner runs during `npm run release:verify` ensuring no API tokens, private keys, or passwords leak into distribution packages.

---

## 6. Security Review Conclusion

Wazir meets strict production security requirements. No open vulnerabilities, bypasses, or unclassified routes remain in the release candidate.
