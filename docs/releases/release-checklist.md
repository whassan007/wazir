# Wazir AI OS — Release Checklist (v0.3.2)

- [x] `npm run typecheck` passes (`tsc --build --force`).
- [x] `npm run build` passes (all TS workspaces, Tauri desktop, `bin/wa.js`).
- [x] `Wazir Shell.app` (`apps/shell/`) built with `portable-pty`, tabs, `!`/`?`/auto routing, first-launch consent, About dialog.
- [x] `Wazir Mission Control.app` (`apps/desktop/`) built with fleet drill-down, 10-state execution graph, approvals inbox, replay.
- [x] `@wazir/observability` diagnostics consent, redaction, and adversarial leakage tests pass.
- [x] `NOTICE`, `AUTHORS`, `CONTRIBUTORS`, `THIRD_PARTY_LICENSES.md`, `LICENSE-COMMERCIAL.md`, `docs/legal/licensing-audit.md` present.
- [ ] Apple Developer ID signing/notarization (external gate: requires Apple Developer credentials if not present).
- [ ] Public portal `wazir.wael.bot` staging & production verification.
- [ ] SHA-256 checksum manifest (`dist/SHA256SUMS.txt`), SBOM (`dist/sbom.cdx.json`), and `dist/release-manifest.json` generated.
