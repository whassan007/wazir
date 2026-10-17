# Wazir Mobile/Desktop/iOS — handoff

Branch: `feat/wazir-mobile-android`. Written 2026-10-15/16 while at least two Claude
Code sessions were active on this same checkout concurrently (this one, and
`wazir-89` working on the Tauri desktop app). If you're picking this up, check
`git status`/`git log` first — this doc is a snapshot, not a live view.

## Android — done, committed

`apps/android/` — native Kotlin/Compose app (not a WebView wrapper). Talks to
the controller's mobile-specific REST API (`/api/v1/mobile/*` in
`apps/api/src/mobile.ts`), not the desktop web dashboard.

Commit `5149c3c` fixed, on an app that was otherwise much further along than
expected:
- App didn't compile (`MainActivity.kt` missing a Compose `setValue` import).
- Three routes the client called don't exist server-side — pairing
  (`/pairing/request|complete` → actually `/pair/request|complete`) and
  emergency-resume (`/emergency-resume` → actually `/resources/resume`) were
  completely broken.
- "Pin model" called an endpoint that doesn't exist on the server at all —
  removed end-to-end (API client, repo, ViewModel, UI).
- Model load/unload/reconcile and emergency-stop/resume are
  `auth.requireOperator`-gated server-side **by design** — a paired device's
  bearer token can never pass that check (see `apps/api/src/mobile.ts` around
  the `resources/emergency-stop` and `/api/v1/models/:id/load` routes for the
  inline rationale: a stolen phone shouldn't be able to halt the cluster).
  These were live buttons that always 403'd; replaced with explanatory,
  disabled states. **Do not wire these back up without an explicit product
  decision to add a device-reachable, suitably scoped version of them.**

Added 35 unit tests (`PairingUriParserTest`, `WazirControllerApiTest` with
MockWebServer) that pin every client call to its exact server route — this is
what would have caught the routing bugs above; keep it in sync with
`apps/api/src/mobile.ts` if routes change.

Verified: `./gradlew clean assembleDebug testDebugUnitTest` — clean, no
warnings, 35/35 passing. Not verified: on-device/emulator instrumented run
(no emulator was booted this session, only a static build+unit-test pass).

## Desktop — done, committed (two authors)

`apps/desktop/` — Tauri 2 shell around the existing `apps/web` React-free
dashboard (plain HTML/JS, not Electron — matches an earlier, separate
gap-analysis decision in `QWEN_WAZIR_GAP_ANALYSIS.md` that explicitly
rejected an Electron host).

- `a26f36c` (wazir-89): initial Tauri scaffold — native menu, window config,
  icons, `npm run desktop:dev`/`desktop:build`.
- `31a2a34` (this session): the scaffold only worked under `tauri dev`
  (`beforeDevCommand` starting `apps/api`+`apps/web` is a dev-only hook —
  a built binary loaded the static dashboard with **no backend behind it
  at all**). Fixed by having `main.rs` health-check ports 4800/4801 on
  startup and spawn `node dist/main.js` / `node server.js` itself if nothing
  is listening, logging to `~/Library/Logs/Wazir/{api,web}.log`. Window
  starts hidden, shows once the web port answers. Only child processes this
  instance actually spawned get killed on quit — a pre-existing or remote
  runtime is left alone.
- `75a5d37` (wazir-89): found the *next* layer under that fix — the API
  requires `WAZIR_API_TOKEN` by default and nothing set it for the
  self-spawned process, so it 401'd every request even after the above fix.
  Now generates a random token per launch and passes it as an env var to
  both spawned processes.
- `1de10fa`: version bump + changelog for both halves.
- Cross-platform Desktop completion:
  - Added cross-platform log directories (`dirs_log_dir`), Linux `secret-tool` keychain integration (`read_keychain_token` / `store_keychain_token`), Windows PowerShell toast notification fallback (`send_system_notification`), and SSH host alias import (`load_local_ssh_config_aliases` emitting `wazir://ssh-hosts-discovered`).
  - Enabled `"targets": "all"` in `apps/desktop/src-tauri/tauri.conf.json` and updated `apps/desktop/README.md`.
  - Verified with `cargo test` in `apps/desktop/src-tauri` (5/5 passing) and `npm run build -w @wazir/desktop`.

Verified (by both sessions, independently, end-to-end): cold launch with no
backend running → both node processes spawn, logs populate, dashboard loads
real data; closing the window kills both children, zero orphaned processes.

## iOS — full multi-surface parity done, verified

`apps/ios/WazirMobile/` — a **native SwiftUI app mirroring the Android
architecture** (same `/api/v1/mobile/*` API, same pairing flow, same
"operator-only" exclusions learned from the Android pass above), not a
WKWebView wrapper.

Full layer stack, all field-for-field ports of the Android sources (re-read
fresh each time, not from memory — see the Android section for the exact
files each mirrors):
- `Domain/Models.swift` + `DecodingHelpers.swift` — every DTO, `Codable`
  with hand-written `init(from:)` and an explicit `CodingKeys` enum on every
  one, including multi-surface parity models (`MobileAutonomyState`,
  `MobileVerifiableArtifact`, `MobileDiffFileItem`, `MobileScheduleItem`,
  `PushRelayRegistration`, `PushWakeupEvent`, etc.).
- `Security/CredentialVault.swift` — Keychain-backed (no extra AES layer
  needed, unlike Android's `SharedPreferences` + `KeystoreCredentialVault`).
- `Security/TlsPinning.swift` — system CA trust first, SHA-256
  leaf-fingerprint fallback for self-signed controllers.
- `Security/BiometricAuthGate.swift` — Face ID/Touch ID/passcode via
  `LocalAuthentication`, `.deviceOwnerAuthentication` policy.
- `Network/PairingUriParser.swift`, `Network/WazirControllerApi.swift` —
  includes all mobile endpoints including `/api/v1/mobile/autonomy`,
  `/api/v1/mobile/tasks/:id/artifacts`, `/api/v1/mobile/tasks/:id/diff-review`,
  `/api/v1/mobile/schedules*`, and `/api/v1/mobile/push/*`.
- `Network/MobileSseEventStream.swift` — `URLSession.bytes(for:)` line-by-line
  SSE parsing, cursor-based resume, exponential-backoff+jitter reconnect.
- `Network/MdnsControllerDiscovery.swift` — Bonjour `_wazir._tcp.` discovery
  via `Network.framework`'s `NWBrowser`.
- `Notifications/WazirNotificationManager.swift` + `BGAppRefreshTask` — local
  notifications via `UNUserNotificationCenter` and periodic background app
  refresh (`ai.wazir.mobile.refresh`) registered in `Info.plist` and
  `WazirMobileApp.swift` via `.backgroundTask(.appRefresh(...))`.
- `Data/ControllerStore.swift` & `Data/WazirRepository.swift` — JSON-file-backed
  cache + repository methods for tasks, approvals, autonomy, artifacts/diff
  reviews, schedules, and push relay registrations.
- `UI/MainViewModel.swift` & `UI/Screens/*.swift` —
  - `PairingOnboardingView.swift`: branded `WazirLogo` emblem + native
    `AVFoundation` QR code camera scanner (`QrCodeScannerSheet`) alongside
    paste-a-link, manual entry, and Bonjour mDNS scan.
  - `DashboardView.swift` & `RootView.swift`: Pending approval gate banner,
    Autonomy & Cellular Guard quick controls, and `.resources` navigation to
    `ResourcesView`.
  - `TaskDetailView.swift`: Verifiable Artifacts (plan steps, test checks, and
    per-file diff review with Keep/Skip actions).
  - `ApprovalsView.swift`: Pending/Resolved/Schedules tabs, Autonomy & Cellular
    Guard controls, Out-of-Band Push Relay (APNs registration, test wakeup,
    disable), and recurring schedule management (create, run now, pause/resume,
    delete).
- `Resources/Assets.xcassets/` — populated `AppIcon.appiconset` (all 11 iOS icon
  sizes) and `WazirLogo.imageset` from `assets/brand/ios/`.
- `Tests/` — `WazirControllerApiTests.swift` + `PairingUriParserTests.swift`:
  **37/37 passing** on simulator (`xcodebuild test`), covering all core and
  multi-surface routes.

## Android — full multi-surface parity done

- Completed end-to-end Push Relay integration across `WazirRepository.kt`,
  `MainViewModel.kt`, `OperationsScreens.kt` (`ApprovalCenterScreen`),
  `MainActivity.kt`, and `WazirControllerApiTest.kt` alongside the existing
  Autonomy, Verifiable Artifacts / Diff Review, and Schedules features.

## Cross-session coordination note

`wazir-89` was independently fixing the same Desktop 502/offline bug this
session found. We compared notes over `SendMessage` mid-session rather than
duplicating work — see commits `31a2a34`/`75a5d37`/`1de10fa` above for the
split. If another session is active when you read this, check `git log`
and `git status` before touching `apps/desktop` or branding
(`assets/brand/`, `scripts/generate-brand-assets.py` were uncommitted and
not mine as of this doc).
