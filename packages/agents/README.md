# @wazir/agents

## `CodingAgent`

A turn-based coding agent loop: **plan → implement → test → repair → verify**. Each turn, the model must respond with exactly one JSON action (`plan`, `tool`, or `done`) — no markdown fences, no commentary; malformed responses get a bounded number of correction attempts before the turn is recorded as a failure.

- Every tool call goes through the host-provided `AgentRuntime.executeTool`, which is policy-gated — the agent can never bypass `PolicyEngine`.
- Verification is deterministic and host-side: after the model says `done`, the agent itself re-runs the check tools (test/lint/typecheck/build) and drives a bounded repair loop on failure, rather than trusting the model's own claim that things pass.
- `maxTurns` can be overridden per request (`AgentRunRequest.maxTurns`), separately from the agent's own constructor-time default — useful when a job wants a shorter leash than a one-off `wa ask`.
- `getSteeringInstruction` (also per-request) lets a host inject a mid-run instruction the agent picks up on its next turn — this is what `wa chat`'s `/steer` command uses.

## `ExternalAgentAdapter`

Wraps an external CLI coding agent (OpenCode, Bionic, etc.) as a downstream execution provider via `child_process.spawn`, while Wazir retains scheduling, policy, and logging. Optional — `CodingAgent` is the default, native agent and needs nothing external installed.
