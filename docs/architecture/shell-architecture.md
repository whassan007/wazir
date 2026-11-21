# Wazir Shell Architecture

## Components

- **Native PTY Backend (`apps/shell/src-tauri/src/main.rs`)**: Uses `portable-pty` to spawn the user's native login shell (`/bin/zsh` / `/bin/bash` / `cmd.exe`) with full `TERM=xterm-256color`, resize (`pty_resize`), multi-tab session management, and Ctrl+C signal propagation.
- **CLI Universal Shell (`apps/cli/src/commands/shellCommand.ts`)**: Exposes `wa shell` (`-c <cmd>`, `--no-ai`, `--tools`) using the same deterministic classifier, persistent `cwd` / `OLDPWD` (`cd -`) / `env` / `aliases` / `history`, readline tab completion, interactive subprocess `SIGINT` forwarding, and authoritative version sourcing (`resolveAuthoritativePackageVersion()` from `package.json`).
- **Deterministic Classifier (`packages/core/src/services/shellClassifier.ts`)**:
  - `! <cmd>` -> forced native shell
  - `? <req>` -> forced governed AI
  - `/mode <auto|shell|ai>` -> explicit session routing mode switch
  - Auto mode -> recognizes shell builtins (`cd`, `export`, `unset`, `alias`, `unalias`, `pwd`, `history`, `exit`), known binaries, executables on `PATH`, pipelines (`|`), redirections (`>`, `<`), chaining (`&&`, `||`, `;`), path prefixes, and `ENV=val` syntax deterministically without initializing any model.
  - English-verb disambiguation (`find the ...` -> AI vs `find . -name ...` -> shell), destructive-keyword confirmation flags, and safe rejection (`exitCode = 2`) for short unknown ambiguous tokens.
- **Optional Tool Discovery (`discoverOptionalShellTools`)**: Detects `fzf`, `zoxide`, `rg` (ripgrep), `bat`, `atuin`, and `lazygit` on `PATH` without automatically installing anything.
- **Offline Resilience**: An AI or network outage never blocks ordinary shell commands.
- **First-Launch Disclosure**: Affirmative consent modal (`apps/shell/ui/index.html`) and `wa diagnostics` CLI controls; declining disables telemetry without altering the native shell.
