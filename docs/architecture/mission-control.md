# Wazir Mission Control Architecture

## Overview

`Wazir Mission Control` (`apps/desktop/`, `apps/web/public/mission-control.html`) is a dedicated Tauri 2 operations console separated from `Wazir Shell`.

## Key Capabilities

1. **Fleet Visualization**: Displays registered machines with OS/arch, online/offline state, last heartbeat, capabilities, models, and CPU/GPU/memory telemetry (explicitly marking missing telemetry as `unavailable`). Clicking a machine opens a hardware & model drill-down drawer.
2. **10-State Visual Execution Graph**:
   `User Request -> Planner -> Model Router -> Worker -> Tool Execution -> Verification -> Result`
   Distinguishes: `Planned`, `Queued`, `Running`, `Waiting for approval`, `Verifying`, `Completed and verified`, `Completed but unverified`, `Failed`, `Cancelled`, `Disconnected`.
   Supports search, state filtering, zoom, execution replay, and trace inspection.
3. **Jobs & Approvals Inbox**: Displays queued, active, and historical jobs, pending tool approvals, diagnostic issues, and About/Licensing metadata.
4. **Security**: Operator bearer token is synchronized between `~/.wazir/local-operator.token` and OS Keychain (`ai.wazir.desktop.operator`) and injected server-side by `@wazir/web` only for trusted loopback requests.
