# Wazir Server Distribution & Infrastructure Guide

This guide covers deployment and operations of Wazir on Linux servers, cloud infrastructure, container environments, and DGX Spark compute fleets.

---

## 1. Docker & OCI Container Deployment

Wazir publishes multi-architecture OCI container images targeting:
- `linux/amd64` (x86_64 cloud instances and workstations)
- `linux/arm64` (Apple Silicon, AWS Graviton, and NVIDIA DGX Spark)

### Image Registry Target

```
ghcr.io/whassan007/wazir:latest
ghcr.io/whassan007/wazir:v0.1.59
```

### Running with Docker

#### 1. Interactive CLI Mode
```bash
docker run --rm -it \
  -v "$HOME/.wazir:/home/wazir/.wazir" \
  ghcr.io/whassan007/wazir:latest doctor
```

#### 2. Headless Control Plane (Controller Mode)
```bash
docker run -d --name wazir-controller \
  -p 3000:3000 \
  -v wazir-data:/home/wazir/.wazir \
  ghcr.io/whassan007/wazir:latest api
```

#### 3. Worker Fleet Node
```bash
docker run -d --name wazir-worker-01 \
  -e WAZIR_SERVER_URL="http://controller-host:3000" \
  -e WAZIR_COMPUTER_ID="worker-01" \
  -v wazir-worker-data:/home/wazir/.wazir \
  ghcr.io/whassan007/wazir:latest worker --api-url http://controller-host:3000
```

### Docker Compose Multi-Node Orchestration

Use the included [docker-compose.yml](../docker-compose.yml):

```bash
# Start controller and compute worker in background
docker compose up -d

# View fleet logs
docker compose logs -f
```

### NVIDIA DGX Spark & GPU Acceleration

For GPU-accelerated local models (Ollama, LM Studio, vLLM) on NVIDIA DGX Spark, ensure the NVIDIA Container Toolkit is installed on the host. In `docker-compose.yml`, enable GPU reservations:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

---

## 2. Debian / Ubuntu Packaging (.deb)

Wazir provides native Debian packages supporting Debian 11/12 and Ubuntu 20.04/22.04/24.04.

### Building the Package

```bash
npm run build:deb
```

Outputs: `dist/deb/wazir_<version>_all.deb`

### Installation

```bash
sudo dpkg -i dist/deb/wazir_*.deb
sudo apt-get install -f # resolve any runtime dependencies (Node.js >= 22.5.0)
```

### System Architecture
- Executable: `/usr/bin/wa`
- Application bundle: `/usr/lib/wazir/wa.js`
- Service units: `/lib/systemd/system/wazir-api.service`, `/lib/systemd/system/wazir-worker.service`
- Persistent state: `/var/lib/wazir/`
- Logs: `/var/log/wazir/`

### Removal & Data Retention
- `sudo apt remove wazir`: Removes binaries and systemd units while **preserving** `/var/lib/wazir` databases and configuration.
- `sudo apt purge wazir`: Removes binaries, systemd units, system user, and deletes `/var/lib/wazir`.

---

## 3. Fedora / RHEL / CentOS Packaging (.rpm)

Wazir provides an RPM spec file at [packaging/rpm/wazir.spec](../packaging/rpm/wazir.spec).

### Building the RPM Package

```bash
npm run build:rpm
```

On a Fedora/RHEL build system with `rpmbuild`:

```bash
rpmbuild --define "_topdir dist/rpmbuild" -ba dist/rpmbuild/SPECS/wazir.spec
```

### Installation

```bash
sudo rpm -ivh dist/rpmbuild/RPMS/noarch/wazir-*.noarch.rpm
# Or using dnf:
sudo dnf install dist/rpmbuild/RPMS/noarch/wazir-*.noarch.rpm
```

---

## 4. Native System Services (`wa service`)

Wazir includes built-in service lifecycle management that automatically adapts to the underlying operating system:
- **Linux:** `systemd` (supports both system-wide units in `/etc/systemd/system/` and user units in `~/.config/systemd/user/`)
- **macOS:** `launchd` (supports LaunchAgents in `~/Library/LaunchAgents/` and LaunchDaemons in `/Library/LaunchDaemons/`)
- **Windows:** Windows Task Scheduler (`schtasks`) or Windows Service

### Service Commands

#### Install Service
```bash
# Install worker daemon (default)
wa service install

# Install API control plane daemon
wa service install --type api --port 3000

# Install with custom name
wa service install --name wazir-worker-02
```

#### Inspect Service Status
```bash
wa service status
# Or JSON output:
wa service status --json
```

#### Start, Stop, and Restart
```bash
wa service start
wa service stop
wa service restart
```

#### Uninstall Service
```bash
wa service uninstall
```

### Resilience & Hardening Invariants:
1. **Auto-Restart:** All generated service definitions include automatic restart on failure with backoff intervals (`Restart=always`, `RestartSec=5` on systemd; `KeepAlive` with `ThrottleInterval=5` on launchd).
2. **Environment File Loading:** Services automatically source environment variables from `~/.wazir/.env`.
3. **Least Privilege:** When installed as root on Linux, services drop privileges using `NoNewPrivileges=true` and `PrivateTmp=true`.
4. **Clean Child Termination:** On shutdown, the service manager ensures all spawned agent sub-processes and worker child processes receive termination signals without leaving orphaned processes.
