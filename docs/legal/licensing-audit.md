# Wazir AI OS — Licensing, Copyright & Compatibility Audit

**Audit Date:** 2026-11-20  
**Repository:** `https://github.com/whassan007/wazir`  
**Current Repository License:** `AGPL-3.0-only` ([LICENSE](../../LICENSE))

---

## 1. Copyright Holders & Git Authorship Audit

Verified from `git log --format="%an <%ae>" | sort -u`:
- `Wael Hassan` (`whassan007`, `163226430+whassan007@users.noreply.github.com`) — Principal author of all Wazir codebases.
- `Wazir Hardening Suite` (`hardening@wazir.ai`) — Automated formal verification test commits.

No external third-party human contributors have committed directly to the repository.

---

## 2. Third-Party Code & Dependency Audit

| Component / Source | Origin | License | Compatibility & Boundary |
|---|---|---|---|
| `packages/agents/src/qwenCore/*`, `packages/tools/src/{editMatcher,multiEdit,readManyFiles,todoTool}.ts` | Selective port from `QwenLM/qwen-code` | `Apache-2.0` | Compatible with `AGPL-3.0-only` (FSF-confirmed one-way compatibility: Apache-2.0 code may be included in an AGPL-3.0 work with attribution preserved in `NOTICE`). |
| Node.js workspace dependencies (`express`, `commander`, `zod`, `vitest`, `esbuild`, `tsx`, `@modelcontextprotocol/*`, etc.) | npm ecosystem | `MIT`, `ISC`, `BSD-2-Clause`, `BSD-3-Clause`, `Apache-2.0` | Permissive licenses compatible with both AGPL-3.0 and source-available distributions. |
| Rust / Tauri 2 dependencies (`tauri`, `serde`, `rand`, `portable-pty`) | crates.io | `MIT` / `Apache-2.0` | Permissive dual-licensed; attribution preserved in `THIRD_PARTY_LICENSES.md`. |
| Android / Jetpack Compose dependencies | Maven / Google | `Apache-2.0` | Permissive; compatible with `AGPL-3.0-only`. |

---

## 3. Relicensing & Dual-Boundary Strategy

1. **Existing AGPL-3.0-only Codebase (Preserved):**
   - Existing `packages/core`, `packages/agents`, `packages/policies`, `packages/scheduler`, `packages/tools`, `packages/models`, `apps/cli`, `apps/api`, `apps/worker`, `apps/desktop`, and `apps/android` remain licensed under `AGPL-3.0-only`.
   - Prior AGPL-3.0 grants are **not** retroactively revoked or obscured.
   - No arbitrary license-check DRM is added to disable legitimate AGPL-3.0 usage.

2. **Proposed New Source-Available Noncommercial Boundary (Pending Legal Review):**
   - Newly authored standalone modules wholly owned by the project (such as the Wazir Portal `apps/portal`, standalone Wazir Shell UI/branding assets, and standalone commercial extensions) are candidates for **PolyForm Noncommercial 1.0.0** paired with a **separate commercial authorization** ([LICENSE-COMMERCIAL.md](../../LICENSE-COMMERCIAL.md)).
   - **Important:** Software distributed under PolyForm Noncommercial 1.0.0 is accurately described as **"Source-available, noncommercial license"** and is **not** claimed to be OSI-approved open source.
   - Modules licensed under PolyForm Noncommercial 1.0.0 are kept in separate packages/apps from `AGPL-3.0-only` code and interact only over documented HTTP/IPC/CLI boundaries, preventing incompatible license mixing.

3. **Open Legal Review Items:**
   - Final legal counsel sign-off on PolyForm Noncommercial 1.0.0 + Commercial CLA wording before commercial enforcement.
   - Confirmation of trademark/brand usage guidelines for "Wazir AI OS".
