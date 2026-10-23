# Wazir Release Readiness — Security & Dependency Audit

## 1. Platform & Runtime Security Controls Audit (Agent `A6` — `PASS`)

Agent `A6` (`7e9953c0-0817-4f92-9c66-acc0cff2c800`) audited all 9 security domains at commit `8ed0269eaa051eb9e66fe455465ee454b393ab66` and executed 10 security test suites (`125 passed, 0 failed, 10 Linux bwrap platform-skipped`):

| # | Security Control | Implementation Reference | Test Suite Verification | Verdict |
|---|---|---|---|---|
| 1 | **Sandbox Isolation** (`seatbelt` on macOS, `bwrap`+`seccomp` on Linux, env-change cache invalidation) | `packages/tools/src/sandbox.ts:166-434` | `packages/tools/tests/sandbox.test.ts` (10/10 macOS passed) | **PASS** |
| 2 | **Tool Authorization & `effectiveIsolation` Propagation** | `apps/cli/src/run.ts:807-813,1529-1535`, `apps/cli/src/fleetRunner.ts:409-415`, `apps/api/src/toolExecution.ts:82-88`, `apps/cli/src/tui/fleetTui.ts:3075-3098` | `packages/core/tests/phase4SandboxAndCodeMode.test.ts` (9/9 passed) | **PASS** |
| 3 | **Unknown-Tool Denial (`unknown-tool` fail-closed)** | `packages/core/src/services/policyEngine.ts:389,795-800`, `packages/tools/src/registry.ts:201-214` | `packages/core/tests/policyEngine.test.ts` (23/23 passed) | **PASS** |
| 4 | **Shell Execution Policy & Wrapper/Redirect Containment** (`bash -c` trust isolation) | `packages/core/src/services/policyEngine.ts:221-239,899-1072,1478-1526` | `packages/core/tests/policyEngineShell.test.ts` (25/25 passed) | **PASS** |
| 5 | **Workspace File Protections & Symlink TOCTOU Prevention** (`O_NOFOLLOW`, `assertSameInode`, `.git`/`.wazir` protection) | `packages/tools/src/paths.ts:42-149`, `packages/core/src/services/policyEngine.ts:128-132,293-305` | `packages/tools/tests/security.test.ts` (18/18 passed), `packages/tools/tests/protectedVerification.test.ts` (5/5 passed) | **PASS** |
| 6 | **Code-Mode Restrictions & VM Realm Prototype Lockdown** (`NON_IDEMPOTENT_WRITE` / `MUTATING` / `exclusive`, zero host global mutation) | `packages/tools/src/codeModeTool.ts:36-40,80-84`, `packages/core/src/services/codeModeService.ts:293-437` | `packages/core/tests/codeMode.test.ts` (9/9 passed), `packages/core/tests/phase4SandboxAndCodeMode.test.ts` | **PASS** |
| 7 | **Mobile Authentication & Protocol Negotiation** (dynamic `CONTROLLER_VERSION`, semver check, expired credential rotation block, 3-strike pairing lockout) | `apps/api/src/mobile/typesAndCompatibility.ts:79-162`, `apps/api/src/auth.ts:201-216`, `apps/api/src/mobile/pairingService.ts:59-335` | `apps/api/tests/phase4MobileCompatibility.test.ts` (9/9 passed), `apps/api/tests/mobileApi.test.ts` (8/8 passed) | **PASS** |
| 8 | **Credential Handling & Secret Redaction** (`AES-256-GCM` `EncryptedFileBackend`, `0600` perms, child env stripping, token redaction) | `packages/secrets/src/secretBroker.ts:27-79`, `packages/secrets/src/encryptedFileBackend.ts:42-173`, `apps/api/src/mobile/typesAndCompatibility.ts:394-415` | `packages/secrets/tests/secretBroker.test.ts` (9/9 passed) | **PASS** |
| 9 | **No Silent Unsafe Fallback** (`checkIsolationCompliance` fail-closed, `allowWorkspaceArtifactExecution` sandbox gate) | `packages/core/src/services/policyEngine.ts:506-551,1028-1038`, `packages/tools/src/sandbox.ts:420-434` | `packages/core/tests/phase4SandboxAndCodeMode.test.ts` | **PASS** |

---

## 2. Dependency Security Audit & Remediation (Agent `A7` — `PASS` @ `01a6059`)

Agent `A7` (`6b8c66af-3975-46f2-9ab7-95690ecb6c97`) audited all 495 workspace packages and remediated all 12 actionable vulnerabilities in isolated worktree `/tmp/wazir-rr-a7` (`a2e2bc673b32c2d335ccfd5c198e7901a9a17a51`), integrated onto `remediation/v0.2.13` at `01a6059ded8085de3e7055270e53226b831d131d`.

### 2.1 Before vs. After `npm audit` Summary

| Audit Scope | Metric | Before (`8ed0269`) | After (`01a6059`) | Delta |
|---|---|---:|---:|---:|
| **Production (`npm audit --omit=dev --json`)** | **Total Vulnerabilities** | **`0`** | **`0`** | **`0` (Exit Code `0`)** |
| | Critical / High / Moderate / Low | `0 / 0 / 0 / 0` | `0 / 0 / 0 / 0` | `0` |
| **Full Workspace (`npm audit --json`)** | **Total Vulnerabilities** | `15` | **`3`** | **`-12 (-80.0%)`** |
| | Critical | `5` | `2` | `-3` |
| | High | `6` | **`0`** | **`-6 (-100.0%)`** |
| | Moderate | `4` | `1` | `-3` |
| | Low / Info | `0 / 0` | `0 / 0` | `0` |

### 2.2 Complete Vulnerability Classification & Disposition Table

| # | Package | Severity | Direct / Transitive | Exposure | Advisory | Disposition |
|---|---|---|---|---|---|---|
| 1 | `shell-quote` | **Critical** | Direct (`@wazir/core`) & Transitive (`concurrently`) | Prod/Dev | `GHSA-pqg4-j6r4-53mv` (`<1.11.0`) | **FIXED** (`^1.12.0` override in root `package.json`) |
| 2 | `concurrently` | **Critical** | Direct (`devDependencies`) | Dev only | Via `shell-quote` | **FIXED** (via `shell-quote: ^1.12.0` override) |
| 3 | `@modelcontextprotocol/server` | **High** | Direct (`devDependencies`) | Dev only | `GHSA-jm63-cq47-j5jp`, `GHSA-46jr-4wx8-v453`, `GHSA-rvq5-wwqv-78pq` (`<2.3.0`) | **FIXED** (upgraded to `^2.3.0` → `2.3.1`; `@modelcontextprotocol/client` pinned to `^2.3.1`) |
| 4 | `hono` | **Moderate** | Transitive (`@modelcontextprotocol/node`) | Dev only | `GHSA-5r4p-p66f-jhc7` (`<4.13.11`) | **FIXED** (`^4.13.11` override) |
| 5 | `source-map-js` | **High** | Transitive (`postcss`) | Dev only | `GHSA-68fv-2mgg-jv7q` (`<1.2.2`) | **FIXED** (`^1.2.2` override) |
| 6 | `ts-node-dev` | **High** | Direct (`@wazir/api` `devDependencies`) | Dev only | Via `chokidar` / `braces` | **FIXED** (removed unmaintained `ts-node-dev`; `apps/api` `dev` script uses Node native `node --watch`) |
| 7 | `chokidar` | **High** | Transitive (`ts-node-dev`) | Dev only | Via `braces` | **FIXED** (removed with `ts-node-dev`) |
| 8 | `braces` | **High** | Transitive (`chokidar`) | Dev only | `GHSA-vfj7-8cjw-p6xm` (`<=3.0.3`) | **FIXED** (removed with `ts-node-dev`) |
| 9 | `esbuild` | **Moderate** | Transitive (`vite`) | Dev only | `GHSA-67mh-4wv8-2f99` (`<=0.24.2`) | **FIXED** (`^0.28.2` override deduplicating with root `esbuild@0.28.2`) |
| 10 | `tinypool` | **Critical** | Transitive (`vitest`) | Dev only | `GHSA-5gmw-xhrv-c9v3`, `GHSA-85c8-ppgw-ccpr` (`<2.1.2`) | **FIXED** (`^2.1.2` override) |
| 11 | `vite` | **High** | Transitive (`vitest`) | Dev only | Multiple `GHSA-*` (`<=6.4.3`) | **FIXED** (`^6.4.4` override) |
| 12 | `vite-node` | **Moderate** | Transitive (`vitest`) | Dev only | Via `vite` | **FIXED** (via `vite: ^6.4.4` override) |
| 13 | `@vitest/mocker` | **Moderate** | Transitive (`vitest@2.1.9`) | Dev only | `GHSA-82fw-gwwq-j7x9`, `GHSA-qxg6-89mg-rqv8` | **DEFERRED (Dev-only, Unreachable)**: Requires breaking major upgrade to `vitest@5.0.5`; only affects browser/UI mocker server, never invoked by `npx vitest run`. |
| 14 | `vitest` | **Critical** | Direct (`devDependencies`, `2.1.9`) | Dev only | `GHSA-5xrq-8626-4rwp` (`--ui` server) | **DEFERRED (Dev-only, Unreachable)**: Requires breaking major upgrade to `vitest@5.0.5`; only affects `vitest --ui` server when listening, never enabled in Wazir. |
| 15 | `@vitest/coverage-v8` | **Critical** | Direct (`devDependencies`, `2.1.9`) | Dev only | Via `vitest` | **DEFERRED (Dev-only, Unreachable)**: Coupled to `vitest@2.1.9`. |
