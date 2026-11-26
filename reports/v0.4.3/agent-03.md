# Agent 03 — GNOME / Nautilus / Profile hardening (v0.4.3)

- **Branch**: `fix/v043-gnome-hardening`
- **Starting SHA**: `d6ca44a` (docs(reports): v0.4.3 baseline and integration contracts)
- **Code commit**: `0bfad5d` fix(ubuntu): harden GNOME search provider, Nautilus extension and profile script
- **Host**: macOS arm64 (Python 3.13.12); containers `ubuntu:24.04` (arm64) and `koalaman/shellcheck:stable` (0.11.0) via OrbStack docker 29.4.0
- **Contract consumed**: C1 `wazir-shell [--cwd <dir>] [--attach <path>]... [-c <input>]` (coded against the contract; Agent 02's binary not present here)

## Files touched
| File | Change |
|---|---|
| `os/wazir-os-ubuntu/nautilus/wazir_nautilus_extension.py` | Rewritten. Paths go only as `--attach <abs path>` argv elements; `-c` is a fixed per-action string; `--cwd <dir of first file>`; `shell=False`, `start_new_session`, DEVNULL stdio; non-local files (`get_path() is None`) and NUL-containing paths skipped; missing `wazir-shell` swallowed. 9 actions kept. `gi.require_version` guarded (Nautilus 4.0 then 3.0, stubs otherwise); pure functions `local_paths`, `build_argv`, `launch`. |
| `os/wazir-os-ubuntu/gnome/wazir-gnome-search.py` | Rewritten. `normalize_query` strips control chars and truncates to 512; `wa route --json <query>` with query as one argv element, `shell=False`, timeout 1.5 s, stdin DEVNULL; every failure (timeout, OSError, non-zero exit, empty/oversize/malformed JSON) returns `[]`; ≤5 results; bounded (64) result cache; deterministic sha256 IDs (old code used per-process `hash()`); activation and `LaunchSearch` use `wazir-shell -c <query>`. D-Bus layer only defined when `dbus` imports; pure `SearchCore` is testable. Shebang `/usr/bin/python3` so a PATH python without python3-dbus is not picked. |
| `os/wazir-os-ubuntu/gnome/org.wazir.SearchProvider.service` | Added `SystemdService=wazir-gnome-search.service` so D-Bus activation goes through the user unit. |
| `os/wazir-os-ubuntu/profile/wazir-gnome-profile.sh` | Rewritten. `--apply [--force]` dumps `/org/gnome/` atomically (mktemp + mv) before changing anything and refuses (exit 1) if a backup exists without `--force`; settings written with `dconf write` (no schema needed). `--revert` = `dconf reset -f /org/gnome/` + `dconf load`, so keys added by apply are removed; backup is then archived to `<backup>.restored-<UTC>[-n]` (never clobbered). Unknown args exit 2. `WAZIR_PROFILE_BACKUP` overrides the location (default unchanged: `~/.wazir/backups/gnome-profile.dconf.bak`). |
| `os/wazir-os-ubuntu/tests/{__init__.py,_load.py,test_nautilus_argv.py,test_search_provider.py}` | New unittest suite (22 tests). |
| `os/wazir-os-ubuntu/tests/profile_roundtrip.sh` | New docker round-trip test (10 checks). |
| `os/wazir-os-ubuntu/tests/dbus_provider_smoke.sh` | New container smoke test: real session bus + gdbus calls into the provider, real Nautilus 4.0 GI binding. |
| `reports/v0.4.3/INTEGRATION-CONTRACTS.md` | Two change requests to Agent 02 (below). |

Filenames used by `scripts/build-deb.mjs` are unchanged; `build-deb.mjs` was read, not edited.

## Leading-dash decision (`-c.txt`)
Chosen: keep C1's separate-element form (`--attach <path>`) and **always pass absolute paths** (`os.path.abspath`). An attachment value therefore always begins with `/` (`/dir/-c.txt`), so it cannot look like a flag even to a parser that inspects values. `--attach=<path>` was not used because C1 does not promise the `=` form and the Rust parser may not support it. No C1 syntax change. For the search provider the `-c` value is user text and can begin with `-`; a clarification request was filed so both parsers consume the next element verbatim.

## Config consistency (task 2)
| Item | .ini | D-Bus .service | systemd user unit | build-deb.mjs install |
|---|---|---|---|---|
| Bus name | `org.wazir.SearchProvider` | `Name=org.wazir.SearchProvider` | `BusName=org.wazir.SearchProvider` | — |
| Object path | `/org/wazir/SearchProvider` | — | — | — |
| Exec | — | `/usr/libexec/wazir-gnome-search.py` | `ExecStart=/usr/libexec/wazir-gnome-search.py` | `usr/libexec/wazir-gnome-search.py` (chmod 755) |
| DesktopId | `wazir-shell.desktop` | — | — | `packaging/linux/wazir-shell.desktop` installed |

All consistent, and checked by `ConfigConsistencyTests`. No path change request was needed.

## Commands and exit codes
| # | Command | Exit |
|---|---|---|
| 1 | `python3 -I -m unittest discover -s tests -t . -v` (first run, macOS) | 1 (9 subtest failures: a test bug where the filename `--attach` equals the flag token; the assertion was replaced with an exact-argv equality) |
| 2 | same, after the fix (macOS) | **0**: `Ran 22 tests ... OK` |
| 3 | `docker run ... ubuntu:24.04 ...` (first try) | 127: `docker-credential-desktop: executable file not found` → re-ran with `DOCKER_CONFIG=<scratch>/dockercfg` (`{}`) and `DOCKER_HOST=unix:///Users/wael/.orbstack/run/docker.sock` |
| 4 | profile round-trip, apt `dconf-cli dbus-x11` only | 1: `ServiceUnknown: The name ca.desrt.dconf was not provided` → also install `dconf-service` |
| 5 | profile round-trip with dconf-service | 1: `seed dump empty` (D-Bus-activated dconf-service inherited the bus daemon's HOME) → the test now re-execs itself in a fresh `dbus-run-session` after setting HOME |
| 6 | `docker run --rm -v $PWD/os/wazir-os-ubuntu:/w:ro ubuntu:24.04 bash -c 'apt-get update && apt-get install -y dconf-cli dconf-service dbus-x11 && dbus-run-session -- bash /w/tests/profile_roundtrip.sh'` | **0**: 10 checks passed (output below) |
| 7 | `docker run --rm -v .../os/wazir-os-ubuntu:/mnt:ro koalaman/shellcheck:stable -S style /mnt/profile/wazir-gnome-profile.sh /mnt/tests/profile_roundtrip.sh` | **0** |
| 8 | shellcheck including `tests/dbus_provider_smoke.sh` | 1: SC2016 on an intentionally literal payload → added a targeted `# shellcheck disable=SC2016` |
| 9 | shellcheck, all three scripts | **0** |
| 10 | `docker run ... ubuntu:24.04` with `python3 python3-dbus python3-gi gir1.2-nautilus-4.0 libglib2.0-bin dbus`: `dbus-run-session -- bash /w/tests/dbus_provider_smoke.sh` | **0** |
| 11 | unittest inside ubuntu:24.04 with only the subtree mounted | 1 error: `build-deb.mjs` not found → the test now skips when the file is absent |
| 12 | `python3 -I -m unittest discover -s os/wazir-os-ubuntu/tests -t os/wazir-os-ubuntu` (macOS) | **0**: 22 tests OK |
| 13 | `docker run -v $PWD:/repo:ro ubuntu:24.04 ... python3 -I -m unittest discover -s tests -t . -v` (Python 3.12.3 with real python3-gi + Nautilus 4.0 typelib, full repo mounted) | **0**: 22 tests OK |
| 14 | `git commit` | 0 → `0bfad5d` |

Package versions in the container: dconf-cli/dconf-service 0.40.0-4ubuntu0.1, dbus-x11 1.14.10-4ubuntu4.1, python3 3.12.3, python3-dbus 1.3.2-5build3, python3-gi 3.48.2-1, gir1.2-nautilus-4.0 1:46.4-0ubuntu0.2.

## Test output
Profile round-trip (#6):
```
ok: apply created backup identical to pre-apply dump
ok: apply changed settings
ok: second --apply refused, backup untouched
ok: dump -> apply -> revert -> dump is byte-identical (234 bytes, sha256 85ad7c4e0d7300f0)
ok: keys outside /org/gnome/ untouched
ok: backup archived after revert
ok: --revert without backup fails
ok: --apply --force refreshes backup and round-trips
ok: archived backups are never clobbered
ok: unknown argument rejected
PROFILE ROUNDTRIP: 10 checks passed
```
D-Bus/Nautilus smoke (#10), using fake `wa` and `wazir-shell` that log their argv:
```
GetInitialResultSet -> (['wazir:aae51bd42b2f34fd'],)
GetResultMetas -> ([{... 'name': <'Wazir: -c "$(touch /tmp/pwned)"'>, 'description': <'Tier 1 (fake) - argc=3'> ...}],)
launch.log:
["-c", "-c \"$(touch /tmp/pwned)\""]
["-c", "aaaa…(512 chars)"]
ok: D-Bus provider returns results, activation uses C1 argv, query truncated, no injection
Nautilus GI namespace version: 4.0
ok: Nautilus extension builds 9 menu items with real GI: [9 labels]
```
The unit suite (22 tests) covers: the adversarial names `a"b.txt`, `$(touch pwned).txt`, `x\ny.txt`, unicode (Latin, Arabic, emoji), `-c.txt`, `--attach`, `; rm -rf ~ #.txt`, `` it's `id`.txt `` across all 9 actions, with exact argv equality; real-exec byte-exact argv delivery; skipping of non-local and NUL paths; `shell=False`; a missing binary; truncation at 512 before the subprocess; control-char stripping; a mocked timeout and a real timeout (`sleep 5` with a 0.2 s timeout → `[]`); 7 failure modes → `[]`; the 5-result cap; the bounded cache; C1 activation; config and `build-deb.mjs` consistency.

## Status
| Item | Status | Evidence |
|---|---|---|
| Nautilus argv construction (pure logic) | **VERIFIED_OPERATIONAL** | #12, #13 exit 0 |
| Nautilus extension loads with real Nautilus 4.0 GI and builds 9 menu items | **VERIFIED_OPERATIONAL** (headless GI only) | #10 exit 0 |
| Nautilus menu inside a live Nautilus window | IMPLEMENTED_NOT_VERIFIED | Agent 04 |
| Search provider: timeout, truncation, cap, failure → [] | **VERIFIED_OPERATIONAL** | #12, #13 exit 0 |
| Search provider over a real D-Bus session bus (gdbus calls) | **VERIFIED_OPERATIONAL** | #10 exit 0 |
| GNOME Shell actually querying the provider (.ini discovery, systemd activation) | IMPLEMENTED_NOT_VERIFIED | Agent 04 |
| .ini / D-Bus .service / user unit / build-deb paths consistent | **VERIFIED_OPERATIONAL** | `ConfigConsistencyTests`, #12 |
| Profile backup / refuse / revert byte-identical | **VERIFIED_OPERATIONAL** | #6 exit 0, sha256 85ad7c4e0d7300f0 |
| Profile visual effect on a live GNOME desktop | IMPLEMENTED_NOT_VERIFIED | Agent 04 |
| shellcheck clean | **VERIFIED_OPERATIONAL** | #9 exit 0 |
| End-to-end with Agent 02's real `wazir-shell` C1 parser | IMPLEMENTED_NOT_VERIFIED | depends on Agent 02 |

## Change requests filed (INTEGRATION-CONTRACTS.md)
1. → Agent 02: C1 clarification, no syntax change. `--cwd`, `--attach` and `-c` must consume the next argv element verbatim even if it starts with `-`. This matters for search queries such as `-c "-foo"`. Nautilus attachment paths are always absolute. (open)
2. → Agent 02: add `Recommends: python3-dbus, python3-gi, python3-nautilus, dconf-cli` to `packaging/deb/debian/control`. No install-path change is needed. (open)

## Blockers
None. Note for the other agents: on this Mac, docker needs `DOCKER_CONFIG` pointing at a config without `credsStore: desktop`, plus `DOCKER_HOST=unix:///Users/wael/.orbstack/run/docker.sock`. Otherwise image pulls fail with `docker-credential-desktop` not found.
