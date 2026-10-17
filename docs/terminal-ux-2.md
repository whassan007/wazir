# Terminal UX 2.0

`wa chat` opens the inline conversation interface. It uses the primary terminal
screen and normal scrollback. Completed transcript lines are written once;
conversation mode does not enable mouse reporting or enter the alternate
screen. `wa fleet` and `wa chat --dashboard` open the existing full-screen
fleet dashboard. `wa chat --legacy` is retained as an explicit migration
fallback to that dashboard. `/fleet` and `/chat` switch presentation in the
same running TUI, so active jobs remain owned by the same orchestrator and
prompt state stays in memory.

## Controls

| Key | Action |
| --- | --- |
| Enter | Submit a single-line prompt |
| Shift+Enter | Insert a newline on terminals that report the modifier |
| `\` then Enter | Insert a newline on terminals without a distinguishable Shift+Enter |
| Ctrl+Enter | Explicitly submit a multiline composer/paste |
| Up / Down | Recall conversation history at the input edge |
| Left / Right | Move the cursor by grapheme; Ctrl+Left/Right moves by word |
| Home / End | Move to the beginning/end of the prompt |
| Backspace / Delete | Remove a grapheme before/at the cursor |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo the latest input edit |
| Esc | Close an input review; otherwise interrupt active work; with no work, clear the prompt |
| Ctrl+C | First press interrupts active work; a second press exits. When idle, exits |
| Ctrl+Y | Enter copy mode; arrows move by transcript line, `V` marks a range, `Y` copies, Esc exits |
| Ctrl+L | Repaint the dashboard; transcript output remains in scrollback |
| `/fleet` / `/chat` | Switch between dashboard and conversation |
| `/logs` or `/details` | Print the most recent detailed tool/event log |
| `/tail` | Print the selected task's response or recent task events |
| `/quiet`, `/verbose`, `/debug` | Change event detail level (`normal` is the default) |
| `/help`, `/tasks`, `/models` | Existing help/task/model views and commands |

Bracketed paste is buffered and never submits on its own. Multiline or large
paste enters a review barrier: press `E` to load it into the editable composer,
then explicitly submit with Ctrl+Enter; Enter and pasted approval letters do
not approve or submit. Single-line small paste goes directly into the editable
prompt. Native paste chords are left to the terminal emulator. Wazir does not
automatically write clipboard data. Keyboard copy uses OSC52 only when
`WAZIR_OSC52=1` is explicitly set and the terminal type is recognized. It
rejects selections over 100 KB and text matching credential patterns. Without
that opt-in, copy mode remains available for keyboard navigation and terminal
native selection remains available.

Conversation mode emits no color by default and therefore honors `NO_COLOR`.
When stdout is redirected, the header and initial prompt are plain text with no
cursor sequences or spinner; later durable results are appended as plain text.
Interactive conversation mode uses Unicode terminal-cell widths and limits
the live editor region to at most nine rows.

The interface is a presentation over the existing `JobOrchestrator` event
stream. Per-task terminal states are absorbing in the display projection;
usage telemetry remains accepted after completion, and runtime lifecycle
events cannot replace a terminal job status. Tool and verification details are
summarized only from recorded outcomes. Full engine telemetry and audit events
remain unchanged and can be inspected with `/logs`, `/details`, `/tail`, or the
fleet dashboard.

Mouse drag, word/line selection, and native terminal copy are not intercepted:
conversation mode does not enable mouse tracking. Native copy/paste bindings
are emulator-specific (commonly Ctrl+Shift+C/V on Linux, Cmd+C/V on macOS, and
terminal-specific bindings in VS Code, Windows Terminal, GNOME Terminal, and
iTerm2). These emulator interactions must be validated in the user's actual
terminal; automated byte-stream tests verify only that Wazir does not turn on
mouse reporting or overwrite transcript rows during activity updates.
