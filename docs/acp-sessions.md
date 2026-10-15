# ACP session lifecycle and integration contract

Wazir's ACP client now exposes a live session record through `AcpClientAdapter`:

- `createSession({ cwd })` creates one stable upstream session ID.
- `prompt(sessionId, text)` submits a turn; `steer(sessionId, text)` appends an ordered instruction. If a prompt is active, stable ACP has no generic mid-turn input operation, so the instruction is queued as a follow-up turn. The return value identifies the message as accepted or queued.
- `getSessionState(sessionId)` returns lifecycle status, advertised capabilities, ordered in-memory messages, and tool telemetry. `onTimelineEvent` and `onToolTelemetry` allow an embedding persistence layer to append durable records.
- `cancelSession(sessionId)` requests ACP cancellation and marks queued, undelivered instructions as failed. It does not claim that an in-flight tool was rolled back.
- `loadSession(id, { cwd })` is available only when initialize advertised `agentCapabilities.loadSession` and the connection implements `session/load`. Agents without that capability cannot be resumed after process loss.

Session records in the client are live-process state, not a durable database. The owning API/service must persist timeline callbacks and the tuple `(workspace, taskId, executionId, agent identity, ACP sessionId)`, authorize resume against that tuple, and reconstruct a client only through advertised `loadSession`. Do not resume a session into a different workspace or task.

## Permission broker integration

`AcpClientOptions.onRequestPermission` is fail-closed and must select one of the exact ACP options offered by the agent. Before returning a grant, a higher-level broker must bind its approval record to the Wazir session ID, task/execution identity, workspace, ACP request/tool-call identity, operation kind and arguments, approver identity, and expiry. Revalidate the binding when the callback resolves; a timed-out, expired, cancelled, disconnected, or mismatched approval must return `{ cancelled: true }`. The existing `read`, `edit`, and `full` modes remain one-time allowlists and never select persistent “always” grants. Controller-side restrictions must run before this broker.

The ACP package does not own Wazir's approval database or API. This is the integration seam for higher-level callers; they must provide the callback and durable approval workflow. The one-shot `AcpAgentAdapter` continues to create and close one ACP session per task for compatibility.

## Protocol capability matrix

| Capability | ACP v1 baseline | Wazir behavior | Portability |
| --- | --- | --- | --- |
| Initialize / new session / prompt / cancel / session updates | Required baseline methods | Implemented over SDK JSON-RPC stdio | Agent must implement ACP baseline |
| Multiple turns | Prompt can be called again in a session | Implemented; queue serialized per session | Within a connected process |
| Active generation steering | No generic stable v1 method | Ordered queued follow-up; no hidden state mutation | Available as next turn only |
| Session load | Optional `loadSession` capability | Checks advertised capability; otherwise rejects | Only where agent advertises and persists sessions |
| Available modes | Optional `session/new` mode response and set-mode method | Modes and current mode surfaced in session state | Mode switching remains connection-interface dependent |
| Tool updates / permission requests | ACP update/request methods | Timeline and fail-closed callback | Tool output/duration only when observable |
| Durable history | Agent-specific persistence | Caller can persist callbacks; client itself is in-memory | Restart recovery depends on agent load support and caller store |

Codex, Claude Code, Antigravity, and other CLIs are not assumed to expose identical ACP support. Wazir keeps their existing vendor-native adapters and does not force them through ACP. A configured executable alone is not evidence of authentication readiness.

Tool completion output is sourced from ACP `rawOutput` or reported text content. An absent result stays empty; metadata `durationMs` is null unless Wazir observed both start and terminal update. `AgentTurn` currently requires numeric duration for compatibility, so the adapter sets the required legacy field to zero when duration is not measurable and carries `null` in `metadata.durationMs`. Consumers should treat the metadata field as authoritative for ACP evidence.

## Qualification status

ACP tests use a disposable in-repository stdio agent implementing ACP JSON-RPC; these are protocol integration tests, not tests against Claude Code, Codex, Antigravity, or a hosted provider. Real-vendor qualification must be run per installed adapter and authorization state, with workspace diff and independent tests inspected. Do not treat an agent's completion text as proof of code changes.
