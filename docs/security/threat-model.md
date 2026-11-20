# Wazir AI OS — Threat Model

## Scope & Trust Boundaries

1. **Public Portal (`wazir.wael.bot`) vs Private Control Plane (`127.0.0.1:4800`)**:
   - Public visitors access only static portal assets, `/api/v1/public/demo-fleet` (synthetic sample data), and `/api/v1/public/commercial-license`.
   - Real worker inventories, hostnames, private IPs, and job logs are gated behind `auth.requireViewerOrOperator`.
2. **Loopback Proxy Trust (`apps/web/server.js`)**:
   - Host-held operator credentials are injected only when the TCP peer is loopback, `Host` header is loopback, and `Origin`/`Sec-Fetch-Site` is same-origin (preventing DNS rebinding and CSRF).
3. **Wazir Shell PTY & PolicyEngine**:
   - Ambiguous destructive AI requests trigger `requiresConfirmation: true`.
   - Tool execution enforces realpath workspace containment (`packages/tools/`) and PolicyEngine approval rules.
4. **Diagnostic Telemetry (`@wazir/observability`)**:
   - Zero telemetry before affirmative acceptance.
   - Strict allowlist + regex redaction strips API keys (`sk-`, `ghp_`, `nvapi-`, `Bearer`), emails, IPv4 addresses, and `/Users/...` or `/home/...` paths; max 8 KB payload limit; per-installation rate limiting.
5. **Distributed Workers**:
   - Authenticated registration (`WAZIR_REGISTRATION_TOKEN`), per-computer tokens, and lease-fenced execution claims.
