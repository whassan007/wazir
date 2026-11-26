# Package Manifest — Wazir AI OS v0.4.2

- `dist/deb/wazir_0.4.2_all.deb`: CLI (`/usr/bin/wa`, `/usr/bin/wazir`), Shell launcher (`/usr/bin/wazir-shell`), systemd units (`wazir-api.service`, `wazir-worker.service`, `wazir-gnome-search.service`), GNOME Search Provider, Nautilus extension, and reversible profile script.
- `apps/shell/src-tauri/target/release/wazir-shell`: Native Tauri 2 + `portable-pty` executable.
- `bin/wa.js`: Standalone CLI bundle (`15.5mb`).
