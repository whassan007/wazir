# Distributed Execution & Recovery

- **Services**: `JobManager`, `JobOrchestrator`, `Scheduler`, `CheckpointService`, `CheckpointTransportService`, `ExecutionRecovery`.
- **Verification**: `packages/core/tests/phase3LeasesAndFencing.test.ts` and `packages/core/tests/checkpointTransport.test.ts` verify lease fencing, stale worker rejection, and checkpoint transfer.
- **Status**: `VERIFIED_OPERATIONAL` (unit/integration); live multi-machine DGX/Jetson tests `BLOCKED` in sandbox.
