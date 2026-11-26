# Agent 02 — Linux shell GUI + .deb (contracts C1, C2)

- **Branch**: `fix/v043-linux-shell-deb` (worktree `/Users/wael/Code/Wazir-v043/agent-02`)
- **Starting SHA**: `d6ca44a` (docs(reports): v0.4.3 baseline and integration contracts)
- **Commits**: `2e4403e`, `c8384c6`, `d99235a`, `ba4e2c7`, `6a9f8f2`, plus the commit that adds this report. Not pushed.
- **dgx build dir (left in place)**: `~/wazir-v043-build` (`src/` = shell source + cargo target, `repo/` = packaging tree + `dist/`, `container-test.log`, `ctest.sh`). Nothing else in the dgx home was modified, and nothing was apt-installed on the host.

## Status summary

| Item | Status | Evidence |
|---|---|---|
| Native arm64 GUI binary shipped in `.deb` at `/usr/lib/wazir/wazir-shell-bin` | **VERIFIED_OPERATIONAL** (install, ldd, argv) | `apt-get install ./wazir_0.4.3_arm64.deb` → EXIT 0 in `ubuntu:24.04` arm64; ldd 128 libs, 0 `not found`; `wazir-shell-bin --help` → 0 |
| Per-arch `build-deb.mjs` (`--arch`, `--shell-bin`, `--version`, `--out-dir`) | **VERIFIED_OPERATIONAL** | arm64 + all builds exit 0; negative cases exit 2 |
| amd64 package | **IMPLEMENTED_NOT_VERIFIED** | dgx has no amd64 binfmt/qemu (`exec format error`, buildx shows only linux/arm64). Registering binfmt needs a privileged host change, so it was not attempted. `--arch amd64` path is coded and its ELF e_machine check works (rejects the aarch64 ELF with exit 2) |
| User systemd units generated correctly | **VERIFIED_OPERATIONAL** | `systemd-analyze verify --user` → 0 for all 3 units (package installed, `XDG_RUNTIME_DIR` set) |
| No unit enabled on install; purge cleans up | **VERIFIED_OPERATIONAL** | `find /etc/systemd -name 'wazir*'` = 0 after install; remove/purge exit 0 |
| C1 argv in native binary + Rust unit test | **VERIFIED_OPERATIONAL** (parser/CLI level) | `cargo test` 6/6 on Mac and dgx |
| C1 `-c`/attachments reaching the UI router | **IMPLEMENTED_NOT_VERIFIED** | app.js wiring was not exercised in a live GUI session (no display used) |
| `wa shell --attach/--cwd` | **VERIFIED_OPERATIONAL** | vitest `shellLaunchArgs.test.ts` 4/4; headless `wazir-shell --cwd /usr/share -c pwd` printed `/usr/share` |
| Launcher terminal fallback | **VERIFIED_OPERATIONAL** with a stub `x-terminal-emulator` | argv arrived as separate elements (see below). Not tested with a real terminal emulator |

## What changed

### 1. `scripts/build-deb.mjs` (C2)
- New flags: `--arch all|arm64|amd64` (default `all`), `--shell-bin <ELF>` (required for arm64/amd64, refused for `all`), `--version <v>` (default: root `package.json` version), `--out-dir <dir>` (default `dist/`).
- **Version handling**: package.json files were not bumped. Packages were built with `--version 0.4.3`. The embedded binaries still report `0.4.2` (`wazir-shell --version` comes from `apps/shell/src-tauri/Cargo.toml`; `wa --version` from package.json) until the integrator bumps them.
- Output: `dist/wazir_<ver>_<arch>.deb` (staging in `dist/deb/wazir_<ver>_<arch>/`).
- `--shell-bin` is checked as an ELF whose `e_machine` matches `--arch` (0xb7 aarch64 / 0x3e x86_64), and installed at `/usr/lib/wazir/wazir-shell-bin` with mode 0755.
- Arch packages: the GUI libs move into `Depends`. The list comes from `readelf -d` NEEDED on the actual binary: `libwebkit2gtk-4.1-0, libjavascriptcoregtk-4.1-0, libgtk-3-0t64 | libgtk-3-0, libsoup-3.0-0, libglib2.0-0t64 | libglib2.0-0, libdbus-1-3`. `Recommends` keeps `libayatana-appindicator3-1, libsecret-1-0, libnotify-bin, xdg-utils`. The `all` package keeps the GUI libs in Recommends.
- Agent 03 change request: `Recommends` now also lists `python3-dbus, python3-gi, python3-nautilus, dconf-cli` in both variants.
- File modes are normalized (dirs/executables 0755, everything else 0644). Before this, a umask 002 host produced 0664 files.
- macOS fallback (no dpkg-deb): writes the System V `ar` container in JS, because BSD `ar` injects `__.SYMDEF`, which dpkg rejects. The tarballs are root-owned and built with `COPYFILE_DISABLE=1`. Verified: a Mac-built `all` .deb passes `dpkg-deb -I/-c` on dgx.
- Contract C2 paths for Agent 03's `os/wazir-os-ubuntu/{gnome,nautilus,profile}` files are unchanged.

### 2. systemd units
- User units (`/usr/lib/systemd/user/wazir-{api,worker}.service`) are generated from the system units by `toUserUnit()`:
  - Removed: `User=`, `Group=`, `ProtectSystem=`, `ReadWritePaths=`, `PrivateTmp=` (needs user namespaces in user managers), `WorkingDirectory=/var/lib/wazir`, and `After=`/`Wants=network-online.target` (that target doesn't exist in the user manager).
  - Added: `WorkingDirectory=%h`, `Environment=WAZIR_HOME=%h/.wazir`, `WantedBy=default.target`.
  - The API binds to loopback (`--host 127.0.0.1`, `WAZIR_HOST=127.0.0.1`).
- System units are unchanged (still `User=wazir`, `multi-user.target`).
- `prerm` now stops/disables the system units only on `remove|deconfigure`. Before, it also did this on `upgrade`, which silently disabled services an administrator had enabled. No maintainer script enables, starts or touches user units for any user. `postinst` only runs `daemon-reload`, with a comment that self-improvement is opt-in only (there is no unit for it).

### 3. C1 argv — `apps/shell/src-tauri/src/main.rs`, `apps/shell/ui/app.js`
- `parse_launch_args()` handles:
  - `--cwd <dir>` and repeatable `--attach <path>`
  - `-c`/`--command <input>`
  - the `--flag=value` form
  - `--` (everything after it is an attachment)
  - `-h/--help` and `-V/--version`, which print and exit before GTK starts, so they work headless.
- Unknown options and stray positional arguments exit with code 2.
- Option values are always the **next argv element verbatim**, even if they start with `-` (Agent 03 change request; covered by the test, e.g. `-c "-rf foo"`).
- `resolve_launch_paths()` makes `--cwd` and the attachments absolute, and rejects a `--cwd` that is not a directory (exit 2).
- The result is stored in a `OnceLock` and returned as `launch: {cwd, attachments[], command}` from `get_shell_bootstrap`. `initial_cwd` honors `--cwd`.
- app.js:
  - The first tab opens with `pty_spawn({cwd: launch.cwd})`.
  - Attachments are listed in the pane.
  - `launch.command` goes through `executeCommandInput()`, the normal Tier 0..3 router; it is never `/bin/sh -c`.
  - `executeCommandInput` takes `context.attachments` and forwards it to `run_wazir_ai_task`, which appends one `--attach <path>` argv pair per attachment to `wa shell -c`.
- Tests added: `parses_c1_launch_argv` and `resolves_launch_paths_against_cwd`.
- Also fixed a pre-existing flaky test: two tests raced on the process-global `WAZIR_HOME` and failed about 3 of every 3 parallel runs on the Mac. They are now serialized with a test mutex.

### 4. `wa shell` — `apps/cli/src/commands/shellCommand.ts`
- `--attach <path>` (repeatable, commander collector) and `--cwd <dir>` (validated as a directory, exit 2 otherwise).
- Values starting with `-` are taken verbatim; a vitest covers this.
- Attachments are resolved against the session cwd and stored as `ShellSessionState.attachments: string[]`.
- Routing always classifies the raw input. Only the model-facing request (Liquid, Tier 2 fast and Tier 3 `executeTask`) gets the attachments, appended after routing as a JSON-array data block by `buildAttachmentAwareRequest()`. File names can therefore never change the routed input or the classification.
- **Limitation**: `executeTask` has no structured attachments field (`run.ts` is not owned by this agent), so the model sees the paths as a JSON block in the prompt text, not as a typed field.

### 5. Launcher `/usr/bin/wazir-shell` (`packaging/linux/wazir-shell.sh`) and `/usr/lib/wazir/wazir-shell-terminal`
1. GUI binary present and `DISPLAY` or `WAYLAND_DISPLAY` set → `exec wazir-shell-bin "$@"`.
2. stdin is a TTY, or there is no display at all → `exec node wa.js shell "$@"`.
3. No TTY but a display (e.g. launched from a .desktop file without the GUI) → `x-terminal-emulator -e wazir-shell-terminal "$@"`, falling back to `gnome-terminal -- …`, then to headless with a warning.
- The helper keeps the window open after a one-shot `-c` run.
- Arguments are only ever forwarded as `"$@"`.
- A recursion guard (`WAZIR_SHELL_IN_TERMINAL`) stops the helper from spawning another terminal.

## Commands and exit codes

| # | Host | Command | Exit |
|---|---|---|---|
| 1 | Mac | `cargo test` (apps/shell/src-tauri), first run after the argv change | 101 (pre-existing `WAZIR_HOME` race; passes with `--test-threads=1`) |
| 2 | Mac | `cargo test` after the env-lock fix, 3 runs | 0, 0, 0 (6/6) |
| 3 | Mac | `npm ci` | 0 |
| 4 | Mac | `npm run build` | 0 |
| 5 | Mac | `npm run typecheck` | 0 |
| 6 | Mac | `npx vitest run apps/cli/tests/shellLaunchArgs.test.ts apps/cli/tests/shellCommand.test.ts apps/cli/tests/shell.test.ts` | 0 (27/27) |
| 7 | Mac | `cargo test` (final) | 0 (6/6) |
| 8 | Mac | `node scripts/build-deb.mjs --version 0.4.3-mactest --out-dir <scratch>` (ar fallback) | 0; `dpkg-deb -I/-c` on dgx → 0 |
| 9 | dgx | `cargo test` | 0 (6/6) |
| 10 | dgx | `cargo build --release --features tauri/custom-protocol` (same as `tauri build --no-bundle`; frontend embedded) | 0 |
| 11 | dgx | `file target/release/wazir-shell` | ELF 64-bit LSB pie, ARM aarch64 |
| 12 | dgx | `wazir-shell --help` / `--version` / `--bogus` | 0 / 0 / 2 |
| 13 | dgx | `node scripts/build-deb.mjs --arch arm64 --shell-bin …/wazir-shell --version 0.4.3` | 0 |
| 14 | dgx | `node scripts/build-deb.mjs --version 0.4.3` (`all`) | 0 |
| 15 | dgx | `build-deb.mjs --arch arm64` with no `--shell-bin` | 2 |
| 16 | dgx | `build-deb.mjs --arch amd64 --shell-bin <aarch64 ELF>` | 2 (e_machine mismatch) |
| 17 | dgx | `build-deb.mjs --arch arm64 --shell-bin README.md` | 2 (not ELF) |
| 18 | dgx | `dpkg-deb -c dist/wazir_0.4.3_arm64.deb` | 0 (contains `./usr/lib/wazir/wazir-shell-bin` 0755, `./usr/bin/wazir-shell`, user units 0644) |
| 19 | dgx | `docker run --rm --platform linux/arm64 ubuntu:24.04 bash /ctest.sh` | 0 (full log: `~/wazir-v043-build/container-test.log`) |
| 19a | ctr | `apt-get install -y /debs/wazir_0.4.3_all.deb` (with the NodeSource node_22.x apt repo, because Depends needs nodejs ≥ 22.13) | 0 |
| 19b | ctr | `apt-get install -y /debs/wazir_0.4.3_arm64.deb` (all → arm64 crossgrade) | 0; `Architecture: arm64`, `install ok installed` |
| 19c | ctr | `ldd /usr/lib/wazir/wazir-shell-bin` | 0; 128 libs, 0 not found |
| 19d | ctr | `wazir-shell-bin --help` / `--version` / `--cwd /nonexistent` | 0 / 0 / 2 |
| 19e | ctr | `wa --version` | 0 (prints 0.4.2, not bumped) |
| 19f | ctr | `wazir-shell --cwd /usr/share -c pwd </dev/null` (no display) | 0, printed `/usr/share` |
| 19g | ctr | `DISPLAY=:99 WAZIR_SHELL_GUI_BIN=/nonexistent wazir-shell --attach '/tmp/a b; $(id).txt' -c '-rf foo' </dev/null` with stub `x-terminal-emulator` | 0; argv `[-e] [/usr/lib/wazir/wazir-shell-terminal] [--attach] [/tmp/a b; $(id).txt] [-c] [-rf foo]` |
| 19h | ctr | `DISPLAY=:99 wazir-shell --help` (GUI branch) | 0 |
| 19i | ctr | `systemd-analyze verify --user …` without `XDG_RUNTIME_DIR` | 1 (`Failed to lookup RuntimeDirectory path`: container environment issue) |
| 19j | ctr | `systemd-analyze verify /lib/systemd/system/wazir-{api,worker}.service` | 0, 0 |
| 19k | ctr | `find /etc/systemd -name 'wazir*' \| wc -l` after install | 0 links |
| 19l | ctr | `apt-get remove wazir` / `apt-get purge wazir`; `getent passwd wazir` | 0 / 0; user gone (rc 2) |
| 20 | dgx host | `systemd-analyze verify --user` on extracted units (package not installed) | 1 (only `Command /usr/bin/wa is not executable`: binaries absent) |
| 21 | ctr | package installed, `XDG_RUNTIME_DIR=/run/user/0`, `systemd-analyze verify --user` for wazir-api, wazir-worker, wazir-gnome-search | **0, 0, 0** |
| 22 | ctr | grep the user units for `User= Group= ProtectSystem ReadWritePaths multi-user /var/lib/wazir` | 1 (no matches) |
| 23 | dgx | `docker run --rm --platform linux/amd64 ubuntu:24.04 uname -m` | 255 (`exec format error`: no amd64 emulation) |
| 24 | dgx | `docker pull --platform linux/arm64 ubuntu:24.04` (restores the local tag that step 23 had re-pointed to amd64) | 0; tag is arm64 again |

One combined dgx step was refused by the Claude Code permission classifier because it ran the NodeSource `curl | bash` setup script. I replaced it with a signed apt source (gpg key + `sources.list.d` entry) inside the throwaway container.

## Artifacts (SHA-256)

| File | SHA-256 |
|---|---|
| `dist/wazir_0.4.3_arm64.deb` (also `/Users/wael/Code/Wazir-v043/artifacts/`) | `0c51aa71962c79cce5f7d8380290d95a8d19bafb2416c96b8722586d0502940e` |
| `dist/wazir_0.4.3_all.deb` (also in artifacts/) | `b7a142783d27d5e5d8ba4f3afb986b138638ef3d9d2964cd8f091c75a5eef005` |
| `dist/wazir-shell-bin-linux-arm64` = `/usr/lib/wazir/wazir-shell-bin` (also in artifacts/) | `406e5e22163bf99e3b86de3850b21e19d78b95a6d44f2a62b5d1660aa8909350` |

`dist/` is gitignored, so the artifacts are not committed. The binary is a 15 MB release build, not stripped.

## Change requests from Agent 03
1. **Dash-leading argv values**: done. The Rust parser already consumed the next element verbatim; an explicit test now covers `-c "-rf foo"`, `--attach --help` and `--cwd -dir`. Commander behaves the same (vitest: `-c '-rf foo' --attach --debug --cwd -dir`). Container step 19g confirms end to end through the launcher.
2. **Recommends** `python3-dbus, python3-gi, python3-nautilus, dconf-cli`: done (visible in `dpkg-deb -I`).
- Mac Docker/OrbStack tip: not needed. All dpkg and container work ran on dgx, and the Mac only used the JS ar fallback.

## Remaining blockers / findings
1. **amd64**: IMPLEMENTED_NOT_VERIFIED. dgx has no amd64 emulation and enabling it needs privileged binfmt registration on the host. Options: build on an amd64 host and run `build-deb.mjs --arch amd64 --shell-bin <elf>`, or cross-compile in an arm64 container with amd64 multiarch dev libs.
2. **Broken worker ExecStart (pre-existing, not fixed)**: `wazir-worker.service` (system and user) runs `/usr/bin/wa worker start`, but no `wa worker` command exists (`wa workers` only has list/status), and `apps/worker` is not in the .deb. `serviceManager.ts` generates the same broken command (`worker start` / `api start`). The units are never enabled by the package, but enabling one by hand would fail. This needs a CLI owner decision.
3. **Version strings**: the `.deb` says 0.4.3, but the embedded `wa`/`wazir-shell` report 0.4.2 until the integrator bumps package.json files and `apps/shell/src-tauri/{Cargo.toml,tauri.conf.json}`. Then rebuild the binary and run build-deb without `--version`.
4. **GUI runtime not exercised**: the launch-arg UI path (first tab in `--cwd`, `-c` routed, attachments forwarded to `run_wazir_ai_task`) was not run in a live GNOME session. Agent 04 should check it with `wazir-shell --cwd /tmp --attach /etc/hostname -c 'what is in this file?'`.
5. **Single-instance**: each invocation opens a new window (allowed by C1).
6. **nodejs dependency**: `Depends: nodejs (>= 22.13.0)` can't be satisfied from Ubuntu 24.04 main (ships 18.x). Installs need the NodeSource repo or similar. This is pre-existing and should be documented in the install docs.
7. **Attachments in the CLI** reach the model as a JSON block in the prompt text, because `run.ts` `ExecuteTaskOptions` has no attachments field (not owned by this agent).
