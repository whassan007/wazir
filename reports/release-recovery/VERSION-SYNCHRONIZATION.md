# WAZIR — CENTRALIZED VERSION SYNCHRONIZATION SPECIFICATION

**Author:** Google Antigravity & OpenAI Codex Engineering  
**Version:** 0.2.17  
**Date:** 2026-10-29T06:05:00Z  

---

## 1. Architecture & Design Invariant

```
                 Canonical Version (package.json)
                                |
                   npm run version:sync [v]
                                |
        +-----------------------+-----------------------+
        |                       |                       |
   NPM & Workspaces       Linux Packaging         macOS / Windows
   ----------------       ---------------         ---------------
   • package.json         • deb/debian/control    • Formula/wazir.rb
   • package-lock.json    • rpm/wazir.spec        • bucket/wazir.json
   • 23 package.json(s)   • systemd units         • apps/desktop/Cargo.toml
   • apps/cli fallback    • package-manager-ver   • apps/desktop/tauri.conf
                                |
                                v
                   npm run version:check (Exit 0 / 1)
                                |
                  PASS: Release preparation continues
                  FAIL: Release pipeline aborts immediately
```

---

## 2. CLI Interface & Script Contracts

### `npm run version:check`
- **Execution:** `node scripts/version-manager.mjs check`
- **Behavior:** Reads root `package.json` version as the canonical single source of truth. Iterates through all 37 known distribution files across Debian, RPM, Homebrew, Scoop, WinGet, Tauri/Cargo, and package manifests.
- **Side effects:** Strictly read-only; never touches the filesystem.
- **Exit Code:** `0` on 100% parity; `1` on any mismatch with a detailed diagnostic report.

### `npm run version:sync`
- **Execution:** `node scripts/version-manager.mjs sync [version]`
- **Behavior:** Updates every manifest to match the requested or canonical version. Formats correctly for each target (JSON, TOML, Ruby, RPM spec, Debian control).
- **Idempotence:** Rerunning produces zero git diff.

### `npm run version:prepare -- <version>`
- **Execution:** `node scripts/version-prepare.mjs <version>`
- **Behavior:** Executes the complete release preparation sequence:
  1. Validates SemVer formatting.
  2. Runs `syncAllVersions(<version>)`.
  3. Updates `package-lock.json` via `npm install --package-lock-only`.
  4. Runs `checkVersionParity()`.
  5. Rebuilds standalone CLI bundle (`npm run build`).

---

## 3. Verified Execution Evidence

```bash
$ npm run version:check
> wazir@0.2.17 version:check
> node scripts/version-manager.mjs check

Authoritative Version: 0.2.17
Inspected 37 version declarations.
✓ All version declarations match authoritative version.
```
