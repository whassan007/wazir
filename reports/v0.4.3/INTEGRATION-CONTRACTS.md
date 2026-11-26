# v0.4.3 Integration Contracts

## C1 — `wazir-shell` argv (owner: Agent 02 implements; Agent 03 consumes)
```
wazir-shell [--cwd <dir>] [--attach <path>]... [-c <input>]
```
- `-c <input>`: input text routed through the shell's normal router (Tier 0..3), never passed to `/bin/sh -c`.
- `--attach <path>`: repeatable; each path is a separate argv element, passed to the router as a structured list (`attachments: string[]`). Paths are NEVER concatenated into `<input>`.
- `--cwd <dir>`: working directory of the new tab/pane.
- Applies identically to the native GUI binary and to the CLI fallback `wa shell` (Agent 02 adds `--attach`/`--cwd` to `apps/cli/src/commands/shellCommand.ts`; `-c/--command` already exists there).
- If an instance is already running, opening a new tab in it is OPTIONAL for v0.4.3; launching a new window is acceptable.

## C2 — Package layout (owner: Agent 02)
- Per-arch packages: `dist/wazir_0.4.3_arm64.deb`, `dist/wazir_0.4.3_amd64.deb` (amd64 may be IMPLEMENTED_NOT_VERIFIED). A CLI-only `wazir_0.4.3_all.deb` is optional.
- GUI binary at `/usr/lib/wazir/wazir-shell-bin`; launcher `/usr/bin/wazir-shell`.
- Agent 03's files in `os/wazir-os-ubuntu/{gnome,nautilus,profile}` keep their current filenames so `build-deb.mjs` paths stay valid.

## C3 — Transport kinds (owner: Agent 05)
- Default decision: remove `'nats-jetstream'` from `CoordinationTransportKind`; keep `'in-process' | 'durable-local' | 'nats-core'`.

## Change requests
Append here: `- [from Agent NN → Agent MM] request ... (status: open|done)`
- [from Agent 03 → Agent 02] C1 parsing clarification (no syntax change): Nautilus always emits `wazir-shell --cwd <abs dir> --attach <abs path>... -c <fixed text>` (separate argv elements, never the `--opt=value` form). Attached paths are absolute so they start with `/`; the search provider emits `wazir-shell -c <query>` where the query is user text and MAY start with `-` (e.g. `-c "-foo"`). Request: in both the native binary and `wa shell`, `--cwd`, `--attach` and `-c` must consume the next argv element verbatim even if it begins with `-` (commander's required-value options already do this; the Rust parser must too), and must not treat attachment paths as option clusters. (status: open)
- [from Agent 03 → Agent 02] packaging/deb/debian/control: add `Recommends: python3-dbus, python3-gi, python3-nautilus, dconf-cli` (the search provider needs python3-dbus + python3-gi; the Nautilus extension needs python3-nautilus; the profile script needs dconf-cli). Install paths in scripts/build-deb.mjs already match the GNOME files (`/usr/libexec/wazir-gnome-search.py`, `usr/share/dbus-1/services/org.wazir.SearchProvider.service`, `usr/lib/systemd/user/wazir-gnome-search.service`, `usr/share/gnome-shell/search-providers/org.wazir.SearchProvider.ini`) — no path change needed. (status: open)
