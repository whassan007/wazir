# Ubuntu Compatibility — Wazir Shell

- **Target Platforms**: Ubuntu 24.04 LTS & Ubuntu 26.04 LTS (GNOME, x86_64 & ARM64).
- **Packaging (`scripts/build-deb.mjs`)**:
  - Fixed `wazir-worker.service` `ExecStart` from `/usr/bin/wa improve start --foreground --continuous` to `/usr/bin/wa worker start`.
  - Added `/usr/bin/wazir-shell` launcher (uses native GUI binary when `DISPLAY`/`WAYLAND_DISPLAY` is set, otherwise `wa shell`).
  - Installed `wazir-shell.desktop` (`Terminal=false`, `Exec=wazir-shell`), `wazir-mission-control.desktop`, `wazir.desktop`, `128x128` icons, and systemd user units (`usr/lib/systemd/user/`).
  - Added `Recommends: libwebkit2gtk-4.1-0, libgtk-3-0, libayatana-appindicator3-1, libsecret-1-0, libnotify-bin, xdg-utils` in `packaging/deb/debian/control`.
- **Verification**: `node scripts/build-deb.mjs` succeeded and produced `dist/wazir_0.4.2_all.deb`.
