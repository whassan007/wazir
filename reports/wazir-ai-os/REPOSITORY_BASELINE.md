# Repository Baseline — Wazir AI OS v0.4.2+

- **Repository**: `https://github.com/whassan007/wazir`
- **Integration Branch**: `feat/coordination-fabric` (`5579359d920413560694905c352bbd1541553fda`, `tag: v0.4.2`)
- **Remote Default (`origin/main`)**: `4fef398a2fade5a6eda680037e928e8a2d533fa7` (`v0.3.1`)
- **Host**: macOS ARM64 (`node v22.23.3`, `rustc 1.99.0`, `cargo 1.99.0`)
- **Build & Integrity Gates**:
  - `npm run build`: PASS (exit 0)
  - `npm run typecheck`: PASS (exit 0)
  - `npm run check-dist`: PASS (all 26 workspace packages fresh)
  - `npm run version:check`: PASS (`0.4.2` across 43 declarations)
  - `node scripts/build-deb.mjs`: PASS (`dist/deb/wazir_0.4.2_all.deb`)
  - `cargo test -- --test-threads=1` (`apps/shell/src-tauri`): PASS (4/4)
  - `cargo build --release` (`apps/shell/src-tauri`): PASS
