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
env -u WAZIR_TEST_DATABASE_URL -u WAZIR_REQUIRE_DATABASE npx vitest run --exclude 'tests/distributed/**'
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
- The same computer identity can recover its expired dispatch in a fresh worker
  process. Another computer's token cannot claim that dispatch.
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

## Acceptance gaps requiring integration work

These tests characterize bounded guarantees, not universal distributed safety.

1. The API does not invoke `RecoveryManager`/`checkHeartbeats`. After the actual
   60-second offline threshold, a killed worker's registry entry can still be online
   and its expired dispatch remains pending without an explicit failed/orphaned
   outcome. The record is durable, but automatic missing-worker recognition and
   terminal abandonment are not established.
2. Dispatch ownership is bound to a computer, not an interchangeable worker pool.
   Worker B on a different computer receives 403; same-computer restart is required.
   Automatic cross-computer failover is unsupported.
3. Opaque provider requests can execute again after the worker dies following an
   external mutation but before acknowledgment. The process test observes two
   executions and two effects for a non-idempotent external service. Supplying
   external operation idempotency keeps effects at one, with two executions and
   one authoritative result. Wazir does not automatically inspect that external
   ledger. Lease fencing alone does not prevent duplicate side effects.
4. `UNKNOWN_OUTCOME` blocks blind replay for known non-idempotent tool checkpoints
   in RecoveryManager; that unit guarantee is not wired into opaque API dispatch
   recovery. The process test deliberately exposes that difference.
5. There is no public cancellation route for distributed dispatched tasks. The
   terminal-completion/cancellation race cannot be qualified through this production
   interface. Completion/renewal and competing terminal outcomes are covered.

API fixes must be coordinated with the dispatcher/protocol workstream at integration.
This branch changes tests and dedicated CI only; it does not alter API dispatcher
or protocol transaction implementations. No universal exactly-once execution or
uncontrolled-effect prevention claim is made.
