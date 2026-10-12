# Qwen-Live-Harness Upstream Maintenance & Tracking Guide

This guide establishes the maintenance strategy, version pinning, licensing compliance, and upgrade workflows for components adapted from **Qwen-Live-Harness** into **Wazir**.

---

## 1. Upstream Origin & Pinned Commit

- **Upstream Repository:** `https://github.com/QwenLM/Qwen-Live-Harness`
- **Pinned Commit SHA:** `b6ce544ebbcd7417e37e0314ec946466c49c615c`
- **Upstream Release Tag:** `v1.0.0` (Workspace packages: `qwen-live-harness@1.0.0`, `qwen-live-harness-host@1.0.0`)
- **Upstream License:** Apache License 2.0
- **Upstream Author:** Alibaba Group Holding Limited / Qwen Team

---

## 2. Licensing & Attribution Compliance

Under the terms of the **Apache License, Version 2.0**:
1. **Notice & License Preservation:** All files adapted from Qwen-Live-Harness must preserve the original copyright notice and SPDX identifier in the file header:
   ```typescript
   /**
    * @license
    * Copyright 2026 Alibaba Group Holding Limited
    * Copyright 2026 Qwen
    * SPDX-License-Identifier: Apache-2.0
    * Adapted for Wazir.
    */
   ```
2. **State Changes:** Files that have been modified or adapted must explicitly state that changes were made for Wazir integration.
3. **No Unapproved Trademarks:** Wazir does not claim endorsement by or affiliation with Qwen or Alibaba Group.

---

## 3. Maintenance Strategy & Divergence Tracking

To minimize technical debt and prevent divergence from becoming unmaintainable, Wazir adopts the **Modular Adapter Pattern**:

```
Upstream Repo (Qwen-Live-Harness)
       │
       ▼ (Periodic Sync / Pin)
Isolated Adaptation Modules in Wazir
├── packages/agents/src/acp/          <-- ACP Client & stdio multiplexer
├── packages/core/src/subagents/      <-- Subagents Ledger & status types
├── packages/core/src/permissions/    <-- PermissionBroker & risk classifier
├── packages/core/src/proactive/      <-- Tool Receipts & ProactiveTaskManager
└── packages/memory/src/sqlite/       <-- Node:sqlite persistent store & BM25
       │
       ▼ (Clean Interfaces)
Wazir Core Runtime & Execution Engine
```

### Key Maintenance Rules
1. **Zero Monolithic Imports:** Do not copy the entire upstream repository into Wazir. Import only verified, tested modules with explicit responsibilities.
2. **Platform Agnostic Execution:** Avoid introducing any macOS-only dependencies or Objective-C native extensions (`appshot.mm`). All integrated modules must pass cleanly on Linux, macOS, and containerized CI environments.
3. **Built-in Node.js APIs:** Prefer Node.js 22 built-in modules (`node:sqlite`, `node:child_process`, `node:crypto`) over heavy native npm dependencies.

---

## 4. Upstream Upgrade Procedure

When a new version or security patch is released in `QwenLM/Qwen-Live-Harness`:

1. **Inspect Upstream Changes:**
   ```bash
   git fetch https://github.com/QwenLM/Qwen-Live-Harness.git main
   git log --oneline b6ce544ebbcd7417e37e0314ec946466c49c615c..FETCH_HEAD
   git diff b6ce544ebbcd7417e37e0314ec946466c49c615c..FETCH_HEAD -- packages/qwen-live-harness/src/
   ```

2. **Verify Target Subsystems:**
   Inspect diffs in the specific adapted subsystems:
   - `src/adaptor/acp-adaptor.ts`
   - `src/subagents/ledger.ts`
   - `src/permissions/permission-broker.ts`
   - `src/permissions/important-operation.ts`
   - `src/memory/store.ts` & `retrieval.ts`
   - `src/proactive/tool-receipt.ts`

3. **Port Fixes into Adapted Modules:**
   Apply bug fixes or protocol updates directly to Wazir's adapted files, maintaining regression test coverage.

4. **Run Wazir Verification Harness:**
   ```bash
   npm run typecheck
   npx vitest run tests/acceptance/
   npx vitest run packages/core/tests/
   npx vitest run packages/agents/tests/
   npx vitest run packages/memory/tests/
   ```

5. **Update Pinned SHA:**
   Update the pinned SHA in this document and record the changelog in `QWEN_INTEGRATION_RESULTS.md`.
