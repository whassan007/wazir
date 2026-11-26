# Repository Baseline — Wazir Shell P0 Remediation

- **Repository**: `https://github.com/whassan007/wazir`
- **Local Path**: `/Users/wael/Code/Wazir`
- **Current Branch**: `feat/coordination-fabric`
- **HEAD Commit**: `79a39e65225b02cf6e59903882d4eb631f4b2289` (`79a39e6`)
- **Remote Default Branch (`origin/main`)**: `4fef398` (tag `v0.3.1`)
- **Local Version**: `0.4.2` (uncommitted version bump from `0.4.1` in `package.json`, `apps/shell/package.json`, `apps/shell/src-tauri/Cargo.toml`, `apps/shell/src-tauri/tauri.conf.json`, `apps/desktop/package.json`, etc.)
- **Tooling Versions**:
  - `wa --version`: `0.4.1` (from `bin/wa.js` prior to rebuild)
  - `node --version`: `v22.23.3`
  - `rustc --version`: `rustc 1.99.0 (b940084d7 2026-09-28) (Homebrew)`
  - `cargo --version`: `cargo 1.99.0 (5f94df478 2026-08-27) (Homebrew)`

## Pre-Fix Affected Executable

- **Path**: `/Users/wael/Code/Wazir/apps/shell/src-tauri/target/release/wazir-shell`
- **Size**: `10,949,952` bytes
- **Modified**: `Nov 25 22:36`
- **SHA-256**: `e952b99cee9c34b4a3d2d756adbb78e96bdd56d0f764669ac13a062ec7f1e331`

## Repository Reconciliation Findings

1. **`apps/shell` status**: Committed on `feat/coordination-fabric` (and `feat/wazir-shell-e2e-repair`, `feat/wazir-ai-os-launch`), not present on `origin/main` (`v0.3.1`).
2. **Uncommitted local changes**: Preserved in full. Includes `0.4.2` version bumps, `apps/shell/src-tauri/src/main.rs` (`MAX_PTY_SESSIONS`, theme/custom-command handlers), `apps/shell/ui/index.html` (split panes + command palette additions), `apps/shell/src-tauri/tauri.conf.json` (CSP), and coordination fabric files.
3. **`apps/shell` vs `apps/desktop`**:
   - `apps/desktop` (`ai.wazir.desktop`) is the **Wazir Mission Control** operations console that spawns `apps/api` (`4800`) and `apps/web` (`4801`) and loads `http://127.0.0.1:4801/mission-control.html`.
   - `apps/shell` (`ai.wazir.shell`) is the **Wazir Shell** native PTY terminal application.
   - They are complementary: `apps/shell` can open Mission Control for advanced fleet/ops workflows rather than duplicating it.
4. **Shared services verified present**:
   - `packages/core/src/services/executionEngine.ts`
   - `packages/core/src/services/jobManager.ts`
   - `packages/core/src/services/jobOrchestrator.ts`
   - `packages/core/src/services/scheduler.ts`
   - `packages/core/src/services/checkpointService.ts`
   - `packages/core/src/services/checkpointTransportService.ts`
   - `packages/core/src/services/policyEngine.ts`
   - `packages/core/src/services/handoffService.ts`
   - `packages/core/src/services/verificationEngine.ts`
   - `packages/core/src/services/fastOrchestrator.ts`
   - `packages/agents/src/fastPathClassifier.ts`
   - `apps/cli/src/serviceManager.ts`
   - `apps/cli/src/improvementSupervisor.ts`
