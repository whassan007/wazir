# Wazir Autonomous Multi-Agent Remediation — Handoff State

- **Current Branch**: `remediation/v0.2.13`
- **Base Commit SHA**: `2846834280099ed22c29b2f8d058f80343c07320` (`v0.2.12` / `main`)
- **Completed Phases**:
  - **Phase 0 (Baseline & Architectural Reconnaissance)**: **PASS**
- **Current Phase**: **Phase 1 — Release Reconciliation and CI Integrity (P0)**
- **Open Issues Assigned to Phase 1**:
  - `ISS-001` (P0): Restore autonomous updater (`apps/cli/src/updater/*`, `wa update`, `docs/auto-updates.md`, `scripts/build-cli.mjs`) from `v0.2.8`–`v0.2.10` (`1d1ce13`, `9f70a61`).
  - `ISS-002` (P0): Repair Linux desktop/Tauri build prerequisites (`libwebkit2gtk-4.1-dev`, etc.) in `.github/workflows/ci.yml` and `.github/workflows/reliability.yml`, and fix `reliability.yml` trigger path `'tests/reliability/**'`.
  - `ISS-003` (P0): Pin `.github/workflows/release.yml` jobs to exact verified commit SHA (`${{ needs.verify.outputs.commit_sha }}` / `${{ github.sha }}`), enforce full mandatory test gates, integrate `scripts/release-integrity.mjs` and `scripts/api-health-smoke.mjs` (`87d4a34`), and publish verified non-prerelease tags as Latest (`draft: false`).
  - `ISS-004` (P0): Align Debian (`packaging/deb/debian/control`) and RPM (`packaging/rpm/wazir.spec`) Node.js dependency to `>= 22.13.0`, synchronize Homebrew/Scoop/RPM/DEB versions to `0.2.12`, fix `scripts/build-deb.mjs` and `scripts/build-rpm.mjs` systemd `ExecStart` commands, and prevent `scripts/build-binary.mjs` from mutating user dotfiles unless explicitly requested.
  - `ISS-005` (P0): Align SPDX licensing metadata (`AGPL-3.0-only` across root, all 24 workspace `package.json` files, RPM/Homebrew/Scoop manifests, and `scripts/update-package-managers.mjs`), synchronize workspace `package.json` versions and `engines.node` (`>=22.13.0`), and add release feature-parity regression tests (`tests/release/packageParity.test.ts`).
- **Next Reproducible Action**:
  - Commit Phase 0 baseline documentation on `remediation/v0.2.13` and launch parallel Phase 1 worker agents on disjoint file sets.
