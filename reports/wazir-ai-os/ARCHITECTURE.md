# Wazir AI OS Architecture (v0.4.2+)

Wazir AI OS layers onto standard Ubuntu LTS + GNOME (and macOS/Windows) without forking the Linux kernel or replacing Mutter/GNOME:
1. **Wazir Shell (`apps/shell/`)**: Native Tauri 2 + `portable-pty` terminal with `ModalController`, kernel CWD sync (`pty_get_info`), and 4-tier routing.
2. **Wazir Mission Control (`apps/desktop/`, `apps/web/`)**: Operations console for fleet, goal graphs, approvals, and audit logs.
3. **Wazir Core & Coordination Fabric (`packages/core/`)**: `FastOrchestrator`, `JobOrchestrator`, `CoordinationFabric` (`in-process`, `durable-local`, `nats-core`), `MessageRouter`, `ResourceReservationManager`.
4. **Ubuntu GNOME Integration (`os/wazir-os-ubuntu/`)**: `org.wazir.SearchProvider` D-Bus service, Nautilus context actions, reversible `wazir-gnome-profile.sh`, and `build-apt-repo.sh`.
