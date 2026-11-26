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
