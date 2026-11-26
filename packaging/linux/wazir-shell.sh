#!/bin/sh
# /usr/bin/wazir-shell — Wazir Shell launcher (contract C1).
#   wazir-shell [--cwd <dir>] [--attach <path>]... [-c <input>]
# Arguments are forwarded verbatim as "$@"; they are never joined into a string
# or evaluated by a shell.
GUI_BIN="${WAZIR_SHELL_GUI_BIN:-/usr/lib/wazir/wazir-shell-bin}"
WA_JS="${WAZIR_SHELL_WA_JS:-/usr/lib/wazir/wa.js}"
TERM_HELPER="${WAZIR_SHELL_TERM_HELPER:-/usr/lib/wazir/wazir-shell-terminal}"

has_display=0
if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
  has_display=1
fi

# 1. Native GUI when installed and a display is available.
if [ -x "$GUI_BIN" ] && [ "$has_display" = 1 ]; then
  exec "$GUI_BIN" "$@"
fi

# 2. Interactive TTY (or no display at all): run the CLI shell in place.
if [ -t 0 ] || [ "$has_display" = 0 ] || [ -n "${WAZIR_SHELL_IN_TERMINAL:-}" ]; then
  exec node "$WA_JS" shell "$@"
fi

# 3. No TTY but a display (e.g. launched from a .desktop file without the GUI):
#    open a terminal emulator running the CLI shell instead of a headless process.
export WAZIR_SHELL_IN_TERMINAL=1
if command -v x-terminal-emulator >/dev/null 2>&1; then
  exec x-terminal-emulator -e "$TERM_HELPER" "$@"
fi
if command -v gnome-terminal >/dev/null 2>&1; then
  exec gnome-terminal -- "$TERM_HELPER" "$@"
fi
echo "wazir-shell: no GUI binary and no terminal emulator (x-terminal-emulator, gnome-terminal) found; running headless" >&2
exec node "$WA_JS" shell "$@"
