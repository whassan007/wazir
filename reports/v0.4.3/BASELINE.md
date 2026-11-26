# v0.4.3 Baseline

- **BASELINE_SHA**: `0f398cb80e8dc78f94c744415732216dcaddc00f` (`feat/coordination-fabric`)
- **Worktree base**: the commit that adds this file (all agent branches start here)
- **Recorded**: 2026-11-25
- **Pre-checks at baseline**: `npm run build` exit 0, `npm run typecheck` exit 0 (macOS arm64 host).
- **Known gaps going in** (verified by code inspection, not by the v0.4.2 reports):
  1. `.deb` is `Architecture: all` and never ships `wazir-shell-bin`; GUI launcher always falls back to headless `wa shell`.
  2. System units copied verbatim to `usr/lib/systemd/user/` (User=, WantedBy=multi-user.target) — invalid as user units.
  3. Native `wazir-shell` binary ignores argv; GNOME/Nautilus call `wazir-shell -c ...`.
  4. Nautilus extension interpolates filenames into prompt text (`f'"{p}"'`) — quoting/injection bug.
  5. 4 vitest files (10 tests) failing, attributed to sandbox EPERM without proof.
  6. `'nats-jetstream'` remains in `CoordinationTransportKind` with no implementation.
  7. All v0.4.2 screenshot/log evidence directories are empty.

## Hosts
| Host | Use | Notes |
|---|---|---|
| Mac (this) arm64, 26 GB | Agents 01, 03, 05; Lima VM for Agent 04 | docker, limactl, cargo available; OrbStack stopped |
| `ssh dgx` Ubuntu 24.04.5 aarch64, GNOME | Agent 02 arm64 build; Agent 05 second node | No sudo. Docker OK. libwebkit2gtk-4.1-dev installed. cargo at ~/.cargo/bin (not on non-interactive PATH). **Do not apt-install anything on the DGX host itself — use containers.** |
| `ssh gb10` | — | Unreachable at baseline (timeout) |
