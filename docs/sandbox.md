# Tool sandbox

The policy engine decides *whether* a tool call may run. The sandbox decides
*what it can touch when it does*. Every `shell`, `git` and check-tool
subprocess is wrapped in an OS-level sandbox (`packages/tools/src/sandbox.ts`):

| Backend        | Platform | Mechanism                                              |
| -------------- | -------- | ------------------------------------------------------ |
| `bwrap`        | Linux    | bubblewrap: mount + user/pid/ipc/uts/net namespaces, seccomp |
| `sandbox-exec` | macOS    | Seatbelt profile                                       |
| `none`         | any      | plain host execution (fallback, or `WAZIR_SANDBOX=none`) |

Inside the sandbox:

- the host filesystem is **read-only**; only the project directory and a
  private `/tmp` are writable (plus a git worktree's slice of the main
  repository's `.git`, so fleet-mode commits work);
- `$HOME` is masked except for toolchain directories (`~/.nvm`, `~/.cargo`,
  `~/.pyenv`, …, read-only) and package caches (`~/.npm`, `~/.cache/pnpm`, …,
  read-write) — `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.wazir`, `~/.config` are not visible;
- other users' homes (`/home`, `/Users`, `/root`), mount points (`/mnt`,
  `/media`) and service data (`/srv`) are masked;
- runtime sockets under `/run`, `/var/run` and `/var/tmp` are masked
  (a read-only bind would still allow `connect(2)` on `docker.sock`);
- the network is unreachable unless the policy's `networkAccess` allows it;
- the process runs in its own PID/IPC/UTS namespaces, cannot create nested
  user namespaces (`--disable-userns`), and (Linux) runs under a **seccomp
  denylist**: `mount`/`umount2`/`pivot_root`/`open_tree`/`move_mount`/`fs*`,
  `setns`/`unshare`/`clone(CLONE_NEW*)`, `ptrace`/`process_vm_*`,
  module loading, `kexec`/`reboot`/`swap*`, `bpf`, `perf_event_open`,
  `userfaultfd`, kernel keyrings and clock setting all fail with `EPERM`
  (`clone3` returns `ENOSYS` so libc falls back to the inspected `clone`).

The effective mode is stored on every tool call record (`metadata.sandbox`)
and reported by `wa doctor`.

## Configuration

| Variable                 | Values                                             | Default |
| ------------------------ | -------------------------------------------------- | ------- |
| `WAZIR_SANDBOX`          | `auto` \| `required` \| `bwrap` \| `sandbox-exec` \| `none` | `auto` |
| `WAZIR_SANDBOX_SECCOMP`  | `1` \| `0`                                          | `1`     |

- **`auto`** — use the platform backend; if it cannot start, warn once and run
  tools directly on the host (development default).
- **`required`** — same, but **fail closed**: tool processes are refused with
  `SandboxUnavailableError` instead of running on the host. Use this for
  shared or internet-facing deployments. Orchestrator-internal git calls
  (`unsandboxed: true`) are unaffected.
- **`bwrap` / `sandbox-exec`** — name a backend explicitly; if it cannot start
  that is an error (like `required`), never a fallback.
- **`none`** — disable the sandbox (e.g. when a container is the boundary).
- **`WAZIR_SANDBOX_SECCOMP=0`** — keep bwrap but drop the seccomp filter, for
  tools that legitimately need `unshare`/`ptrace` (e.g. Chrome's own sandbox
  or `strace`-based test suites). The filter exists for x86_64 and aarch64;
  other architectures run bwrap without it.

## Enabling user namespaces on Ubuntu ≥ 23.10

Ubuntu restricts unprivileged user namespaces through AppArmor
(`kernel.apparmor_restrict_unprivileged_userns=1`), so `bwrap` fails with
`setting up uid map: Permission denied`. Install the shipped profile, which
grants the `userns` permission to `/usr/bin/bwrap` only:

```sh
sudo apt install bubblewrap
sudo install -m 644 scripts/apparmor/bwrap /etc/apparmor.d/bwrap
sudo apparmor_parser -r /etc/apparmor.d/bwrap
wa doctor        # tool sandbox: PASS — tool processes run under bwrap + seccomp
```

Avoid `sysctl kernel.apparmor_restrict_unprivileged_userns=0`: it re-enables
user namespaces for every binary on the host, not just bubblewrap.

Inside a container, either run it with `--security-opt seccomp=unconfined
--cap-add SYS_ADMIN` so bwrap can create namespaces, or treat the container as
the boundary and set `WAZIR_SANDBOX=none`.

## macOS

`sandbox-exec` ships with macOS; no setup is needed. The Seatbelt profile
denies `$HOME` (except toolchains/caches), denies writes outside the project
and temp directories, hides `docker.sock`, and denies the network unless the
policy allows it. It has no seccomp equivalent; process-level isolation on
macOS relies on the platform's own protections.

## Verifying

```sh
npx vitest run packages/tools/tests/sandbox.test.ts
```

The "sandbox enforcement (live backend)" suite runs only where a backend
works; it checks write containment, home masking, network isolation, the PID
namespace, fleet-mode `git commit` inside a worktree, and that `mount`,
`unshare` and namespace-creating `clone` are refused while threads and
`fork`/`exec` still work. When the suite is skipped, `sandboxStatus().reason`
(and `wa doctor`) says why.
