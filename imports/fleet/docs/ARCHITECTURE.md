# Fleet Core Architecture

Fleet Core (`Sources/FleetCore`) is a domain-agnostic AI meta-orchestration, evaluation, and continuous project optimization control plane:

- **Execution Engine**: `ModelAdapters` (`Ollama`, `LM Studio`, `vLLM`, `llama.cpp`, `MLX`, `OpenAI-Compatible`, `CLIAgentAdapter`), `ResourceAwareScheduler` (dynamic concurrency, priority queues, backpressure, token/cost accounting), `ExecutionReplayEngine`.
- **Meta-Orchestration**: `ExecutionTopology` (13 topologies), `MetaOrchestrator` (objective decomposition validation & decision journal).
- **Continuous Improvement**: `OptimizationLoopEngine` (baseline, targeted repair, independent evaluation, regression rejection, best-candidate retention, convergence).
- **Evaluation & Quality**: `EvaluationEngine` (weighted rubrics, deterministic & LLM judges, cross-model agreement, strict `.unverified` state on missing evidence).
- **Registries**: `OntologyEngine`, `FrameworkPolicyRegistry` (immutable platform security gates), `WorkflowRegistry` (composable specs & legacy prompt importer), `ProjectIntelligenceEngine` (canonical findings consolidation & priority scoring), `ExecutionIntelligenceStore`.
- **Distributed Engineering**: `GitWorktreeCoordinator` (human modification protection & exclusive file ownership).
- **Extension SDK**: `ExtensionManager` + `SyntheticRoboticsExtension` & `SyntheticDataEngineeringExtension`.
- **Shared Command Runtime**: `ControlPlaneRuntime` & `FleetCLI` (`fleet`) sharing the exact same contracts as the macOS SwiftUI app.
