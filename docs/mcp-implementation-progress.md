# MCP implementation status — 2026-09-21

Wazir now uses the official MCP TypeScript SDK (2.0) as its protocol client. The integration reuses ToolRegistry, PolicyEngine, Secret Broker, execution history, and audit log.

## Implemented

- STDIO and Streamable HTTP transports, SDK initialization, negotiated capabilities, dynamic tool/resource/prompt discovery, bounded pagination, request timeout and abort signal support, reconnect retries, circuit breaker state, and graceful child cleanup.
- MCPRegistry, MCPConnection, MCPAuthProvider, OAuth provider backed by Secret Broker, and MCPToolAdapter.
- Default GitHub and NVIDIA Run:ai profiles. Profiles start registered and enabled; missing configuration/credentials are represented without aborting Wazir startup. GitHub supports PAT and documented OAuth after a host OAuth client ID is configured. NVIDIA supports documented local container environment injection and administrator-supplied remote URL. NVIDIA writes remain disabled unless explicitly enabled with policy approval.
- MCP tools are dynamically namespaced mcp.<server>.<tool> and registered with the existing ToolRegistry. Tool schemas are compiled and arguments validated before policy decisions and network invocation. Host-owned risk classifications default unknown tools to approval. The adapter authorizes through PolicyEngine, including direct calls outside the agent path.
- MCP policy decisions, server lifecycle events, tool call status, duration, provenance, agent/execution IDs, and redacted input metadata flow into execution/audit records. External descriptions, results, resources, and prompts carry untrusted provenance.
- Explicit resource and prompt retrieval methods return optional, provenance-marked MCP context; resources are never injected automatically.
- CLI commands: wa mcp list/status/add/remove/enable/disable/connect/disconnect/inspect/tools/resources/prompts/auth/test/doctor/config/import/export/read/prompt. `connect` starts a supervised per-server process so the negotiated MCP session remains live across CLI invocations; `status`, `inspect`, `disconnect`, disable, removal, and reconfiguration observe or stop that process. Startup uses a per-server lock, a private heartbeat file, and graceful signal shutdown. Imports migrate literal environment/header values into Secret Broker references; exports contain only references. GitHub auth supports explicit --oauth and --pat.
- Fleet shows compact MCP server status. wa ask can route MCP-equipped requests through the existing task executor.
- Cached, endpoint-bound tool descriptors allow selection and same-execution recovery to attempt reconnection/authentication without creating a duplicate task.

## Verification

- npx tsc --build apps/cli: passed.
- Phase 2: CLI post-action closes process-owned MCP registries, and process exit closes SDK transports so a short-lived command cannot leave a STDIO server alive. Import normalizes MCP IDs before deriving broker references.
- Phase 3: MCP tool risk classification no longer trusts server-provided `readOnlyHint` or `destructiveHint` annotations. Only host-recognized retrieval verbs get `READ_ONLY`; ambiguous names remain approval-required even when a server labels them read-only. The regression fixture advertises a misleading hint and confirms PolicyEngine still requires approval.
- Phase 4: Connection initialization and capability discovery now accept the calling execution's abort signal. Cancelling a pending STDIO handshake closes the SDK-owned child, reports `MCP_CANCELLED`, and does not count as a server failure or open the circuit.
- Phase 5: `wa mcp connect` now maintains a real cross-command MCP connection through a supervised process; live status includes discovered tool/resource/prompt counts, connection failures are normalized, and disconnect/disable/remove/configuration changes stop the server process. Added a real subprocess CLI test using a local official-SDK STDIO fixture.
- `npx tsc --build apps/cli`: passed. `npx vitest run apps/cli/tests/mcpDaemon.test.ts packages/core/tests/mcp.integration.test.ts apps/cli/tests/mcpImport.test.ts`: 24 passed. Fixtures use the official server SDK and exercise actual STDIO and Streamable HTTP handshakes, discovery, invocation, schema validation, policy approval/deny, timeouts, connection/tool cancellation, reconnect, circuit opening, broker-backed bearer/environment/OAuth token handling, secret redaction, resource/prompt trust boundaries, arbitrary server registration, import migration, and persistent CLI lifecycle.
- Latest `npm test`: workspace build passed; 97 test files passed, one failed, with 863 passed and 17 skipped. The failure is in the untracked `apps/cli/tests/live-coding/01-bugRepair.test.ts` and is outside MCP; the two previously noted unrelated failures now pass. MCP suites passed in that run.

## Not verified / remaining limitations

- No live GitHub or Run:ai acceptance run was possible without operator OAuth/PAT or Run:ai service credentials and a configured endpoint. Compatibility is verified against local protocol fixtures and published connector documentation, not live services.
- OAuth callback/auth-server interoperability has not been tested against live GitHub or Run:ai; provider storage code has deterministic unit coverage only.
- The GitHub/Run:ai authenticated acceptance flows were not run because no operator credentials or Run:ai endpoint were supplied. OAuth authorization/callback interoperability is not verified against the live providers.
- The deterministic tests cover the highest-risk integration paths but do not exhaust every requested case; notably interactive CLI creation, a complete `wa ask` mutation approval round-trip, and recovery through a real interactive task remain unverified.
- Risk classification combines tool names and server annotations. Unknown names default to approval, but a server can mislabel a mutating tool; operators should use least-privilege credentials and review discovered schemas.
- MCP tool calls pass PolicyEngine, but the external calls are not OS-sandboxed. MCP servers should be treated as external capability providers under operator control.
