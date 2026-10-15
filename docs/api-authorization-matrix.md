# Control-plane API authorization matrix

Enforced in `apps/api/src/server.ts`, using the credentials described in `apps/api/src/auth.ts`.
`apps/api/tests/p0Remediation.test.ts` enumerates every route the Express app registers and
fails if one is missing from this table. It then checks each scope:

- Anonymous callers get 401 on viewer and operator routes.
- Viewer callers get 403 on operator routes.
- Viewer callers are allowed on read-only routes.

When `WAZIR_ALLOW_UNAUTHENTICATED=1` is set and a scope's token is not configured, that scope
is open. This mode is for a loopback development instance only. The server refuses to bind a
non-loopback address without an operator token.

| Scope | Who | Routes |
|---|---|---|
| public | anyone | `GET /health` |
| viewer | viewer or operator token | `GET /metrics`; `GET /api/v1/{overview,computers,workers,runtimes,models,model-instances,agents,agents/capabilities,tools,executions}`; `GET /api/v1/models/:id/inspect`; `GET /api/v1/executions/:id`; `GET /api/v1/tasks/:requestId/status`; every `GET /ap/v1/agent/tasks…` |
| operator | operator token | `POST /api/v1/models/reconcile`; `POST /api/v1/models/:id/{estimate,load,unload,…}`; `POST /api/v1/tasks/dispatch`; `POST /executions`; `POST /ap/v1/agent/tasks`; `POST /ap/v1/agent/tasks/:task_id/steps`; `POST /ap/v1/agent/tasks/:task_id/artifacts` |
| registration | registration token for a new id; that computer's token or the registration token to replace one | `POST /computers/register` |
| computer | the token issued to `:id`, and for execution channels, `:id` must own `:requestId` | `POST /computers/:id/heartbeat`; `GET /computers/:id/tasks/stream`; `POST /computers/:id/executions/:requestId/{claim,renew,events,result}` |
| mcp | viewer for read-only JSON-RPC methods; operator for everything else | `POST /mcp`, `POST /mcp/v1` |

## MCP

A viewer may call these methods:

- `initialize`
- `notifications/initialized`
- `ping`
- `tools/list`
- `resources/list`
- `resources/read`
- `prompts/list`
- `prompts/get`

Any other method needs operator scope. That includes `tools/call`, which runs registered
tools, and any method that is unknown or added later. A batch that contains even one such call
needs operator scope for the whole batch. A refused call gets HTTP 403 with JSON-RPC error
`-32001`.

## Before 2026-10-13

Before 2026-10-13, two kinds of request were open to a viewer token:

- **Agent Protocol POSTs:** `/ap/v1` accepted viewer tokens for all three POST routes.
  A viewer could therefore create tasks, execute steps (model calls and tools) and write
  artifacts.
- **MCP `tools/call`:** `/mcp` accepted it from a viewer token. That meant a read-only
  credential could run tools, including `shell`.
