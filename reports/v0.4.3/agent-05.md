# Agent 05 — Coordination fabric (contract C3)

- **Branch**: `fix/v043-fabric` (worktree `/Users/wael/Code/Wazir-v043/agent-05`)
- **Starting SHA**: `d6ca44a02b286b718bcf0b373aeb3a1186b1e0e8`
- **Commits**: see `git log d6ca44a..fix/v043-fabric` (3 commits: fabric fix, live test, two-node script + this report)

## Status summary
| Task | Status | Evidence |
|---|---|---|
| 1. Remove `'nats-jetstream'`, document semantics, legacy mapping | **VERIFIED_OPERATIONAL** | `npx vitest run …coordinationFabric.test.ts …fabricCommands.test.ts` exit 0 → `logs/agent-05-fabric-tests.log` |
| 2. Live nats-server outage / outbox drain / idempotent consumer | **VERIFIED_OPERATIONAL** | live vitest exit 0 → `logs/agent-05-nats-live.log` (`RESULT: N=40 deliveries=42 uniqueEffects=40 duplicatesSuppressed=2`) |
| 3. Two-node lease fencing (Mac ↔ dgx over NATS) | **VERIFIED_OPERATIONAL** | coordinator exit 0 + dgx worker exit 0 → `logs/agent-05-two-node-coordinator.log`, `logs/agent-05-two-node-worker-dgx.log` |
| 4. build + typecheck + fabric tests | **VERIFIED_OPERATIONAL** | `logs/agent-05-build.log` (0), `logs/agent-05-typecheck.log` (0), `logs/agent-05-fabric-tests.log` (0) |

## Delivery semantics (as implemented, now documented in code)
Doc comments on `CoordinationTransportKind` (`packages/core/src/types/coordination.ts`) and `NatsWireTransport` (`packages/core/src/services/coordinationFabric.ts`):
- **Wire (`nats-core`) is at-most-once.** NATS Core PUB/SUB; the server does not persist or redeliver. A subscriber that is disconnected when a message is routed never receives it. There is no JetStream (no streams, consumer acks, or broker replay).
- **Producer durability comes from the local outbox.** `publish()` writes `events/<id>.json` and `outbox/<id>.json` atomically before returning. An outbox entry becomes `delivered` only after the server's `PONG` to a `PING` sent after the batch's `PUB` frames (new in v0.4.3, `confirmPublish` defaults to true). Before this change, `delivered` meant only "written to the local socket buffer", so events written just before a broker crash could be marked delivered and lost. While the broker is down, entries stay `pending`/`failed`, are retried with backoff behind the circuit breaker, and go to the DLQ after `maxRetries`.
- **Producer → server is at-least-once on ambiguous failure.** If the PONG is lost, the batch is retried and may be duplicated.
- **Consumers must be idempotent.** Deduplicate on `idempotency_key` (or `event_id`) to get exactly-once side effects. `CoordinationFabric` already deduplicates on `event_id` in memory.
- **Known gap (documented, not fixed):** `NatsWireTransport` does not reconnect on its own. `connect()` re-sends all SUBs, and the fabric calls it only during a flush, so a consume-only process must run its own reconnect loop (the live test does this). Events published while a consumer is disconnected are not replayed to it by NATS. Recovery relies on the producer's durable event log (`replayEvents`).

## Task 1 — C3 transport kinds
- `CoordinationTransportKind = 'in-process' | 'durable-local' | 'nats-core'`. Also added `COORDINATION_TRANSPORT_KINDS` and `normalizeCoordinationTransportKind(raw)`, which maps `nats-jetstream`/`jetstream`/`nats` to `nats-core` and returns `undefined` for unknown values.
- `CoordinationFabric.getStatus()` normalizes the adapter's runtime `kind`, so a legacy or third-party adapter that still reports `nats-jetstream` shows as `nats-core`. `natsConfigured` is now derived from the normalized kind.
- `apps/cli/src/commands/fabricCommands.ts`: `wa fabric status` used to print `nats-jetstream` whenever `WAZIR_NATS_URL` was set. It now prints `nats-core`, and any status `transport` it reads goes through `normalizeFabricTransportKind` (exported).
- Persisted state: outbox, event, lease and consumer files do not store a transport kind. The only places a kind is read back are the status payload and the adapter `kind`, and both are now normalized and tested.
- `git grep nats-jetstream -- packages apps` now matches only the legacy-alias mapping, its doc comments, and the tests that cover it.
- New tests: `coordinationFabric.test.ts` covers the kinds list and mapping, a legacy adapter reporting `nats-core`, and a fake NATS server that never answers PONG (the event stays `failed` in the outbox). `fabricCommands.test.ts` covers the mapping and `WAZIR_NATS_URL` set → `transport: nats-core`.

## Task 2 — live nats-server
- Server: `nats:2.10` (2.10.29) in docker, `-p 14222:4222`. Docker needed `DOCKER_HOST=unix:///Users/wael/.orbstack/run/docker.sock` and an empty `DOCKER_CONFIG`, because the default config refers to a missing `docker-credential-desktop` helper (`docker: error getting credentials - err: exec: "docker-credential-desktop": executable file not found in $PATH`).
- Test: `packages/core/tests/coordinationFabric.natsLive.test.ts`. It is skipped unless `WAZIR_NATS_LIVE_URL` is set; the container name comes from `WAZIR_NATS_LIVE_CONTAINER`.
- Flow:
  1. Publish 20 events; all are confirmed and consumed.
  2. `docker stop`, then publish 20 more. The outbox holds exactly 20 undelivered entries, the circuit is not closed, and the consumer still has 20.
  3. `docker start`. The consumer reconnects, the outbox drains to 0, and the DLQ is 0.
  4. Inject 2 duplicate wire deliveries. The ledger has 40 keys, each applied exactly once, with 2 duplicates suppressed.
- Without the env var the test is reported as skipped (`logs/agent-05-fabric-tests.log`).

## Task 3 — two-node fencing
- Network: dgx (`192.168.0.233/24`) and the Mac (`192.168.1.225/24`) cannot reach each other over the LAN (`bash: connect: Network is unreachable`). Over Tailscale, dgx → Mac `100.80.184.43:14222` works.
- dgx: `git archive HEAD (150df25) | ssh dgx tar -x -C ~/wazir-v043-fabric`, then `npm ci --ignore-scripts` (exit 0) and `npx tsc --build packages/core` (exit 0) → `logs/agent-05-dgx-build.log`. `scripts/fabric-two-node-fencing.mjs` was then copied with scp; its sha256 matches the committed file (`81a7cc5c32346a8c…`).
- Result:
  1. The coordinator on the Mac (arm64, owns `ResourceReservationManager`) granted `worker-waelbot` on dgx (aarch64) token 1 with a 1500 ms TTL, sent over NATS.
  2. The lease expired and was reclaimed. A local holder got token 2 and its write was accepted.
  3. The dgx worker's late write arrived over NATS with `fencing_token=1` and was rejected: `StaleFencingTokenError: Stale fencing token 1 for resource 'exclusive:shared-ledger' (expected >= 2)`. `validateFence` also returned `ResourceLeaseExpiredError`.
  4. The worker received `resource.conflict`. The final ledger held the token-2 write. Both processes exited 0.

## Files touched
- `packages/core/src/types/coordination.ts`
- `packages/core/src/services/coordinationFabric.ts`
- `packages/core/tests/coordinationFabric.test.ts`
- `packages/core/tests/coordinationFabric.natsLive.test.ts` (new)
- `apps/cli/src/commands/fabricCommands.ts`
- `apps/cli/tests/fabricCommands.test.ts`
- `scripts/fabric-two-node-fencing.mjs` (new)
- `reports/v0.4.3/agent-05.md`, `reports/v0.4.3/logs/agent-05-*.log`, `reports/v0.4.3/INTEGRATION-CONTRACTS.md` (two change-request lines appended)

## Commands and exit codes
| Command | Exit | Log |
|---|---|---|
| `npm ci` | 0 | `logs/agent-05-npm-ci.log` |
| `npm run build` (initial) | 0 | `logs/agent-05-build-initial.log` |
| `npx vitest run packages/core/tests/coordinationFabric.test.ts apps/cli/tests/fabricCommands.test.ts` (after task 1) | 0 | `logs/agent-05-unit-tests.log` |
| `docker run -d --name wazir-nats-v043 -p 14222:4222 nats:2.10` (default docker config) | 125 (credential helper error above) | — |
| `docker pull nats:2.10` + `docker run …` (OrbStack socket, empty DOCKER_CONFIG) | 0 | (container id `3c5b05398fd7`) |
| `WAZIR_NATS_LIVE_URL=nats://127.0.0.1:14222 WAZIR_NATS_LIVE_CONTAINER=wazir-nats-v043 npx vitest run packages/core/tests/coordinationFabric.natsLive.test.ts` | 0 | `logs/agent-05-nats-live.log` |
| dgx `git archive` + `npm ci --ignore-scripts` + `npx tsc --build packages/core` | 0 / 0 / 0 | `logs/agent-05-dgx-build.log` |
| `node scripts/fabric-two-node-fencing.mjs coordinator --nats nats://127.0.0.1:14222` (Mac) | 0 | `logs/agent-05-two-node-coordinator.log` |
| `ssh dgx … node scripts/fabric-two-node-fencing.mjs worker --nats nats://100.80.184.43:14222` | 0 | `logs/agent-05-two-node-worker-dgx.log` |
| `npm run build` (final) | 0 | `logs/agent-05-build.log` |
| `npm run typecheck` (final) | 0 | `logs/agent-05-typecheck.log` |
| `npx vitest run coordinationFabric, coordinationFabric.natsLive (skipped), fabricCommands, messageRouter, phase3LeasesAndFencing` | 0 (20 passed, 1 skipped) | `logs/agent-05-fabric-tests.log` |
| `npx vitest run packages/core/tests/jobOrchestratorCoordination.test.ts` with baseline d6ca44a sources | 1 (pre-existing failure) | `logs/agent-05-baseline-jobOrchestratorCoordination.log` |
| `docker stop wazir-nats-v043 && docker rm wazir-nats-v043` | 0 / 0 | `logs/agent-05-docker-cleanup.log` |

## Blockers and notes
- **Pre-existing failure (not mine):** `packages/core/tests/jobOrchestratorCoordination.test.ts` fails with `expected [...] to include 'resource.released'`. It fails the same way with the baseline d6ca44a sources. Filed as a change request to Agent 01 in INTEGRATION-CONTRACTS.md and left out of the pass set above.
- **Process incident (fixed):** while trying to get a baseline comparison, I ran `git stash` with no tracked changes and then `git stash pop`. That applied an unrelated shared stash entry (`stash@{0}: WIP on feat/parallel-tui-performance`) to this worktree. Git kept the entry because the pop had conflicts, so it is still in the stash, unchanged. I restored the 4 conflicted tracked files from HEAD. The 5 untracked files the pop added were moved, not deleted, to `/private/tmp/claude-503/-Users-wael-Code-Wazir/75c28f4f-4744-4142-9d5b-fae46803c539/scratchpad/stash-pop-quarantine/`. They are also still in the stash's untracked tree. No commits or stash entries were lost.
- `~/wazir-v043-fabric` remains on dgx (build tree). No containers were started on dgx.
