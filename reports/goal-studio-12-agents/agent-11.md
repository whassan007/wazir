# Agent 11 Report — TUI, CLI, and Startup Performance (`feat/parallel-tui-performance`)

## 1. Executive Summary

Workstream 11 remediated CLI startup latency on fast-path invocations (`wa --version`, `wa --help`), added deterministic startup profiling (`WAZIR_PROFILE_STARTUP`), extracted modular Goal Studio TUI presentation and keyboard shortcut discoverability components (`apps/cli/src/tui/goalStudioPanel.ts`), ensured immediate visible feedback for all interactive TUI commands (including `/status`, `/goals`, view switches, and unknown slash commands), and hardened terminal cleanup with `AbortController` cancellation support in both `TerminalSession` and `FleetTui`.

---

## 2. Root Causes Identified & Remediated

### 2.1 CLI Startup Latency & Eager Module Graph Loading
- **Root Cause**:
  1. `apps/cli/src/index.ts` imported `closeMCPRegistries` from `@wazir/core` statically at top level and registered a `postAction` hook that unconditionally invoked `closeMCPRegistries()`.
  2. `apps/cli/src/mcp.ts` statically imported `@modelcontextprotocol/client`, `@wazir/core`, `@wazir/tools`, and `@wazir/secrets` at module load time even though `registerMCPCommands(program)` only defines Commander subcommands and does not touch those packages until an `mcp` subcommand action executes.
  3. `apps/cli/src/web.ts` statically imported `@wazir/core`, `@wazir/tools`, and `@wazir/secrets` at module load time even though `registerWebCommands(program)` only registers `wa web` subcommands.
  4. `apps/cli/src/index.ts` lacked an early fast-path for `wa --version` / `wa -V` prior to constructing 50+ Commander subcommands.
- **Fix Implemented**:
  - Created `apps/cli/src/startupProfiler.ts` (`StartupProfiler`, `createStartupProfiler`, `globalStartupProfiler`, `isStartupProfilingEnabled`) supporting `WAZIR_PROFILE_STARTUP=1|true|json|pretty` with phase marks (`cli.entry`, `cli.fast_version`, `cli.commands_registered`, `cli.parse`, `cli.post_action`, `engine.start`, `engine.config`, `engine.store`, `engine.discovery`, `engine.ready`) and span measurements.
  - Added early `--version` / `-V` fast-path in `apps/cli/src/index.ts` while preserving the canonical `CLI_VERSION` declaration (`typeof __WAZIR_VERSION__ === 'string' ? __WAZIR_VERSION__ : '0.2.13'`).
  - Converted top-level heavy imports in `apps/cli/src/index.ts`, `apps/cli/src/mcp.ts`, and `apps/cli/src/web.ts` to lazy dynamic imports inside command action handlers and tracked MCP runtime usage via `wasMCPRuntimeUsed()` so `closeMCPRegistries()` is only loaded and called when MCP was actually used.
  - Rebuilt standalone bundle `bin/wa.js` via `node scripts/bundle.mjs` (bundle size reduced from `19.5 MB` to `18.8 MB`).

| Metric / Path | Before Optimization | After Optimization | Budget / Target |
| :--- | :--- | :--- | :--- |
| Top-level `@wazir/core`, `@wazir/tools`, `@wazir/secrets`, `@modelcontextprotocol/client` imports on `wa --version` / `wa --help` | Eagerly loaded on every invocation | **0** (100% lazy-loaded on command execution) | 0 heavy packages loaded on `--version` / `--help` |
| `wa --version` internal JS execution (`cli.entry` → `cli.fast_version`) | Full module graph + Commander tree construction | **< 2 ms** (verified `< 25 ms` budget in `tuiGoalStudioPerformance.test.ts`) | `< 25 ms` internal JS |
| `wa --version` & `wa --help` subprocess wall time | Slow due to eager `@wazir/core` + `@wazir/tools` load | **~45–90 ms** per subprocess (verified `< 350 ms` in `tuiGoalStudioPerformance.test.ts`) | `< 350 ms` subprocess wall time |

---

### 2.2 TUI Controller Modularization, Goal Studio View, Shortcut Discoverability & Command Feedback
- **Root Cause**:
  1. `FleetTui` lacked a dedicated Goal Studio view (`'goals'`) and modular rendering helpers for `@wazir/goals` (`GoalPhase`, `TargetStatus`, `GoalRunStatus`, `GoalRunLedger`, `GoalGraphDefinition`).
  2. Keyboard shortcuts for Goal Studio (`7` / `g` / `/goals`) and immediate status inspection (`/status`) were not surfaced in the Mission Control header or Help view, and several view-switching or unknown `/...` slash commands either had no status bar feedback or fell through to task submission.
- **Fix Implemented**:
  - Created `apps/cli/src/tui/goalStudioPanel.ts` and exported its public API from `apps/cli/src/tui/index.ts`:
    - `GOAL_PRIMARY_LIFECYCLE_PHASES` & `GOAL_RECOVERY_PHASES`
    - `TUI_KEYBOARD_SHORTCUTS` & `formatShortcutFooterHint`
    - `formatGoalPhaseIndicator`, `formatTargetStatusBadge`, `formatGoalRunStatusBadge`, `summarizeGoalTargets`, `renderGoalStudioPane`
    - `formatCommandFeedback`
  - Explicitly surfaces the Goal Studio invariant in both target badges (`[COMPLETED ✓ unlocks deps]` vs `[VERIFIED · awaiting gate/commit]`) and the Goal Studio header (`Invariant: Only COMPLETED unlocks dependents; VERIFIED alone never does.`).
  - Wired `'goals'` into `TuiView` (`apps/cli/src/tui/fleetTuiTypes.ts`), `renderGoalPane` (`apps/cli/src/tui/fleetTuiPanes.ts`), `missionHeader` (`apps/cli/src/tui/missionControl.ts`), and `FleetTui` (`apps/cli/src/tui/fleetTui.ts`) via key `7` / `g`, `/goals`, `/status`, and unknown `/...` command handling.

---

### 2.3 Terminal Cleanup & `AbortController` Cancellation
- **Root Cause**:
  - `TerminalSession` and `FleetTui` did not accept an external `AbortSignal` (`options.signal`) or expose an internal session `AbortSignal` that aborts on cleanup/stop, making programmatic cancellation require manual `.stop()` / `.cleanup()` calls.
- **Fix Implemented**:
  - Updated `TerminalSession` (`apps/cli/src/tui/terminalSession.ts`) to accept `signal?: AbortSignal` in `TerminalSessionOptions`, expose `session.signal: AbortSignal`, automatically run idempotent `cleanup()` (restoring cursor visibility, raw mode, and alternate screen) when the external signal aborts, and abort `session.signal` when `cleanup()` runs.
  - Updated `FleetTui` (`apps/cli/src/tui/fleetTui.ts`, `apps/cli/src/tui/fleetTuiTypes.ts`) to accept `signal?: AbortSignal` in `FleetTuiOptions`, expose `tui.getAbortSignal()`, and cleanly invoke `stop('interrupt')` (restoring terminal state via `screen.leave()`) when aborted.

---

## 3. Files Owned & Modified

- `apps/cli/src/startupProfiler.ts` (new)
- `apps/cli/src/index.ts` (modified)
- `apps/cli/src/mcp.ts` (modified)
- `apps/cli/src/web.ts` (modified)
- `apps/cli/src/engine.ts` (modified)
- `apps/cli/src/tui/goalStudioPanel.ts` (new)
- `apps/cli/src/tui/fleetTuiTypes.ts` (modified)
- `apps/cli/src/tui/fleetTuiPanes.ts` (modified)
- `apps/cli/src/tui/fleetTui.ts` (modified)
- `apps/cli/src/tui/missionControl.ts` (modified)
- `apps/cli/src/tui/terminalSession.ts` (modified)
- `apps/cli/src/tui/index.ts` (modified)
- `apps/cli/tests/tuiGoalStudioPerformance.test.ts` (new)
- `bin/wa.js` (rebuilt bundle)
- `reports/goal-studio-12-agents/agent-11.md` (new)

---

## 4. Verification & Test Results

1. **TypeScript Build (`npx tsc --build`)**:
   - Exit code: `0` (0 errors across all workspace packages).
2. **Vitest Verification (`npx vitest run apps/cli/tests/tuiGoalStudioPerformance.test.ts apps/cli/tests/canonicalVersion.test.ts apps/cli/tests/phase6Maintainability.test.ts apps/cli/tests/tuiSessionLifecycle.test.ts apps/cli/tests/terminalArchitecture.test.ts`)**:
   - `apps/cli/tests/tuiGoalStudioPerformance.test.ts`: **7 passed (7)**
   - `apps/cli/tests/canonicalVersion.test.ts`: **1 passed (1)**
   - `apps/cli/tests/phase6Maintainability.test.ts`: **3 passed (3)**
   - `apps/cli/tests/tuiSessionLifecycle.test.ts`: **10 passed (10)**
   - `apps/cli/tests/terminalArchitecture.test.ts`: **45 passed (45)**
   - Total: **5 test files passed, 66 tests passed, 0 failed**.

---

## 5. Integration Notes

- No changes were required to `packages/goals/src/contracts.ts` or `apps/cli/src/commands/goalCommands.ts` (owned by Agent 07).
- When merging with Agent 07 (`feat/parallel-cli-api`), Agent 07's `registerGoalCommands(program)` can be registered in `apps/cli/src/index.ts` and can optionally pass live `GoalRunLedger` / `GoalGraphDefinition` snapshots to `FleetTui.setGoalStudioSnapshot({ run, graph, activePhase })`.
