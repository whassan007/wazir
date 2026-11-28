# Fleet Core 1.0.0-rc1 Release Notes

- **Branch**: `release/fleet-core-1.0.0-rc1` (not merged to `main` pending explicit authorization).
- **New Capabilities**:
  - Distributed Execution Engine with `vllm` & `openaiCompatible` support, `ResourceAwareScheduler`, and `ExecutionReplayEngine`.
  - Meta-Orchestration Engine with 13 topologies and `DecisionJournal`.
  - Continuous Improvement Loop Engine with regression rejection and best-candidate retention.
  - Evaluation & Quality Engine separating `ExecutionOutcome` from `ValidationState`.
  - Domain-agnostic Ontology, Policy, Workflow, Project Intelligence, and Execution Intelligence registries.
  - Extension SDK with two synthetic reference extensions (`SyntheticRoboticsExtension`, `SyntheticDataEngineeringExtension`).
  - `FleetCLI` (`fleet`) supporting all 16 slash commands (`/goal` .. `/history`) in human and `--json` modes.
