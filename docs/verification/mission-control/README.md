# Mission Control verification — 2026-10-17

The active `chat` command and its `fleet` alias now open Mission Control through the existing FleetTui execution/input controller. No flag is required. The source and PATH executable report version 0.2.2.

## Why the redesign was missing

- `apps/cli/src/index.ts` instantiated FleetTui directly. Commit `7f4b673` implemented inline shell commands and task/approval cycling, not a new visual shell.
- `feat/terminal-ux-2` points at `06f3fe0`, a conversation-first implementation with a separate presentation path. Although that commit appears in merged ancestry, its conversation renderer, transcript store, and presentation-mode options are absent from the active tree. No current flag enables them.
- Reviewed all branches and worktrees with `git branch --all`, `git worktree list`, and TUI path history. The active tree retained the older FleetTui composition.
- `layout.ts` and `renderer.ts` provide standalone geometry/rendering primitives; FleetTui composes rows itself and TerminalScreen converts those rows to TerminalFrame and FrameDiffer patches. Changing the standalone renderer alone would not change `wa chat`.
- Existing working features included job output expansion, execution/tool logs, approvals, evidence inspection, error recovery, model startup, shell mode, and task cycling. They were buried behind the old header and selected registry/job detail view.
- The old overview fabricated DGX/Mac/PC workers and hardware readings. Task and model detail paths also fabricated checks, token counts, prices, and benchmark evidence. Those paths now use real registries, task cards, and evidence inspection, with explicit unknown/unreported states.

## Implemented

- Mission Control landing page, including when persisted jobs exist; workspace identity and persistent view navigation.
- Official logo from `brand.ts`: crown/shield and WAZIR wordmark when space permits, compact official logo at smaller sizes.
- Adaptive split/single-pane layouts and compact operational sections at 64×24.
- Live job monitor, registered agents, distinct ready model counts, provider/runtime state, session usage, activity/tool events, approval count, and verification summary.
- Arrow navigation retains registry and job inspectors; Enter expands job output. `1` returns Home, `5` opens model/provider browsing, `6` opens verification evidence.
- Models: arrows/j/k browse all registered models; Enter pins the selected model through the existing routing state. `/model auto` clears the pin.
- Existing Tab/Shift-Tab views, task cycling, shell commands, approval actions, paste barrier, cancellation, and recovery remain connected to the existing controller.
- Adaptive status footer preserves actionable messages and separates usage from status text.

Costs are explicitly **unreported**: the records consumed here do not contain authoritative billed costs. The old fixed per-token price was removed. Persisted job token totals remain available in the job inspector. No model execution was purchased for the screenshots; they show actual local registry/history state, with execution behavior covered by deterministic end-to-end tests.

## Actual terminal captures

| Capture | Command | Dimensions |
| --- | --- | --- |
| [Before](before.png) | Original `53f7c88` FleetTui, bundled against the same working entry point | 140×42 |
| [After](after.png) | `node bin/wa.js chat` | 140×42 |
| [Wide + official logo](after-wide.png) | Installed `/opt/homebrew/bin/wa chat` | 160×50 |
| [Narrow](installed-narrow.png) | Installed `/opt/homebrew/bin/wa fleet` | 64×24 |

Each screenshot comes from a real Python `pty.fork` process with a terminal size set by `TIOCSWINSZ`. Raw `.ansi` captures are replayed through `@xterm/headless`; SVGs preserve the resulting terminal cells and colors, and Chrome rasterizes them to PNG. This is a rendering of captured terminal output, not a mockup. TERM=xterm-256color, COLORTERM=truecolor; inherited NO_COLOR is cleared for the color comparison. The original source renderer was substituted only in a temporary baseline bundle, without altering the working source.

PTY interactions were replayed and checked against terminal contents:

- Home → Models → next model → Enter: `Pinned model: adept/fuyu-8b`.
- `6`: Evidence view; `1`: Home.
- Tab: Tail → Approval → Worktrees; Shift-Tab reverses.
- Home + Enter: actual persisted `JOB OUTPUT` modal; Escape closes.
- `!printf mission-shell-verified`: actual workspace shell execution, exit 0, referenceable history block.
- Ctrl+C: terminal teardown; deterministic lifecycle tests separately cover raw mode/alternate-screen cleanup and EOF.

`after-*.ansi` and corresponding text captures preserve these interaction states. `capture-pty.py` and `render-capture.cjs` are included for replay from the repository root. For example:

```sh
python3 docs/verification/mission-control/capture-pty.py review node 140 42 bin/wa.js chat
node docs/verification/mission-control/render-capture.cjs review 140 42
```

The capture script executes a harmless printf shell command, which records a Wazir history block.

## Build and tests

- `npm run build`: all workspace builds and standalone bundle passed.
- TUI/regression selection: 17 files, 259 tests passed. Includes fleet TUI, session lifecycle, acceptance, canary, fleet runner, spinner, doctor, task execution, and Mission Control projection tests.
- Terminal regression selection: 12 files, 180 tests passed. Includes terminal architecture/integrity, execution projection, branding, references, and paste barrier.
- Focused final check: model browsing/pinning, restored-job landing, adaptive dashboard, and existing FleetTui tests passed.
- Vitest's repository-wide discovery also includes matching tests in the pre-existing `tmp/p0-remediation` worktree; these counts include those mirror runs. Logs are preserved alongside this report.
- `chat --help`, `fleet --help`, `models --help`, source version and installed version checked. Command flags/aliases remain compatible.
- `git diff --check` passed.

The initial shell resolved `wa` to Homebrew 0.1.39, while `~/.local/bin/wa` already launched the source 0.2.2 bundle. `npm install -g . --force --ignore-scripts` updated the executable on PATH. `/opt/homebrew/bin/wa` now points to the current source package's bundled executable, verified in a real PTY.

## Protected development and changed files

All pre-existing tracked changes were captured before editing. A byte comparison of their diff sections confirmed none changed before the deliberate one-line `index.ts` help-description update. The NVIDIA integration files and untracked provider package were not staged or committed. No reset, clean, stash, or checkout was performed.

Source/test changes:

- `apps/cli/src/index.ts`: Mission Control help description only; NVIDIA hunks remain uncommitted.
- `apps/cli/src/tui/fleetTui.ts`: active integration, Home navigation, real task/model/overview projections, adaptive status.
- `apps/cli/src/tui/missionControl.ts`: new responsive Mission Control presentation.
- `apps/cli/tests/fleetTui.test.ts`: visual expectations, model selection and persisted-job landing regression coverage.
- `apps/cli/tests/acceptanceTui.test.ts`: updated header/landing expectation.
- `apps/cli/tests/missionControl.test.ts`: compact layout and truthful telemetry checks.
- `docs/verification/mission-control/`: captured screens, interaction recordings, replay helpers, and validation logs.

The generated ignored `bin/wa.js` is rebuilt after the implementation commit so its build metadata points to that commit. It also contains the user's uncommitted NVIDIA integration, because verification used the active working tree.
