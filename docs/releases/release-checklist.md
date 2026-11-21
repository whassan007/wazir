# Wazir AI OS — Release Checklist (`v0.4.1`)

- [x] `npm run version:check` reports 100% parity at `0.4.1` across all workspace & packaging manifests.
- [x] `npm run typecheck` passes (`tsc --build --force`).
- [x] `npm run build:cli` and `npm run bundle` pass (`bin/wa.js`, `packages/*`, `apps/*`).
- [x] `Wazir Shell.app` (`apps/shell/`) built with `portable-pty`, tabs, `!`/`?`/auto routing, first-launch consent, About dialog.
- [x] `Wazir Mission Control.app` (`apps/desktop/`) built with fleet drill-down, 10-state execution graph, approvals inbox, replay.
- [x] 4-Tier `FastOrchestrator` & `fastLlm` (`Tier 0`–`Tier 3`), Wazir Shell E2E suite (`tests/shell-validation/run-validation.mjs`), and `@wazir/observability` diagnostics/redaction suites pass.
- [x] `wazir-shell-mini` (`LiquidAI/LFM2.5-350M`) SFT dataset generator (`scripts/generate-shell-training-dataset.mjs`), fine-tuning pipeline (`scripts/train-wazir-shell-mini.py`), and training curriculum (`docs/training/WAZIR_TRAINING_GUIDE.md`) verified.
- [x] `NOTICE`, `AUTHORS`, `CONTRIBUTORS`, `THIRD_PARTY_LICENSES.md`, `LICENSE-COMMERCIAL.md`, `docs/legal/licensing-audit.md` updated.
- [ ] Apple Developer ID signing/notarization (external gate: requires Apple Developer credentials if not present).
- [x] Public portal `wazir.wael.bot` staging & production verification (`HTTP/2 200`, Playwright QA pass across 4 viewports).
- [x] SHA-256 checksum manifest (`dist/SHA256SUMS.txt`), SBOM (`dist/sbom.cdx.json`), and `dist/release-manifest.json` generated.
