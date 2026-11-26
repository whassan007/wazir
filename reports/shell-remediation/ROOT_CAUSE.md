# Root Cause Analysis — Wazir Shell Graphical & Functional Failures

## Summary

Inspection of `apps/shell/ui/index.html`, `apps/shell/src-tauri/tauri.conf.json`, `apps/shell/src-tauri/src/main.rs`, `packages/core/src/services/fastOrchestrator.ts`, `packages/observability/src/consent.ts`, and `scripts/build-deb.mjs` identified nine root causes:

1. **Fatal DOM-Ordering Exception on Startup (`apps/shell/ui/index.html:1213-1328`)**:
   - The `<script>` block executes synchronously **before** `<div class="modal-backdrop" id="command-palette-modal">` is parsed.
   - `document.getElementById('palette-search')` returns `null`, and `paletteSearch.addEventListener('input', ...)` at line 1278 throws `TypeError: Cannot read properties of null (reading 'addEventListener')`.
   - Initialization aborts before `window.addEventListener('keydown')`, `initConsent()`, `initTheme()`, `loadCustomCommands()`, `createTab()`, or `refreshWorkflowJobs()` run.

2. **Missing `"withGlobalTauri": true` (`apps/shell/src-tauri/tauri.conf.json`)**:
   - Tauri v2 does not expose `window.__TAURI__` unless `"app": { "withGlobalTauri": true }` is configured. Without it, `invoke` and `listen` are `undefined` in the native binary.

3. **Uncontrolled Concurrent Modals & Stacking Dark Backdrops (`apps/shell/ui/index.html`)**:
   - Three independent `.modal-backdrop` elements (`#consent-modal`, `#about-modal`, `#command-palette-modal`) each use `position: fixed; inset: 0; background: rgba(0,0,0,0.75); z-index: 999` and mutate `style.display` directly without a single state controller.
   - `#command-palette-modal` uses `class="modal-card palette-card"`, whereas CSS only defines `.modal`, leaving the command palette card unstyled/transparent over other dialogs.

4. **Discarded Command & AI Output (`active.buffer` vs `pane.buffer`)**:
   - `createTab()` stores output in `tab.panes[i].buffer`, and `renderOutput()` renders `pane.buffer`.
   - `cmdForm`, `dispatchWorkflow`, `inspectWorkflowJob`, `controlWorkflowJob`, and `clear-btn` all mutate `active.buffer` (`tab.buffer`), which is never rendered. `cmdForm` also sends `sessionId: activeId` instead of `getActivePane().id`.

5. **Duplicate Bubbling `keydown` Listeners (`apps/shell/ui/index.html:926, 1117`)**:
   - Both `.pane-output` and `#terminal-grid` attach `keydown` handlers calling `pty_write` without `e.stopPropagation()`, doubling every keystroke.

6. **Full DOM Destruction on Every `pty-output` Event (`apps/shell/ui/index.html:872, 1203`)**:
   - `renderOutput()` clears `outputEl.innerHTML = ''` on every PTY chunk, destroying keyboard focus and selection, while `stripAnsi()` strips all ANSI colors and control sequences.

7. **Incomplete Command Routing & Main-Thread Blocking IPC**:
   - `isLikelyShell()` in `index.html` only checks 18 hardcoded binaries.
   - `run_wazir_ai_task` in `main.rs` is synchronous (blocking the Tauri main thread) and invokes `wa exec --json` instead of Wazir's 4-Tier `FastOrchestrator`.
   - `matchTier0Intent` in `packages/core/src/services/fastOrchestrator.ts` does not match `show available models`, `show available computers`, or `show running jobs`.

8. **Conflated Licensing / Telemetry Consent & Unsupported Commercial Restriction**:
   - `index.html`, `main.rs`, `consent.ts`, and `shellCommand.ts` conflate AGPL-3.0-only licensing with diagnostic consent and state an unsupported commercial-use restriction contradicting the root `LICENSE` (`AGPL-3.0-only`).
   - Consent was persisted only in `localStorage` instead of `~/.wazir/consent.json`.

9. **Ubuntu Packaging Defects (`scripts/build-deb.mjs:95`, `packaging/linux/wazir-shell.desktop`)**:
   - `scripts/build-deb.mjs` rewrites `wazir-worker.service` `ExecStart` to `/usr/bin/wa improve start --foreground --continuous` instead of `/usr/bin/wa worker start`.
   - `wazir-shell.desktop` uses `Terminal=true` and `Exec=wa shell` instead of launching the native GUI `wazir-shell` with `Terminal=false`.
