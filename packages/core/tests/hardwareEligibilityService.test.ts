import { describe, it, expect } from 'vitest';
import {
  HardwareEligibilityService,
  isUnifiedMemoryArchitecture,
  isNvidiaGpuArchitecture,
  isDiscreteGpuArchitecture,
  determineDeviceKind,
} from '../src/services/hardwareEligibilityService.js';
import type { Computer } from '../src/types/computer.js';
import type { ModelRecord, ModelInstance } from '../src/types/model.js';
import type { ResourceReservation } from '../src/types/modelLifecycle.js';

describe('HardwareEligibilityService', () => {
  const service = new HardwareEligibilityService();

  const createModel = (overrides: Partial<ModelRecord> = {}): ModelRecord => ({
    id: 'test-model',
    name: 'Test Model',
    provider: 'local',
    family: 'qwen',
    contextMax: 32768,
    capabilities: ['generalChat'],
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: false,
    runtimeCompatibility: 'any',
    local: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  const createComputer = (overrides: Partial<Computer> = {}): Computer => ({
    id: 'comp-1',
    name: 'Test Computer',
    type: 'workstation',
    status: 'online',
    local: true,
    health: 'healthy',
    os: { platform: 'darwin', architecture: 'arm64', version: '14.5' },
    hardware: {
      cpu: 'Apple M3',
      cpuCores: 12,
      memoryGB: 36,
      gpu: {
        vendor: 'apple',
        model: 'Apple M3',
        memoryGB: 36,
        unifiedMemory: true,
      },
    },
    load: {
      cpuPercent: 20,
      memoryUsedGB: 16,
      memoryAvailableGB: 20,
      gpuMemoryAvailableGB: 20,
    },
    runtimes: ['ollama', 'mlx'],
    models: [],
    capabilities: ['gpu', 'apple-silicon'],
    runtimeHealth: {},
    modelHealth: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  describe('Architecture Classification', () => {
    it('detects Apple Silicon unified memory correctly', () => {
      const appleMac = createComputer();
      expect(isUnifiedMemoryArchitecture(appleMac)).toBe(true);
      expect(determineDeviceKind(appleMac)).toBe('apple_unified');

      const intelMac = createComputer({
        os: { platform: 'darwin', architecture: 'x86_64', version: '13.0' },
        hardware: {
          cpu: 'Intel Core i9',
          cpuCores: 8,
          memoryGB: 32,
          gpu: { vendor: 'amd', model: 'Radeon Pro 5500M', memoryGB: 8, unifiedMemory: false },
        },
      });
      expect(isUnifiedMemoryArchitecture(intelMac)).toBe(false);
      expect(determineDeviceKind(intelMac)).toBe('discrete_gpu');
    });

    it('detects NVIDIA discrete GPU vs CPU-only', () => {
      const nvidiaBox = createComputer({
        os: { platform: 'linux', architecture: 'x86_64', version: '6.5' },
        hardware: {
          cpu: 'AMD Ryzen 9',
          cpuCores: 16,
          memoryGB: 64,
          gpu: { vendor: 'nvidia', model: 'RTX 4090', memoryGB: 24, cuda: true },
        },
      });
      expect(isNvidiaGpuArchitecture(nvidiaBox)).toBe(true);
      expect(determineDeviceKind(nvidiaBox)).toBe('nvidia_gpu');

      const cpuBox = createComputer({
        os: { platform: 'linux', architecture: 'x86_64', version: '6.5' },
        hardware: {
          cpu: 'AMD EPYC',
          cpuCores: 32,
          memoryGB: 128,
        },
      });
      expect(isNvidiaGpuArchitecture(cpuBox)).toBe(false);
      expect(isDiscreteGpuArchitecture(cpuBox)).toBe(false);
      expect(determineDeviceKind(cpuBox)).toBe('cpu_only');
    });
  });

  describe('Apple Silicon Unified Memory (No Double Counting)', () => {
    it('does not double count available memory by summing RAM and VRAM', () => {
      // 36GB unified machine with 20GB available reported on both memoryAvailableGB and gpuMemoryAvailableGB
      const mac = createComputer({
        load: {
          cpuPercent: 10,
          memoryUsedGB: 16,
          memoryAvailableGB: 20,
          gpuMemoryAvailableGB: 20,
        },
      });

      const model = createModel({
        id: 'large-model-25gb',
        memory: { minGpuGB: 25 },
      });

      // If naively summed 20GB RAM + 20GB VRAM = 40GB, a 25GB model would be mistakenly admitted.
      // Under unified memory architecture, available memory is strictly 20GB from the single unified pool!
      const result = service.assessDeviceForModel({ model, computer: mac });
      expect(result.unifiedMemory).toBe(true);
      expect(result.deviceKind).toBe('apple_unified');
      expect(result.availableMemoryGB).toBe(20);
      expect(result.totalMemoryGB).toBe(36);
      expect(result.eligible).toBe(false);
      expect(result.rejectionReasons.some((r) => r.includes('exceeds available unified memory'))).toBe(true);
    });

    it('does not double subtract model requirements (minSystemGB and minGpuGB) on unified memory', () => {
      // Model specifies 14GB system and 14GB GPU (representing the same weights in unified RAM)
      const mac = createComputer({
        load: {
          cpuPercent: 10,
          memoryUsedGB: 16,
          memoryAvailableGB: 18,
        },
      });

      const model = createModel({
        id: 'model-14gb',
        memory: { minSystemGB: 14, minGpuGB: 14 },
      });

      // Naive addition would require 14 + 14 = 28GB (which would fail on 18GB available).
      // Unified memory must take max(minSystemGB, minGpuGB) = 14GB, which fits cleanly in 18GB!
      const result = service.assessDeviceForModel({ model, computer: mac });
      expect(result.unifiedMemory).toBe(true);
      expect(result.requiredMemoryGB).toBe(14);
      expect(result.availableMemoryGB).toBe(18);
      expect(result.eligible).toBe(true);
    });

    it('does not double count reservations that report both memoryBytes and vramBytes on unified memory', () => {
      // Unsettled reservation of 10GB that populated both memoryBytes and vramBytes
      const reservation: ResourceReservation = {
        id: 'res-1',
        instanceId: 'inst-1',
        memoryBytes: 10 * 1024 ** 3,
        vramBytes: 10 * 1024 ** 3,
        createdAt: new Date(),
      };

      const mac = createComputer({
        load: {
          cpuPercent: 10,
          memoryUsedGB: 16,
          memoryAvailableGB: 20,
        },
        reservations: [reservation],
      });

      const model = createModel({
        id: 'model-8gb',
        memory: { minGpuGB: 8 },
      });

      // Available: 20GB. Reserved: 10GB (not 20GB). Net available: 10GB.
      // Required 8GB <= 10GB -> eligible!
      const result = service.assessDeviceForModel({ model, computer: mac });
      expect(result.reservedMemoryGB).toBe(10);
      expect(result.availableMemoryGB).toBe(10);
      expect(result.eligible).toBe(true);
    });
  });

  describe('NVIDIA Discrete VRAM vs System RAM', () => {
    const nvidiaServer = createComputer({
      id: 'gpu-server',
      os: { platform: 'linux', architecture: 'x86_64', version: '6.5' },
      hardware: {
        cpu: 'Intel Xeon',
        cpuCores: 24,
        memoryGB: 64, // 64GB System RAM
        gpu: {
          vendor: 'nvidia',
          model: 'RTX 4090',
          memoryGB: 24, // 24GB discrete VRAM
          cuda: true,
        },
      },
      load: {
        cpuPercent: 15,
        memoryUsedGB: 16,
        memoryAvailableGB: 48, // 48GB available system RAM
        gpuMemoryUsedGB: 8,
        gpuMemoryAvailableGB: 16, // 16GB available discrete VRAM
      },
    });

    it('enforces GPU VRAM separately from System RAM and does not confuse them', () => {
      const modelNeeding20GBVram = createModel({
        id: 'weights-20gb',
        memory: { minGpuGB: 20 },
      });

      // Available VRAM is 16GB, available System RAM is 48GB.
      // The 20GB model must NOT be admitted just because System RAM (48GB) has room!
      const result = service.assessDeviceForModel({
        model: modelNeeding20GBVram,
        computer: nvidiaServer,
      });

      expect(result.unifiedMemory).toBe(false);
      expect(result.deviceKind).toBe('nvidia_gpu');
      expect(result.totalMemoryGB).toBe(24);
      expect(result.availableMemoryGB).toBe(16);
      expect(result.requiredMemoryGB).toBe(20);
      expect(result.eligible).toBe(false);
      expect(result.rejectionReasons.some((r) => r.includes('exceeds available VRAM'))).toBe(true);
    });

    it('admits model when GPU VRAM fits', () => {
      const modelNeeding12GBVram = createModel({
        id: 'weights-12gb',
        memory: { minGpuGB: 12 },
      });

      const result = service.assessDeviceForModel({
        model: modelNeeding12GBVram,
        computer: nvidiaServer,
      });

      expect(result.availableMemoryGB).toBe(16);
      expect(result.requiredMemoryGB).toBe(12);
      expect(result.eligible).toBe(true);
    });

    it('rejects model if discrete system RAM is insufficient even if VRAM is sufficient', () => {
      const modelWithHighSysRam = createModel({
        id: 'weights-12gb-high-ram',
        memory: { minGpuGB: 12, minSystemGB: 60 },
      });

      // VRAM (12GB <= 16GB) fits, but System RAM available is 48GB < 60GB required
      const result = service.assessDeviceForModel({
        model: modelWithHighSysRam,
        computer: nvidiaServer,
      });

      expect(result.eligible).toBe(false);
      expect(result.rejectionReasons.some((r) => r.includes('exceeds available system RAM'))).toBe(true);
    });
  });

  describe('Already-Loaded vs Unloaded Model Incremental Memory', () => {
    // Model: qwen/qwen3.8-27b requiring ~22GB
    const qwenModel = createModel({
      id: 'qwen/qwen3.8-27b',
      parameters: '27B',
    });

    // Computer with only 0.1GB free RAM
    const constrainedComputer = createComputer({
      hardware: {
        cpu: 'Apple M2 Max',
        cpuCores: 12,
        memoryGB: 64,
        gpu: { vendor: 'apple', model: 'Apple M2 Max', memoryGB: 64, unifiedMemory: true },
      },
      load: {
        cpuPercent: 10,
        memoryUsedGB: 63.9,
        memoryAvailableGB: 0.1, // Only 0.1GB free RAM!
      },
    });

    it('rejects qwen/qwen3.8-27b requiring 22GB on 0.1GB free RAM when unloaded', () => {
      const unloadedInstance: ModelInstance = {
        id: 'inst-qwen',
        modelId: 'qwen/qwen3.8-27b',
        computerId: constrainedComputer.id,
        runtimeId: 'ollama',
        runtimeModelId: 'qwen3.8-27b',
        loaded: false,
        state: 'UNLOADED',
        health: 'healthy',
      };

      const result = service.assessDeviceForModel({
        model: qwenModel,
        computer: constrainedComputer,
        instance: unloadedInstance,
        requiredKvCacheGB: 0.05,
      });

      expect(result.alreadyLoaded).toBe(false);
      expect(result.availableMemoryGB).toBe(0.1);
      // Cold-load requires 22GB weights + 0.05GB KV cache = 22.05GB
      expect(result.requiredMemoryGB).toBe(22.05);
      expect(result.eligible).toBe(false);
      expect(result.fits).toBe(false);
      expect(result.shortReason).toContain('Insufficient memory');
      expect(result.shortReason).toContain('0.1');
      expect(result.reason).toContain('available memory 0.1GB < required 22');
      expect(result.rejectionReasons.some((r) => r.includes('exceeds available unified memory'))).toBe(true);
    });

    it('allows qwen/qwen3.8-27b on 0.1GB free RAM if already resident and incremental KV cache fits', () => {
      const loadedInstance: ModelInstance = {
        id: 'inst-qwen',
        modelId: 'qwen/qwen3.8-27b',
        computerId: constrainedComputer.id,
        runtimeId: 'ollama',
        runtimeModelId: 'qwen3.8-27b',
        loaded: true,
        state: 'READY',
        health: 'healthy',
      };

      const result = service.assessDeviceForModel({
        model: qwenModel,
        computer: constrainedComputer,
        instance: loadedInstance,
        requiredKvCacheGB: 0.05, // 0.05GB incremental KV cache fits within 0.1GB free RAM
      });

      expect(result.alreadyLoaded).toBe(true);
      expect(result.availableMemoryGB).toBe(0.1);
      // Already-loaded model only requires incremental KV cache (0.05GB)
      expect(result.requiredMemoryGB).toBe(0.05);
      expect(result.eligible).toBe(true);
      expect(result.reasons.some((r) => r.includes('already loaded/resident'))).toBe(true);
    });

    it('rejects already loaded model if incremental KV cache exceeds remaining free RAM', () => {
      const loadedInstance: ModelInstance = {
        id: 'inst-qwen',
        modelId: 'qwen/qwen3.8-27b',
        computerId: constrainedComputer.id,
        runtimeId: 'ollama',
        runtimeModelId: 'qwen3.8-27b',
        loaded: true,
        state: 'READY',
        health: 'healthy',
      };

      // Target context requires 0.5GB KV cache, but only 0.1GB free RAM
      const result = service.assessDeviceForModel({
        model: qwenModel,
        computer: constrainedComputer,
        instance: loadedInstance,
        requiredKvCacheGB: 0.5,
      });

      expect(result.alreadyLoaded).toBe(true);
      expect(result.availableMemoryGB).toBe(0.1);
      expect(result.requiredMemoryGB).toBe(0.5);
      expect(result.eligible).toBe(false);
      expect(result.rejectionReasons.some((r) => r.includes('exceeds available unified memory'))).toBe(true);
    });
  });

  describe('Concurrent Unsettled Reservations Preventing Overcommit', () => {
    it('subtracts active unsettled reservations from available memory to protect parallel dispatches', () => {
      const computer = createComputer({
        load: {
          cpuPercent: 10,
          memoryUsedGB: 16,
          memoryAvailableGB: 30, // 30GB available initially
        },
        reservations: [
          // Agent 1 dispatches and reserves 15GB (unsettled)
          {
            id: 'res-agent-1',
            instanceId: 'inst-1',
            memoryBytes: 15 * 1024 ** 3,
            vramBytes: 15 * 1024 ** 3,
            createdAt: new Date(),
          },
        ],
      });

      const modelNeeding20GB = createModel({
        id: 'model-20gb',
        memory: { minGpuGB: 20 },
      });

      // Agent 2 attempts to schedule a 20GB model concurrently.
      // Raw free: 30GB. Reserved: 15GB. Net available: 15GB.
      // 20GB > 15GB -> must be rejected to prevent OOM!
      const result = service.assessDeviceForModel({
        model: modelNeeding20GB,
        computer,
      });

      expect(result.reservedMemoryGB).toBe(15);
      expect(result.availableMemoryGB).toBe(15);
      expect(result.requiredMemoryGB).toBe(20);
      expect(result.eligible).toBe(false);
      expect(result.rejectionReasons.some((r) => r.includes('15GB reserved'))).toBe(true);

      // Agent 3 attempts to schedule a smaller 10GB model concurrently.
      // 10GB <= 15GB -> admitted!
      const modelNeeding10GB = createModel({
        id: 'model-10gb',
        memory: { minGpuGB: 10 },
      });

      const result3 = service.assessDeviceForModel({
        model: modelNeeding10GB,
        computer,
      });

      expect(result3.availableMemoryGB).toBe(15);
      expect(result3.requiredMemoryGB).toBe(10);
      expect(result3.eligible).toBe(true);
    });

    it('ignores settled reservations since settled allocations are already resident', () => {
      const computer = createComputer({
        load: {
          cpuPercent: 10,
          memoryUsedGB: 16,
          memoryAvailableGB: 25,
        },
        reservations: [
          {
            id: 'res-settled',
            instanceId: 'inst-settled',
            memoryBytes: 10 * 1024 ** 3,
            vramBytes: 10 * 1024 ** 3,
            createdAt: new Date(Date.now() - 60000),
            settledAt: new Date(Date.now() - 30000), // Settled reservation!
          },
        ],
      });

      const model = createModel({
        id: 'model-20gb',
        memory: { minGpuGB: 20 },
      });

      // Since res-settled is settled, it is not subtracted from available memory.
      const result = service.assessDeviceForModel({ model, computer });
      expect(result.reservedMemoryGB).toBe(0);
      expect(result.availableMemoryGB).toBe(25);
      expect(result.eligible).toBe(true);
    });
  });

  describe('Remote Workers & Runtimes & Hosted Models', () => {
    it('handles connected remote workers correctly', () => {
      const onlineRemoteWorker = createComputer({
        id: 'worker-node-1',
        local: false,
        status: 'online',
        network: { reachable: true, latencyMs: 25 },
        hardware: {
          cpu: 'AMD EPYC',
          cpuCores: 64,
          memoryGB: 256,
        },
        load: {
          cpuPercent: 20,
          memoryUsedGB: 56,
          memoryAvailableGB: 200,
        },
      });

      const model = createModel({ memory: { minSystemGB: 32 } });
      const result = service.assessDeviceForModel({ model, computer: onlineRemoteWorker });

      expect(result.deviceKind).toBe('remote_worker');
      expect(result.eligible).toBe(true);
      expect(result.availableMemoryGB).toBe(200);
      expect(result.reasons.some((r) => r.includes('Connected remote worker'))).toBe(true);
    });

    it('rejects remote workers that are offline', () => {
      const offlineRemoteWorker = createComputer({
        id: 'worker-node-offline',
        local: false,
        status: 'offline',
      });

      const model = createModel();
      const result = service.assessDeviceForModel({ model, computer: offlineRemoteWorker });

      expect(result.deviceKind).toBe('remote_worker');
      expect(result.eligible).toBe(false);
      expect(result.rejectionReasons.some((r) => r.includes('not online'))).toBe(true);
    });

    it('evaluates hosted API models with 0GB local memory requirement', () => {
      const hostedModel = createModel({
        id: 'gpt-4o',
        provider: 'openai',
        local: false,
      });

      const result = service.assessDeviceForModel({ model: hostedModel });
      expect(result.deviceKind).toBe('hosted_api');
      expect(result.eligible).toBe(true);
      expect(result.requiredMemoryGB).toBe(0);
      expect(result.availableMemoryGB).toBe(0);
    });

    it('enforces runtime constraints (e.g. MLX on non-Apple and vLLM on non-CUDA)', () => {
      const linuxBox = createComputer({
        os: { platform: 'linux', architecture: 'x86_64', version: '6.5' },
        hardware: {
          cpu: 'Intel',
          cpuCores: 16,
          memoryGB: 32,
        },
      });

      const model = createModel();
      const mlxResult = service.assessDeviceForModel({
        model,
        computer: linuxBox,
        runtime: { id: 'mlx', type: 'mlx' },
      });
      expect(mlxResult.eligible).toBe(false);
      expect(mlxResult.rejectionReasons.some((r) => r.includes('MLX requires Apple Silicon'))).toBe(true);

      const vllmResult = service.assessDeviceForModel({
        model,
        computer: linuxBox,
        runtime: { id: 'vllm', type: 'vllm' },
      });
      expect(vllmResult.eligible).toBe(false);
      expect(vllmResult.rejectionReasons.some((r) => r.includes('vLLM requires NVIDIA GPU'))).toBe(true);
    });
  });

  describe('Loaded-Model Incremental Memory Handling (14GB model on 1.5GB remaining memory)', () => {
    const memory16GBComputer = createComputer({
      hardware: {
        cpu: 'Apple M3 Pro',
        cpuCores: 12,
        memoryGB: 16,
        gpu: { vendor: 'apple', model: 'Apple M3 Pro', memoryGB: 16, unifiedMemory: true },
      },
      load: {
        cpuPercent: 15,
        memoryUsedGB: 14.5,
        memoryAvailableGB: 1.5, // 1.5GB remaining usable memory
      },
    });

    const model14gb = createModel({
      id: 'model-14gb',
      memory: { minGpuGB: 14 },
    });

    it('marks unloaded 14GB model as eligible: false and fits: false on 1.5GB remaining memory', () => {
      const result = service.assessDeviceForModel({
        model: model14gb,
        computer: memory16GBComputer,
        isAlreadyLoaded: false,
      });

      expect(result.eligible).toBe(false);
      expect(result.fits).toBe(false);
      expect(result.requiredMemoryGB).toBe(14);
      expect(result.availableMemoryGB).toBe(1.5);
      expect(result.shortReason).toContain('Insufficient memory');
      expect(result.reason).toContain('exceeds available unified memory');
    });

    it('marks already-loaded 14GB model as eligible: true and fits: true on 1.5GB remaining memory (reusing resident weights)', () => {
      const result = service.assessDeviceForModel({
        model: model14gb,
        computer: memory16GBComputer,
        isAlreadyLoaded: true,
        loadedWeightsMemoryGB: 14,
        requiredKvCacheGB: 0.5, // 0.5GB incremental KV cache fits in 1.5GB
      });

      expect(result.eligible).toBe(true);
      expect(result.fits).toBe(true);
      expect(result.alreadyLoaded).toBe(true);
      expect(result.requiredMemoryGB).toBe(0.5);
      expect(result.availableMemoryGB).toBe(1.5);
      expect(result.shortReason).toBe('Loaded');
    });

    it('works identically via checkModelEligibility options', () => {
      const loadedResult = service.checkModelEligibility(model14gb, memory16GBComputer, {
        isAlreadyLoaded: true,
        loadedWeightsMemoryGB: 14,
      });
      expect(loadedResult.eligible).toBe(true);
      expect(loadedResult.fits).toBe(true);

      const unloadedResult = service.checkModelEligibility(model14gb, memory16GBComputer, {
        isAlreadyLoaded: false,
      });
      expect(unloadedResult.eligible).toBe(false);
      expect(unloadedResult.fits).toBe(false);
      expect(unloadedResult.shortReason).toContain('Insufficient memory');
    });
  });

  describe('formatDeviceSummary', () => {
    it('accurately describes Apple Silicon unified memory', () => {
      const appleMac = createComputer({
        hardware: {
          cpu: 'Apple M3 Max',
          cpuCores: 16,
          memoryGB: 64,
          gpu: {
            vendor: 'apple',
            model: 'Apple M3 Max',
            memoryGB: 64,
            unifiedMemory: true,
          },
        },
        load: {
          cpuPercent: 10,
          memoryUsedGB: 15.8,
          memoryAvailableGB: 48.2,
        },
      });

      const summary = service.formatDeviceSummary(appleMac);
      expect(summary).toBe('Apple M3 Max · 64.0GB Unified Memory (48.2GB usable)');
      expect(HardwareEligibilityService.formatDeviceSummary(appleMac)).toBe(
        'Apple M3 Max · 64.0GB Unified Memory (48.2GB usable)',
      );
    });

    it('accurately describes discrete NVIDIA VRAM', () => {
      const nvidiaRig = createComputer({
        os: { platform: 'linux', architecture: 'x86_64', version: '6.5' },
        hardware: {
          cpu: 'Intel Core i9',
          cpuCores: 16,
          memoryGB: 64,
          gpu: {
            vendor: 'nvidia',
            model: 'RTX 4090',
            memoryGB: 24,
            cuda: true,
          },
        },
        load: {
          cpuPercent: 15,
          memoryUsedGB: 16,
          memoryAvailableGB: 48,
          gpuMemoryUsedGB: 3.9,
          gpuMemoryAvailableGB: 20.1,
        },
      });

      const summary = service.formatDeviceSummary(nvidiaRig);
      expect(summary).toBe('NVIDIA RTX 4090 · 24.0GB VRAM (20.1GB usable)');
      expect(HardwareEligibilityService.formatDeviceSummary(nvidiaRig)).toBe(
        'NVIDIA RTX 4090 · 24.0GB VRAM (20.1GB usable)',
      );
    });

    it('accurately describes standard CPU RAM', () => {
      const cpuBox = createComputer({
        local: true,
        os: { platform: 'linux', architecture: 'x86_64', version: '6.5' },
        hardware: {
          cpu: 'Local CPU',
          cpuCores: 8,
          memoryGB: 16,
        },
        load: {
          cpuPercent: 20,
          memoryUsedGB: 4,
          memoryAvailableGB: 12.0,
        },
      });

      const summary = service.formatDeviceSummary(cpuBox);
      expect(summary).toBe('Local CPU · 16.0GB RAM (12.0GB usable)');
      expect(HardwareEligibilityService.formatDeviceSummary(cpuBox)).toBe(
        'Local CPU · 16.0GB RAM (12.0GB usable)',
      );
    });

    it('respects activeReservedBytes when formatting device usable memory', () => {
      const appleMac = createComputer({
        hardware: {
          cpu: 'Apple M3 Max',
          cpuCores: 16,
          memoryGB: 64,
          gpu: {
            vendor: 'apple',
            model: 'Apple M3 Max',
            memoryGB: 64,
            unifiedMemory: true,
          },
        },
        load: {
          memoryAvailableGB: 48.2,
        },
      });

      const reserved2GB = 2 * 1024 ** 3;
      const summary = service.formatDeviceSummary(appleMac, reserved2GB);
      expect(summary).toBe('Apple M3 Max · 64.0GB Unified Memory (46.2GB usable)');
    });
  });
});
