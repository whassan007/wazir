# Wazir OS Architecture & Design Decisions

**Version:** 1.0.0  
**Base Platform:** Fedora Atomic (Kinoite / Universal Blue OCI) + KDE Plasma 6 + Wayland  

---

## Architectural Decision Records (ADRs)

### ADR-001: Immutable OS Image via Fedora Atomic / `bootc` OCI
- **Decision:** Build Wazir OS as an OCI container image extending `ghcr.io/ublue-os/kinoite-main:41` (or `quay.io/fedora/fedora-kinoite:41`), managed via `bootc` / `rpm-ostree`.
- **Rationale:** Macification assets (`/usr/share/plasma/look-and-feel/org.wazir.os.desktop`, `/usr/share/color-schemes/Wazir*.colors`, `/etc/skel/.config/*`, `/etc/environment.d/*`) live in the immutable image layer and `/etc/skel`. OS upgrades atomically swap the OSTree deployment while preserving user state in `/var/home`, and failed updates roll back cleanly at boot.

### ADR-002: Native Plasma 6 + KWin Macification (No Post-Install Scripts)
- **Decision:** Implement the macOS-like top menu bar, centered floating dock, left-side traffic-light window controls, Mission Control Overview (`Meta+Up`), and Finder-like Dolphin layout exclusively using native Plasma 6 (`org.kde.plasma.appmenu`, `org.kde.plasma.icontasks`, `kwin4_effect_overview`, `dolphinrc`).
- **Rationale:** Native KDE components are GPU-accelerated on Wayland, support per-display fractional scaling and hotplug out of the box, and survive KDE minor/major upgrades without third-party QML breakage.

### ADR-003: Isolated KRunner D-Bus Provider for Wazir Spotlight
- **Decision:** Expose Wazir Spotlight (`@wazir/spotlight`) as a user systemd service (`wazir-spotlight.service`) implementing `org.kde.krunner1` on the session D-Bus (`org.wazir.Spotlight`, `/WazirSpotlight`).
- **Rationale:**
  1. **Zero LLM for Deterministic Actions:** App launch, file search, ripgrep code search (`repo:`/`code:`), terminal execution (`>`/`sh:`), model listing (`@`/`models`), fleet status (`fleet`/`agents`), and session history (`sessions`) execute deterministically without invoking an LLM.
  2. **Policy-Governed AI Tasks:** Natural-language AI requests (`wazir:`, `ai:`, `? `) dispatch through `@wazir/api` (`/api/v1/tasks/dispatch` or `/api/v1/goal-studio/runs`), inheriting Wazir's existing permission broker, sandboxing, and verification pipeline.
  3. **Failure Isolation:** If `@wazir/api` or `@wazir/spotlight` is offline or crashes, KRunner's native app/file/calculator runners continue operating normally with zero desktop freeze.

### ADR-004: Single Source of Truth for Wazir Design Tokens
- **Decision:** Create `@wazir/design-tokens` (`packages/design-tokens/`) derived from `assets/brand/brand.json` and `assets/brand/Wazir_CVI_Guidelines.pdf` (read-only).
- **Rationale:** Generates both `wazir-tokens.css` (consumed by `@wazir/web` and `@wazir/desktop`) and KDE `.colors` / Konsole `.colorscheme` / Plasma theme files from one versioned schema, ensuring Dark, Light, High-Contrast (WCAG AAA), and Reduced-Motion parity across login, splash, desktop, terminal, launcher, and settings.

### ADR-005: Developer-Native Surfaces Without Duplicating Control Plane
- **Decision:** All 7 developer-native surfaces (Wazir Terminal, Wazir Spotlight, Wazir Mission Control, Wazir Fleet, Wazir Agent Monitor, Wazir Approvals, Wazir Settings) delegate state, orchestration, scheduling, model routing, and policy enforcement to `@wazir/api` (`:4800`), `@wazir/web` (`:4801`), `@wazir/desktop`, and `wa` CLI.
- **Rationale:** Avoids split-brain state or policy bypasses. Normal shell commands in Wazir Terminal run natively in `zsh`/`bash` with zero AI interception; AI operations require explicit invocation and policy-governed execution.

---

## System Topology

```
+-------------------------------------------------------------------+
|  KDE Plasma 6 / KWin (Wayland)                                    |
|  - Top Menu Bar (AppMenu + Wazir Fleet Plasmoid + System Tray)    |
|  - Floating Dock (Pinned Apps + IconTasks + Trash)                |
|  - KRunner (Super+Space) <---> D-Bus org.wazir.Spotlight          |
|  - Dolphin (Finder-like) | Konsole (Wazir Terminal)               |
+----------------------------------+--------------------------------+
                                   | Loopback HTTP/SSE (:4800 / :4801)
                                   | + OS Keychain / secret-tool
+----------------------------------v--------------------------------+
|  Wazir Control Plane (User / System Services)                     |
|  - wazir-api.service (:4800)  [Orchestration, Policy, Models]     |
|  - wazir-web.service (:4801)  [Dashboard & Mission Control UI]    |
|  - wazir-spotlight.service    [KRunner D-Bus + Ripgrep + Router]  |
|  - @wazir/desktop (Tauri 2)   [Approvals, Monitor, Settings]      |
+-------------------------------------------------------------------+
```
