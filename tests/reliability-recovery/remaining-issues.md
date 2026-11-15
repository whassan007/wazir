# Remaining Issues & Environment Notes

1. **Localhost HTTP test binding inside sandbox (`packages/runtimes/lmstudio/tests/retry.test.ts`, `streamDisconnect.test.ts`, `apps/api/tests/p0Remediation.test.ts`):**
   - When executed inside the restricted terminal sandbox, tests that spin up an ephemeral `127.0.0.1` HTTP server and connect via `fetch()` fail with `connect EPERM 127.0.0.1:<port>`. These require an unsandboxed test run to exercise local TCP loopback.
2. **Platform-conditional Linux sandbox tests (`packages/tools/tests/sandbox.test.ts`):**
   - 10 tests are skipped on macOS (`darwin`) because they test Linux `bwrap` / namespace flags.
3. **Monolithic file decomposition (`fleetTui.ts`, `solutionSearchService.ts`):**
   - `apps/api/src/protocolRoutes.ts` was extracted from `apps/api/src/server.ts`; `fleetTui.ts` (~7.8k lines) and `solutionSearchService.ts` (~3.2k lines) remain large and should be decomposed in a dedicated refactoring pass.
