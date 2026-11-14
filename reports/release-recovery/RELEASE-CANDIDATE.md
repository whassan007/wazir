# WAZIR v0.2.17 — RELEASE CANDIDATE SPECIFICATION

**Candidate Release:** `v0.2.17`  
**Candidate Branch:** `release/v0.2.17-recovery`  
**Status:** QUALIFIED (Local Release Gates: 100% PASS)  

---

## 1. Candidate Scope & Commits
This candidate recovers from the packaging parity failure observed on tag `v0.2.16` by implementing:
- Centralized version synchronization engine (`scripts/version-manager.mjs` and `scripts/version-prepare.mjs`).
- Complete cross-manifest alignment across Debian, RPM, Homebrew, Scoop, WinGet, Tauri, and package-manager markers at version `0.2.17`.
- NPM script hooks: `version:check`, `version:sync`, `version:prepare`.
- Packaging parity regression testing suite (`tests/versionSynchronization.test.ts`).

---

## 2. Invariants & Guarantees
- The previously published tag `v0.2.16` remains completely immutable; git history is not rewritten.
- Packaging parity check (`npm run package:check -- --skip-build`) now achieves **15/15 PASS** on clean runners.
- Native dependencies (`node-pty`, `@napi-rs/keyring`) remain properly built and verified.
