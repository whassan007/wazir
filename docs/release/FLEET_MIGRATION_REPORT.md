# Fleet Repository Migration Report

- **Canonical Repository:** `https://github.com/whassan007/wazir` (base `3620569`, `v0.4.4`)
- **Absorbed Repository:** `https://github.com/whassan007/Fleet` (base `793ab52ac3b5791efd8be6b526a8e38ba2f15dcf`)
- **Integration Branch:** `integration/fleet-consolidation`
- **Strategy:** History-preserving `git subtree add` into `imports/fleet`, baseline SwiftPM verification, then `git mv imports/fleet apps/wazir-fleet`.
- **Canonical Engine:** Wazir TypeScript/Node.js (`@wazir/core`, `@wazir/evaluation`, `@wazir/goals`, `@wazir/scheduler`, `@wazir/models`, `@wazir/cli`, `@wazir/api`).
- **Native macOS UI:** `apps/wazir-fleet` (Wazir Fleet SwiftUI app + `WazirControlPlaneBridge` syncing `~/.wazir/fleet-state.json`).
