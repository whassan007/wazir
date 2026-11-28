export const WAZIR_STUDIO_NODE_KINDS = [
  'machine',
  'model',
  'model_instance',
  'agent',
  'task',
  'sequential',
  'parallel',
  'conditional',
  'loop',
  'evaluator',
  'critic',
  'optimizer',
  'approval_gate',
  'tool',
  'mcp_server',
  'subgraph',
] as const;

export type StudioNodeKind = (typeof WAZIR_STUDIO_NODE_KINDS)[number];
export type StudioExecutionMode = 'SIMULATED' | 'LIVE';
export type StudioBoundaryState = 'queued' | 'ready' | 'review' | 'paused_at_boundary' | 'between_iterations' | 'running' | 'completed';

export interface StudioMachineInventory {
  hostId: string;
  name: string;
  online: boolean;
  availableCpuCores: number;
  availableGpuCount: number;
  availableRamGB: number;
  availableVramGB: number;
  reservedRamGB: number;
  reservedVramGB: number;
  activeInstances: number;
  installedModels: Array<{
    modelId: string;
    runtimeId: string;
    loaded: boolean;
    estimatedMemoryGB: number;
    contextTokens: number;
    expectedThroughputTokensPerSec: number;
    historicalQualityScore: number;
    historicalPassRate: number;
    sampleCount: number;
    costPer1kTokensUsd?: number;
  }>;
}

export interface StudioNode {
  id: string;
  kind: StudioNodeKind;
  label: string;
  x: number;
  y: number;
  hostId?: string;
  modelId?: string;
  runtimeId?: string;
  selectionMode: 'explicit' | 'delegated';
  requiredContextTokens?: number;
  boundaryState: StudioBoundaryState;
  metadata?: Record<string, unknown>;
}

export interface StudioEdge {
  id: string;
  from: string;
  to: string;
  condition?: string;
}

export interface StudioGraph {
  id: string;
  name: string;
  executionMode: StudioExecutionMode;
  nodes: StudioNode[];
  edges: StudioEdge[];
}

export interface StudioPlacementDecision {
  selectedModelId: string;
  selectedHostId: string;
  selectedRuntimeId: string;
  maxSafeInstances: number;
  availableCpuCores: number;
  availableGpuCount: number;
  availableRamGB: number;
  availableVramGB: number;
  runtimeCompatible: boolean;
  requiredContextTokens: number;
  supportedContextTokens: number;
  currentReservations: {
    reservedRamGB: number;
    reservedVramGB: number;
    activeInstances: number;
  };
  expectedThroughputTokensPerSec: number;
  executionCost: {
    estimatedCostUsd: number | null;
    classification: 'ACTUAL_ZERO' | 'ESTIMATED' | 'ACTUAL' | 'UNKNOWN';
  };
  historicalQuality: {
    score: number;
    passRate: number;
    sampleCount: number;
  };
  alternatives: Array<{ hostId: string; modelId: string; runtimeId: string; score: number }>;
}

const SAFE_REASSIGN_BOUNDARIES = new Set<StudioBoundaryState>([
  'queued',
  'ready',
  'review',
  'paused_at_boundary',
  'between_iterations',
]);

export class WazirStudioOrchestrator {
  recommendPlacement(params: {
    machines: StudioMachineInventory[];
    preferredHostId?: string;
    preferredModelId?: string;
    requiredContextTokens?: number;
  }): StudioPlacementDecision {
    const requiredContextTokens = params.requiredContextTokens ?? 8192;
    const candidates: Array<{
      machine: StudioMachineInventory;
      model: StudioMachineInventory['installedModels'][number];
      score: number;
      maxSafeInstances: number;
    }> = [];

    for (const machine of params.machines) {
      if (!machine.online) continue;
      if (params.preferredHostId && machine.hostId !== params.preferredHostId) continue;

      for (const model of machine.installedModels) {
        if (params.preferredModelId && model.modelId !== params.preferredModelId) continue;
        if (model.contextTokens < requiredContextTokens) continue;

        const usableMem = Math.max(machine.availableVramGB, machine.availableRamGB) - Math.max(machine.reservedVramGB, machine.reservedRamGB);
        const memPerInstance = Math.max(1, model.estimatedMemoryGB);
        const maxSafeInstances = Math.max(0, Math.floor(usableMem / memPerInstance));
        if (maxSafeInstances < 1) continue;

        let score = model.historicalQualityScore * 100 + model.expectedThroughputTokensPerSec * 0.25;
        if (model.loaded) score += 15;
        if (model.modelId.toLowerCase().includes('qwen')) score += 10; // Qwen default orchestration preference

        candidates.push({ machine, model, score, maxSafeInstances });
      }
    }

    candidates.sort((a, b) => b.score - a.score || a.machine.hostId.localeCompare(b.machine.hostId));
    const best = candidates[0];
    if (!best) {
      throw new Error('No capacity-safe machine and model candidate satisfies the placement constraints.');
    }

    const isLocalZero = best.model.costPer1kTokensUsd === undefined || best.model.costPer1kTokensUsd === 0;
    return {
      selectedModelId: best.model.modelId,
      selectedHostId: best.machine.hostId,
      selectedRuntimeId: best.model.runtimeId,
      maxSafeInstances: best.maxSafeInstances,
      availableCpuCores: best.machine.availableCpuCores,
      availableGpuCount: best.machine.availableGpuCount,
      availableRamGB: best.machine.availableRamGB,
      availableVramGB: best.machine.availableVramGB,
      runtimeCompatible: true,
      requiredContextTokens,
      supportedContextTokens: best.model.contextTokens,
      currentReservations: {
        reservedRamGB: best.machine.reservedRamGB,
        reservedVramGB: best.machine.reservedVramGB,
        activeInstances: best.machine.activeInstances,
      },
      expectedThroughputTokensPerSec: best.model.expectedThroughputTokensPerSec,
      executionCost: {
        estimatedCostUsd: isLocalZero ? 0 : Number(((requiredContextTokens / 1000) * best.model.costPer1kTokensUsd!).toFixed(4)),
        classification: isLocalZero ? 'ACTUAL_ZERO' : 'ESTIMATED',
      },
      historicalQuality: {
        score: best.model.historicalQualityScore,
        passRate: best.model.historicalPassRate,
        sampleCount: best.model.sampleCount,
      },
      alternatives: candidates.slice(1, 5).map((c) => ({
        hostId: c.machine.hostId,
        modelId: c.model.modelId,
        runtimeId: c.model.runtimeId,
        score: Number(c.score.toFixed(2)),
      })),
    };
  }

  reassignStudioNodeModel(
    graph: StudioGraph,
    nodeId: string,
    target: { hostId: string; modelId: string; runtimeId?: string },
  ): StudioGraph {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`Studio node '${nodeId}' not found.`);
    if (!SAFE_REASSIGN_BOUNDARIES.has(node.boundaryState)) {
      throw new Error(
        `Cannot reassign node '${nodeId}' while in state '${node.boundaryState}'. Wait for a safe workflow boundary.`,
      );
    }
    return {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              hostId: target.hostId,
              modelId: target.modelId,
              runtimeId: target.runtimeId ?? n.runtimeId,
              selectionMode: 'explicit',
            }
          : n,
      ),
    };
  }

  simulateExecution(graph: StudioGraph): {
    executionMode: 'SIMULATED';
    graphId: string;
    nodeCount: number;
    edgeCount: number;
    steps: Array<{ nodeId: string; kind: StudioNodeKind; status: 'simulated_done' }>;
  } {
    return {
      executionMode: 'SIMULATED',
      graphId: graph.id,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      steps: graph.nodes.map((n) => ({
        nodeId: n.id,
        kind: n.kind,
        status: 'simulated_done',
      })),
    };
  }
}
