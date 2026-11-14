import { describe, expect, it, afterEach } from 'vitest';
import {
  AccountRegistry,
  DEFAULT_FS5_FLEET_CONFIG,
  WorkloadDistributor,
  createDefaultFs5ExecutionPlan,
  parseWorkloadDistribution,
} from '@wazir/core';
import { loadConfig } from '../src/config.js';
import { prepareGenerationPlacement } from '../src/escalation.js';

describe('Mac Studio Fleet Execution Path Integration', () => {
  const origFleetHosts = process.env.WAZIR_FLEET_HOSTS;

  afterEach(() => {
    if (origFleetHosts === undefined) {
      delete process.env.WAZIR_FLEET_HOSTS;
    } else {
      process.env.WAZIR_FLEET_HOSTS = origFleetHosts;
    }
  });

  it('registers mac_studio in DEFAULT_FS5_FLEET_CONFIG with SSH tunnel transports and fallback coder model', () => {
    const studioHost = DEFAULT_FS5_FLEET_CONFIG.hosts.find((h) => h.hostId === 'mac_studio');
    expect(studioHost).toBeDefined();
    expect(studioHost?.aliases).toEqual(
      expect.arrayContaining(['studio', 'mac_studio', 'studio.local', '100.76.30.71']),
    );
    expect(studioHost?.endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpointId: 'ep-studio-lmstudio',
          runtimeId: 'mac_studio:lmstudio',
          tunnelTransportId: 'ssh-tunnel-mac-studio-1235',
        }),
        expect.objectContaining({
          endpointId: 'ep-studio-ollama',
          runtimeId: 'mac_studio:ollama',
          tunnelTransportId: 'ssh-tunnel-mac-studio-11435',
        }),
      ]),
    );
    expect(DEFAULT_FS5_FLEET_CONFIG.transports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transportId: 'ssh-tunnel-mac-studio-1235',
          localEndpointUrl: 'http://127.0.0.1:1235/v1',
          targetHostId: 'mac_studio',
        }),
        expect.objectContaining({
          transportId: 'ssh-tunnel-mac-studio-11435',
          localEndpointUrl: 'http://127.0.0.1:11435',
          targetHostId: 'mac_studio',
        }),
      ]),
    );

    const plan = createDefaultFs5ExecutionPlan();
    const studioPool = plan.spec.pools.find((p) => p.id === 'mac_studio');
    expect(studioPool).toMatchObject({
      enabled: true,
      host: 'mac_studio',
      preferred_runtime: 'lmstudio',
      preferred_model: 'qwen/qwen3-30b-a3b',
      fallback_model: 'deepseek-r1-distill-qwen-32b',
    });
  });

  it('routes WorkloadDistributor tasks onto mac_studio via explicit studio share and local hardware rotation', () => {
    const explicitDist = new WorkloadDistributor(
      parseWorkloadDistribution('studio:50,dgx:35,local:15'),
    );
    const batch = explicitDist.allocateBatch(6, {
      hasLocalHardware: true,
      hardwareComputerIds: ['local', 'mac_studio', 'dgx_spark'],
      externalAgents: [],
    });
    expect(batch.filter((t) => t.targetComputerId === 'mac_studio').length).toBe(3);
    expect(batch.filter((t) => t.targetComputerId === 'dgx_spark').length).toBe(2);
    expect(batch.filter((t) => t.targetComputerId === 'local').length).toBe(1);

    const localRoundRobin = new WorkloadDistributor(parseWorkloadDistribution('local:100'));
    const rotated = localRoundRobin.allocateBatch(3, {
      hasLocalHardware: true,
      hardwareComputerIds: ['local', 'mac_studio', 'dgx_spark'],
      externalAgents: [],
    });
    expect(rotated.map((t) => t.targetComputerId)).toEqual(['local', 'mac_studio', 'dgx_spark']);
  });

  it('parses WAZIR_FLEET_HOSTS into config.fleetHosts and allows direct generation placement on mac_studio without WAZIR_API_URL', async () => {
    process.env.WAZIR_FLEET_HOSTS = JSON.stringify([
      {
        id: 'mac_studio',
        name: 'Mac Studio (Apple M4 Max)',
        cpu: 'Apple M4 Max',
        cpuCores: 14,
        memoryGB: 36,
        lmstudioUrl: 'http://127.0.0.1:1235/v1',
        ollamaUrl: 'http://127.0.0.1:11435',
      },
    ]);
    const cfg = loadConfig();
    expect(cfg.fleetHosts).toHaveLength(1);
    expect(cfg.fleetHosts?.[0]).toMatchObject({
      id: 'mac_studio',
      cpu: 'Apple M4 Max',
      memoryGB: 36,
      lmstudioUrl: 'http://127.0.0.1:1235/v1',
    });

    const adapters = new Map<string, unknown>([['mac_studio:lmstudio', { id: 'mac_studio:lmstudio' }]]);
    const placement = await prepareGenerationPlacement(
      {
        models: {
          getRequired: () => ({ id: 'qwen-agentworld-35b-a3b', contextWindow: 32768 } as any),
          instancesOf: () => [{ id: 'mac_studio:lmstudio::mac_studio::qwen-agentworld-35b-a3b', contextTokens: 32768 }],
        },
        runtimes: { get: () => ({ runtimeKind: 'local' }) },
        adapters,
        worker: { computerId: 'local' },
        config: {},
        lifecycle: { ensureReady: async () => ({ effectiveContext: 32768 }) },
      },
      {
        agentId: 'coding',
        modelId: 'qwen-agentworld-35b-a3b',
        modelInstanceId: 'mac_studio:lmstudio::mac_studio::qwen-agentworld-35b-a3b',
        runtimeId: 'mac_studio:lmstudio',
        computerId: 'mac_studio',
        readiness: 'READY_NOW',
        modelDecision: { modelId: 'qwen-agentworld-35b-a3b', reasons: ['studio ready'] },
        computerDecision: { computerId: 'mac_studio', runtimeId: 'mac_studio:lmstudio', reasons: ['36GB unified memory'] },
      } as any,
      { executionId: 'exec-studio-1', minimumContext: 8192 },
    );
    expect(placement.contextTokens).toBe(32768);

    const accounts = new AccountRegistry([]);
    accounts.addImplicit({
      localRuntimes: ['lmstudio', 'ollama', 'mac_studio:lmstudio'],
      hostedRuntimes: [],
      agents: [],
      hostedAuthorized: false,
    });
    const studioCandidates = accounts.candidates({
      runtimeId: 'mac_studio:lmstudio',
      modelId: 'qwen/qwen3-coder-30b',
    });
    expect(studioCandidates.length).toBeGreaterThan(0);
    expect(studioCandidates[0]?.kind).toBe('local');
  });
});
