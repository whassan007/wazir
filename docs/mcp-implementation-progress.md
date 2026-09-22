# MCP implementation

Scope: the complete user-supplied MCP specification, including both transports,
default profiles, policy/schema enforcement, broker-backed auth, CLI/Fleet,
resources/prompts, recovery, audit, and deterministic plus live acceptance tests.

Initial inspection (2026-09-21):
- MCPClient and its transports are unwired stubs; existing tests use non-protocol mocks.
- ToolRegistry and executeTool live in packages/tools; runtime policy gates live in
  CLI run.ts and fleetRunner.ts. PolicyEngine and ApprovalQueue are reusable.
- Audit and output sanitization exist in packages/shared.
- No SecretBroker or OAuth client infrastructure exists in this checkout.
- ContextCompiler already recognizes MCP context parts.
- Other agents have pre-existing edits in CLI/Fleet and context/job/block types;
  preserve their work and use targeted edits.
- Official SDK 2.0.0 is available on npm and supports CommonJS, STDIO,
  Streamable HTTP and OAuth. Installed in @wazir/core with Ajv validators.

Authoritative references checked:
- https://github.com/modelcontextprotocol/typescript-sdk
- https://github.com/github/github-mcp-server
- https://run-ai-docs.nvidia.com/self-hosted/getting-started/mcp-server

All implementation and acceptance requirements remain open until verified.
