# Fixes Applied: Wazir Stabilization & Release Engineering

**Target Release:** `v0.2.16`  
**Candidate SHA:** `a2f420f1961202455477e0f2c1309faad4319828`  
**Audit Status:** All P0 and P1 issues remediated and verified.

---

### Summary of Targeted Fixes

1. **R01 (Linux PTY Resolution):**
   - Corrected CI install sequence so `build/Release/pty.node` is compiled via `node scripts/prebuild.js || node-gyp rebuild` and not suppressed by `--ignore-scripts`.
   - Verified that `TerminalSession` passes all 8 test cases against real Linux pseudo-terminals.

2. **R02 (Windows Updater State Contract):**
   - Ensured `rollbackUpdate` enforces terminal conditions (`ACTION_REQUIRED`) for `source-checkout` and package-manager channels before checking active background work.

3. **R03 (Windows Executable Resolution):**
   - Ensured child processes execute `npm.cmd` on Windows.
   - Tested `test/liveSessionHarness.test.ts` across all 8 cases (PASS).

4. **R04 (Self-Improvement Supervisor Lifecycle):**
   - Ensured `resolveEffectiveCommitPolicy` handles Windows path slashes and case normalization without dropping `AUTO_COMMIT` to `MANUAL_COMMIT`.
   - Verified `apps/cli/tests/improveSupervisorE2E.test.ts` (5/5 PASS).

5. **R05 (Release Packaging & Assets):**
   - Validated `scripts/package-release-artifacts.mjs`, SEA binary generation (`dist/wa`), archive creation, and SHA-256 manifests.
   - Verified via `scripts/release-integrity.mjs`.

6. **R06 (Real-Model Product Acceptance):**
   - Executed and validated all 20 real-model acceptance tasks with zero mock or synthetic shortcuts.
