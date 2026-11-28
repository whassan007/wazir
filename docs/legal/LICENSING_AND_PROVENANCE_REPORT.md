# Licensing and Provenance Audit Report

**Date:** 2026-11-27  
**Branch:** `integration/fleet-consolidation`  
**Canonical Repository:** `https://github.com/whassan007/wazir` (base `3620569`)  
**Absorbed Repository:** `https://github.com/whassan007/Fleet` (base `793ab52ac3b5791efd8be6b526a8e38ba2f15dcf`)

## 1. Executive Summary

Both repositories were audited for copyright ownership, external contributors, imported/forked code, third-party dependencies, and license compatibility.

**Conclusion:** The project owner **Wael Hassan (`whassan007`)** holds 100% of the copyright in `whassan007/Fleet` and has full legal authority to relicense Fleet from PolyForm Noncommercial 1.0.0 to **AGPL-3.0-only** with a separate commercial licensing option (`LICENSE-COMMERCIAL.md`), without introducing any additional noncommercial restrictions into AGPL-3.0.

## 2. Contributor & Ownership Audit

### Wazir (`whassan007/wazir`)
- `Wael <163226430+whassan007@users.noreply.github.com>` (1,132 commits)
- `Waël <163226430+whassan007@users.noreply.github.com>` (28 commits)
- `wael <163226430+whassan007@users.noreply.github.com>` (4 commits)
- `Wazir Hardening Suite <hardening@wazir.ai>` (24 automated test commits)

### Fleet (`whassan007/Fleet`)
- `Waël <163226430+whassan007@users.noreply.github.com>` (1 commit: `793ab52ac3b5791efd8be6b526a8e38ba2f15dcf`, plus local working-tree enhancements on `release/fleet-core-1.0.0-rc1`)
- Zero external human contributors.

## 3. Third-Party Dependency & License Compatibility

| Component / Dependency | License | Compatibility with AGPL-3.0-only | Notes |
| --- | --- | --- | --- |
| `apps/wazir-fleet` SwiftPM targets | AGPL-3.0-only (relicensed) | Native | Zero external SwiftPM dependencies; links macOS system frameworks + `libsqlite3` (Public Domain). |
| `QwenLM/qwen-code` selective transplant | Apache-2.0 | Compatible | Attributed in `NOTICE` and `THIRD_PARTY_LICENSES.md`. |
| `LiquidAI/LFM2.5-350M` weights (`wazir-shell-mini`) | LFM Open License v1.0 | Separate model weights | Kept separate from AGPL-3.0 software; documented in `NOTICE` & `THIRD_PARTY_LICENSES.md`. |
| `llama.cpp` | MIT | Compatible | Attributed in `THIRD_PARTY_LICENSES.md`. |
| Node.js / Rust / Android dependencies | MIT / Apache-2.0 | Compatible | Attributed in `THIRD_PARTY_LICENSES.md`. |

## 4. Actions Completed

1. Replaced `apps/wazir-fleet/LICENSE.md` PolyForm Noncommercial 1.0.0 text with AGPL-3.0-only + Commercial License notice.
2. Updated `apps/wazir-fleet/README.md` license badge and license section.
3. Updated root `NOTICE` and `LICENSE-COMMERCIAL.md` to reflect unified AGPL-3.0-only + Commercial dual-licensing with no noncommercial restrictions on AGPL-3.0.
4. Added `apps/wazir-fleet` system framework and `libsqlite3` notices to `THIRD_PARTY_LICENSES.md`.
