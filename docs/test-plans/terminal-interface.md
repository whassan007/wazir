# Wazir — Terminal Interface Test Plan

Status: active · Owner: Wazir CLI team · Applies to: `wa chat` / `wa fleet` (interactive TUI), terminal primitives (TerminalScreen, spinner/status), and the terminal one-shot/diagnostic CLI surfaces.

## 1. Purpose

This plan defines the executable test program for everything Wazir renders into a terminal: the fleet-scale interactive TUI (dashboard, tail, approval queue, worktrees, help views; input line, modals, pickers), the terminal feedback primitives (braille spinner, status loader, non-TTY fallbacks), and the one-shot/diagnostic command paths that print to the terminal.

Every case below has a stable ID and maps 1:1 to an automated test. The plan is not a paper artifact: `node scripts/tui-test-plan.mjs` runs the entire matrix and reports per-case PASS/FAIL/SKIP/MISSING, so "the plan is green" is a checkable claim.
## 2. Scope

In scope:
- `apps/cli/src/tui/fleetTui.ts` — interactive fleet TUI (views, navigation, input line, modals, pickers, job/agent management, approvals)
- `apps/cli/src/tui/terminalScreen.ts` — alt-screen rendering, raw mode, keypress binding, resize, non-TTY fallback
- `apps/cli/src/tui/inputHarness.ts` — the TuiTestHarness used to drive the TUI headlessly in tests
- `apps/cli/src/tui/spinner.ts` / `spinnerAndStatus.ts` — terminal feedback primitives (braille frames, in-place updates, withSpinner)
- `apps/cli/src/fleetRunner.ts` — the runner that ties orchestrator progress events into terminal output
- `apps/cli/src/doctor.ts` — `wa doctor` terminal diagnostic surface
- one-shot task execution terminal path (`executeTask` e2e)

Out of scope (covered by other plans / the repo-wide `npm test`):
- web dashboard UI
- remote fleet SSE transport (covered under its own plan)
- model runtime adapters (covered under `runtimes` plans)

## 3. Test levels

| Level | Meaning |
|-------|---------|
| L1 | Terminal primitive (single module, no engine) — TerminalScreen, spinner |
| L2 | TUI harness — real FleetTui + fake RookEngine + TuiTestHarness, headless |
| L3 | End-to-end terminal path — real orchestrator/execution through the terminal surface |
| L4 | CLI command surface — `wa doctor` check suite |

## 4. Environment & prerequisites

- Node.js >= 20 (repo baseline), pnpm workspaces built (`npm run build` — dist/ must be fresh; the runner enforces this)
- No display, no network, no real model required: every L2/L3 case runs against a fake `RookEngine` (fake adapter yields a plan → done cycle) or pure primitives
- Linux/macOS/Windows bash-compatible shell; CI-safe (no interactive terminal needed)

## 5. Running the plan

```bash
# Full executable plan (build-if-stale → run suites → per-case matrix → report)
node scripts/tui-test-plan.mjs

# Subsets / CI knobs
node scripts/tui-test-plan.mjs --skip-build                # trust existing dist/
node scripts/tui-test-plan.mjs --only TUI-001,TUI-002      # specific cases
npm run test:tui          # raw vitest run of all suites in the matrix
npm run test:plan:tui     # alias for the plan runner
```

The runner writes `test-plan-report.json` (gitignored) with per-case status, vitest totals, and timestamps. Exit code 0 ⇒ every case PASS (SKIP allowed); 1 ⇒ any FAIL or MISSING (plan/code drift); 2 ⇒ plan itself broken (unknown ids, missing files).

## 6. Test case matrix

Priority: B = blocking (session safety / correctness), R = regression, F = feature.
Status vocabulary: PASS · FAIL · SKIP · MISSING (case not found in code — drift).

### A. Session lifecycle & terminal hygiene
| ID | Case | Entry | Level | Pri |
|----|------|-------|-------|-----|
| TUI-001 | `/exit` exits, restores terminal (alt-screen leave, cursor on), detaches TUI input listeners | tuiSessionLifecycle: `exits the session on /exit, restores the terminal, and detaches all input listeners` | L2 | B |
| TUI-002 | `/quit` exits and resolves `waitForExit` for all waiters | tuiSessionLifecycle: `exits the session on /quit and resolves waitForExit exactly once` | L2 | B |
| TUI-003 | bare `q` at the prompt exits; `q` mid-word does not | tuiSessionLifecycle: `exits the session on a bare q at the prompt` | L2 | R |
| TUI-004 | Ctrl+C terminates with exit code 0 after full teardown | tuiSessionLifecycle: `terminates cleanly on Ctrl+C with exit code 0 and full cleanup` | L2 | B |
| TUI-005 | `stop()` clears render timer, resize listeners, rejection guard | tuiSessionLifecycle: `stop() clears the render timer, resize and event subscriptions, and the rejection guard` | L2 | B |
| TUI-006 | raw mode + keypress binding + explicit steady-box cursor (DECSCUSR) on enter, reset on leave | fleetTui: `verifies raw mode and keypress binding on TerminalScreen` | L1 | R |

### B. Navigation & view management
| ID | Case | Entry | Level | Pri |
|----|------|-------|-------|-----|
| TUI-010 | initial dashboard render, Tab view cycling, `/help` pane | fleetTui: `renders initial dashboard, transitions between views via keyboard shortcuts, and displays help` | L2 | B |
| TUI-011 | Up/Down navigation across nav categories with cursor + glyphs | fleetTui: `supports generalized Up/Down navigation across categories with status glyphs and cursor` | L2 | R |
| TUI-012 | Shift-Tab reverse, Ctrl+L repaint, Ctrl+R refresh, `?` help | fleetTui: `supports Tier 2 navigation keybindings: Shift-Tab reverse traversal, Ctrl+L repaint, Ctrl+R refresh, and ? help toggle` | L2 | R |
| TUI-013 | view switch redraws cleanly; no job-id/buffer residue in panes | fleetTui: `clean view transition: Tab triggers clean redraw without leaking job ID fragments or residual buffer characters into active log pane` | L2 | R |
| TUI-014 | each view uses its own template; no text ghosting/clipping | fleetTui: `clears screen on view switch to prevent text ghosting, renders independent view templates, and updates view title without clipping` | L2 | R |
| TUI-015 | Tab toggles focus without falling through to input/pickers | fleetTui: `isolates Tab key events in global keypress listener and toggles target focus with early return` | L2 | R |

### C. Job & agent management
| ID | Case | Entry | Level | Pri |
|----|------|-------|-------|-----|
| TUI-020 | fanout job → 3 live agents → tail view with token usage + rollup | fleetTui: `submits a multi-agent fanout job, displays live agent states, and tails an agent stream` | L2 | B |
| TUI-021 | no token leakage between jobs sharing default task ids | fleetTui: `does not leak tokens between jobs that would otherwise share the same default task id` | L2 | B |
| TUI-022 | cancel selected job via `c` and `/cancel`, incl. reloaded jobs | fleetTui: `cancels a selected job via the c key and /cancel, even one not launched this session` | L2 | R |
| TUI-023 | `/cancel <job-id>` cancels a pending job by explicit id | tuiSessionLifecycle: `cancels a pending job by explicit id via /cancel <job-id>` | L2 | R |
| TUI-024 | cancelling a finished job reports error, does not crash process | fleetTui: `pressing c on an already-finished job reports an error instead of crashing the process` | L2 | B |
| TUI-025 | Delete key removes completed job from JOBS list | fleetTui: `deletes a completed job from the JOBS list via the Delete key` | L2 | R |
| TUI-026 | x/Delete on non-JOBS item gives feedback instead of no-op | fleetTui: `gives feedback instead of silently no-oping when x/Delete is pressed on a non-JOBS item` | L2 | F |
| TUI-027 | worktrees pane shows per-agent isolated branch names | tuiSessionLifecycle: `renders the worktrees view with per-agent isolated branch names` | L2 | F |
| TUI-028 | event-stream pane with typed lifecycle states (PLAN/ROUTE/TOOL/TEST/COMPLETE/ERROR) | fleetTui: `renders scrollable event-stream activity pane with typed lifecycle states (PLAN, ROUTE, TOOL, TEST, COMPLETE, ERROR)` | L2 | F |
| TUI-029 | a failed tool call shows a plain-language reason, not the raw policy rule id | fleetTui: `shows a failed tool call with a plain-language reason, not the raw policy rule id` | L2 | F |

### D. Approvals & policy
| ID | Case | Entry | Level | Pri |
|----|------|-------|-------|-----|
| TUI-030 | non-blocking approval queue + mid-run steering | fleetTui: `handles in-TUI non-blocking approval queue and mid-run steering` | L2 | B |
| TUI-031 | policy modal with A/D/V/I actions | fleetTui: `displays overlaid policy approval modal with [A], [D], [V], [I] actions` | L2 | B |
| TUI-032 | Ctrl+A / Ctrl+D approve/deny all queued at once | fleetTui: `supports Ctrl+A / Ctrl+D to approve or deny all queued policy requests at once` | L2 | R |
| TUI-033 | approval view has its own layout, no column collision | fleetTui: `renders approval view with dedicated layout template that does not collide with execution table columns` | L2 | F |
| TUI-034 | a pending `edit` approval shows a line diff instead of raw JSON args | fleetTui: `shows a line diff for a pending edit approval instead of a raw JSON args blob` | L2 | F |
| TUI-035 | a pending `write` approval shows a labeled content preview, not a diff (no reliable on-disk path to diff against) | fleetTui: `shows a labeled content preview (not a diff) for a pending write approval` | L2 | F |

### E. Input & text editing
| ID | Case | Entry | Level | Pri |
|----|------|-------|-------|-----|
| TUI-040 | backspace, Delete, Ctrl+W, Ctrl+U buffer editing | fleetTui: `correctly handles backspace, delete, Ctrl+W, and Ctrl+U in the input buffer` | L2 | R |
| TUI-041 | backspace/delete slice buffer + re-render prompt immediately | fleetTui: `correctly handles backspace and delete key events, slicing buffer and re-rendering prompt immediately` | L2 | R |
| TUI-042 | Tab never leaks into input buffer | fleetTui: `intercepts Tab key without leaking control characters or literal \t into the input buffer` | L2 | B |
| TUI-043 | nav keys / unparsed ANSI never echo into buffer or streams | fleetTui: `prevents stream echo: navigation keys and unparsed ANSI codes never bind into input buffer or log streams` | L2 | R |
| TUI-044 | bracketed paste barrier & multiline review mode | pasteBarrier: `enters PASTE review mode on multiline paste and creates exactly 0 jobs until explicit Ctrl+Enter` | L2 | B |
| TUI-045 | rendered screen fragment rejection and accidental submission circuit breaker | pasteBarrier: `pasting the entire rendered Fleet screen creates exactly 0 jobs` | L2 | B |

### F. Layout & rendering fidelity
| ID | Case | Entry | Level | Pri |
|----|------|-------|-------|-----|
| TUI-050 | 2-pane layout at >=100 cols, collapse below | fleetTui: `renders persistent 2-pane layout when columns >= 100 and collapses when < 100` | L2 | F |
| TUI-051 | live token-budget indicator in status bar | fleetTui: `wires up real-time token budget context indicator in status bar` | L2 | F |
| TUI-052 | structured error card (phase, reason, required, available, fixes) | fleetTui: `renders structured error card with phase, reason, required, available, and suggested resolution steps` | L2 | R |
| TUI-053 | history strip wired to blocks + details modal | fleetTui: `renders history strip wired to blocks and expands block details modal` | L2 | R |
| TUI-054 | `@` reference fuzzy picker + Tab completion | fleetTui: `triggers @ reference fuzzy picker and completes candidate on Tab` | L2 | R |
| TUI-055 | Ctrl+P quick-actions palette: filter + select | fleetTui: `supports Ctrl+P quick actions palette modal navigation, filtering, and selection` | L2 | F |

### G. Terminal feedback primitives (spinner / status)
| ID | Case | Entry | Level | Pri |
|----|------|-------|-------|-----|
| TUI-060 | standard braille frame rotation (§1) | spinner: `uses standard Unicode braille pattern animation frames (§1)` | L1 | F |
| TUI-061 | in-place updates, no scrollback flood (§2) | spinner: `performs in-place terminal updates without flooding scrollback history (§2)` | L1 | R |
| TUI-062 | bound to execution phases; clean stop on completion (§3) | spinner: `binds spinner activation to active execution phases and safely stops/clears on completion (§3)` | L1 | R |
| TUI-063 | withSpinner success lifecycle (§3) | spinner: `supports withSpinner helper for automatic lifecycle binding (§3)` | L1 | F |
| TUI-064 | withSpinner error marks failure safely (§3) | spinner: `handles errors inside withSpinner safely and marks failure (§3)` | L1 | R |
| TUI-065 | non-TTY fallback, no escape sequences | spinner: `provides clean non-TTY stream fallback without flooding or escape sequences` | L1 | B |

### H. End-to-end terminal paths
| ID | Case | Entry | Level | Pri |
|----|------|-------|-------|-----|
| TUI-070 | fleetRunner reports each tool call to onProgress exactly once | fleetRunner.e2e: `reports each tool call to onProgress exactly once, not twice` | L3 | B |
| TUI-071 | TerminalScreen non-TTY + stream fallback | fleetTui: `provides non-TTY and stream fallback in TerminalScreen` | L1 | B |
| TUI-072 | `wa doctor` diagnostics suite — all check families (config, persistence, control plane, worker, registration, runtime connectivity, models, permissions, scheduler) | doctor.test.ts (whole file) | L4 | R |
| TUI-073 | one-shot task execution terminal path — plan → policy-gated tools → result, denial e2e, JSON stream mode | executeTask.e2e.test.ts (whole file) | L3 | B |

## 7. Acceptance criteria

A terminal-interface change is mergeable when:
1. `node scripts/tui-test-plan.mjs` exits 0 (all 48 cases PASS or SKIP; no FAIL/MISSING)
2. All priority-B cases PASS (session safety: exit paths, cleanup, no buffer leakage, non-TTY fallback, approval flow, single progress emission, one-shot task path)
3. New interactive behavior ships with a new TC added to §6 and the runner matrix (same-day)
4. No case may be deleted to make the plan green; it is renamed or retired with a reason in the commit

## 8. Known residuals & manual checklist

Known residual (documented, asserted in TUI-001/004/005):
- `readline.emitKeypressEvents()` parks one anonymous `data` parser on stdin during `screen.enter()`; `stop()` removes the TUI's own handlers but not readline's. Harmless on `process.stdin` (the parser is inert once raw mode is off) but tracked for a future `screen` cleanup pass.

Manual checklist (run by hand when terminal regressions are suspected; not in CI):
- [ ] `wa chat` in a 80x24, 100x40, and 200x60 terminal — no clipping, pane collapse correct
- [ ] type a long prompt, mash Up/Down — buffer preserved across view switches
- [ ] paste a multi-line block — no keypress storm, buffer sane
- [ ] Ctrl+Z → SIGTSTP (if wired) / Ctrl+C → shell prompt clean, no raw-mode residue
- [ ] resize window mid-stream — layout reflows, no garbage rows
- [ ] non-TTY: `wa chat < prompt.txt > out.log` — plain text, zero escape sequences
- [ ] Windows Terminal + tmux + screen — braille frames and alt-screen behave

## 9. Maintenance

- Source of truth for case→test mapping: `scripts/tui-test-plan.mjs` (CASES array). §6 above is generated from it — keep them in sync when renaming tests.
- MISSING in the report means a renamed/deleted test — fix the mapping or restore the test, never ignore.
- Report artifact: `test-plan-report.json` (gitignored). CI can upload it as an artifact.
- Related docs: `docs/sandbox.md` (sandbox isolation), `docs/wazir_features_and_comparison.md` (feature surface).
