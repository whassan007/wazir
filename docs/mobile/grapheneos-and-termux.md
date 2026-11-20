# GrapheneOS Companion & Termux ARM64 Integration

## 1. GrapheneOS / Android Companion (`apps/android/`)
- Package: `ai.wazir.mobile` (Jetpack Compose, minSdk 26, targetSdk 35).
- **Zero-Root Guarantee:** Never requests root access; respects Android/GrapheneOS sandboxing and scoped permissions.
- Features: Pairing via URI/QR (`PairingOnboardingScreen`), Fleet Dashboard (`DashboardScreen`), Tasks & Progress SSE (`TasksScreen`, `MobileSseEventStream`), Task Creation (`CreateTaskScreen`), Approvals & Operations (`OperationsScreens`), Room local persistence (`WazirDatabase`).

## 2. Termux ARM64 CLI Integration (`scripts/install-termux.sh`)
- Runs Wazir CLI (`wa`) inside Termux user-space using `nodejs-lts` on ARM64 Android/GrapheneOS.
- **Host Limitations:** Termux runs inside an unprivileged Android app sandbox; it cannot directly manage host systemd services or access other apps' private storage without Android SAF permissions.
- **Android Linux Terminal (AVF VM):** When available on Pixel/GrapheneOS, Wazir CLI can also run inside the Linux VM with standard Linux PTY support (`wa shell`).
