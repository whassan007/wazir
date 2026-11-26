# Coordination & Messaging Transport

- **Service**: `packages/core/src/services/coordinationFabric.ts` (`CoordinationFabric`, `NatsWireTransport`).
- **Correction Applied**: `NatsWireTransport.kind` updated from `'nats-jetstream'` to `'nats-core'` to accurately reflect basic NATS `PUB`/`SUB` wire protocol backed by local outbox durability.
- **Verification**: `packages/core/tests/coordinationFabric.test.ts` (4/4), `packages/core/tests/messageRouter.test.ts`, `apps/cli/tests/fabricCommands.test.ts` (1/1).
- **Status**: `VERIFIED_OPERATIONAL`.
