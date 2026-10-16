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

## iOS — in progress, core layer verified, no UI yet

`apps/ios/WazirMobile/` — intentionally a **native SwiftUI app mirroring the
Android architecture** (same `/api/v1/mobile/*` API, same pairing flow, same
"operator-only" exclusions learned from the Android pass above), not a
WKWebView wrapper. No `.xcodeproj`/`project.yml` yet — only Swift sources so
far, directly transcribed from `apps/android/app/.../domain/Models.kt` and
`.../security/SecurityLayer.kt` field-for-field (not from memory — re-read the
Kotlin source first) to avoid repeating the Android session's own path-typo
class of bug.

Written so far, **uncompiled**:
- `Sources/WazirMobile/Domain/Models.swift` + `DecodingHelpers.swift` — every
  DTO from the Kotlin file, as `Decodable` with hand-written `init(from:)`
  (Swift's synthesized `Decodable` has no concept of a Kotlin-style field
  default, and the real API responses are sparse — `{}` is a valid body for
  many of these — so synthesis would throw on real traffic).
- `Sources/WazirMobile/Security/CredentialVault.swift` — Keychain-backed
  (simpler than Android: iOS Keychain entries are encrypted at rest by the
  Secure Enclave class key already, so there's no separate AES-wrap layer
  like Android's `KeystoreCredentialVault` needed).
- `Sources/WazirMobile/Security/TlsPinning.swift` — `URLSessionDelegate`
  mirroring Android's `TlsPinningClientFactory`/`FingerprintPinnedTrustManager`:
  system CA trust first, SHA-256 leaf-fingerprint fallback for self-signed
  controllers pinned during QR/manual pairing.

Also written and **verified**, since this session:
- `Network/PairingUriParser.swift` — field-for-field port of the Android
  object (same validation rules, same error cases).
- `Network/WazirControllerApi.swift` — field-for-field port of
  `WazirControllerApi.kt`, **including the three already-fixed Android paths**
  (`pair/request`, `pair/complete`, `resources/resume` — not the broken
  `pairing/*`/`emergency-resume` Android originally shipped with). Also keeps
  `loadModel`/`unloadModel`/`reconcileModels`/`emergencyStop`/`emergencyResume`
  at the client layer only (operator-gated server-side, same as Android — see
  the Android section above); no SwiftUI screen should call these.
- `project.yml` (xcodegen) + generated `WazirMobile.xcodeproj` — one app
  target (`WazirMobile`, bundle id `ai.wazir.mobile`, iOS 16+, `wazir://`
  URL scheme registered, camera/Face ID usage strings set) and one test
  target (`WazirMobileTests`).
- `Tests/StubURLProtocol.swift` + `Tests/WazirControllerApiTests.swift` +
  `Tests/PairingUriParserTests.swift` — the same route-pinning test suite
  Android has (`StubURLProtocol` stands in for MockWebServer: records every
  request, serves canned responses in enqueue order). **33/33 passing**,
  run on a real booted simulator (not just `build`), including the 401→token
  rotation→retry path and the exact emergency-resume-path regression guard.
- `WazirMobileApp.swift` — currently just a placeholder view; confirmed via
  `xcrun simctl launch` + a screenshot that the compiled app actually boots
  on-device (iPhone 17 simulator, iOS 27.0) without crashing.

Toolchain, fully working as of this doc: Xcode 27.0 licensed, first-launch
components installed, `xcodegen` installed via Homebrew, iOS 27.0 simulator
runtime downloaded and a device booted. `xcodebuild build -destination
'generic/platform=iOS Simulator'` compiles without needing a booted
simulator; `xcodebuild test -destination 'platform=iOS Simulator,id=<udid>'`
needs one (`xcrun simctl list devices available` to find a udid).

**Not yet written**: biometric (`LocalAuthentication`/Face ID) gate, the
repository/view-model layer, every SwiftUI screen (pairing/onboarding,
dashboard, tasks, task detail/live monitor, create task, approvals,
models/runtimes (read-only — see the Android operator-gating note),
compute workers, resources (read-only)), app icon image (currently an empty
`AppIcon.appiconset`), deep-link handling for `wazir://pair` inside
`WazirMobileApp.swift` (the URL scheme is registered in `project.yml` but
nothing consumes `onOpenURL` yet), QR scanning (AVFoundation).

### Resuming iOS work
1. Build the Keychain-backed repository/view-model layer on top of
   `WazirControllerApi`/`CredentialVault` (mirrors
   `apps/android/.../data/WazirRepository.kt` +
   `.../ui/MainViewModel.kt`).
2. Write the SwiftUI screens mirroring
   `apps/android/.../ui/screens/*.kt` — **including** the
   already-learned lesson from the Android section above: do not expose
   load/unload/pin/reconcile/emergency-stop/resume as tappable controls:
   they always fail for a device credential by server-side design.
3. Wire `wazir://pair` into `onOpenURL` in `WazirMobileApp.swift` (parse with
   `PairingUriParser`, same as Android's `MainActivity.handleIntent`).
4. Add Face ID/Touch ID via `LocalAuthentication.LAContext`, mirroring
   Android's `BiometricAuthGate` (gate: approving a biometric-required
   approval, emergency actions if ever exposed to an operator-mode client).
5. After each slice: `xcodebuild build -destination 'generic/platform=iOS
   Simulator'` for fast compiler feedback, then `xcodebuild test
   -destination 'platform=iOS Simulator,id=<udid from xcrun simctl list
   devices available>'` before moving on — this is what caught the
   systemic `CodingKeys` bug in `Models.swift` (Swift's synthesized
   `Decodable` doesn't exist once you write a custom `init(from:)`, so every
   DTO needs its own explicit `CodingKeys` enum — easy to get wrong across
   ~40 types, exactly the kind of thing that only shows up at compile time).
6. Click through pairing → dashboard → a task on the simulator, the same way
   Android and Desktop were manually verified above.

## Cross-session coordination note

`wazir-89` was independently fixing the same Desktop 502/offline bug this
session found. We compared notes over `SendMessage` mid-session rather than
duplicating work — see commits `31a2a34`/`75a5d37`/`1de10fa` above for the
split. If another session is active when you read this, check `git log`
and `git status` before touching `apps/desktop` or branding
(`assets/brand/`, `scripts/generate-brand-assets.py` were uncommitted and
not mine as of this doc).
