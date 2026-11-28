# Regression Test Evidence

- **SwiftPM (`apps/wazir-fleet`):** 84 tests in 7 suites passed (0 failures).
- **TypeScript Build & Bundle (`npm run build`):** Exited 0 across all workspaces (`@wazir/core`, `@wazir/evaluation`, `@wazir/cli`, `@wazir/api`, `@wazir/desktop`, `@wazir/shell`, `@wazir/worker`, etc.).
- **Consolidated Vitest Suites:** 5 files, 13 tests passed (0 failures).
- **CLI Smoke Verification:** `wa fleet status --json`, `wa fleet parse`, `wa fleet plan`, `wa studio nodes --json`, `wa optimize status --json`, `wa extensions list --json`, `wa inspect local --json` all exited 0 with valid JSON.
