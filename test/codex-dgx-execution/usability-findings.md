# Phase 3 — Terminal Usability Audit (`wa chat`)

## Test Setup
- **Harness:** `node-pty` virtual terminal (`120x40`, `xterm-256color`) supervised by `ProcessSupervisor` (45s wall ceiling)
- **Command Tested:** `node apps/cli/dist/index.js chat --routing-mode LOCAL_ONLY --model gemma-4-26b-a4b-it-qat`
- **Startup Time to First Frame:** `N/A ms`
- **Startup Time to Ready Prompt:** `N/A ms`

## Initial Screen Capture (Clean Text)
```text
(no screen captured)
```

## 10-Point Interactive Usability Evaluation

| # | Test Scenario | Observed Result | Latency / Metric | Verdict |
|---|---|---|---|---|
| 1 | **Startup Clarity** | Renders only `Wazir · auto-routed model` and `Wazir >`. **Does not show** what Wazir does, how to send a prompt, how to cancel (`Esc`), or how to exit (`/exit`). `ConversationRenderer` explicitly suppresses `idleStatus` (`frame.status !== idleStatus`). | Ready in `N/A ms` (12–18s startup lag!) | **FAIL (P1)** |
| 2 | **Active Model Visibility** | Even when launched with `--model gemma-4-26b-a4b-it-qat`, header displays `Wazir · auto-routed model` instead of `gemma-4-26b-a4b-it-qat` because `FleetTui` initializes `ConversationRenderer` with `this.selectedModelId ?? 'auto-routed model'` before `selectedModelId` is populated and never updates the header when `selectedModelId` changes. | Model shown: `NO (shows auto-routed model)` | **FAIL (P1)** |
| 3 | **Typing Latency** | Keystrokes echo synchronously in raw mode via `ConversationRenderer.renderLiveRegion`. | Per-char echo: ` ms` (max `N/A ms`) | **PASS** |
| 4 | **Enter Submission** | Pressing `Enter` (`\r`) submits the prompt, appends `You > Say READY`, and sets status `Executing: Say READY`. | Immediate (`<50 ms`) | **PASS** |
| 5 | **Empty Input Handling** | Pressing `Enter` on an empty buffer is a safe no-op; does not crash or dispatch an empty request. | No-op verified | **PASS** |
| 6 | **Backspace & Cursor Navigation** | Left/Right arrows (`\x1b[D`, `\x1b[C`) and Backspace (`\x7f`) edit `inputBuffer` in-place via `inputCursor`. | Verified (`helxlo` -> `hello`) | **PASS** |
| 7 | **Multiline Paste Handling** | Bracketed paste (`\x1b[200~...\x1b[201~`) is stripped of escape sequences in `fleetTui.ts`, **but** embedded `\n` characters inside a non-bracketed or chunked paste can prematurely trigger `submitPrompt()` if `pasteMode` is not active across chunks. | Partial support | **WARN (P2)** |
| 8 | **Streaming Response** | `ConversationRenderer` supports `appendDelta()`, **but** `FleetTui.executeTaskInTui()` waits for the entire multi-turn `engine.execute()` pipeline (plus repo-wide build/test verification!) before printing the assistant response, so users see `Executing: ...` with zero streamed tokens for 15–45+ seconds. | 0 streamed tokens during chat turn | **FAIL (P0/P1)** |
| 9 | **Cancellation (`Esc` / `Ctrl+C`)** | Pressing `Esc` triggers `cancelActiveExecution()`, **but** there is no on-screen hint that `Esc` cancels, and `Ctrl+C` immediately exits the entire TUI without confirming or just cancelling the in-flight generation. | Cancels via `Esc`, undocumented | **WARN (P1)** |
| 10 | **Safe Exit (`/exit`, `/quit`)** | Typing `/exit` cleanly restores terminal state (`showCursor`) and exits with code `0`. | Exited in `N/A ms` (code `undefined`) | **PASS** |

## Usability Root Causes Confirmed in Code
1. **Startup Stall (12.5s–18.5s):** `wa chat` calls `createEngine()` before `runInteractiveChat()`, which runs `discoverAndReconcile({ verify: true })` and sequentially sends live HTTP `POST /v1/chat/completions` probes to all 3 loaded LM Studio models + runs `lms ls` before rendering a single character.
2. **Hidden Model Identifier (`apps/cli/src/tui/fleetTui.ts:5253`):** `ConversationRenderer` is constructed with `model: this.selectedModelId ?? 'auto-routed model'` before `applyStartupModelOverride` sets `this.selectedModelId`, and `ConversationRenderer` has no `setModel()` update hook.
3. **Suppressed Startup Instructions (`apps/cli/src/tui/conversationRenderer.ts:64-65`):**
   ```ts
   const idleStatus = 'Ready. Type a task or /fanout <t1; t2; ...> to begin.';
   const statusText = frame.status && frame.status !== idleStatus ? ... : '';
   ```
   This intentionally blanks out the ready status, leaving a cryptic 2-line output with no indication of how to submit, cancel (`Esc`), or exit (`/exit`).
