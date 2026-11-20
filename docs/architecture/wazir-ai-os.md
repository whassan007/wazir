# Wazir AI OS — System Architecture

Wazir AI OS is a cross-platform, AI-native execution environment that unifies traditional OS shell commands and governed AI task execution across local and distributed hardware.

## Seven Connected Components

1. **Wazir Shell (`apps/shell/`, `apps/cli/src/commands/shellCommand.ts`, `packages/core/src/services/shellClassifier.ts`)**
   - Native Tauri 2 + `portable-pty` graphical terminal (`Wazir Shell.app`) and `wa shell` CLI.
   - Deterministic input classification: `!` forces shell, `?` forces AI, automatic mode routes known shell syntax/builtins/pipes directly to the persistent PTY and natural-language requests to Wazir Core.
2. **Wazir Mission Control (`apps/desktop/`, `apps/web/public/mission-control.html`)**
   - Separate Tauri 2 operations console (`Wazir Mission Control.app`) with fleet machine drill-down, 10-state visual execution graph, approvals inbox, execution replay, and sanitized trace inspection.
3. **Wazir Core (`packages/core/`, `packages/agents/`, `packages/policies/`, `packages/scheduler/`, `packages/models/`)**
   - Task planning, PolicyEngine enforcement, capability-aware model routing (local-first Qwen preference), durable checkpoints, and VerificationEngine.
4. **Wazir Workers (`apps/worker/`, `apps/api/`)**
   - Distributed execution daemons on macOS, Linux/DGX Spark, and Windows with SSE task streaming, heartbeats, and lease-fenced execution claims.
5. **Wazir Mobile (`apps/android/`, `scripts/install-termux.sh`)**
   - Zero-root GrapheneOS/Android Jetpack Compose companion (`ai.wazir.mobile`) and Termux ARM64 CLI integration.
6. **Wazir Diagnostics (`packages/observability/`, `apps/api/src/diagnosticsRoutes.ts`)**
   - Consent-gated, redacted diagnostic collection, bounded offline queue, crash fingerprinting, deduplication, and local Qwen issue triage.
7. **Wazir Portal (`apps/portal/`)**
   - Public website (`https://wazir.wael.bot`) with interactive component explorer, explicitly labeled Public Demo fleet topology, verified downloads, 8-step onboarding, documentation, and commercial licensing inquiry workflow.
