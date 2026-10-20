# PostgreSQL and distributed process qualification

Base candidate: `cdea8aa125731765ca789dd6de13f35a0aa8b61f` (v0.1.61).
Branch: `hardening/postgres-worker-recovery`.

Run on Linux with Node 22 and a **disposable** PostgreSQL 16 database. The suites
reject database names that do not match `wazir_*_test`. Database tests truncate
`wazir_kv_store`; never supply a shared or production database, even if its name
matches. Each distributed cluster creates a random schema in the disposable
database to isolate dispatch records and credential hashes. Destroy the disposable
container afterward; schemas intentionally survive until then for inspection.

```sh
npm ci
npm run build
npm run typecheck
npm run test:distributed:typecheck
docker run --rm -d --name wazir-distributed-pg \
  -e POSTGRES_PASSWORD=disposable-test-only \
  -e POSTGRES_DB=wazir_distributed_test \
  -p 127.0.0.1:55432:5432 postgres:16
export WAZIR_TEST_DATABASE_URL=postgres://postgres:disposable-test-only@127.0.0.1:55432/wazir_distributed_test
npm run test:postgres
WAZIR_REQUIRE_DATABASE=1 npm run test:distributed
# JSON-file durability variant:
env -u WAZIR_TEST_DATABASE_URL -u WAZIR_REQUIRE_DATABASE npm run test:distributed
# Existing regressions, without destructive database tests:
env -u WAZIR_TEST_DATABASE_URL -u WAZIR_REQUIRE_DATABASE npx vitest run --exclude 'test/distributed/**'
docker stop wazir-distributed-pg
```

The dedicated CI job requires the database URL and fails on missing configuration
or unreachable PostgreSQL. Existing default test runs leave distributed scenarios
opt-in; the dedicated config enables every scenario and rejects non-Linux hosts.
No GPU or model download is required: the external HTTP fixture speaks Ollama's
protocol. API and workers are actual unmodified production entry points:
`apps/api/dist/main.js` and `apps/worker/dist/index.js`. Simulated inference is not
claimed as neural model qualification. The two RecoveryManager tests are unit
regressions, separately from process-level evidence.

Evidence defaults to `test-results/distributed/<cluster>/`: PID logs, process exit
codes/signals, authenticated HTTP response statuses, task IDs, and state transitions
in `evidence.json`. Set `WAZIR_DISTRIBUTED_EVIDENCE` to choose another directory.
Credentials and lease tokens are redacted. The original/replacement attempts,
computer identity, deadlines, rejected stale response, and final outcome are
recorded without tokens. CI uploads evidence even on failure.

## Guarantees under test

- PostgreSQL migrations, JSON/Date round trips, atomic conditional updates, rollback,
  concurrent connections/processes, connection failure, and persistence across a
  terminated writer and fresh reader.
- Two independent worker processes register with distinct computer identities and
  credentials. SSE dispatch drives a real worker claim and provider HTTP request.
- A killed PID is gone before recovery; an expired lease and a replaced lease each
  reject the original holder's authenticated result with 409 `LEASE_LOST`.
- The same computer identity can recover an explicitly read-only expired dispatch in a fresh worker
  process. Another computer's token cannot claim that dispatch without operator reassignment.
- Controller SIGKILL/restart preserves dispatch state and credential ownership.
  Result acknowledgment loss after durable commit is reconciled by authenticated
  duplicate submission; the first terminal outcome remains authoritative.
- Three bounded rounds of eight simultaneous claims yield one winner. Concurrent
  renewal and result submissions preserve one authoritative terminal outcome.
- A held provider request remains active beyond its original lease deadline through
  real lease renewal and heartbeat. A surviving worker reconnects its SSE connection
  automatically after controller restart using its existing computer credential.
- Duplicate dispatch is rejected; duplicate result submission changes no outcome.
- Wrong worker credentials cannot hijack registration, SSE, or result submission.
  Reconnect can use the persisted computer credential with an invalid bootstrap token.

## Recovery and cancellation contract

The API entry point runs a non-overlapping recovery sweep every second. The normal
60-second heartbeat threshold marks missing workers offline. Unclaimed or explicitly
read-only expired work is retained with `recovery: "orphaned"` when its worker is offline.

Dispatch requests default to `replayPolicy: "never"`. If an attempt loses its lease,
its external effects cannot be inferred from missing acknowledgment: the dispatcher
persists a failed outcome with `error: "UNKNOWN_OUTCOME"`, revokes the lease, and blocks
replay across worker/controller restarts. This does not undo an already committed effect.
An operator must reconcile the external system before creating any replacement request.
Only use `replayPolicy: "read-only"` for work known to have no external side effects.
The policy is an operator assertion, not an automatic proof or an idempotency mechanism.

Operator-only routes:

- `POST /api/v1/tasks/:requestId/reassign` with `{ "computerId": "replacement" }`:
  explicitly reassigns unclaimed or expired read-only work to an online computer.
  Live leases and terminal/unknown-outcome work cannot be reassigned. Attempt numbers
  continue increasing and old worker credentials/tokens cannot commit or renew.
  Reassignment is explicit; the API does not autonomously select a replacement machine.
- `POST /api/v1/tasks/:requestId/cancel`: atomically persists `CANCELLED` if no result
  has won. Sends an SSE cancellation to the worker; failed renewal also stops its work
  if notification was missed. A worker must obtain a durable started-event acknowledgment
  before entering the provider. Completion and cancellation preserve the first durable
  terminal result. Repeated cancellation is idempotent.

Cancellation requests provider abort; it cannot roll back completed external effects
or guarantee that an external provider honors transport cancellation. Production process
tests verify abort using the Ollama-compatible HTTP fixture.

`crashRecovery.test.ts`, `processSideEffect.test.ts`, and `cancellation.test.ts` now
assert these guarantees instead of passing while characterizing the old gaps. Historical
`evidence-report.md` describes the previous baseline; see `recovery-fixes-report.md` for
current validation. No universal exactly-once execution claim is made.
