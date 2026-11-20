# Wazir Shell Architecture

## Components

- **Native PTY Backend (`apps/shell/src-tauri/src/main.rs`)**: Uses `portable-pty` to spawn the user's native login shell (`/bin/zsh` / `/bin/bash` / `cmd.exe`) with full `TERM=xterm-256color`, resize (`pty_resize`), multi-tab session management, and Ctrl+C signal propagation.
- **Deterministic Classifier (`packages/core/src/services/shellClassifier.ts`)**:
  - `! <cmd>` -> forced native shell
  - `? <req>` -> forced governed AI
  - Auto mode -> recognizes shell builtins (`cd`, `export`, `unset`, `alias`, `pwd`, `history`), known binaries, pipelines (`|`), redirections (`>`, `<`), chaining (`&&`, `||`, `;`), path prefixes, and `ENV=val` syntax deterministically.
  - English-verb disambiguation (`find the ...` -> AI vs `find . -name ...` -> shell) and destructive-keyword confirmation flags.
- **Offline Resilience**: An AI or network outage never blocks ordinary shell commands.
- **First-Launch Disclosure**: Affirmative consent modal (`apps/shell/ui/index.html`) and `wa diagnostics` CLI controls; declining disables telemetry without altering the native shell.
