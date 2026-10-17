# Terminal interface verification — 2026-10-17

In v0.2.4, `wa chat` opens Wazir's conversation-first coding interface. `wa fleet` and `wa chat --dashboard` open Mission Control through the same FleetTui execution/input controller. `/fleet` and `/chat` switch views in a running session. The installed Homebrew command and `~/.local/bin/wa` both report v0.2.4.

The v0.2.3 release made Mission Control the default for `wa chat`, which hid the conversation-first interface previously added by commit `06f3fe0`. The release retained no active presentation selector for that mode. This update restores that implementation and exposes Mission Control as the explicit fleet view.

## Why the redesign was missing

- `apps/cli/src/index.ts` instantiated FleetTui directly in dashboard mode. Commit `7f4b673` implemented inline shell commands and task/approval cycling, not a new visual shell.
- `feat/terminal-ux-2` points at `06f3fe0`, a conversation-first implementation with a separate presentation path. Although that commit appears in merged ancestry, its conversation renderer, transcript store, and presentation-mode options are absent from the active tree. No current flag enables them.
- Reviewed all branches and worktrees with `git branch --all`, `git worktree list`, and TUI path history. The active tree retained the older FleetTui composition.
- `layout.ts` and `renderer.ts` provide standalone geometry/rendering primitives; FleetTui composes rows itself and TerminalScreen converts those rows to TerminalFrame and FrameDiffer patches. Changing the standalone renderer alone would not change `wa chat`.
- Existing Mission Control features include job output expansion, execution/tool logs, approvals, evidence inspection, error recovery, model startup, shell mode, and task cycling. They remain available in `wa fleet` and dashboard mode.
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
| [Conversation-first chat](after-chat-wide.png) | Installed `/opt/homebrew/bin/wa chat` | 120×36 |
| [Conversation-first chat, narrow](after-chat-narrow.png) | Installed `/opt/homebrew/bin/wa chat` | 60×14 |
| [Wide + official logo](after-wide.png) | Installed `/opt/homebrew/bin/wa chat` | 160×50 |
| [Mission Control, narrow](installed-narrow.png) | Installed `/opt/homebrew/bin/wa fleet` | 64×24 |

Each screenshot comes from a real Python `pty.fork` process with a terminal size set by `TIOCSWINSZ`. Raw `.ansi` captures are replayed through `@xterm/headless`; SVGs preserve the resulting terminal cells and colors, and the SVGs are rasterized to PNG. This is a rendering of captured terminal output, not a mockup. Mission Control captures use `TERM=xterm-256color`, `COLORTERM=truecolor`, and clear inherited `NO_COLOR`; conversation captures preserve the conversation mode's default no-color output. The original source renderer was substituted only in a temporary baseline bundle, without altering the working source.

PTY interactions were replayed and checked against terminal contents:

- Home → Models → next model → Enter: `Pinned model: adept/fuyu-8b`.
- `6`: Evidence view; `1`: Home.
- Tab: Tail → Approval → Worktrees; Shift-Tab reverses.
- Home + Enter: actual persisted `JOB OUTPUT` modal; Escape closes.
- `!printf mission-shell-verified`: actual workspace shell execution, exit 0, referenceable history block.
- Ctrl+C: terminal teardown; deterministic lifecycle tests separately cover raw mode/alternate-screen cleanup and EOF.
- Conversation PTY: `wa chat` renders on the primary screen with a persistent prompt; `/help` prints available slash commands and `/exit` restores terminal input modes.

`after-*.ansi` and corresponding text captures preserve these interaction states. `capture-pty.py` and `render-capture.cjs` are included for replay from the repository root. For example:

```sh
python3 docs/verification/mission-control/capture-pty.py review node 140 42 bin/wa.js chat
node docs/verification/mission-control/render-capture.cjs review 140 42
```

The capture script executes a harmless printf shell command, which records a Wazir history block.

## Build and tests

- `npm run build`: all workspace builds and standalone bundle passed for v0.2.4.
- v0.2.4 targeted terminal/conversation selection: 5 files, 111 tests passed, including quick actions, paste barriers, PTY exit/resize, and dashboard behavior.
- `npm run typecheck`, `npm run check-dist -- --quiet`, `npm run package:check -- --skip-build` (14/14 checks), `npm run release:verify`, and `npm run release:gate` passed on macOS arm64.
- TUI/regression selection: 17 files, 259 tests passed. Includes fleet TUI, session lifecycle, acceptance, canary, fleet runner, spinner, doctor, task execution, and Mission Control projection tests.
- Terminal regression selection: 12 files, 180 tests passed. Includes terminal architecture/integrity, execution projection, branding, references, and paste barrier.
- Focused final check: model browsing/pinning, restored-job landing, adaptive dashboard, and existing FleetTui tests passed.
- Vitest's repository-wide discovery also includes matching tests in the pre-existing `tmp/p0-remediation` worktree; these counts include those mirror runs. Logs are preserved alongside this report.
- `chat --help`, `fleet --help`, `models --help`, source version and installed version checked. Command flags/aliases remain compatible.
- `git diff --check` passed.

`which -a wa` resolves `/opt/homebrew/bin/wa` first, followed by `~/.local/bin/wa`. Both launch the installed package at `/opt/homebrew/lib/node_modules/wazir/bin/wa.js`; both report the v0.2.4 release commit.

## Protected development and changed files

The interface work is isolated in the `fix/codex-style-chat` worktree based on v0.2.3. The active `feat/nvidia-execution-provider` checkout retains its existing staged and unstaged NVIDIA integration changes; none were staged, reset, cleaned, stashed, or overwritten during this work.

Source/test changes:

- `apps/cli/src/index.ts`: conversation-first default for `chat`; explicit dashboard mode for `fleet` and `chat --dashboard`.
- `apps/cli/src/tui/fleetTui.ts`: shared execution/input controller with conversation and dashboard presentations.
- `apps/cli/src/tui/conversationRenderer.ts`, `statusProjection.ts`, `eventSummarizer.ts`, and terminal helper modules: transcript, readable progress, and primary-screen rendering.
- `apps/cli/src/tui/missionControl.ts`: new responsive Mission Control presentation.
- `apps/cli/tests/fleetTui.test.ts`: visual expectations, model selection and persisted-job landing regression coverage.
- `apps/cli/tests/acceptanceTui.test.ts`: updated header/landing expectation.
- `apps/cli/tests/missionControl.test.ts`: compact layout and truthful telemetry checks.
- `docs/verification/mission-control/`: captured screens, interaction recordings, replay helpers, and validation logs.

The generated ignored `bin/wa.js` is rebuilt after the implementation commit so its build metadata points to that commit. It also contains the user's uncommitted NVIDIA integration, because verification used the active working tree.
