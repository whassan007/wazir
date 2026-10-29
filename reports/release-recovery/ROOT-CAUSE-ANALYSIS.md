# WAZIR v0.2.16 -> v0.2.17 — ROOT CAUSE ANALYSIS & PACKAGING PARITY FAILURE

**Orchestrator:** Google Antigravity (Principal Release Engineering Orchestrator)  
**Date:** 2026-10-29T06:05:00Z  
**Failed Release:** `v0.2.16`  
**Failed Run:** [GitHub Actions Run 40824716398](https://github.com/whassan007/wazir/actions/runs/40824716398)  
**Failed Commit:** `f1f51df1d1fab3d507deee54baf1fae02b0cb34e`  
**Proposed Recovery Release:** `v0.2.17`

---

## 1. Problem Statement

On push of tag `v0.2.16`, the GitHub Actions release workflow failed during the `Verify Quality Gates` job at step `Run npm run package:check -- --skip-build`:

```text
FAIL: 14/15 checks passed — /home/runner/work/wazir/wazir/dist/package-check-linux-x64.json
✗ packaging-parity — deb control Version != 0.2.16; rpm spec Version != 0.2.16; Formula/wazir.rb version != 0.2.16; packaging/homebrew/Formula/wazir.rb version != 0.2.16; bucket/wazir.json version 0.2.15 != 0.2.16; packaging/scoop/wazir.json version 0.2.15 != 0.2.16; package-manager-version.txt 0.2.15 != 0.2.16; Cargo.toml version != 0.2.16; tauri.conf.json version 0.2.15 != 0.2.16
```

Because `packaging-parity` is a non-bypassable quality gate, the release was aborted prior to cross-platform verification and artifact publication.

---

## 2. Root Cause Analysis

### A. Decentralized Version Declarations
Wazir distributes across multiple ecosystems:
1. **npm / Node.js:** `package.json`, `package-lock.json`, and 23 workspace packages.
2. **Debian / Ubuntu:** `packaging/deb/debian/control`
3. **RPM / RHEL / Fedora:** `packaging/rpm/wazir.spec`
4. **Homebrew (macOS / Linux):** `Formula/wazir.rb` and `packaging/homebrew/Formula/wazir.rb`
5. **Scoop (Windows):** `bucket/wazir.json` and `packaging/scoop/wazir.json`
6. **WinGet (Windows):** `packaging/winget/manifests/w/Whassan/Wazir/<version>/`
7. **Desktop / Tauri (Rust):** `apps/desktop/src-tauri/Cargo.toml` and `tauri.conf.json`
8. **Package Manager Tracking Marker:** `packaging/package-manager-version.txt`
9. **CLI Dev Fallback:** `apps/cli/src/index.ts` (`CLI_VERSION`)

During the v0.2.16 release bump, only `package.json` and package workspace files were updated to `0.2.16`. The external distribution manifests were not updated simultaneously, causing `scripts/package-check.mjs` to detect a 9-way version divergence.

### B. Lack of Automated Version Synchronization
Previously, version updates relied on manual file editing or ad-hoc sed scripts, which easily missed formats with nested JSON keys or custom spec syntaxes (e.g. RPM `%changelog`, Homebrew `version "..."`, Scoop `architecture.<arch>.url`).

---

## 3. Engineering Remediation (CODEX Fleet & Antigravity Fleet)

1. **Centralized Synchronization Engine (`scripts/version-manager.mjs`):**
   - Implemented `checkVersionParity()`: Inspects all 37 version declarations across all manifests without modifying files. Exits nonzero on mismatch.
   - Implemented `syncAllVersions(version)`: Programmatically and idempotently updates all 37 manifests, preserving syntax, indentation, and structure.
2. **Release Preparation Script (`scripts/version-prepare.mjs`):**
   - Orchestrates semantic version validation, cross-manifest synchronization, package lock updating, version parity validation, and CLI rebuild.
3. **NPM Scripts Integration (`package.json`):**
   - Added `npm run version:check`
   - Added `npm run version:sync`
   - Added `npm run version:prepare -- <version>`
4. **WinGet Automation (`packaging/winget/manifests/...`):**
   - Automated creation of version directory structure matching the authoritative release.
5. **Regression Test Suite (`tests/versionSynchronization.test.ts`):**
   - Added automated tests ensuring every manifest format is discovered and audited.
