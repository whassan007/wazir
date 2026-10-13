# Containers, DGX Spark, Linux packages and background services

## OCI images

One Dockerfile, four targets, built for `linux/amd64` and `linux/arm64`:

| Image (on release) | Target | Runs |
|---|---|---|
| `ghcr.io/whassan007/wazir:<v>` | `cli` | `wa` (bundled CLI) |
| `ghcr.io/whassan007/wazir-api:<v>` | `api` | control-plane API (healthcheck on `/health`) |
| `ghcr.io/whassan007/wazir-worker:<v>` | `worker` | worker daemon |
| `ghcr.io/whassan007/wazir-web:<v>` | `web` | web dashboard |

The images contain production dependencies only, run as the unprivileged `node` user, keep all
state in `/data` (`WAZIR_HOME`, a volume), and run under `tini` so `docker stop` is a clean
SIGTERM shutdown. The API still refuses to bind `0.0.0.0` without `WAZIR_API_TOKEN`, and
`docker-compose.yml` still requires both tokens and publishes ports on host loopback only.

```sh
WAZIR_API_TOKEN=$(openssl rand -hex 32) WAZIR_REGISTRATION_TOKEN=$(openssl rand -hex 32) docker compose up -d
docker compose run --rm cli doctor
docker run --rm -v wazir:/data ghcr.io/whassan007/wazir:<v> resources validate
```

Images are pushed only by the manually dispatched release with `publish_images: true`, behind
the `ghcr-publish` environment; an existing version tag is never overwritten.

## DGX Spark (linux/arm64)

Validated on a DGX Spark (Docker 29, NVIDIA Container Toolkit 1.20): all four images build and
run natively on arm64; API auth, worker registration, persistence across restart and clean
shutdown were exercised with the compose stack.

- **Models run in host runtimes**, not in the Wazir containers. Containers reach Ollama /
  LM Studio through `host.docker.internal`, which compose maps to the host gateway
  (`extra_hosts`); the runtime must listen on `0.0.0.0` (LM Studio: *Serve on local network*), or
  run the container with `--network host` and use `127.0.0.1`.
- **GPU telemetry**: `--gpus all` passes the GPU devices into the container, but the images are
  Alpine (musl) and `nvidia-smi` cannot run there, so `wa resources` shows GPU metrics as
  unavailable inside containers. Run `wa` on the host (npm, deb/rpm, or the standalone
  executable) for GPU telemetry. Wazir does not change the NVIDIA runtime configuration.
- External coding agents (Claude Code, Codex, …) use their own logins on the host; they are not
  installed in or authenticated from the images.

## Debian and RPM packages

`wazir_<v>_<arch>.deb` and `wazir-<v>-1.<arch>.rpm` install the standalone `wa` executable
(embedded Node.js, no `nodejs` package dependency) to `/usr/bin/wa`, plus the license and README.
They have no maintainer scripts: no users, services or configuration are created, and
upgrading or removing the package never touches `~/.wazir`.

Tested (install → run as an unprivileged user → upgrade → state unchanged → remove → data kept):
Debian 12, Ubuntu 24.04, Ubuntu 22.04, Rocky Linux 9, Fedora 41 on arm64 (DGX Spark) and, in CI,
on amd64. Other distributions are not claimed.

```sh
sudo apt install ./wazir_<v>_arm64.deb     # or: sudo dnf install ./wazir-<v>-1.aarch64.rpm
```

## Background service (opt-in, per user)

```sh
wa service install [--port 4801]   # writes the unit/agent/task; does not start it
wa service start | stop | status
wa service uninstall               # keeps ~/.wazir
```

Runs `wa dashboard --no-open` (loopback only) as the current user: a `systemd --user` unit on
Linux, a LaunchAgent on macOS, a logon scheduled task on Windows. Nothing privileged is created,
and no package installs a service on its own. The system-wide API/worker units in
`scripts/systemd/` remain for multi-machine deployments.

## Rollback

Images: deploy the previous version tag (tags are immutable). Packages: install the previous
`.deb`/`.rpm` (`apt install ./wazir_<old>.deb --allow-downgrades`, `dnf downgrade ./…`).
Service: `wa service uninstall`.
