#!/bin/sh
# /usr/lib/wazir/wazir-shell-terminal — runs `wa shell "$@"` inside a terminal
# emulator spawned by /usr/bin/wazir-shell, and keeps the window open after a
# one-shot `-c` request so its output stays readable.
WA_JS="${WAZIR_SHELL_WA_JS:-/usr/lib/wazir/wa.js}"
one_shot=0
for arg in "$@"; do
  case "$arg" in
    -c|--command|--command=*) one_shot=1 ;;
  esac
done
node "$WA_JS" shell "$@"
status=$?
if [ "$one_shot" = 1 ]; then
  printf '\n[wazir-shell exited with status %s] Press Enter to close.' "$status"
  read -r _ || true
fi
exit "$status"
