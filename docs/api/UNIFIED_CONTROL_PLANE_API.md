# Unified Control Plane API

- **Fleet State:** `~/.wazir/fleet-state.json` (shared between `wa` CLI and `apps/wazir-fleet` SwiftUI via `WazirControlPlaneBridge`).
- **Core Modules (`@wazir/core`):**
  - `packages/core/src/fleet/`: `parseFleetCommand`, `planFleetOperation`, `enrichFleetPlan`, `parseTailscaleStatusJson`, `parseHostMetricsOutput`, `executeFleetPlanDryRun`.
  - `packages/core/src/studio/`: `WAZIR_STUDIO_NODE_KINDS` (16 node types), `WazirStudioOrchestrator` (`recommendPlacement`, `reassignStudioNodeModel`, `simulateExecution`).
  - `packages/core/src/sdk/`: `WazirExtensionRegistry`, `BUILTIN_REFERENCE_EXTENSIONS`.
- **Optimization (`@wazir/evaluation`):**
  - `UnifiedOptimizationEngine`: `routeAtPhaseBoundary`, `compareModelsAndHarnesses`, `evaluateWithIndependentEvidence`, `runBoundedRepairLoop`.
