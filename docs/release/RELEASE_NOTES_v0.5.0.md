# Wazir v0.5.0 Release Notes (Integration Branch `integration/fleet-consolidation`)

- Consolidated `whassan007/Fleet` into `whassan007/wazir` as **Wazir Fleet** (`apps/wazir-fleet`) with full Git history preserved.
- Unified licensing under **AGPL-3.0-only** with a separate commercial license option (`LICENSE-COMMERCIAL.md`).
- Added `packages/core/src/fleet/` (command parser, planner, Tailscale/metrics probes, shared `fleet-state.json`).
- Added `packages/core/src/studio/` (16-node Wazir Studio visual orchestration, capacity-safe Qwen placement, boundary reassignment, simulated vs live execution).
- Added `packages/evaluation/src/unifiedOptimizationEngine.ts` (phase-boundary routing, session stickiness, independent verification gate, bounded repair loops).
- Added `packages/core/src/sdk/` with 6 domain extension manifests (`lorecraft`, `90nf-forge`, `bazaar`, `robotics-simulation`, `research-evaluation`, `software-development`).
- Extended `wa` CLI with `wa fleet`, `wa studio`, `wa optimize`, `wa extensions`, `wa eval`, and `wa inspect`.
