# Fixes Applied — Wazir Shell P0 Remediation

| Issue | Fix Applied | Status |
|---|---|---|
| Fatal DOM-ordering exception on startup (`paletteSearch` null) | Moved JS into external `apps/shell/ui/app.js` loaded at end of `<body>` | `VERIFIED_FIXED` |
| Missing `"withGlobalTauri": true` in `tauri.conf.json` | Added `"withGlobalTauri": true` under `"app"` | `VERIFIED_FIXED` |
| Overlapping modals & stacking dark backdrops | Implemented authoritative `ModalController` with 8 states, single `#modal-overlay`, focus trap/restore, and `approvalQueue` | `VERIFIED_FIXED` |
| Discarded command/AI output (`active.buffer` vs `pane.buffer`) | Unified all output and PTY writes to `getActivePane()` | `VERIFIED_FIXED` |
| Duplicate bubbling `keydown` listeners | Consolidated to single `keydown` listener per pane with `e.stopPropagation()` | `VERIFIED_FIXED` |
| Full DOM destruction on `pty-output` | Persistent `<pre class="pane-terminal">` per pane with stateful ANSI/VT100 parser | `VERIFIED_FIXED` |
| Tier 0 routing gaps (`show available models/computers/jobs`, `run <cmd>`) | Extended `matchTier0Intent` in `packages/core/src/services/fastOrchestrator.ts` and `apps/shell/ui/app.js` | `VERIFIED_FIXED` |
| Conflated licensing/consent & unsupported commercial restriction | Separated Onboarding, Diagnostics Consent, and `AGPL-3.0-only` licensing; persisted in `~/.wazir/consent.json` with queue purge on decline | `VERIFIED_FIXED` |
| Ubuntu `.deb` launching `wa improve start` & `Terminal=true` | Fixed `scripts/build-deb.mjs` to use `/usr/bin/wa worker start`, added `/usr/bin/wazir-shell`, icons, and `Terminal=false` in `wazir-shell.desktop` | `VERIFIED_FIXED` |
