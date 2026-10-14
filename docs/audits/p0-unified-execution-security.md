# P0 — Unified Execution Authorization, MCP Security, Evidence-Based Completion

Baseline: `7c0313d` (local `main`). Branch: `hardening/p0-unified-execution-security`.

## Confirmed vulnerabilities (reproduced over HTTP against the unmodified API)

| ID | Finding | Baseline evidence |
|---|---|---|
| V1 | Viewer token can create Agent Protocol tasks, steps, artifacts (`/ap/v1` used `requireViewerOrOperator` for POST) | 201/200 responses |
| V2 | Viewer can invoke any registered tool over `/mcp` `tools/call` | canary overwritten (`PWNED-MCP`), `shell touch` created a file |
| V3 | Protocol tool calls bypassed PolicyEngine, approval, tool surface and audit (`runTool` → `registry.get(name).execute()` direct) | `shell` ran an unapproved command |
| V4 | False completion: tool exception/`ok:false` recorded as `status: completed`; `is_last` completed the parent task | failing `read` + `is_last` → task `completed` |
| V5 | False verification: fallback `{ passing: true, checks: [] }`; `wazir://verification/status` returned `verified: true` unconditionally | `{"verified":true,"engineAvailable":false}` |
| V6 | Concurrent/late step requests could overwrite a terminal task state (read-modify-write without serialization) | code inspection; covered by test |

## Fixes

- **Authorization matrix** — GET on `/ap/v1` needs viewer or operator; every POST needs operator (route `requireOperator` + service-level scope re-check). `/mcp` authenticates any credential, then classifies each JSON-RPC method: `initialize`, `ping`, `notifications/initialized`, `tools/list`, `resources/*`, `prompts/*` are read; everything else (incl. `tools/call` and unknown methods) needs `execute`. Forbidden → HTTP 403 / JSON-RPC `-32003`. Batches → `-32600`; malformed JSON → `-32700`.
- **Principal** — `ApiAuth.principalFor()` derives `{kind, id, scopes}` only from the matched credential; it is passed as the request context and cannot be supplied by bodies/arguments. Unauthenticated local-dev (no tokens + `allowUnauthenticated`) keeps its existing operator-equivalent boundary.
- **Single execution boundary** — `apps/api/src/toolExecution.ts` (`createControlledExecution`): scope → protocol tool surface → schema → `PolicyEngine.authorize` (approval callback; absent ⇒ `ask` denied) → `executeTool` (controller-only, allowed tools, oracle protection, workspace snapshot, timeout, cancellation) → audit record. Injected into `EditorProtocolService` as a callback (no new package dependency). Direct `tool.execute()` fallback removed; missing executor/principal fails closed. Client disconnect aborts the tool.
- **Truthful completion** — steps are persisted `running` before dispatch; outcome recorded in `additional_output.outcome` (`RECORDED`, `TOOL_SUCCEEDED`, `TOOL_FAILED`, `POLICY_DENIED`, `CANCELLED`, `TIMED_OUT`, `OUTCOME_UNKNOWN`, `EXECUTION_UNAVAILABLE`, `VERIFIED`, `VERIFICATION_FAILED`, `VERIFICATION_UNAVAILABLE`) with tool evidence (callId, policy decision, failure class, workspace hashes, file mutations). Any failure ⇒ step `failed` and task `failed` regardless of `is_last`. Text-only steps are `RECORDED`, `executed: false`. Terminal tasks reject further steps (409); steps are serialized per task. Existing status enums unchanged; new fields are optional.
- **Evidence** — verification runs project checks (`test|lint|typecheck|build`) through the same boundary. PASS requires ≥1 dispatched check, all passing, bound to the step's executionId/taskId/stepId; includes timestamps, output tail and workspace revision hash. `verification/status` returns the latest evidence, else `UNKNOWN`/`UNAVAILABLE` with `verified:false`.

## Files changed

- `apps/api/src/auth.ts`, `apps/api/src/server.ts`, `apps/api/src/toolExecution.ts` (new)
- `packages/core/src/services/editorProtocolService.ts`, `packages/core/src/services/index.ts`, `packages/core/src/types/editorProtocol.ts`
- `apps/api/tests/protocolSecurity.test.ts` (new, 33 black-box tests)

## Remaining risks

- Task serialization is in-process; a multi-instance (Postgres/distributed) deployment needs a store-level compare-and-set on task status.
- Verification PASS relies on the project's own check scripts (exit status of a server-dispatched `npm run <check>`), bound to a workspace hash; it does not judge test quality beyond the existing oracle-weakening heuristics.
- The API has no interactive approver: all policy `ask` decisions are denied unless a host passes `approveTool`.
- `resources/read` exposes check output tails to viewers.
- Live model/agent execution over the protocol is not implemented (BLOCKED / out of scope): the protocol records steps and runs explicit tool calls only.
