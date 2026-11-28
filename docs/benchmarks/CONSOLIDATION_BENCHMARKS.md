# Consolidation Benchmarks

- `npm run build` (all TypeScript workspaces + Tauri + `esbuild` bundle): ~11s
- `bin/wa.js` standalone bundle size: `17.3mb`
- `bin/wazir-worker.js` standalone bundle size: `192.5kb`
- `swift test --package-path apps/wazir-fleet`: 84 tests in 7 suites in `< 1s` (after build)
- Consolidated Vitest suites (`fleetSubsystem`, `wazirStudio`, `extensionSdk`, `unifiedOptimizationEngine`, `consolidatedCli`): 13 tests across 5 files in `1.35s`
