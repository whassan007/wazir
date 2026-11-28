import { describe, expect, it } from 'vitest';
import {
  WAZIR_STUDIO_NODE_KINDS,
  WazirStudioOrchestrator,
  type StudioGraph,
  type StudioMachineInventory,
} from '../src/studio/index.js';

const MACHINES: StudioMachineInventory[] = [
  {
    hostId: 'dgx',
    name: 'DGX Spark',
    online: true,
    availableCpuCores: 20,
    availableGpuCount: 1,
    availableRamGB: 128,
    availableVramGB: 128,
    reservedRamGB: 16,
    reservedVramGB: 16,
    activeInstances: 1,
    installedModels: [
      {
        modelId: 'qwen3-coder:30b',
        runtimeId: 'ollama',
        loaded: true,
        estimatedMemoryGB: 20,
        contextTokens: 65536,
        expectedThroughputTokensPerSec: 68,
        historicalQualityScore: 0.94,
        historicalPassRate: 0.92,
        sampleCount: 40,
      },
    ],
  },
];

describe('Wazir Studio Orchestrator', () => {
  it('supports all 16 required visual orchestration node kinds', () => {
    expect(WAZIR_STUDIO_NODE_KINDS).toHaveLength(16);
    expect(WAZIR_STUDIO_NODE_KINDS).toContain('approval_gate');
    expect(WAZIR_STUDIO_NODE_KINDS).toContain('mcp_server');
    expect(WAZIR_STUDIO_NODE_KINDS).toContain('subgraph');
  });

  it('recommends capacity-safe Qwen placement and prevents overcommitment', () => {
    const orch = new WazirStudioOrchestrator();
    const decision = orch.recommendPlacement({ machines: MACHINES, requiredContextTokens: 16384 });
    expect(decision.selectedModelId).toBe('qwen3-coder:30b');
    expect(decision.selectedHostId).toBe('dgx');
    expect(decision.maxSafeInstances).toBeGreaterThanOrEqual(1);
    expect(decision.executionCost.classification).toBe('ACTUAL_ZERO');
  });

  it('allows dynamic model reassignment at safe boundaries and blocks mid-flight mutation', () => {
    const orch = new WazirStudioOrchestrator();
    const graph: StudioGraph = {
      id: 'g1',
      name: 'Studio Flow',
      executionMode: 'SIMULATED',
      nodes: [
        { id: 'n1', kind: 'agent', label: 'Planner', x: 100, y: 100, selectionMode: 'delegated', boundaryState: 'review' },
        { id: 'n2', kind: 'task', label: 'Worker', x: 300, y: 100, selectionMode: 'delegated', boundaryState: 'running' },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
    };

    const updated = orch.reassignStudioNodeModel(graph, 'n1', { hostId: 'dgx', modelId: 'qwen3-coder:30b' });
    expect(updated.nodes[0]?.modelId).toBe('qwen3-coder:30b');
    expect(() => orch.reassignStudioNodeModel(graph, 'n2', { hostId: 'dgx', modelId: 'qwen3-coder:30b' })).toThrow();

    const sim = orch.simulateExecution(updated);
    expect(sim.executionMode).toBe('SIMULATED');
    expect(sim.steps).toHaveLength(2);
  });
});
