# Ubuntu Installation & Packaging

- **Package**: `dist/deb/wazir_0.4.2_all.deb` (and `dist/wazir_0.4.2_all.deb`)
- **APT Staging**: `dist/apt/pool/main/w/wazir/wazir_0.4.2_all.deb` (via `os/wazir-os-ubuntu/apt/build-apt-repo.sh`)
- **Fixes Applied**:
  - `wazir-worker.service` `ExecStart` fixed to `/usr/bin/wa worker start`.
  - `/usr/bin/wazir-shell` launcher, `wazir-shell.desktop` (`Terminal=false`), GNOME Search Provider, Nautilus extension, and `wazir-gnome-profile.sh` packaged.
- **Status**: `.deb` build `VERIFIED_OPERATIONAL`; live Ubuntu 24.04/26.04 `apt install` `IMPLEMENTED_NOT_VERIFIED` (macOS host).
