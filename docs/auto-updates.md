# Wazir automatic updates

Automatic updates are opt-in. `wa update enable` installs one per-user scheduler: a launchd agent on macOS, a systemd user timer on Linux, or a Task Scheduler task on Windows. The scheduler starts a short-lived `wa update check --scheduled` process; closing `wa chat` does not stop it. It checks every 300 seconds by default. Linux adds up to 45 seconds of timer jitter; macOS and Windows add up to 45 seconds before a check to avoid a fleet-wide download spike.

The updater reads and writes JSON under `$WAZIR_HOME/updates` (normally `~/.wazir/updates`). `config.json` stores update preferences, `history.jsonl` is the append-only audit trail, and `journal.json` stores the last state for crash recovery. Files are created with user-only permissions. This directory is separate from credentials, task history, checkpoints, and model configuration.

```sh
wa update status [--json]
wa update check [--json]     # discover and verify; stage only
wa update now [--json]       # discover, verify, and attempt safe activation
wa update enable [--json]
wa update disable [--json]
wa update history [--json]
wa update rollback [--json]
wa update config [--json] [--channel stable|prerelease|development]
```

The only release source is the Wazir GitHub Releases API for `whassan007/wazir`. Stable is the default channel. Prerelease and development both select published GitHub prereleases; development additionally requires `WAZIR_ALLOW_DEVELOPMENT_UPDATES=1`. The updater never follows a branch or arbitrary commit. It requires the platform artifact or npm tarball, the release `SHA256SUMS.txt`, and GitHub's SHA-256 asset digest to agree. Downloads are HTTPS-only, size-bounded, staged, and re-verified before reuse.

Global npm installations can install the verified release npm tarball through npm itself. A copy of the previous package is retained for rollback, and the installed CLI must report the target version after activation. User-owned macOS and Linux standalone binaries can be installed with an atomic same-directory replacement and a retained rollback copy. Windows npm installations use npm's package manager; Windows standalone binary replacement is deferred because a safe post-exit replacement helper is not yet available.

Homebrew, apt/dnf, Scoop, WinGet, and unmanaged source checkouts are detected and left under their installation owner's control. They report `ACTION_REQUIRED` with the supported command instead of writing package-manager-owned files. A source checkout must never be reset or cleaned by the updater. API and worker services installed through `wa service install` are registered as managed deployments; the current release packages their code with the CLI, but the updater does not yet coordinate worker draining/restarts or roll releases across registered remote computers. Separate desktop-app update artifacts and schema migrations are not published in this release topology, so they are not installed independently.

Local Wazir chat, fleet, run, ask, worker, and API processes defer activation. The updater fails closed if it cannot inspect local processes, detects unsupported package ownership, lacks authenticated checksum metadata, or cannot preserve a rollback path. Remote task leases are not visible to this local guard; operators should use a controller drain/maintenance window before updating a computer that may execute remotely assigned work.

Use `wa update disable` to stop the scheduler without removing update history. If automatic activation reports `ROLLED_BACK`, inspect `wa update history` and the latest journal before retrying. System package managers that require administrator approval should be updated with the command reported by `wa update status` or the update event.
