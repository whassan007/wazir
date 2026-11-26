# Wazir AI OS `v0.4.3` Distributed Release Readiness Report

- **Version**: `0.4.3`
- **Branch**: `feat/coordination-fabric`
- **Date**: 2026-11-25

## Distributed Fleet Results

| Target | Workstream | Status | Evidence |
|---|---|---|---|
| **Mac ARM64 (Coordinator)** | Build, typecheck, `check-dist`, `version:check` (43/43), `release-integrity` (11/11) | **PASS** | `npm run build && npm run typecheck && npm run version:check` |
| **Mac ARM64 (AGY 1–6)** | Core, Coordination Fabric, Message Router, Resource Reservations, Policy/Sandbox, LiquidShell, Theme/Commands, CLI C1 | **PASS** | `155/155` vitest tests passed (10 Linux-only `bwrap`/live skipped) |
| **Mac ARM64 (AGY 7)** | Native Rust Tauri suites (`wazir-desktop` 6/6, `wazir-shell` 6/6) | **PASS** | `cargo test` for both crates |
| **Mac ARM64 (AGY 8)** | Ubuntu GNOME Search Provider & Nautilus Extension Python suite | **PASS** | `22/22` tests passed (`PYTHONPATH=os/wazir-os-ubuntu python3 -m unittest discover -s os/wazir-os-ubuntu/tests -v`) |
| **DGX Spark (`ssh dgx`, aarch64)** | Runtime & Ollama probe (`qwen3.6:35b-a3b-q8_0`, Docker 29.6.2) | **PASS** | `reports/v0.4.3/logs/dgx-runtime-smoke.log` |
| **DGX Spark (`ubuntu:24.04` container)** | `wazir_0.4.3_arm64.deb` unpack, `/usr/bin/wazir-shell`, `/usr/lib/wazir/wazir-shell-bin`, `/usr/lib/systemd/user/wazir-gnome-search.service` | **PASS** | `reports/v0.4.3/logs/agent-04-ubuntu-acceptance.log` |
| **Jetson Thor (`ssh gb10`, `100.83.5.2`)** | Edge node SSH & inference probe | **BLOCKED** | `Operation timed out` (`JETSON_EXIT=255`) in `reports/v0.4.3/logs/jetson-probe.log` |

## Release Artifacts (`v0.4.3`)
- `dist/wazir_0.4.3_arm64.deb` (per-arch Debian/Ubuntu package with native `wazir-shell-bin`)
- `dist/wazir_0.4.3_all.deb` (CLI-only Debian/Ubuntu package)
- `dist/wazir-0.4.3.tar.gz` (RPM source tarball)
- `apps/portal/release-manifest.json`, `apps/portal/releases/SHA256SUMS.txt`, `apps/portal/releases/sbom.cdx.json` (767 components)
