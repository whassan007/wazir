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

Verified (by both sessions, independently, end-to-end): cold launch with no
backend running → both node processes spawn, logs populate, dashboard loads
real data; closing the window kills both children, zero orphaned processes.

Still true / deliberately not done: no signed/bundled installer
(`bundle.targets: []`, `desktop:build` passes `--no-bundle` — no signing
certs in this environment), no remote-host connection mode (desktop is
local-only right now; only the Android/iOS mobile API layer has
pairing/remote-profile support).

## iOS — functional slice done, committed, verified

`apps/ios/WazirMobile/` — a **native SwiftUI app mirroring the Android
architecture** (same `/api/v1/mobile/*` API, same pairing flow, same
"operator-only" exclusions learned from the Android pass above), not a
WKWebView wrapper.

Full layer stack, all field-for-field ports of the Android sources (re-read
fresh each time, not from memory — see the Android section for the exact
files each mirrors):
- `Domain/Models.swift` + `DecodingHelpers.swift` — every DTO, `Codable`
  with hand-written `init(from:)` (the real API responses are sparse — `{}`
  is valid for many of these — so Swift's synthesized `Decodable` would throw
  on real traffic) **and an explicit `CodingKeys` enum on every one**: Swift
  only synthesizes `CodingKeys` alongside a synthesized `init(from:)`/
  `encode(to:)`, so a hand-written decoder referencing `CodingKeys.self`
  without declaring the enum fails to compile — hit this across ~40 types,
  full rewrite fixed it. Once `CodingKeys` already existed by hand, switching
  `Decodable` → `Codable` let `encode(to:)` synthesize for free for caching
  (one exception: `MobileApprovalRecord` needed a manual `encode(to:)` too,
  since its `redactedArgumentsDescription` field doesn't map 1:1 to the
  `redactedArguments` wire key).
- `Security/CredentialVault.swift` — Keychain-backed (no extra AES layer
  needed, unlike Android's `SharedPreferences` + `KeystoreCredentialVault`).
- `Security/TlsPinning.swift` — system CA trust first, SHA-256
  leaf-fingerprint fallback for self-signed controllers.
- `Security/BiometricAuthGate.swift` — Face ID/Touch ID/passcode via
  `LocalAuthentication`, `.deviceOwnerAuthentication` policy (closest iOS
  equivalent to Android's `BIOMETRIC_STRONG|WEAK|DEVICE_CREDENTIAL`).
- `Network/PairingUriParser.swift`, `Network/WazirControllerApi.swift` —
  **start from the already-fixed Android paths** (`pair/request`,
  `pair/complete`, `resources/resume`), not the broken ones Android first
  shipped with. `loadModel`/`unloadModel`/`reconcileModels`/`emergencyStop`/
  `emergencyResume` stay client-layer-only (operator-gated server-side); no
  screen calls them.
- `Network/MobileSseEventStream.swift` — `URLSession.bytes(for:)` line-by-line
  SSE parsing, cursor-based resume, exponential-backoff+jitter reconnect,
  mirrors Android's OkHttp-SSE-based stream (including its event
  deduplicator).
- `Network/MdnsControllerDiscovery.swift` — Bonjour `_wazir._tcp.` discovery
  via `Network.framework`'s `NWBrowser` (Android uses `NsdManager`).
- `Notifications/WazirNotificationManager.swift` — local notifications via
  `UNUserNotificationCenter`, same event-type → title/body mapping as
  Android's `onStreamEvent`, routes via `userInfo` instead of Android's
  `Intent` extras. **Not ported**: Android's `ControllerSyncWorker`
  (periodic background sync via WorkManager) — iOS background execution is
  far more restricted; would need `BGAppRefreshTask`/`BGProcessingTask`
  wiring as a separate piece of work if background sync turns out to matter.
- `Data/ControllerStore.swift` — JSON-file-backed cache (controller list +
  per-controller snapshot + a 50-entry-bounded task-detail cache) under
  `~/Library/Application Support/WazirMobile/`, playing Room's role without
  pulling in CoreData/SwiftData for what's a handful of small blobs. Device
  credentials never live here — only in `CredentialVault`.
- `Data/WazirRepository.swift` — ties the above together, mirrors
  `WazirRepository.kt` (partial-failure tolerance: if the dashboard AND task
  list both fail, the whole refresh fails so the UI falls back to cache;
  otherwise it merges whatever succeeded).
- `UI/MainViewModel.swift` — one `@Published var state: WazirUiState`,
  `@MainActor`, mirrors `MainViewModel.kt`'s state shape and every action
  (pairing flow incl. polling, controller switching, task CRUD, approval
  resolution, SSE/mDNS wiring, event merge/dedup/cap-at-80).
- `UI/Screens/*.swift` — Pairing/Onboarding (paste-a-`wazir://pair`-link +
  manual-fields form + mDNS-discovered list + awaiting-approval view with
  confirmation code), Dashboard, Tasks (tab-filtered list), Task Detail
  (timeline/tool-calls/verification/logs, live-polls while visible), Create
  Task, Approvals (pending/resolved, biometric gate on `requiresBiometric`),
  Models & Runtimes (read-only, explanatory text — no mutate controls, see
  above), Compute Workers, Resources (read-only, same reason). These are
  idiomatic SwiftUI, not a pixel-for-pixel port of the Compose layouts —
  same data, same actions, same restrictions, different presentation layer.
- `UI/RootView.swift` — `TabView` (Home/Tasks/Approvals/Models/Workers) each
  in its own `NavigationStack`, controller switcher + SSE-state dot in the
  toolbar, notification-tap and `wazir://pair` deep links both route through
  it.
- `WazirMobileApp.swift` — builds the dependency graph, requests notification
  authorization, registers the `UNUserNotificationCenterDelegate`, handles
  `onOpenURL` for `wazir://pair`.
- `Tests/` — `StubURLProtocol.swift` (records every request, serves canned
  responses in order — the `URLProtocol`-based analog of MockWebServer) +
  `WazirControllerApiTests.swift` + `PairingUriParserTests.swift`: the same
  route-pinning suite Android has, **33/33 passing**, run on a real booted
  simulator (not just `build`), including the 401→rotate→retry path and an
  explicit regression guard on the emergency-resume path.

Verified end-to-end: `xcodebuild build` and `xcodebuild test` both clean (no
warnings), app installs and launches on a real booted iOS 27.0 simulator
(`xcrun simctl launch` + screenshots — the Pairing screen renders its real
content: header, paste-link field, manual-entry toggle, notification
permission prompt fires correctly).

**Not yet done / explicitly deferred**:
- QR camera scanning (AVFoundation) — pairing currently only supports
  pasting the `wazir://pair?...` URI text or opening it as a link (the `wa
  mobile pair` CLI output includes the same URI the QR code encodes) or
  manual field entry. No camera code exists yet.
- Background periodic sync (`BGAppRefreshTask`) — see
  `WazirNotificationManager` note above.
- App icon image (still an empty `AppIcon.appiconset`) and a bespoke launch
  screen.
- No real device testing (simulator only) — Face ID/Touch ID and push
  notifications behave differently on a physical device; the simulator's
  Face ID is software-simulated (`xcrun simctl ui ... faceid`), not covered
  here.
- No tap-through / UI test of the full pairing → dashboard → task flow
  against a live controller — verified by code review + unit tests +
  confirming the app boots and renders, not by a live end-to-end click-through
  (unlike Android/Desktop above, which *were* clicked through against a real
  running controller).

### Resuming iOS work
1. If you want real end-to-end verification: run a Wazir controller locally
   (`npm run start:dashboard` from repo root, or `apps/desktop`), run
   `wa mobile pair` (or whatever the current pairing CLI command is) to get
   a real `wazir://pair?...` URI, paste it into the simulator's pairing
   screen, and click through to a real task.
2. QR scanning: add an `AVFoundation`/`VisionKit` capture view, feed results
   into the same `PairingUriParser.parse(...)` + `pairFromQrUri` path already
   wired up for pasted text.
3. Background sync, if it turns out to matter: `BGAppRefreshTask` registered
   in `WazirMobileApp`, calling the same `MainViewModel.refreshAll(silent:
   true)` path.
4. After any change: `xcodegen generate` (if `project.yml` changed) →
   `xcodebuild build -destination 'generic/platform=iOS Simulator'` for fast
   compiler feedback → `xcodebuild test -destination 'platform=iOS
   Simulator,id=<udid from xcrun simctl list devices available>'` before
   moving on.

## Cross-session coordination note

`wazir-89` was independently fixing the same Desktop 502/offline bug this
session found. We compared notes over `SendMessage` mid-session rather than
duplicating work — see commits `31a2a34`/`75a5d37`/`1de10fa` above for the
split. If another session is active when you read this, check `git log`
and `git status` before touching `apps/desktop` or branding
(`assets/brand/`, `scripts/generate-brand-assets.py` were uncommitted and
not mine as of this doc).
