import { describe, it, expect } from 'vitest';
import {
  AgentRegistry,
  ComputerRegistry,
  ModelRegistry,
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
  SchedulingError,
} from '../src/index.js';

function setupFleet() {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const policy = new PolicyEngine();

  // 1. macOS ARM64 Worker (Apple Silicon M3 Max)
  computers.register({
    id: 'mac-studio',
    name: 'Mac Studio M3 Max',
    type: 'workstation',
    local: false,
    os: { platform: 'darwin', architecture: 'arm64', version: '14.5' },
    hardware: {
      cpu: 'Apple M3 Max',
      cpuCores: 16,
      memoryGB: 64,
      gpu: { vendor: 'apple', model: 'Apple M3 Max GPU', memoryGB: 64, unifiedMemory: true },
    },
    capabilities: ['localExecution'],
  });
  runtimes.register({
    id: 'runtime-mac',
    type: 'ollama',
    name: 'Ollama macOS',
    version: '0.3.0',
    computerId: 'mac-studio',
    capabilities: {
      chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: true,
      embeddings: true, reasoning: true, modelLoad: true, modelUnload: true, modelDownload: true,
      statefulChat: false, mcp: true,
    },
  });

  // 2. Windows x64 Worker (Intel i9 + RTX 4090)
  computers.register({
    id: 'win-workstation',
    name: 'Windows Workstation',
    type: 'workstation',
    local: false,
    os: { platform: 'win32', architecture: 'x64', version: '10.0.22631' },
    hardware: {
      cpu: 'Intel Core i9-14900K',
      cpuCores: 24,
      memoryGB: 64,
      gpu: { vendor: 'nvidia', model: 'NVIDIA GeForce RTX 4090', memoryGB: 24, cuda: true },
    },
    capabilities: ['localExecution'],
  });
  runtimes.register({
    id: 'runtime-win',
    type: 'lmstudio',
    name: 'LM Studio Windows',
    version: '0.2.20',
    computerId: 'win-workstation',
    capabilities: {
      chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false,
      embeddings: true, reasoning: true, modelLoad: true, modelUnload: true, modelDownload: true,
      statefulChat: false, mcp: false,
    },
  });

  // 3. Linux ARM64 NVIDIA DGX Spark Worker (Grace Blackwell GB10, ATS + C2C unified memory)
  computers.register({
    id: 'dgx-spark',
    name: 'NVIDIA DGX Spark Station',
    type: 'workstation',
    local: false,
    os: { platform: 'linux', architecture: 'arm64', version: '7.0.0-1019-nvidia' },
    hardware: {
      cpu: 'Cortex-X925',
      cpuCores: 20,
      memoryGB: 122,
      gpu: { vendor: 'nvidia', model: 'NVIDIA GB10', memoryGB: 122, unifiedMemory: true, cuda: true },
    },
    capabilities: ['localExecution'],
  });
  runtimes.register({
    id: 'runtime-dgx',
    type: 'ollama',
    name: 'Ollama DGX Spark',
    version: '0.3.0',
    computerId: 'dgx-spark',
    capabilities: {
      chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: true,
      embeddings: true, reasoning: true, modelLoad: true, modelUnload: true, modelDownload: true,
      statefulChat: false, mcp: true,
    },
  });

  // 4. Linux x64 Cloud Worker (AMD EPYC, CPU only)
  computers.register({
    id: 'linux-cpu-node',
    name: 'Linux CPU Node',
    type: 'workstation',
    local: true,
    os: { platform: 'linux', architecture: 'x64', version: '6.5.0-generic' },
    hardware: {
      cpu: 'AMD EPYC 7763',
      cpuCores: 32,
      memoryGB: 32,
    },
    capabilities: ['localExecution'],
  });
  runtimes.register({
    id: 'runtime-linux-cpu',
    type: 'ollama',
    name: 'Ollama Linux CPU',
    version: '0.3.0',
    computerId: 'linux-cpu-node',
    capabilities: {
      chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false,
      embeddings: true, reasoning: true, modelLoad: true, modelUnload: true, modelDownload: true,
      statefulChat: false, mcp: true,
    },
  });

  // Model registered on all runtimes
  models.register({
    id: 'qwen-coder-32b',
    name: 'Qwen 2.5 Coder 32B',
    provider: 'ollama',
    family: 'qwen',
    contextMax: 32_768,
    capabilities: ['coding', 'generalChat', 'analysis'],
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    runtimeCompatibility: 'any',
    local: true,
    memory: { minSystemGB: 16, minGpuGB: 16 },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Register instances across computers
  for (const [comp, run] of [
    ['mac-studio', 'runtime-mac'],
    ['win-workstation', 'runtime-win'],
    ['dgx-spark', 'runtime-dgx'],
  ] as const) {
    models.upsertInstance({
      id: `qwen-coder-32b::${comp}::${run}`,
      modelId: 'qwen-coder-32b',
      computerId: comp,
      runtimeId: run,
      runtimeModelId: 'qwen2.5-coder:32b',
      loaded: true,
      health: 'healthy',
      contextTokens: 32_768,
    });
  }

  // Linux CPU node instance with CPU offload (no GPU memory requirement satisfaction)
  models.upsertInstance({
    id: 'qwen-coder-32b::linux-cpu-node::runtime-linux-cpu',
    modelId: 'qwen-coder-32b',
    computerId: 'linux-cpu-node',
    runtimeId: 'runtime-linux-cpu',
    runtimeModelId: 'qwen2.5-coder:32b',
    loaded: true,
    health: 'healthy',
    contextTokens: 32_768,
  });

  agents.register(
    {
      descriptor: {
        name: 'coding-agent',
        version: '1.0',
        description: 'Heterogeneous coding agent',
        capabilities: ['coding'],
        requiredTools: [],
        modelRequirements: { capabilities: ['coding'] },
        permissions: [],
        taskTypes: ['coding'],
        strategy: 'standard',
      },
      async *run() { yield { kind: 'done', content: 'finished' }; },
    },
    'native',
  );

  const scheduler = new Scheduler({ computers, runtimes, models, agents, policy });
  return { computers, runtimes, models, scheduler };
}

describe('Resource-Aware Heterogeneous Scheduling', () => {
  it('routes macOS-specific task to macOS worker and records routing reasons', () => {
    const { scheduler } = setupFleet();
    const decision = scheduler.plan({
      task: {
        id: 'task-mac',
        type: 'coding',
        input: 'Compile macOS Swift app with Xcode tools',
        requirements: { os: 'darwin', minimumMemoryGB: 16 },
        priority: 'normal',
        status: 'pending',
      },
    });

    expect(decision.computerId).toBe('mac-studio');
    expect(decision.reasons.some((r) => r.includes("OS 'darwin' matches task requirements"))).toBe(true);
  });

  it('routes Windows-specific task to Windows worker', () => {
    const { scheduler } = setupFleet();
    const decision = scheduler.plan({
      task: {
        id: 'task-win',
        type: 'coding',
        input: 'Build Windows C# WPF app with MSBuild',
        requirements: { os: 'win32', minimumMemoryGB: 16 },
        priority: 'normal',
        status: 'pending',
      },
    });

    expect(decision.computerId).toBe('win-workstation');
    expect(decision.reasons.some((r) => r.includes("OS 'win32' matches task requirements"))).toBe(true);
  });

  it('routes CUDA-intensive task requiring high GPU memory to NVIDIA DGX Spark', () => {
    const { scheduler } = setupFleet();
    const decision = scheduler.plan({
      task: {
        id: 'task-dgx-cuda',
        type: 'coding',
        input: 'Fine-tune model using flash-attention and CUDA kernels',
        requirements: {
          os: 'linux',
          architecture: 'arm64',
          requiresCuda: true,
          minimumGPUMemoryGB: 60,
        },
        priority: 'high',
        status: 'pending',
      },
    });

    expect(decision.computerId).toBe('dgx-spark');
    expect(decision.reasons.some((r) => r.includes('NVIDIA CUDA acceleration active (NVIDIA GB10)'))).toBe(true);
    expect(decision.reasons.some((r) => r.includes("architecture 'arm64' matches task requirements"))).toBe(true);
  });

  it('strictly rejects scheduling incompatible workloads with explainable reasons (no silent fallback)', () => {
    const { scheduler } = setupFleet();
    // Task requires Windows OS but also requires ARM64 architecture (which our Windows workstation lacks)
    expect(() =>
      scheduler.plan({
        task: {
          id: 'task-incompatible',
          type: 'coding',
          input: 'Windows ARM64 build',
          requirements: { os: 'windows', architecture: 'arm64' },
          priority: 'normal',
          status: 'pending',
        },
      }),
    ).toThrow(SchedulingError);

    try {
      scheduler.plan({
        task: {
          id: 'task-incompatible-2',
          type: 'coding',
          input: 'Windows ARM64 build',
          requirements: { os: 'windows', architecture: 'arm64' },
          priority: 'normal',
          status: 'pending',
        },
      });
    } catch (err: any) {
      expect(err.message).toContain('No computer can host model');
      expect(err.message).toContain('No silent fallback will be performed');
    }
  });

  it('rejects scheduling on a machine lacking required CUDA capability', () => {
    const { scheduler } = setupFleet();
    // Requires macOS but also requires CUDA (Apple Silicon does not have CUDA)
    expect(() =>
      scheduler.plan({
        task: {
          id: 'task-mac-cuda',
          type: 'coding',
          input: 'CUDA on macOS',
          requirements: { os: 'macos', requiresCuda: true },
          priority: 'normal',
          status: 'pending',
        },
      }),
    ).toThrow(SchedulingError);
  });

  it('routes platform-neutral task to eligible worker based on resources, load, and hardware acceleration', () => {
    const { scheduler, computers } = setupFleet();
    // Set load on win-workstation
    computers.heartbeat('win-workstation', { load: { cpuPercent: 90, memoryUsedGB: 50, memoryAvailableGB: 14 } });
    // mac-studio has lower load
    computers.heartbeat('mac-studio', { load: { cpuPercent: 10, memoryUsedGB: 16, memoryAvailableGB: 48 } });

    const decision = scheduler.plan({
      task: {
        id: 'task-neutral',
        type: 'coding',
        input: 'Implement an algorithm in pure TypeScript',
        requirements: { minimumMemoryGB: 16 },
        priority: 'normal',
        status: 'pending',
      },
    });

    expect(['mac-studio', 'dgx-spark']).toContain(decision.computerId);
    expect(decision.reasons.length).toBeGreaterThan(0);
  });
});
