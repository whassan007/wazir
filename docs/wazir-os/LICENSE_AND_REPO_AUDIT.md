# Wazir OS: Repository, Brand, and License Audit

**Date:** 2026-11-19  
**Branch:** `feat/wazir-os-macification` (branched from `main` at `4fef398`)  
**Status:** Approved Architectural Baseline (Phase 1)

---

## 1. Wazir Repository Audit

| Component | Path | Language / Runtime | License | Current Capabilities & Gaps |
|---|---|---|---|---|
| **Root Monorepo** | `package.json`, `tsconfig.base.json` | Node.js `>=22.13.0`, TypeScript `5.6`, Vitest `2.1` | `AGPL-3.0-only` | Workspaces `packages/*`, `packages/runtimes/*`, `apps/*`. Unified `npm run build` and `vitest run`. |
| **Core Engine** | `packages/core/` | TypeScript | `AGPL-3.0-only` | Job orchestration, permissions (`permissionBroker.ts`), proactive task manager, meta-harness, resource admission. |
| **Policy & Secrets** | `packages/policies/`, `packages/secrets/` | TypeScript | `AGPL-3.0-only` | Deterministic shell/path/network policy gates, secret redaction. |
| **Scheduler & Models** | `packages/scheduler/`, `packages/models/`, `packages/workers/` | TypeScript | `AGPL-3.0-only` | Cron/timer scheduling, local/remote model routing, worker leases. |
| **API Control Plane** | `apps/api/` | Node / Express | `AGPL-3.0-only` | Loopback HTTP/SSE server on `:4800` (`/health`, `/ready`, `/api/v1/overview`, `/api/v1/models`, `/api/v1/workers`, `/api/v1/agents`, `/api/v1/executions`, `/api/v1/tasks/dispatch`, `/api/v1/goal-studio/*`, `/api/v1/autonomy`, `/api/v1/hosts`, `/api/v1/schedules`, `/mcp`). |
| **Web Dashboard** | `apps/web/` | HTML/CSS/JS + Node proxy (`:4801`) | `AGPL-3.0-only` | Complete dashboard UI (`apps/web/public/index.html` + `goal-studio/`) proxying `/api/*` with server-side bearer token injection. Inline CSS tokens already reference Wazir CVI colors, but lack a shared versioned token package, high-contrast mode, and reduced-motion tokens. |
| **Tauri Desktop Shell** | `apps/desktop/` | Rust (Tauri 2) | `AGPL-3.0-only` | Native window around `:4801`, OS keychain/`secret-tool` credential sync, native Control/Autonomy/Scheduler menus, background approval notifications. Needs Linux KDE/Wayland desktop integration, Spotlight/Settings/Monitor deep links, and shared design tokens. |
| **CLI & TUI** | `apps/cli/` | TypeScript (`bin/wa.js`) | `AGPL-3.0-only` | `wa` / `wazir` binary, `brand.ts` terminal CVI renderer, `wa search`, `wa fleet`, `wa doctor`, `wa explain`, `wa mcp`. |
| **Linux Packaging** | `packaging/rpm/wazir.spec`, `packaging/linux/wazir.desktop`, `scripts/systemd/` | RPM Spec, `.desktop`, systemd | `AGPL-3.0-only` | RPM spec and systemd units (`wazir-api.service`, `wazir-worker.service`) exist, but no Fedora Atomic OCI `Containerfile`, no KDE Plasma Look-and-Feel, no KRunner provider, and no SDDM/Plymouth branding. |

---

## 2. Official Brand Specification Audit

**Authoritative Sources (Read-Only — Never Overwrite):**
- `assets/brand/Wazir_CVI_Guidelines.pdf` (v1.0)
- `assets/brand/brand.json` (v1.0.0)
- `assets/brand/generated/` (`logo-emblem.svg`, `logo-lockup.svg`, `logo-monochrome.svg`, `emblem-transparent.png`, `lockup-transparent.png`)

### Extracted Authoritative Tokens
- **Primary Colors:**
  - `darkAbyss`: `#0f131a` (`rgb(15, 19, 26)`) — Primary background across terminals and dashboards
  - `electricBlue`: `#38bdf8` (`rgb(56, 189, 248)`) — Active states, primary CTA, counselor intelligence indicators
  - `metallicSilver`: `#94a3b8` (`rgb(148, 163, 184)`) — Secondary typography, borders, inactive iconography
  - `dataGreen`: `#22c55e` (`rgb(34, 197, 94)`) — Operational fleet status and verified execution hooks
- **Extended Colors:**
  - `iceWhite`: `#f8fafc` (`rgb(248, 250, 252)`) — Primary wordmark, crown highlights, high-contrast headings
  - `cyanCoreGlow`: `#67e8f9` (`rgb(103, 232, 249)`) — Central AI core and active circuit node highlights
  - `shieldInteriorNavy`: `#162032` (`rgb(22, 32, 50)`) — Shield body interior and elevated card surface
  - `shieldLowerSteel`: `#2f4469` (`rgb(47, 68, 105)`) — Lower shield facet shading and secondary structural accents
- **Typography:**
  - Display: `Archon Bold, SF Pro Display, Inter, system-ui, sans-serif` (weight `700`)
  - UI / Body: `Nexus Light, Inter, -apple-system, BlinkMacSystemFont, sans-serif` (weights `400`, `500`)
  - Monospace: `JetBrains Mono, Fira Code, ui-monospace, SFMono-Regular, monospace` (weights `400`, `700`)
- **Geometry & Usage Rules:**
  - Minimum digital emblem size: `96px` (`25mm` print)
  - Clear space ratio: `0.25`
  - Always pair wordmark with subtitle `"A Local AI Fleet Counselor"` in technical contexts
- **Prohibited Modifications:**
  1. Never modify core proportions of the shield geometry
  2. Never substitute unauthorized neon accent colors
  3. Never stretch the 16:9 presentation card directly into a 1:1 square icon
  4. Never replace the Crowned Circuit-Shield emblem with a generic monogram

---

## 3. Desktop & OS Component Candidate Audit

| Candidate | Upstream / Source | License | Compatibility (Plasma 6 / Wayland / Atomic) | Update Policy & Security | Integration Cost & Decision |
|---|---|---|---|---|---|
| **KDE Plasma 6 Desktop** (`plasma-desktop`, `plasma-workspace`) | KDE (`invent.kde.org/plasma`) | `GPL-2.0-or-later` / `LGPL-2.1-or-later` | Native Wayland, fractional scaling, Global Menu (`org.kde.plasma.appmenu`), floating panel, Icon-Only Task Manager (`org.kde.plasma.icontasks`). | Maintained by Fedora Kinoite & upstream KDE; atomic OS updates preserve `/usr/share/plasma` Look-and-Feel packages. | **Low / SELECTED.** Use native Plasma 6 Look-and-Feel (`org.wazir.os.desktop`) + `/etc/skel` defaults. Zero post-install scripts. |
| **KWin (Wayland)** | KDE (`invent.kde.org/plasma/kwin`) | `GPL-2.0-or-later` | Native Wayland compositor, Overview (`kwin4_effect_overview`), Desktop Grid, multi-monitor hotplug, fractional scaling, `org.kde.kdecoration2` left-side window buttons. | Upstream KDE security & Wayland protocol updates; isolated from user AI workloads. | **Low / SELECTED.** Configure declaratively via `kwinrc` and `kglobalshortcutsrc`. |
| **KRunner** | KDE (`invent.kde.org/frameworks/krunner`) | `LGPL-2.1-or-later` | Native `Alt+Space` / `Meta+Space` launcher with `org.kde.krunner1` D-Bus plugin protocol. | Built-in app, file (`baloo`), calculator, and system settings runners stay functional even if D-Bus plugins fail or go offline. | **Low / SELECTED.** Extend via isolated `@wazir/spotlight` D-Bus service (`org.wazir.Spotlight`). |
| **Dolphin** | KDE (`invent.kde.org/system/dolphin`) | `GPL-2.0-or-later` | Native Wayland file manager, split view, Places sidebar, previews, editable path bar. | Upstream KDE; configuration lives in `dolphinrc` (`XDG_CONFIG_HOME`). | **Low / SELECTED.** Ship Finder-like `dolphinrc` defaults in `/etc/skel/.config/dolphinrc`. |
| **Universal Blue / Fedora Atomic Kinoite** (`ghcr.io/ublue-os/kinoite-main` / `fedora-kinoite`) | `ublue-os` / Fedora Project | `Apache-2.0` (uBlue tooling) / `GPL+MIT` (Fedora packages) | Immutable `rpm-ostree` / `bootc` OCI image with KDE Plasma 6 Wayland, automatic A/B rollback, `cosign` image signing, `bootc-image-builder` ISO generation. | Atomic image rebases; user config in `/etc` and `/home` survives OS updates cleanly; failed updates roll back at GRUB/ostree. | **Medium / SELECTED.** Base OS & release infrastructure for Wazir OS. |
| **XMacTahoe** (`chapdel/XMacTahoe`) | GitHub (`chapdel`) | `GPL-3.0` + mixed bundled assets (`CC-BY-SA-4.0`, `MIT`, `SIL`) | Designed as a mutable post-install script mutating `~/.config` and `~/.local/share` with `xmactahoe doctor`. | Requires manual post-install scripts; conflicts with immutable Fedora Atomic `/usr`; mixed third-party asset licenses and unverified Plasma 6.x drift. | **High / REJECTED.** Violates "no post-install theme scripts", "survive OS updates", and Wazir CVI brand exclusivity. |
| **Third-Party macOS Dock Plasmoids** (`hud-macos-dock`, `spacedock`, `dockyard`, `plasma-stack`) | GitHub community | `GPL-3.0` | QML plasmoids targeting Plasma 6; prone to QML API drift across Plasma minor releases. | Unmaintained or single-author update cadence; can crash `plasmashell` on ABI/QML changes. | **Medium / REJECTED for core dock.** Use Plasma 6's native floating panel + `org.kde.plasma.icontasks` for rock-solid OS updates. |
| **Wazir Fleet Plasmoid** (`org.wazir.fleet`) | Wazir OS (first-party) | `AGPL-3.0-only` | Minimal QML plasmoid using only stable `org.kde.plasma.plasmoid` & `org.kde.kirigami` APIs, polling loopback `/health` & `/api/v1/overview` asynchronously. | Maintained in this repo; degrades gracefully to "Offline" badge if `@wazir/api` is stopped. | **Low / SELECTED.** Provides native top-bar AI Fleet status without risking `plasmashell` stability. |

---

## 4. License Compatibility Summary

- **OS Base & KDE Components:** Distributed as a Fedora Atomic / Universal Blue OCI image (`GPL-2.0+` / `GPL-3.0+` / `LGPL-2.1+` / `Apache-2.0`).
- **Wazir Platform & OS Extensions:** `@wazir/design-tokens`, `@wazir/spotlight`, `@wazir/desktop`, `@wazir/api`, `@wazir/web`, `@wazir/cli`, Plasma Look-and-Feel (`org.wazir.os.desktop`), and Fleet Plasmoid (`org.wazir.fleet`) are `AGPL-3.0-only` (compatible with GPL-3.0+ system distribution when packaged as distinct OCI layers / RPMs).
- **Zero Proprietary / Restrictive Blobs:** No proprietary macOS fonts, icons, or wallpapers are redistributed. Typography uses open-source `Inter` and `JetBrains Mono` (SIL OFL 1.1) with `SF Pro Display` / `Archon Bold` as CSS fallback stack only.
