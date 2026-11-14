import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@wazir/shared';
import {
  apportionAgentsLargestRemainder,
  AuthorizedHostRegistry,
  buildConfigurationReportJson,
  buildLiveExecutionReportJson,
  buildServerAcceptanceTable,
  CapabilityGraphBuilder,
  classifyMetaHarnessIntent,
  classifyTaskRequirements,
  createDefaultFs5ExecutionPlan,
  detectOracleWeakening,
  DistributedExecutionController,
  enforceWorkerSecurityGuard,
  evaluateHostAcceptanceFromRuntimes,
  findBestHostsForModelSize,
  inspectPatchForOracleWeakening,
  IntelligentHardwareScheduler,
  MetaHarnessReconciler,
  MetaHarnessService,
  optimizeAgentAllocationForSpeed,
  parseExecutionPlanYamlOrJson,
  parseHardUserConstraints,
  qualifyRuntimeConcurrency,
  qualifyRuntimeEndpoint,
  resolveEndpointForExecutionContext,
  runAutonomousRepairCycle,
  SharedGpuAdmissionController,
  summarizeObservedExecutionMetrics,
  verifyDeliverableIndependently,
  type CapabilityGraph,
  type PhysicalHostNode,
} from '../src/index.js';

function makeHost(
  overrides: Partial<PhysicalHostNode> & Pick<PhysicalHostNode, 'hostId' | 'machineId' | 'hostname'>,
): PhysicalHostNode {
  return {
    kind: 'physical_host',
    machineId: overrides.machineId,
    hostId: overrides.hostId,
    hostname: overrides.hostname,
    aliases: overrides.aliases ?? [overrides.hostId],
    os: overrides.os ?? { platform: 'linux', release: '6.8.0', architecture: 'arm64' },
    cpu: overrides.cpu ?? {
      brand: 'ARM Neoverse',
      architecture: 'arm64',
      logicalCores: 20,
      physicalCores: 20,
      utilizationPercent: 12,
    },
    gpus: overrides.gpus ?? [
      {
        gpuId: 'GPU-4d4d5fec-2c64-4410-3fd3-1174e5082765',
        index: 0,
        vendor: 'nvidia',
        model: 'NVIDIA GB10',
        cudaVersion: '13.0',
        unifiedMemory: true,
        totalMemoryGB: 121.69,
        availableMemoryGB: 86.4,
        usedMemoryGB: 35.29,
        utilizationPercent: 18,
      },
    ],
    memory: overrides.memory ?? {
      totalGB: 121.69,
      availableGB: 86.4,
      usedGB: 35.29,
      unifiedMemory: true,
      pressureLevel: 'normal',
      reservedBySystemGB: 4,
      reservedByUserGB: 0,
    },
    disk: overrides.disk ?? { mountPoint: '/', totalGB: 4000, freeGB: 3100, usedPercent: 22.5 },
    networkIdentityIds: overrides.networkIdentityIds ?? [],
    localWorkerAvailable: overrides.localWorkerAvailable ?? false,
    workerIds: overrides.workerIds ?? [],
    runtimeIds: overrides.runtimeIds ?? [],
    workloadConflicts: overrides.workloadConflicts ?? [],
    resourceReservationsGB: overrides.resourceReservationsGB ?? { ramGB: 0, vramByGpuId: {} },
    lastDiscoveredAt: overrides.lastDiscoveredAt ?? new Date().toISOString(),
    provenance: overrides.provenance ?? ['authorized_ssh'],
    confidence: overrides.confidence ?? 0.99,
  };
}

function buildReferenceFs5Graph(): CapabilityGraph {
  const builder = new CapabilityGraphBuilder({ coordinatorHostId: 'macbook_pro' });

  builder.upsertHost(
    makeHost({
      hostId: 'macbook_pro',
      machineId: 'mach-mbp-m5-pro',
      hostname: 'MacBook-Pro.local',
      os: { platform: 'darwin', release: '25.0.0', architecture: 'arm64', appleSiliconGeneration: 'M5 Pro' },
      gpus: [
        {
          gpuId: 'apple-gpu-mbp-0',
          index: 0,
          vendor: 'apple',
          model: 'Apple M5 Pro',
          metalSupported: true,
          mpsSupported: true,
          unifiedMemory: true,
          totalMemoryGB: 24,
          availableMemoryGB: 14.5,
          usedMemoryGB: 9.5,
          utilizationPercent: 10,
        },
      ],
      memory: {
        totalGB: 24,
        availableGB: 14.5,
        usedGB: 9.5,
        unifiedMemory: true,
        pressureLevel: 'normal',
        reservedBySystemGB: 3,
        reservedByUserGB: 0,
      },
      localWorkerAvailable: true,
      provenance: ['local_introspection'],
    }),
  );

  builder.upsertHost(
    makeHost({
      hostId: 'dgx_spark',
      machineId: 'mach-dgx-gb10',
      hostname: 'spark-gb10',
      aliases: ['dgx_spark', '100.113.62.112', 'dgx_spark_lan_alias'],
    }),
  );

  builder.upsertHost(
    makeHost({
      hostId: 'mac_studio',
      machineId: 'mach-studio-m4-max',
      hostname: 'Mac-Studio.local',
      aliases: ['mac_studio', 'studio', '100.76.30.71'],
      os: { platform: 'darwin', release: '25.0.0', architecture: 'arm64', appleSiliconGeneration: 'M4 Max' },
      gpus: [
        {
          gpuId: 'apple-gpu-studio-0',
          index: 0,
          vendor: 'apple',
          model: 'Apple M4 Max',
          metalSupported: true,
          mpsSupported: true,
          unifiedMemory: true,
          totalMemoryGB: 36,
          availableMemoryGB: 15.2,
          usedMemoryGB: 20.8,
          utilizationPercent: 15,
        },
      ],
      memory: {
        totalGB: 36,
        availableGB: 15.2,
        usedGB: 20.8,
        unifiedMemory: true,
        pressureLevel: 'normal',
        reservedBySystemGB: 4,
        reservedByUserGB: 0,
      },
    }),
  );

  builder.addTransport({
    transportId: 'tunnel:mbp->mac_studio:1235',
    type: 'ssh_tunnel',
    originHostId: 'macbook_pro',
    localEndpointUrl: 'http://127.0.0.1:1235/v1',
    targetHostId: 'mac_studio',
    remoteLoopbackUrl: 'http://127.0.0.1:1234/v1',
    sshHostAlias: 'studio',
    verifiedActive: true,
  });

  builder.addRuntimeProcess({
    processNodeId: 'proc:dgx:lms',
    runtimeId: 'dgx_spark:lmstudio',
    hostId: 'dgx_spark',
    machineId: 'mach-dgx-gb10',
    runtimeType: 'lmstudio',
    version: '0.4.0',
    running: true,
    role: 'primary',
  });
  builder.addRuntimeProcess({
    processNodeId: 'proc:dgx:ollama',
    runtimeId: 'dgx_spark:ollama',
    hostId: 'dgx_spark',
    machineId: 'mach-dgx-gb10',
    runtimeType: 'ollama',
    version: '0.6.0',
    running: true,
    role: 'secondary',
  });
  builder.addRuntimeProcess({
    processNodeId: 'proc:studio:lms',
    runtimeId: 'mac_studio:lmstudio',
    hostId: 'mac_studio',
    machineId: 'mach-studio-m4-max',
    runtimeType: 'lmstudio',
    version: '0.4.0',
    running: true,
    role: 'primary',
  });
  builder.addRuntimeProcess({
    processNodeId: 'proc:mbp:lms',
    runtimeId: 'macbook_pro:lmstudio',
    hostId: 'macbook_pro',
    machineId: 'mach-mbp-m5-pro',
    runtimeType: 'lmstudio',
    version: '0.4.0',
    running: true,
    role: 'primary',
  });

  builder.addEndpoint({
    endpointId: 'ep:dgx:lms',
    runtimeId: 'dgx_spark:lmstudio',
    hostId: 'dgx_spark',
    machineId: 'mach-dgx-gb10',
    rawUrl: 'http://100.113.62.112:1234/v1',
    originContextHostId: 'dgx_spark',
    transport: 'http',
    apiCompatibility: ['openai_chat', 'lmstudio_v0'],
    acceptanceState: 'CAPACITY_VERIFIED',
  });
  builder.addEndpoint({
    endpointId: 'ep:dgx:ollama',
    runtimeId: 'dgx_spark:ollama',
    hostId: 'dgx_spark',
    machineId: 'mach-dgx-gb10',
    rawUrl: 'http://100.113.62.112:11434',
    originContextHostId: 'dgx_spark',
    transport: 'http',
    apiCompatibility: ['ollama_native', 'openai_chat'],
    acceptanceState: 'EXECUTION_VERIFIED',
  });
  builder.addEndpoint({
    endpointId: 'ep:studio:lms',
    runtimeId: 'mac_studio:lmstudio',
    hostId: 'mac_studio',
    machineId: 'mach-studio-m4-max',
    rawUrl: 'http://127.0.0.1:1234/v1',
    originContextHostId: 'mac_studio',
    tunnelTransportId: 'tunnel:mbp->mac_studio:1235',
    transport: 'ssh_tunnel',
    apiCompatibility: ['openai_chat', 'lmstudio_v0'],
    acceptanceState: 'CAPACITY_VERIFIED',
  });
  builder.addEndpoint({
    endpointId: 'ep:mbp:lms',
    runtimeId: 'macbook_pro:lmstudio',
    hostId: 'macbook_pro',
    machineId: 'mach-mbp-m5-pro',
    rawUrl: 'http://127.0.0.1:1234/v1',
    originContextHostId: 'macbook_pro',
    transport: 'http',
    apiCompatibility: ['openai_chat', 'lmstudio_v0'],
    acceptanceState: 'CAPACITY_VERIFIED',
  });

  builder.addModel({
    modelNodeId: 'mdl:dgx:qwen35b',
    modelId: 'qwen-agentworld-35b-a3b',
    runtimeId: 'dgx_spark:lmstudio',
    hostId: 'dgx_spark',
    residency: 'loaded',
    parameterBillions: 35,
    isMoE: true,
    maxContextTokens: 32768,
    capabilities: ['chat', 'coding', 'reasoning', 'tool_calling'],
    toolCallingSupported: true,
    toolCallingVerified: true,
    visionSupported: false,
    measuredTokensPerSecond: 68,
    measuredEndToEndLatencyMs: 210,
  });
  builder.addModel({
    modelNodeId: 'mdl:dgx:coder30b',
    modelId: 'qwen3-coder:30b',
    runtimeId: 'dgx_spark:ollama',
    hostId: 'dgx_spark',
    residency: 'installed_not_loaded',
    parameterBillions: 30,
    isMoE: true,
    maxContextTokens: 32768,
    capabilities: ['chat', 'coding', 'tool_calling'],
    toolCallingSupported: true,
    toolCallingVerified: false,
    visionSupported: false,
  });
  builder.addModel({
    modelNodeId: 'mdl:studio:qwen35b',
    modelId: 'qwen-agentworld-35b-a3b',
    runtimeId: 'mac_studio:lmstudio',
    hostId: 'mac_studio',
    residency: 'loaded',
    parameterBillions: 35,
    isMoE: true,
    maxContextTokens: 32768,
    capabilities: ['chat', 'coding', 'reasoning', 'tool_calling'],
    toolCallingSupported: true,
    toolCallingVerified: true,
    visionSupported: false,
    measuredTokensPerSecond: 54,
    measuredEndToEndLatencyMs: 260,
  });
  builder.addModel({
    modelNodeId: 'mdl:mbp:qwen9b',
    modelId: 'mlx-community/qwen3.5-9b',
    runtimeId: 'macbook_pro:lmstudio',
    hostId: 'macbook_pro',
    residency: 'loaded',
    parameterBillions: 9,
    isMoE: false,
    maxContextTokens: 16384,
    capabilities: ['chat', 'coding', 'vision'],
    toolCallingSupported: true,
    toolCallingVerified: true,
    visionSupported: true,
    measuredTokensPerSecond: 42,
    measuredEndToEndLatencyMs: 180,
  });

  builder.discoverCloudProviders({
    env: {
      GOOGLE_API_KEY: 'test-gemini-key',
      OPENAI_API_KEY: 'test-codex-key',
      ANTHROPIC_API_KEY: 'ignored-claude-key',
    },
    disabledProviders: ['claude'],
    coordinatorChannelActive: true,
  });

  return builder.build();
}

describe('WAZIR META-HARNESS — Part 11 Required Acceptance Tests (Tests 1–15)', () => {
  it('Test 1: Physical machine deduplication merges multiple network identities and runtimes into one host', () => {
    const builder = new CapabilityGraphBuilder({ coordinatorHostId: 'macbook_pro' });
    builder.upsertHost(makeHost({ hostId: 'dgx_spark', machineId: 'mach-dgx-gb10', hostname: 'spark-gb10' }));
    builder.upsertHost(
      makeHost({
        hostId: 'dgx_lan_eth0',
        machineId: 'mach-dgx-gb10',
        hostname: 'spark-lan.local',
        aliases: ['192.168.50.112'],
      }),
    );
    builder.addNetworkIdentity({
      networkId: 'net:dgx:tailscale',
      hostId: 'dgx_spark',
      machineId: 'mach-dgx-gb10',
      address: '100.113.62.112',
      scope: 'tailscale',
      authorized: true,
    });
    builder.addNetworkIdentity({
      networkId: 'net:dgx:lan',
      hostId: 'dgx_lan_eth0',
      machineId: 'mach-dgx-gb10',
      address: '192.168.50.112',
      scope: 'lan',
      authorized: true,
    });

    const graph = builder.build();
    expect(Object.keys(graph.hosts)).toHaveLength(1);
    expect(graph.hosts['dgx_spark'].aliases).toContain('192.168.50.112');
    expect(graph.hosts['dgx_spark'].networkIdentityIds).toHaveLength(2);
  });

  it('Test 2: Loopback context isolation never rewrites remote 127.0.0.1 to a guessed LAN/Tailscale IP', () => {
    const remoteLoopbackEndpoint = {
      kind: 'inference_endpoint' as const,
      endpointId: 'ep:studio:loopback',
      runtimeId: 'mac_studio:lmstudio',
      hostId: 'mac_studio',
      machineId: 'mach-studio-m4-max',
      rawUrl: 'http://127.0.0.1:1234/v1',
      originContextHostId: 'mac_studio',
      visibility: 'loopback_only' as const,
      transport: 'http' as const,
      apiCompatibility: ['openai_chat' as const],
      acceptanceState: 'DISCOVERED' as const,
    };

    const unbridged = resolveEndpointForExecutionContext({
      callerHostId: 'macbook_pro',
      endpoint: remoteLoopbackEndpoint,
      transports: [],
      workers: [],
    });
    expect(unbridged.usable).toBe(false);
    expect(unbridged.routeVia).toBe('unreachable_loopback');
    expect(unbridged.resolvedUrl).toBeUndefined();

    const bridged = resolveEndpointForExecutionContext({
      callerHostId: 'macbook_pro',
      endpoint: remoteLoopbackEndpoint,
      transports: [
        {
          transportId: 'tunnel:studio:1235',
          type: 'ssh_tunnel',
          originHostId: 'macbook_pro',
          localEndpointUrl: 'http://127.0.0.1:1235/v1',
          targetHostId: 'mac_studio',
          remoteLoopbackUrl: 'http://127.0.0.1:1234/v1',
          verifiedActive: true,
        },
      ],
      workers: [],
    });
    expect(bridged.usable).toBe(true);
    expect(bridged.routeVia).toBe('ssh_tunnel');
    expect(bridged.resolvedUrl).toBe('http://127.0.0.1:1235/v1');

    const auth = new AuthorizedHostRegistry();
    expect(() => auth.assertNoArbitrarySubnetScan('192.168.1.0/24')).toThrow(/SUBNET_SCAN_FORBIDDEN/);
  });

  it('Test 3: Multi-runtime single-GPU accounting prevents double-counting VRAM across Ollama, LM Studio, and Isaac Sim', () => {
    const builder = new CapabilityGraphBuilder({ coordinatorHostId: 'win_rtx4080' });
    builder.upsertHost(
      makeHost({
        hostId: 'win_rtx4080',
        machineId: 'mach-win-4080',
        hostname: 'win-sim-box',
        os: { platform: 'win32', release: '10.0.22631', architecture: 'x64' },
        gpus: [
          {
            gpuId: 'GPU-rtx-4080-0',
            index: 0,
            vendor: 'nvidia',
            model: 'NVIDIA GeForce RTX 4080',
            cudaVersion: '12.6',
            unifiedMemory: false,
            totalMemoryGB: 16,
            availableMemoryGB: 7,
            usedMemoryGB: 9,
          },
        ],
        memory: {
          totalGB: 64,
          availableGB: 42,
          usedGB: 22,
          unifiedMemory: false,
          pressureLevel: 'normal',
          reservedBySystemGB: 4,
          reservedByUserGB: 0,
        },
        workloadConflicts: [
          {
            pid: 4412,
            processName: 'isaac-sim.exe',
            kind: 'simulation',
            gpuId: 'GPU-rtx-4080-0',
            reservedVramGB: 9,
            reservedRamGB: 16,
            doNotInterrupt: true,
          },
        ],
      }),
    );

    const graph = builder.build();
    const admission = new SharedGpuAdmissionController(graph);
    const budget = admission.getGpuBudgetSummary('win_rtx4080');
    expect(budget.totalMemoryGB).toBe(16);
    expect(budget.usableFreeGB).toBeLessThan(7);

    const first = admission.admitSlot({
      slotId: 'slot-ollama-1',
      hostId: 'win_rtx4080',
      runtimeId: 'win:ollama',
      modelId: 'qwen2.5-coder:7b',
      parameterBillions: 7,
      quantization: 'q4',
    });
    expect(first.admitted).toBe(true);

    const secondRuntime = admission.admitSlot({
      slotId: 'slot-lmstudio-1',
      hostId: 'win_rtx4080',
      runtimeId: 'win:lmstudio',
      modelId: 'qwen3.5-9b',
      parameterBillions: 9,
      quantization: 'q4',
    });
    expect(secondRuntime.admitted).toBe(false);
    expect(secondRuntime.reason).toMatch(/Insufficient|usable/i);
  });

  it('Test 4: Loaded vs installed model distinction does not mark installed-only models as loaded without warm/cold verification', async () => {
    const graph = buildReferenceFs5Graph();
    expect(graph.models['mdl:dgx:qwen35b'].residency).toBe('loaded');
    expect(graph.models['mdl:dgx:coder30b'].residency).toBe('installed_not_loaded');

    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/v0/models')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'qwen-agentworld-35b-a3b', state: 'loaded' },
              { id: 'deepseek-r1-distill-qwen-32b', state: 'not-loaded' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not called', { status: 404 });
    };

    const probeOnly = await qualifyRuntimeEndpoint({
      runtimeId: 'dgx_spark:lmstudio',
      runtimeType: 'lmstudio',
      endpointUrl: 'http://100.113.62.112:1234/v1',
      targetModelId: 'deepseek-r1-distill-qwen-32b',
      allowColdLoad: false,
      runRealInference: false,
      fetchImpl: fakeFetch,
    });
    expect(probeOnly.installedModelIds).toContain('deepseek-r1-distill-qwen-32b');
    expect(probeOnly.loadedModelIds).toEqual(['qwen-agentworld-35b-a3b']);
    expect(probeOnly.state).toBe('API_READY');
    expect(probeOnly.evidence.modelLoadedConfirmed).toBe(false);
  });

  it('Test 5: Real execution acceptance requires a real inference round-trip beyond /v1/models HTTP 200', async () => {
    const brokenInferenceFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'qwen-agentworld-35b-a3b', state: 'loaded' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: 'VRAM engine failed' }), { status: 500 });
    };

    const broken = await qualifyRuntimeEndpoint({
      runtimeId: 'dgx_spark:lmstudio',
      runtimeType: 'lmstudio',
      endpointUrl: 'http://100.113.62.112:1234/v1',
      targetModelId: 'qwen-agentworld-35b-a3b',
      runRealInference: true,
      fetchImpl: brokenInferenceFetch,
    });
    expect(broken.state).toBe('DEGRADED');
    expect(broken.state).not.toBe('EXECUTION_VERIFIED');

    const healthyFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/models') || url.includes('/api/v0/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'qwen-agentworld-35b-a3b', state: 'loaded' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        const fnName = body.tools[0]?.function?.name ?? 'wazir_ping_tool';
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: fnName, arguments: JSON.stringify({ echo: 'ok', ping: 'ok' }) },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'READY_OK' } }],
          usage: { completion_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const verified = await qualifyRuntimeEndpoint({
      runtimeId: 'dgx_spark:lmstudio',
      runtimeType: 'lmstudio',
      endpointUrl: 'http://100.113.62.112:1234/v1',
      targetModelId: 'qwen-agentworld-35b-a3b',
      runRealInference: true,
      requireToolCalling: true,
      fetchImpl: healthyFetch,
    });
    expect(verified.state).toBe('EXECUTION_VERIFIED');
    expect(verified.evidence.responseContractValid).toBe(true);
    expect(verified.evidence.toolCallPassed).toBe(true);
  });

  it('Test 6: Secondary stopped runtime (e.g. stopped local Ollama) does not mark host unhealthy when LM Studio is healthy', () => {
    const hostEval = evaluateHostAcceptanceFromRuntimes([
      {
        state: 'EXECUTION_VERIFIED',
        role: 'primary',
        affectsHostHealth: true,
        installedModelIds: ['mlx-community/qwen3.5-9b'],
        loadedModelIds: ['mlx-community/qwen3.5-9b'],
        diagnosticMessage: 'LM Studio healthy',
        evidence: {
          evidenceId: 'ev-1',
          runtimeId: 'macbook_pro:lmstudio',
          hostId: 'macbook_pro',
          endpointUrl: 'http://127.0.0.1:1234/v1',
          state: 'EXECUTION_VERIFIED',
          connectivityOk: true,
          modelsEnumerated: true,
          modelLoadedConfirmed: true,
          inferenceExecuted: true,
          responseContractValid: true,
          toolCallTested: false,
          cancellationTested: false,
          verifiedAt: new Date().toISOString(),
        },
      },
      {
        state: 'UNAVAILABLE',
        role: 'secondary',
        affectsHostHealth: false,
        installedModelIds: [],
        loadedModelIds: [],
        diagnosticMessage: 'Ollama stopped on :11434',
        evidence: {
          evidenceId: 'ev-2',
          runtimeId: 'macbook_pro:ollama',
          hostId: 'macbook_pro',
          endpointUrl: 'http://127.0.0.1:11434',
          state: 'UNAVAILABLE',
          connectivityOk: false,
          modelsEnumerated: false,
          modelLoadedConfirmed: false,
          inferenceExecuted: false,
          responseContractValid: false,
          toolCallTested: false,
          cancellationTested: false,
          verifiedAt: new Date().toISOString(),
          error: 'ECONNREFUSED',
        },
      },
    ]);

    expect(hostEval.hostAcceptanceState).toBe('EXECUTION_VERIFIED');
    expect(hostEval.healthyPrimaryRuntimeIds).toEqual(['macbook_pro:lmstudio']);
    expect(hostEval.ignoredSecondaryRuntimeIds).toEqual(['macbook_pro:ollama']);
  });

  it('Test 7: Concurrency qualification establishes empirical safe concurrency and halts cleanly on saturation', async () => {
    const cq = await qualifyRuntimeConcurrency({
      runtimeId: 'mac_studio:lmstudio',
      hostId: 'mac_studio',
      endpointUrl: 'http://127.0.0.1:1235/v1',
      modelId: 'qwen-agentworld-35b-a3b',
      maxConcurrencyBound: 5,
      executeProbe: async ({ level }) => {
        if (level <= 3) {
          return { ok: true, latencyMs: 180 + level * 20, outputTokens: 12 };
        }
        return { ok: false, status: 429, latencyMs: 50, error: 'HTTP 429 queue saturated' };
      },
    });

    expect(cq.verifiedSafeConcurrency).toBe(3);
    expect(cq.recoveredAfterLoad).toBe(true);
    expect(cq.state).toBe('CAPACITY_VERIFIED');
  });

  it('Test 8: Disabled provider enforcement guarantees 0% Claude under normal, saturated, and failover conditions', async () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const fs5_20 = parseExecutionPlanYamlOrJson(
      fs.readFileSync(path.join(repoRoot, 'examples/fs5.yaml'), 'utf8'),
    );
    const fs5_100 = parseExecutionPlanYamlOrJson(
      fs.readFileSync(path.join(repoRoot, 'examples/fs5-100.yaml'), 'utf8'),
    );

    const alloc20 = apportionAgentsLargestRemainder(fs5_20);
    expect(alloc20.byPool['dgx_spark'].allocatedAgents).toBe(7);
    expect(alloc20.byPool['mac_studio'].allocatedAgents).toBe(5);
    expect(alloc20.byPool['macbook_pro'].allocatedAgents).toBe(2);
    expect(alloc20.byPool['antigravity'].allocatedAgents).toBe(5);
    expect(alloc20.byPool['codex'].allocatedAgents).toBe(1);
    expect(alloc20.byPool['claude'].allocatedAgents).toBe(0);

    const alloc100 = apportionAgentsLargestRemainder(fs5_100);
    expect(alloc100.byPool['dgx_spark'].allocatedAgents).toBe(35);
    expect(alloc100.byPool['mac_studio'].allocatedAgents).toBe(25);
    expect(alloc100.byPool['macbook_pro'].allocatedAgents).toBe(10);
    expect(alloc100.byPool['antigravity'].allocatedAgents).toBe(25);
    expect(alloc100.byPool['codex'].allocatedAgents).toBe(5);
    expect(alloc100.byPool['claude'].allocatedAgents).toBe(0);

    const speed100 = optimizeAgentAllocationForSpeed({
      plan: fs5_100,
      requestedAgents: 100,
      verifiedTotalConcurrency: 16,
    });
    expect(speed100.speedOptimizedActiveAgents).toBeLessThanOrEqual(32);
    expect(speed100.byPool['claude'].activeAgentIds).toHaveLength(0);

    const ctrl = new DistributedExecutionController({
      store: new MemoryStore(),
      plan: fs5_20,
      verifiedSafeConcurrencyByPool: {
        dgx_spark: 5,
        mac_studio: 3,
        macbook_pro: 2,
        antigravity: 4,
        codex: 2,
        claude: 0,
      },
    });
    await ctrl.initialize();
    await expect(
      ctrl.submitTasks([
        {
          assignedPoolId: 'claude',
          profile: classifyTaskRequirements({ taskId: 'illegal-claude', title: 'Test', prompt: 'Test' }),
        },
      ]),
    ).rejects.toThrow(/disabled pool 'claude'/i);
  });

  it('Test 9: Saturation and queueing keeps excess agents queued when 20 agents target 16 concurrent slots', async () => {
    const plan = createDefaultFs5ExecutionPlan({ totalAgents: 20, speedOptimization: false });
    const ctrl = new DistributedExecutionController({
      store: new MemoryStore(),
      plan,
      verifiedSafeConcurrencyByPool: {
        dgx_spark: 5,
        mac_studio: 3,
        macbook_pro: 2,
        antigravity: 4,
        codex: 2,
        claude: 0,
      },
    });
    await ctrl.initialize();

    const alloc = apportionAgentsLargestRemainder(plan);
    const submissions = Object.entries(alloc.byPool).flatMap(([poolId, info]) =>
      info.logicalAgentIds.map((agentId) => ({
        assignedPoolId: poolId,
        logicalAgentId: agentId,
        profile: classifyTaskRequirements({
          taskId: `t-${agentId}`,
          title: `Work ${agentId}`,
          prompt: `Execute shard ${agentId}`,
        }),
      })),
    );
    await ctrl.submitTasks(submissions);

    for (const poolId of ['dgx_spark', 'mac_studio', 'macbook_pro', 'antigravity', 'codex']) {
      for (let i = 0; i < 10; i++) {
        await ctrl.claimTask({
          poolId,
          workerId: `w-${poolId}-${i}`,
          runtimeId: `${poolId}:runtime`,
          modelId: 'qwen-agentworld-35b-a3b',
        });
      }
    }

    // FS5 20-agent allocation (7, 5, 2, 5, 1, 0) against pool caps (5, 3, 2, 4, 2, 0):
    // Running = min(7,5)+min(5,3)+min(2,2)+min(5,4)+min(1,2)+0 = 5+3+2+4+1+0 = 15 running, 5 queued!
    const quantities = await ctrl.getAllPoolQuantities();
    const totalRunning = Object.values(quantities).reduce((s, q) => s + q.runningAgents, 0);
    const totalQueued = Object.values(quantities).reduce((s, q) => s + q.queuedAgents, 0);
    expect(totalRunning).toBe(15);
    expect(totalQueued).toBe(5);
    expect(quantities['dgx_spark'].runningAgents).toBe(5);
    expect(quantities['dgx_spark'].queuedAgents).toBe(2);
    expect(quantities['claude'].runningAgents).toBe(0);
  });

  it('Test 10: Mid-execution worker failure expires lease, fences stale worker via epoch, and recovers task on healthy pool', async () => {
    const graph = buildReferenceFs5Graph();
    const plan = createDefaultFs5ExecutionPlan({ totalAgents: 20 });
    const ctrl = new DistributedExecutionController({
      store: new MemoryStore(),
      plan,
      defaultLeaseDurationMs: 2_000,
      verifiedSafeConcurrencyByPool: {
        dgx_spark: 5,
        mac_studio: 3,
        macbook_pro: 2,
        antigravity: 4,
        codex: 2,
        claude: 0,
      },
    });
    await ctrl.initialize();

    await ctrl.submitTasks([
      {
        assignedPoolId: 'mac_studio',
        logicalAgentId: 'M01',
        profile: classifyTaskRequirements({
          taskId: 'task-m01',
          title: 'Implement parser',
          prompt: 'Implement parser',
        }),
      },
    ]);

    const t0 = '2026-11-13T16:00:00.000Z';
    const firstClaim = await ctrl.claimTask({
      poolId: 'mac_studio',
      workerId: 'worker-studio-1',
      runtimeId: 'mac_studio:lmstudio',
      modelId: 'qwen-agentworld-35b-a3b',
      leaseDurationMs: 2_000,
      nowIso: t0,
    });
    expect(firstClaim.claimed).toBe(true);
    const staleToken = firstClaim.lease!.leaseToken;
    const staleEpoch = firstClaim.lease!.epoch;

    await ctrl.saveCheckpoint({
      taskId: 'task-m01',
      leaseToken: staleToken,
      epoch: staleEpoch,
      checkpointId: 'ckpt-step-2',
      payload: { filesDrafted: ['src/parser.ts'] },
      nowIso: '2026-11-13T16:00:01.000Z',
    });

    // Lease expires at t0 + 5s -> task is requeued and epoch bumped
    const swept = await ctrl.sweepExpiredLeases({
      nowIso: '2026-11-13T16:00:05.000Z',
    });
    expect(swept.expiredTaskIds).toContain('task-m01');

    // Mac Studio goes offline -> failover reroutes task-m01 to a healthy pool (never claude!)
    const failover = await ctrl.markPoolUnavailableAndFailover({
      poolId: 'mac_studio',
      reason: 'SSH tunnel disconnected',
      graph,
      nowIso: '2026-11-13T16:00:05.500Z',
    });
    expect(failover.reroutedTaskIds).toContain('task-m01');
    const targetPool = failover.reroutedToPoolByTaskId['task-m01'];
    expect(targetPool).toBeDefined();
    expect(targetPool).not.toBe('claude');

    const secondClaim = await ctrl.claimTask({
      poolId: targetPool,
      workerId: 'worker-recovery-1',
      runtimeId: `${targetPool}:lmstudio`,
      modelId: 'qwen-agentworld-35b-a3b',
      nowIso: '2026-11-13T16:00:06.000Z',
    });
    expect(secondClaim.claimed).toBe(true);
    expect(secondClaim.lease!.epoch).toBeGreaterThan(staleEpoch);
    expect(secondClaim.resumeCheckpoint?.checkpointId).toBe('ckpt-step-2');

    // Late write from zombie worker-studio-1 with stale epoch/token is fenced and rejected!
    const zombieComplete = await ctrl.completeTask({
      taskId: 'task-m01',
      leaseToken: staleToken,
      epoch: staleEpoch,
      outputSummary: 'stale zombie result',
      verificationPassed: true,
    });
    expect(zombieComplete.accepted).toBe(false);
    expect(zombieComplete.reason).toBe('FENCED_STALE_LEASE_OR_EPOCH');

    const validComplete = await ctrl.completeTask({
      taskId: 'task-m01',
      leaseToken: secondClaim.lease!.leaseToken,
      epoch: secondClaim.lease!.epoch,
      idempotencyKey: 'idem-task-m01-final',
      outputSummary: 'recovered parser result',
      verificationPassed: true,
      verificationEvidenceId: 'ev-ok-1',
    });
    expect(validComplete.accepted).toBe(true);
    expect(validComplete.receiptHash).toMatch(/^[a-f0-9]{64}$/);

    // Duplicate retry with same idempotencyKey does not double-count completions
    const replayComplete = await ctrl.completeTask({
      taskId: 'task-m01',
      leaseToken: secondClaim.lease!.leaseToken,
      epoch: secondClaim.lease!.epoch,
      idempotencyKey: 'idem-task-m01-final',
      outputSummary: 'recovered parser result',
      verificationPassed: true,
      verificationEvidenceId: 'ev-ok-1',
    });
    expect(replayComplete.accepted).toBe(true);
    expect(replayComplete.idempotentDuplicate).toBe(true);
  });

  it('Test 11: Stale inventory invalidation updates routing without deleting Last-Known-Good physical host inventory', () => {
    const plan = createDefaultFs5ExecutionPlan({ totalAgents: 20 });
    const reconciler = new MetaHarnessReconciler({ plan, minConsecutiveFailures: 1 });
    const initialGraph = buildReferenceFs5Graph();

    const snap1 = reconciler.reconcile({ graph: initialGraph });
    expect(snap1.discovered.onlineHostIds).toContain('mac_studio');

    const degradedGraph = structuredClone(initialGraph);
    delete degradedGraph.hosts['mac_studio'];
    degradedGraph.endpoints['ep:studio:lms'].acceptanceState = 'UNAVAILABLE';

    const merged = reconciler.getMergedInventoryGraph(degradedGraph);
    expect(merged.hosts['mac_studio']).toBeDefined();
    expect(reconciler.getLastKnownGoodHost('mac_studio')?.host.machineId).toBe('mach-studio-m4-max');

    const snap2 = reconciler.reconcile({ graph: degradedGraph });
    expect(snap2.discovered.unreachableHostIds).toContain('mac_studio');
    expect(snap2.verified.verifiedConcurrencyByPool['mac_studio']).toBe(0);
    expect(snap2.detectedEvents.length).toBeGreaterThan(0);
  });

  it('Test 12: Independent deliverable verification catches false producing-agent success claims when tests fail', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-accept12-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'broken.mjs'), 'export const add = (a, b) => a - b;\n', 'utf8');
      fs.writeFileSync(
        path.join(tmpDir, 'broken.test.mjs'),
        `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './broken.mjs';\ntest('adds numbers', () => { assert.equal(add(2, 3), 5); });\n`,
        'utf8',
      );

      const res = await verifyDeliverableIndependently({
        producingAgentId: 'agent-D01',
        verifierId: 'independent-verifier-X01',
        agentSelfReportedSuccess: true,
        workspaceDir: tmpDir,
        expectedArtifacts: [{ relativePath: 'broken.mjs', minBytes: 5 }],
        verificationCommands: [
          {
            id: 'run-node-test',
            command: process.execPath,
            args: ['--test', 'broken.test.mjs'],
            expectedExitCode: 0,
          },
        ],
      });

      expect(res.trustedProducingAgentSelfReport).toBe(false);
      expect(res.passed).toBe(false);
      expect(res.checks.commandExecution.passed).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Test 13 & Test 14: Autonomous defect repair fixes reproducible bug AND anti-oracle-weakening rejects test tampering', async () => {
    const tamperedDiffFindings = detectOracleWeakening(
      'packages/core/tests/feature.test.ts',
      `it('validates sum', () => {\n  expect(sum(2, 3)).toBe(5);\n});\n`,
      `it.skip('validates sum', () => {\n  expect(sum(2, 3)).toBeTruthy();\n});\n`,
    );
    expect(tamperedDiffFindings.length).toBeGreaterThan(0);

    const repairOutcome = await runAutonomousRepairCycle(
      {
        failureId: 'fail-off-by-one',
        errorMessage: 'AssertionError: expected 4 to equal 5 in sum(2, 3)',
        failingCommand: 'node --test math.test.mjs',
        testExitCode: 1,
        verificationCriteriaBefore: ['sum(2, 3) === 5'],
        fileSnapshotsBefore: {
          'src/math.mjs': 'export const sum = (a, b) => a + b - 1;\n',
          'tests/math.test.mjs': 'assert.equal(sum(2, 3), 5);\n',
        },
      },
      {
        reproduceFailure: async () => ({ reproduced: true, detail: 'Confirmed exit code 1' }),
        proposePatch: async (_snap, _diag, attemptNumber) => {
          if (attemptNumber === 1) {
            return {
              patchId: 'patch-cheat-1',
              producingAgentId: 'agent-D02',
              summary: 'Skip failing test',
              rootCauseAddressed: 'Skipped test',
              fileChanges: [
                {
                  relativePath: 'tests/math.test.mjs',
                  before: 'test("sum", () => { assert.equal(sum(2, 3), 5); });\n',
                  after: 'test.skip("sum", () => { assert.equal(sum(2, 3), 5); });\n',
                },
              ],
            };
          }
          return {
            patchId: 'patch-legit-2',
            producingAgentId: 'agent-A01',
            summary: 'Fix off-by-one in sum()',
            rootCauseAddressed: 'Removed erroneous - 1 in sum()',
            fileChanges: [
              {
                relativePath: 'src/math.mjs',
                before: 'export const sum = (a, b) => a + b - 1;\n',
                after: 'export const sum = (a, b) => a + b;\n',
              },
            ],
            regressionTestFile: {
              relativePath: 'tests/math.regression.test.mjs',
              before: null,
              after:
                'import assert from "node:assert/strict"; import { sum } from "../src/math.mjs"; assert.equal(sum(2, 3), 5);\n',
            },
            proposedVerificationCriteria: ['sum(2, 3) === 5'],
          };
        },
        verifyPatchIndependently: async (patch) => ({
          passed: patch.patchId === 'patch-legit-2',
          verifierId: 'independent-verifier-X01',
          evidenceSummary: 'node --test math.test.mjs exited 0',
        }),
        runRegressionTests: async () => ({
          passed: true,
          totalTestsRun: 4,
          failedTests: 0,
          newRegressionTestIncluded: true,
          summary: '4/4 passed including new regression test',
        }),
      },
      { maxRepairAttempts: 3, requireNewRegressionTestForProductDefect: true },
    );

    expect(repairOutcome.attempts).toHaveLength(2);
    expect(repairOutcome.attempts[0].decision).toBe('REJECTED_ORACLE_WEAKENING');
    expect(repairOutcome.attempts[1].decision).toBe('ACCEPTED');
    expect(repairOutcome.decision).toBe('ACCEPTED');
    expect(inspectPatchForOracleWeakening).toBeDefined();
  });

  it('Test 15: Multi-machine end-to-end execution, cost separation, hard constraints, NL intents, and honest reporting', async () => {
    const graph = buildReferenceFs5Graph();
    const plan = createDefaultFs5ExecutionPlan({ totalAgents: 20 });

    const configOnly = buildConfigurationReportJson(plan);
    expect(configOnly.reportMode).toBe('CONFIGURATION_ONLY');
    expect(configOnly.qualification.status).toBe('PENDING_LIVE_VERIFICATION');
    expect(configOnly.pools['dgx_spark'].observed).toBeUndefined();

    const constraints = parseHardUserConstraints([
      'Do not use Claude',
      'Use only local machines',
      'Keep 35% of agents on DGX',
      'Do not interrupt Isaac Sim',
      'Never send this repository to a cloud agent',
      'Use Qwen unless the task requires another model',
    ]);
    expect(constraints.disabledProviders).toContain('claude');
    expect(constraints.localMachinesOnly).toBe(true);
    expect(constraints.neverSendRepoToCloud).toBe(true);
    expect(constraints.preferredModelFamily).toBe('qwen');
    expect(constraints.pinnedPoolShares['dgx_spark']).toBe(35);

    const scheduler = new IntelligentHardwareScheduler();
    const codingProfile = classifyTaskRequirements({
      taskId: 'task-feat-1',
      title: 'Implement TypeScript validator',
      prompt: 'Write a TypeScript module and unit tests',
      dataSensitivity: 'restricted_local_only',
    });
    const decision = scheduler.scheduleTask(codingProfile, plan, graph, {
      strategyOverride: 'local_first',
      additionalConstraints: ['Use only local machines', 'Do not use Claude'],
    });
    expect(decision.scheduled).toBe(true);
    expect(decision.selectedRoute?.poolId).toBeDefined();
    expect(['dgx_spark', 'mac_studio', 'macbook_pro']).toContain(decision.selectedRoute?.poolId);
    expect(decision.selectedRoute?.poolId).not.toBe('claude');

    const guardBlocked = enforceWorkerSecurityGuard({
      workspaceRoot: os.tmpdir(),
      targetKind: 'cloud_provider',
      providerId: 'codex',
      taskProfile: codingProfile,
      constraints,
    });
    expect(guardBlocked.allowed).toBe(false);

    const expectedIntents: Array<[string, string]> = [
      ['Discover my machines.', 'DISCOVER_MACHINES'],
      ['What GPUs do I have available?', 'QUERY_GPUS'],
      ['Which machine is best for running a 35B model?', 'BEST_HOST_FOR_MODEL'],
      ['What models are installed across my network?', 'LIST_NETWORK_MODELS'],
      ['Which machines can accept additional agents?', 'AVAILABLE_AGENT_CAPACITY'],
      ['What is currently executing on my DGX?', 'INSPECT_HOST_EXECUTION'],
      ['Find all available Ollama and LM Studio servers.', 'FIND_INFERENCE_SERVERS'],
      ['Can I execute 100 agents using my current infrastructure?', 'CHECK_SCALE_FEASIBILITY'],
      ['Which hardware is idle?', 'FIND_IDLE_HARDWARE'],
      ['Optimize my distributed execution for cost.', 'OPTIMIZE_FOR_COST'],
      ['Route coding tasks to local Qwen models and use cloud agents only when necessary.', 'CONFIGURE_ROUTING_POLICY'],
      ['Distribute 20 agents using FS5.', 'DISTRIBUTE_PLAN'],
      ['Did it work?', 'VERIFY_EXECUTION'],
      ['Improve the execution.', 'IMPROVE_EXECUTION'],
    ];
    for (const [prompt, expected] of expectedIntents) {
      expect(classifyMetaHarnessIntent(prompt).intent).toBe(expected);
    }

    const ranked35B = findBestHostsForModelSize(graph, 35);
    expect(ranked35B[0].hostId).toBe('dgx_spark');
    expect(ranked35B[0].fits).toBe(true);

    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-accept15-repo-'));
    try {
      const store = new MemoryStore();
      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url.includes('/models') || url.includes('/api/tags') || url.includes('/api/ps')) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'qwen-agentworld-35b-a3b', state: 'loaded' },
                { id: 'mlx-community/qwen3.5-9b', state: 'loaded' },
              ],
              models: [{ name: 'qwen3-coder:30b' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Shard verified OK.' } }],
            usage: { completion_tokens: 6 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      };

      const svc = new MetaHarnessService({
        store,
        projectRoot: tmpRepo,
        fetchImpl: mockFetch,
        hostDiscoveryDriver: {
          discoverLocalHost: async () => ({
            ...graph.hosts['macbook_pro'],
            reachable: true,
          }),
          discoverSshHost: async ({ hostId }) => ({
            ...(hostId === 'dgx_spark' ? graph.hosts['dgx_spark'] : graph.hosts['mac_studio']),
            reachable: true,
          }),
        },
      });

      await svc.discoverInfrastructure({ testRealInference: true });
      const feat = await svc.implementFeatureAcrossFleet(
        'Implement a multi-file FS5 share allocator in a disposable test repository',
        { workspaceDir: tmpRepo },
      );
      expect(feat.verification.passed).toBe(true);
      expect(feat.changedFiles.length).toBeGreaterThanOrEqual(4);
      const distinctHosts = new Set(feat.agentProvenance.map((p) => p.hostId));
      expect(distinctHosts.size).toBeGreaterThanOrEqual(2);

      const metrics = summarizeObservedExecutionMetrics({
        observations: feat.agentProvenance.map((p) => ({
          taskId: p.logicalAgentId,
          poolId: p.poolId,
          hostId: p.hostId,
          runtimeId: p.runtimeId,
          modelId: p.modelId,
          modelResidency: 'loaded',
          taskType: 'coding',
          succeeded: true,
          independentlyVerified: true,
          latencyMs: p.latencyMs,
          queueWaitMs: 0,
          operationalOverheadMs: 5,
          cloudCostUsd: 0,
          localGpuUtilizationPct: 50,
        })),
      });
      expect(metrics.costBreakdown.cloudProviderCostUsd).toBe(0);
      expect(metrics.costBreakdown.sovereignLocalCompletionSharePct).toBe(100);

      const liveReport = await svc.getExecutionReport();
      expect(liveReport.reportMode).toBe('LIVE_OBSERVED_EXECUTION');
      expect(liveReport.pools['claude'].assigned_agents).toBe(0);
      expect(buildServerAcceptanceTable({ graph, plan }).find((r) => r.pool === 'claude')?.status).toBe(
        'DISABLED_BY_POLICY',
      );
      expect(buildLiveExecutionReportJson).toBeDefined();
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});
