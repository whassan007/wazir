import type { Computer } from '../types/computer.js';
import type { ModelRecord, ModelInstance } from '../types/model.js';
import { estimateModelMemory } from '../types/model.js';

export type DeviceKind =
  | 'apple_unified'
  | 'nvidia_gpu'
  | 'discrete_gpu'
  | 'cpu_only'
  | 'remote_worker'
  | 'hosted_api';

export interface RuntimeInfo {
  id: string;
  name?: string;
  version?: string;
  type?: string;
  url?: string;
  health?: 'healthy' | 'degraded' | 'unavailable';
  loadedModels?: string[];
}

export interface DeviceEligibilityResult {
  eligible: boolean;
  fits: boolean;
  deviceId: string;
  deviceKind: DeviceKind;
  alreadyLoaded: boolean;
  requiredMemoryGB: number;
  availableMemoryGB: number;
  totalMemoryGB: number;
  reservedMemoryGB: number;
  unifiedMemory: boolean;
  reasons: string[];
  rejectionReasons: string[];
  reason?: string;
  shortReason?: string;
}

export type HardwareEligibilityResult = DeviceEligibilityResult;

export interface AssessDeviceParams {
  model: ModelRecord;
  computer?: Computer;
  instance?: ModelInstance;
  runtime?: RuntimeInfo;
  requiredWeightGB?: number;
  requiredKvCacheGB?: number;
  runtimeOverheadGB?: number;
  safetyReserveGB?: number;
  isAlreadyLoaded?: boolean;
  alreadyLoaded?: boolean;
  loadedWeightsMemoryGB?: number;
  activeReservedBytes?: number;
}

export interface CheckModelEligibilityOptions {
  instance?: ModelInstance;
  runtime?: RuntimeInfo;
  requiredWeightGB?: number;
  requiredKvCacheGB?: number;
  runtimeOverheadGB?: number;
  safetyReserveGB?: number;
  isAlreadyLoaded?: boolean;
  alreadyLoaded?: boolean;
  loadedWeightsMemoryGB?: number;
  activeReservedBytes?: number;
}

export interface HardwareEligibilityOptions {
  safetyReserveGB?: number;
  safetyReservePercent?: number;
}

export function roundGB(val: number): number {
  return Number((Math.round(val * 1000) / 1000).toFixed(3));
}

/**
 * Detects whether the computer uses unified memory architecture (e.g. Apple Silicon).
 * On Apple Silicon, CPU RAM and GPU VRAM share a single physical pool.
 */
export function isUnifiedMemoryArchitecture(computer?: Computer): boolean {
  if (!computer) return false;
  if (computer.hardware?.gpu?.unifiedMemory === true) return true;
  if (computer.hardware?.gpu?.unifiedMemory === false) return false;
  const platform = computer.os?.platform?.toLowerCase();
  const arch = computer.os?.architecture?.toLowerCase();
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'aarch64')) {
    return true;
  }
  return false;
}

/**
 * Detects whether the computer has an NVIDIA GPU with discrete VRAM.
 */
export function isNvidiaGpuArchitecture(computer?: Computer): boolean {
  if (!computer?.hardware?.gpu) return false;
  if (isUnifiedMemoryArchitecture(computer)) return false;
  const gpu = computer.hardware.gpu;
  return gpu.cuda === true || gpu.vendor?.toLowerCase() === 'nvidia';
}

/**
 * Detects whether the computer has any discrete GPU with its own VRAM pool.
 */
export function isDiscreteGpuArchitecture(computer?: Computer): boolean {
  if (!computer?.hardware?.gpu) return false;
  if (isUnifiedMemoryArchitecture(computer)) return false;
  const gpu = computer.hardware.gpu;
  return (gpu.memoryGB ?? 0) > 0;
}

/**
 * Categorizes the target execution device.
 */
export function determineDeviceKind(computer?: Computer, model?: ModelRecord): DeviceKind {
  if (!computer || model?.local === false) {
    return 'hosted_api';
  }
  if (computer.local === false || computer.type === 'remote-worker') {
    return 'remote_worker';
  }
  if (isUnifiedMemoryArchitecture(computer)) {
    return 'apple_unified';
  }
  if (isNvidiaGpuArchitecture(computer)) {
    return 'nvidia_gpu';
  }
  if (isDiscreteGpuArchitecture(computer)) {
    return 'discrete_gpu';
  }
  return 'cpu_only';
}

interface ParsedReservation {
  id: string;
  memoryGB: number;
  vramGB: number;
}

function getActiveUnsettledReservations(computer?: Computer): ParsedReservation[] {
  if (!computer?.reservations || !Array.isArray(computer.reservations)) {
    return [];
  }
  return computer.reservations
    .filter((r) => !r.settledAt)
    .map((r) => {
      const anyR = r as unknown as Record<string, unknown>;
      const memBytes = r.memoryBytes ?? (typeof anyR.memoryBytes === 'number' ? anyR.memoryBytes : 0);
      const memGB = memBytes > 0 ? memBytes / 1024 ** 3 : (typeof anyR.memoryGB === 'number' ? anyR.memoryGB : 0);

      const vramBytes = r.vramBytes ?? (typeof anyR.vramBytes === 'number' ? anyR.vramBytes : 0);
      const vramGB =
        vramBytes > 0
          ? vramBytes / 1024 ** 3
          : (typeof anyR.vramGB === 'number'
              ? anyR.vramGB
              : typeof anyR.gpuMemoryGB === 'number'
                ? anyR.gpuMemoryGB
                : 0);

      return {
        id: r.id,
        memoryGB: memGB,
        vramGB: vramGB,
      };
    });
}

function isModelResident(params: AssessDeviceParams): boolean {
  if (params.isAlreadyLoaded !== undefined) {
    return params.isAlreadyLoaded;
  }
  if (params.alreadyLoaded !== undefined) {
    return params.alreadyLoaded;
  }
  if (params.instance !== undefined) {
    return Boolean(
      params.instance.loaded ||
      params.instance.state === 'READY' ||
      params.instance.state === 'LOADED'
    );
  }
  const { computer, model, runtime } = params;
  if (computer?.modelHealth?.[model.id]?.loaded) {
    return true;
  }
  if (computer?.models?.includes(model.id)) {
    const health = computer.modelHealth?.[model.id];
    if (health === undefined || health.loaded !== false) {
      return true;
    }
  }
  if (runtime?.loadedModels?.includes(model.id)) {
    return true;
  }
  return false;
}

export class HardwareEligibilityService {
  constructor(private readonly options: HardwareEligibilityOptions = {}) {}

  /**
   * Assesses device feasibility for hosting or executing an inference workload.
   *
   * Invariants enforced:
   * 1. Never double-counts Apple Silicon unified memory (single memory pool for RAM & VRAM).
   * 2. Distinguishes cold-load (weights + overhead + KV cache) vs already-loaded (incremental KV cache only).
   * 3. Subtracts active unsettled reservations to prevent concurrent memory overcommit.
   */
  assessDeviceForModel(params: AssessDeviceParams): DeviceEligibilityResult {
    const { model, computer, instance, runtime } = params;
    const reasons: string[] = [];
    const rejectionReasons: string[] = [];

    const deviceKind = determineDeviceKind(computer, model);
    const unifiedMemory = isUnifiedMemoryArchitecture(computer);
    const alreadyLoaded = isModelResident(params);
    const deviceId = computer?.id ?? instance?.computerId ?? runtime?.id ?? 'hosted_api';

    // 1. Hosted API branch (model runs on external provider with 0GB local resource footprint)
    if (deviceKind === 'hosted_api') {
      if (runtime && runtime.health === 'unavailable') {
        rejectionReasons.push(`Hosted runtime '${runtime.id}' is unavailable`);
      }
      reasons.push('Hosted API execution: model executes remotely with 0GB local memory requirement');
      const eligible = rejectionReasons.length === 0;
      return {
        eligible,
        fits: eligible,
        deviceId,
        deviceKind: 'hosted_api',
        alreadyLoaded,
        requiredMemoryGB: 0,
        availableMemoryGB: 0,
        totalMemoryGB: 0,
        reservedMemoryGB: 0,
        unifiedMemory: false,
        reasons,
        rejectionReasons,
        reason: eligible ? reasons.join('; ') : rejectionReasons.join('; '),
        shortReason: eligible ? 'Hosted' : rejectionReasons[0],
      };
    }

    if (!computer) {
      return {
        eligible: false,
        fits: false,
        deviceId,
        deviceKind: 'hosted_api',
        alreadyLoaded: false,
        requiredMemoryGB: 0,
        availableMemoryGB: 0,
        totalMemoryGB: 0,
        reservedMemoryGB: 0,
        unifiedMemory: false,
        reasons: [],
        rejectionReasons: ['No computer provided for local/worker model execution'],
        reason: 'No computer provided for local/worker model execution',
        shortReason: 'No computer provided',
      };
    }

    // 2. Computer status & health checks
    if (computer.status !== 'online') {
      rejectionReasons.push(`Computer '${computer.id}' is not online (status: ${computer.status})`);
    }
    if (computer.health === 'unavailable') {
      rejectionReasons.push(`Computer '${computer.id}' reports unavailable health`);
    }
    if (computer.local === false) {
      if (computer.network?.reachable === false) {
        rejectionReasons.push(`Remote worker '${computer.id}' network is unreachable`);
      } else {
        reasons.push(`Connected remote worker '${computer.id}' is online and reachable`);
      }
    }

    // Policy restrictions
    if (computer.policyRestrictions?.denied?.includes(model.id)) {
      rejectionReasons.push(`Model '${model.id}' is explicitly denied by policy on '${computer.id}'`);
    }
    if (computer.policyRestrictions?.allowed && !computer.policyRestrictions.allowed.includes(model.id)) {
      rejectionReasons.push(`Model '${model.id}' is not in allowed policy restrictions on '${computer.id}'`);
    }

    // CPU checks
    if (computer.hardware.cpuCores <= 0) {
      rejectionReasons.push(`Computer '${computer.id}' reports invalid CPU cores (${computer.hardware.cpuCores})`);
    } else {
      const cpuPercent = computer.load?.cpuPercent;
      if (cpuPercent !== undefined) {
        reasons.push(`CPU: ${computer.hardware.cpuCores} cores, current load ${Math.round(cpuPercent)}%`);
        if (cpuPercent >= 100) {
          rejectionReasons.push(`Computer '${computer.id}' CPU is 100% saturated`);
        }
      } else {
        reasons.push(`CPU: ${computer.hardware.cpuCores} cores available`);
      }
    }

    // Runtime compatibility & health checks
    if (runtime) {
      if (runtime.health === 'unavailable') {
        rejectionReasons.push(`Runtime '${runtime.id}' is unavailable`);
      }
      if (
        computer.runtimeHealth?.[runtime.id]?.status === 'unhealthy' ||
        (computer.runtimeHealth?.[runtime.id]?.status as string) === 'unavailable'
      ) {
        rejectionReasons.push(
          `Runtime '${runtime.id}' on '${computer.id}' reports ${computer.runtimeHealth[runtime.id].status}`,
        );
      }
      const runtimeType = (runtime.type ?? runtime.id).toLowerCase();
      if (runtimeType === 'mlx' && !unifiedMemory) {
        rejectionReasons.push(`Runtime MLX requires Apple Silicon unified memory`);
      }
      if (runtimeType === 'vllm' && !isNvidiaGpuArchitecture(computer)) {
        rejectionReasons.push(`Runtime vLLM requires NVIDIA GPU with CUDA`);
      }
      if (
        model.runtimeCompatibility &&
        model.runtimeCompatibility !== 'any' &&
        Array.isArray(model.runtimeCompatibility)
      ) {
        const isCompat = model.runtimeCompatibility.some(
          (rt) => rt.toLowerCase() === runtimeType || rt.toLowerCase() === runtime.id.toLowerCase(),
        );
        if (!isCompat) {
          rejectionReasons.push(
            `Runtime '${runtime.id}' is incompatible with model runtimeCompatibility (${model.runtimeCompatibility.join(', ')})`,
          );
        }
      }
    }

    // 3. Memory & Resource Assessment
    const activeReservations = getActiveUnsettledReservations(computer);
    const extraReservedGB = (params.activeReservedBytes ?? 0) / (1024 ** 3);

    let totalMemoryGB = 0;
    let availableMemoryGB = 0;
    let reservedMemoryGB = 0;
    let requiredMemoryGB = 0;
    let weightGB = 0;

    const kvCacheGB = params.requiredKvCacheGB ?? 0;
    const overheadGB = params.runtimeOverheadGB ?? 0;

    if (unifiedMemory) {
      // INVARIANT 1: Apple Silicon Unified Memory
      // Total memory is from the single unified RAM pool
      totalMemoryGB = computer.hardware.memoryGB || (computer.hardware.gpu?.memoryGB ?? 0);

      // Raw available memory is from the single unified pool (never add gpuMemoryAvailableGB)
      const rawAvailableGB =
        computer.load?.memoryAvailableGB !== undefined
          ? computer.load.memoryAvailableGB
          : computer.hardware.memoryGB - (computer.load?.memoryUsedGB ?? 0);

      // Active reservations: on unified memory, do NOT double count if a reservation set both memoryBytes & vramBytes
      reservedMemoryGB =
        activeReservations.reduce(
          (sum, r) => sum + Math.max(r.memoryGB, r.vramGB),
          0,
        ) + extraReservedGB;

      availableMemoryGB = Math.max(0, rawAvailableGB - reservedMemoryGB);

      // Determine model weights: on unified memory, never add minSystemGB + minGpuGB together
      if (params.requiredWeightGB !== undefined) {
        weightGB = params.requiredWeightGB;
      } else {
        weightGB = Math.max(model.memory?.minGpuGB ?? 0, model.memory?.minSystemGB ?? 0);
        if (weightGB === 0 && model.local !== false) {
          const est = estimateModelMemory(model.parameters, model.id, model.quantization);
          weightGB = est.minSystemGB;
        }
      }

      // INVARIANT 2: Cold-load vs already-loaded incremental memory
      if (alreadyLoaded) {
        if (params.loadedWeightsMemoryGB !== undefined) {
          const totalRequirement = weightGB + overheadGB + kvCacheGB;
          requiredMemoryGB = Math.max(0, totalRequirement - params.loadedWeightsMemoryGB);
          reasons.push(
            `Model '${model.id}' is already loaded/resident (${roundGB(params.loadedWeightsMemoryGB)}GB resident); incremental memory requirement is ${roundGB(requiredMemoryGB)}GB`,
          );
        } else {
          requiredMemoryGB = kvCacheGB;
          reasons.push(
            `Model '${model.id}' is already loaded/resident; only incremental KV cache (${roundGB(kvCacheGB)}GB) required`,
          );
        }
      } else {
        requiredMemoryGB = weightGB + overheadGB + kvCacheGB;
        reasons.push(
          `Model '${model.id}' cold-load: requires unified memory for weights (${roundGB(weightGB)}GB) + overhead (${roundGB(overheadGB)}GB) + KV cache (${roundGB(kvCacheGB)}GB) = ${roundGB(requiredMemoryGB)}GB`,
        );
      }

      const safetyReserveGB =
        params.safetyReserveGB ??
        this.options.safetyReserveGB ??
        (this.options.safetyReservePercent ? (totalMemoryGB * this.options.safetyReservePercent) / 100 : 0);

      const usableMemoryGB = Math.max(0, availableMemoryGB - safetyReserveGB);

      if (!alreadyLoaded && requiredMemoryGB > totalMemoryGB) {
        rejectionReasons.push(
          `Total unified memory (${roundGB(totalMemoryGB)}GB) cannot fit model requirement (${roundGB(requiredMemoryGB)}GB)`,
        );
      }

      if (requiredMemoryGB > usableMemoryGB) {
        const reserveNote = reservedMemoryGB > 0 ? `, ${roundGB(reservedMemoryGB)}GB reserved` : '';
        const safetyNote = safetyReserveGB > 0 ? `, ${roundGB(safetyReserveGB)}GB safety reserve` : '';
        rejectionReasons.push(
          `Required memory (${roundGB(requiredMemoryGB)}GB) exceeds available unified memory (${roundGB(usableMemoryGB)}GB available${reserveNote}${safetyNote} of ${roundGB(totalMemoryGB)}GB total)`,
        );
      } else {
        reasons.push(
          `Unified memory sufficient: ${roundGB(requiredMemoryGB)}GB required <= ${roundGB(usableMemoryGB)}GB available (${roundGB(totalMemoryGB)}GB total)`,
        );
      }
    } else if (isNvidiaGpuArchitecture(computer) || isDiscreteGpuArchitecture(computer)) {
      // Discrete GPU (NVIDIA or AMD/Intel discrete)
      const gpu = computer.hardware.gpu!;
      totalMemoryGB = gpu.memoryGB ?? 0;

      const rawAvailableVramGB =
        computer.load?.gpuMemoryAvailableGB !== undefined
          ? computer.load.gpuMemoryAvailableGB
          : computer.load?.gpuMemoryUsedGB !== undefined
            ? Math.max(0, totalMemoryGB - computer.load.gpuMemoryUsedGB)
            : totalMemoryGB;

      reservedMemoryGB =
        activeReservations.reduce((sum, r) => sum + r.vramGB, 0) + extraReservedGB;
      availableMemoryGB = Math.max(0, rawAvailableVramGB - reservedMemoryGB);

      if (params.requiredWeightGB !== undefined) {
        weightGB = params.requiredWeightGB;
      } else {
        weightGB = model.memory?.minGpuGB ?? model.memory?.minSystemGB ?? 0;
        if (weightGB === 0 && model.local !== false) {
          const est = estimateModelMemory(model.parameters, model.id, model.quantization);
          weightGB = est.minGpuGB ?? est.minSystemGB;
        }
      }

      // INVARIANT 2: Cold-load vs already-loaded
      if (alreadyLoaded) {
        if (params.loadedWeightsMemoryGB !== undefined) {
          const totalRequirement = weightGB + overheadGB + kvCacheGB;
          requiredMemoryGB = Math.max(0, totalRequirement - params.loadedWeightsMemoryGB);
          reasons.push(
            `Model '${model.id}' is already loaded in GPU memory (${roundGB(params.loadedWeightsMemoryGB)}GB resident); incremental memory requirement is ${roundGB(requiredMemoryGB)}GB`,
          );
        } else {
          requiredMemoryGB = kvCacheGB;
          reasons.push(
            `Model '${model.id}' is already loaded in GPU memory; only incremental KV cache (${roundGB(kvCacheGB)}GB) required`,
          );
        }
      } else {
        requiredMemoryGB = weightGB + overheadGB + kvCacheGB;
        reasons.push(
          `Model '${model.id}' cold-load: requires GPU weights (${roundGB(weightGB)}GB) + overhead (${roundGB(overheadGB)}GB) + KV cache (${roundGB(kvCacheGB)}GB) = ${roundGB(requiredMemoryGB)}GB`,
        );
      }

      const safetyReserveGB =
        params.safetyReserveGB ??
        this.options.safetyReserveGB ??
        (this.options.safetyReservePercent ? (totalMemoryGB * this.options.safetyReservePercent) / 100 : 0);

      const usableVramGB = Math.max(0, availableMemoryGB - safetyReserveGB);

      if (!alreadyLoaded && requiredMemoryGB > totalMemoryGB) {
        rejectionReasons.push(
          `Total GPU VRAM (${roundGB(totalMemoryGB)}GB) cannot fit model requirement (${roundGB(requiredMemoryGB)}GB)`,
        );
      }

      if (requiredMemoryGB > usableVramGB) {
        const reserveNote = reservedMemoryGB > 0 ? `, ${roundGB(reservedMemoryGB)}GB reserved` : '';
        const safetyNote = safetyReserveGB > 0 ? `, ${roundGB(safetyReserveGB)}GB safety reserve` : '';
        rejectionReasons.push(
          `Required GPU memory (${roundGB(requiredMemoryGB)}GB) exceeds available VRAM (${roundGB(usableVramGB)}GB available${reserveNote}${safetyNote} of ${roundGB(totalMemoryGB)}GB total VRAM)`,
        );
      } else {
        reasons.push(
          `GPU VRAM sufficient: ${roundGB(requiredMemoryGB)}GB required <= ${roundGB(usableVramGB)}GB available (${roundGB(totalMemoryGB)}GB total VRAM)`,
        );
      }

      // Discrete check: also enforce separate System RAM constraints
      const rawSysAvailGB =
        computer.load?.memoryAvailableGB !== undefined
          ? computer.load.memoryAvailableGB
          : computer.hardware.memoryGB - (computer.load?.memoryUsedGB ?? 0);
      const sysReservedGB = activeReservations.reduce((sum, r) => sum + r.memoryGB, 0);
      const availSysGB = Math.max(0, rawSysAvailGB - sysReservedGB);

      if (!alreadyLoaded && model.memory?.minSystemGB !== undefined && model.memory.minSystemGB > 0) {
        if (model.memory.minSystemGB > computer.hardware.memoryGB) {
          rejectionReasons.push(
            `Total system RAM (${roundGB(computer.hardware.memoryGB)}GB) cannot fit required system memory (${roundGB(model.memory.minSystemGB)}GB)`,
          );
        } else if (model.memory.minSystemGB > availSysGB) {
          rejectionReasons.push(
            `Required system RAM (${roundGB(model.memory.minSystemGB)}GB) exceeds available system RAM (${roundGB(availSysGB)}GB)`,
          );
        } else {
          reasons.push(`System RAM sufficient: ${roundGB(model.memory.minSystemGB)}GB required <= ${roundGB(availSysGB)}GB available`);
        }
      }
    } else {
      // CPU-only execution target
      totalMemoryGB = computer.hardware.memoryGB;
      const rawAvailableRamGB =
        computer.load?.memoryAvailableGB !== undefined
          ? computer.load.memoryAvailableGB
          : computer.hardware.memoryGB - (computer.load?.memoryUsedGB ?? 0);

      reservedMemoryGB =
        activeReservations.reduce((sum, r) => sum + r.memoryGB, 0) + extraReservedGB;
      availableMemoryGB = Math.max(0, rawAvailableRamGB - reservedMemoryGB);

      if (params.requiredWeightGB !== undefined) {
        weightGB = params.requiredWeightGB;
      } else {
        weightGB = model.memory?.minSystemGB ?? 0;
        if (weightGB === 0 && model.local !== false) {
          const est = estimateModelMemory(model.parameters, model.id, model.quantization);
          weightGB = est.minSystemGB;
        }
      }

      // INVARIANT 2: Cold-load vs already-loaded
      if (alreadyLoaded) {
        if (params.loadedWeightsMemoryGB !== undefined) {
          const totalRequirement = weightGB + overheadGB + kvCacheGB;
          requiredMemoryGB = Math.max(0, totalRequirement - params.loadedWeightsMemoryGB);
          reasons.push(
            `Model '${model.id}' is already loaded in system RAM (${roundGB(params.loadedWeightsMemoryGB)}GB resident); incremental memory requirement is ${roundGB(requiredMemoryGB)}GB`,
          );
        } else {
          requiredMemoryGB = kvCacheGB;
          reasons.push(
            `Model '${model.id}' is already loaded in system RAM; only incremental KV cache (${roundGB(kvCacheGB)}GB) required`,
          );
        }
      } else {
        requiredMemoryGB = weightGB + overheadGB + kvCacheGB;
        reasons.push(
          `Model '${model.id}' cold-load: requires RAM weights (${roundGB(weightGB)}GB) + overhead (${roundGB(overheadGB)}GB) + KV cache (${roundGB(kvCacheGB)}GB) = ${roundGB(requiredMemoryGB)}GB`,
        );
      }

      const safetyReserveGB =
        params.safetyReserveGB ??
        this.options.safetyReserveGB ??
        (this.options.safetyReservePercent ? (totalMemoryGB * this.options.safetyReservePercent) / 100 : 0);

      const usableRamGB = Math.max(0, availableMemoryGB - safetyReserveGB);

      if (model.memory?.minGpuGB && model.memory.minGpuGB > 0) {
        rejectionReasons.push(
          `Model requires ${roundGB(model.memory.minGpuGB)}GB GPU VRAM but device '${computer.id}' is CPU-only`,
        );
      }

      if (!alreadyLoaded && requiredMemoryGB > totalMemoryGB) {
        rejectionReasons.push(
          `Total system RAM (${roundGB(totalMemoryGB)}GB) cannot fit model requirement (${roundGB(requiredMemoryGB)}GB)`,
        );
      }

      if (requiredMemoryGB > usableRamGB) {
        const reserveNote = reservedMemoryGB > 0 ? `, ${roundGB(reservedMemoryGB)}GB reserved` : '';
        const safetyNote = safetyReserveGB > 0 ? `, ${roundGB(safetyReserveGB)}GB safety reserve` : '';
        rejectionReasons.push(
          `Required memory (${roundGB(requiredMemoryGB)}GB) exceeds available system RAM (${roundGB(usableRamGB)}GB available${reserveNote}${safetyNote} of ${roundGB(totalMemoryGB)}GB total)`,
        );
      } else {
        reasons.push(
          `System RAM sufficient: ${roundGB(requiredMemoryGB)}GB required <= ${roundGB(usableRamGB)}GB available (${roundGB(totalMemoryGB)}GB total)`,
        );
      }
    }

    const eligible = rejectionReasons.length === 0;
    let reason: string;
    let shortReason: string;

    if (!eligible) {
      const isMemoryIssue =
        requiredMemoryGB > availableMemoryGB ||
        rejectionReasons.some((r) => r.includes('exceeds available') || r.includes('cannot fit'));

      if (isMemoryIssue) {
        shortReason = `Insufficient memory (needs ${roundGB(requiredMemoryGB)}GB, ${roundGB(availableMemoryGB)}GB avail)`;
        const diagnostic = `local: available memory ${roundGB(availableMemoryGB)}GB < required ${roundGB(requiredMemoryGB)}GB (weights ${roundGB(weightGB)}GB + KV/overhead ${roundGB(overheadGB + kvCacheGB)}GB)`;
        reason = `${diagnostic}; ${rejectionReasons.join('; ')}`;
      } else {
        shortReason = rejectionReasons[0];
        reason = rejectionReasons.join('; ');
      }
    } else {
      reason = reasons.join('; ');
      shortReason = alreadyLoaded ? 'Loaded' : 'Eligible';
    }

    return {
      eligible,
      fits: eligible,
      deviceId,
      deviceKind,
      alreadyLoaded,
      requiredMemoryGB: roundGB(requiredMemoryGB),
      availableMemoryGB: roundGB(availableMemoryGB),
      totalMemoryGB: roundGB(totalMemoryGB),
      reservedMemoryGB: roundGB(reservedMemoryGB),
      unifiedMemory,
      reasons,
      rejectionReasons,
      reason,
      shortReason,
    };
  }

  /**
   * Evaluates model hardware eligibility on a computer.
   */
  checkModelEligibility(params: AssessDeviceParams): DeviceEligibilityResult;
  checkModelEligibility(
    model: ModelRecord,
    computer?: Computer,
    options?: CheckModelEligibilityOptions,
  ): DeviceEligibilityResult;
  checkModelEligibility(
    modelOrParams: ModelRecord | AssessDeviceParams,
    computerOrOptions?: Computer | CheckModelEligibilityOptions,
    maybeOptions?: CheckModelEligibilityOptions,
  ): DeviceEligibilityResult {
    if (this.isAssessParams(modelOrParams)) {
      return this.assessDeviceForModel(modelOrParams);
    }
    const model = modelOrParams as ModelRecord;
    const computer =
      computerOrOptions && 'hardware' in computerOrOptions
        ? (computerOrOptions as Computer)
        : undefined;
    const opts =
      computerOrOptions && !('hardware' in computerOrOptions)
        ? (computerOrOptions as CheckModelEligibilityOptions)
        : maybeOptions ?? {};

    return this.assessDeviceForModel({
      model,
      computer,
      ...opts,
    });
  }

  formatDeviceSummary(computer: Computer, activeReservedBytes?: number): string {
    return HardwareEligibilityService.formatDeviceSummary(computer, activeReservedBytes, this.options);
  }

  private isAssessParams(val: unknown): val is AssessDeviceParams {
    return (
      typeof val === 'object' &&
      val !== null &&
      'model' in val &&
      !('family' in val && 'provider' in val && 'toolCalling' in val)
    );
  }

  static assessDeviceForModel(
    params: AssessDeviceParams,
    options?: HardwareEligibilityOptions,
  ): DeviceEligibilityResult {
    return new HardwareEligibilityService(options).assessDeviceForModel(params);
  }

  static checkModelEligibility(
    params: AssessDeviceParams,
    options?: HardwareEligibilityOptions,
  ): DeviceEligibilityResult;
  static checkModelEligibility(
    model: ModelRecord,
    computer?: Computer,
    checkOptions?: CheckModelEligibilityOptions,
    serviceOptions?: HardwareEligibilityOptions,
  ): DeviceEligibilityResult;
  static checkModelEligibility(
    modelOrParams: ModelRecord | AssessDeviceParams,
    computerOrOptions?: Computer | CheckModelEligibilityOptions,
    optionsOrServiceOptions?: CheckModelEligibilityOptions | HardwareEligibilityOptions,
    maybeServiceOptions?: HardwareEligibilityOptions,
  ): DeviceEligibilityResult {
    if (typeof modelOrParams === 'object' && modelOrParams !== null && 'model' in modelOrParams) {
      const serviceOpts = optionsOrServiceOptions as HardwareEligibilityOptions | undefined;
      return new HardwareEligibilityService(serviceOpts).checkModelEligibility(modelOrParams as AssessDeviceParams);
    }
    const model = modelOrParams as ModelRecord;
    const computer =
      computerOrOptions && 'hardware' in computerOrOptions
        ? (computerOrOptions as Computer)
        : undefined;
    const checkOpts =
      computerOrOptions && !('hardware' in computerOrOptions)
        ? (computerOrOptions as CheckModelEligibilityOptions)
        : (optionsOrServiceOptions as CheckModelEligibilityOptions | undefined);
    const serviceOpts = maybeServiceOptions;
    return new HardwareEligibilityService(serviceOpts).checkModelEligibility(model, computer, checkOpts);
  }

  static formatDeviceSummary(
    computer: Computer,
    activeReservedBytes?: number,
    options?: HardwareEligibilityOptions,
  ): string {
    const unifiedMemory = isUnifiedMemoryArchitecture(computer);
    const activeReservations = getActiveUnsettledReservations(computer);
    const extraReservedGB = (activeReservedBytes ?? 0) / (1024 ** 3);

    if (unifiedMemory) {
      const totalMemoryGB = computer.hardware.memoryGB || (computer.hardware.gpu?.memoryGB ?? 0);
      const rawAvailableGB =
        computer.load?.memoryAvailableGB !== undefined
          ? computer.load.memoryAvailableGB
          : computer.hardware.memoryGB - (computer.load?.memoryUsedGB ?? 0);
      const reservedMemoryGB =
        activeReservations.reduce((sum, r) => sum + Math.max(r.memoryGB, r.vramGB), 0) + extraReservedGB;
      const availableMemoryGB = Math.max(0, rawAvailableGB - reservedMemoryGB);
      const safetyReserveGB =
        options?.safetyReserveGB ??
        (options?.safetyReservePercent ? (totalMemoryGB * options.safetyReservePercent) / 100 : 0);
      const usableMemoryGB = Math.max(0, availableMemoryGB - safetyReserveGB);

      let chipName = computer.hardware.gpu?.model || computer.hardware.cpu || 'Apple Silicon';
      if (!chipName.toLowerCase().includes('apple')) {
        chipName = `Apple ${chipName}`;
      }
      return `${chipName} · ${totalMemoryGB.toFixed(1)}GB Unified Memory (${usableMemoryGB.toFixed(1)}GB usable)`;
    }

    if (isNvidiaGpuArchitecture(computer) || isDiscreteGpuArchitecture(computer)) {
      const gpu = computer.hardware.gpu!;
      const totalMemoryGB = gpu.memoryGB ?? 0;
      const rawAvailableVramGB =
        computer.load?.gpuMemoryAvailableGB !== undefined
          ? computer.load.gpuMemoryAvailableGB
          : computer.load?.gpuMemoryUsedGB !== undefined
            ? Math.max(0, totalMemoryGB - computer.load.gpuMemoryUsedGB)
            : totalMemoryGB;
      const reservedMemoryGB =
        activeReservations.reduce((sum, r) => sum + r.vramGB, 0) + extraReservedGB;
      const availableMemoryGB = Math.max(0, rawAvailableVramGB - reservedMemoryGB);
      const safetyReserveGB =
        options?.safetyReserveGB ??
        (options?.safetyReservePercent ? (totalMemoryGB * options.safetyReservePercent) / 100 : 0);
      const usableVramGB = Math.max(0, availableMemoryGB - safetyReserveGB);

      let gpuName = gpu.model;
      const vendorLower = gpu.vendor?.toLowerCase();
      if (vendorLower === 'nvidia' && !gpuName.toLowerCase().includes('nvidia')) {
        gpuName = `NVIDIA ${gpuName}`;
      } else if (vendorLower && vendorLower !== 'unknown' && !gpuName.toLowerCase().includes(vendorLower)) {
        gpuName = `${gpu.vendor.toUpperCase()} ${gpuName}`;
      }
      return `${gpuName} · ${totalMemoryGB.toFixed(1)}GB VRAM (${usableVramGB.toFixed(1)}GB usable)`;
    }

    // CPU-only
    const totalMemoryGB = computer.hardware.memoryGB;
    const rawAvailableRamGB =
      computer.load?.memoryAvailableGB !== undefined
        ? computer.load.memoryAvailableGB
        : computer.hardware.memoryGB - (computer.load?.memoryUsedGB ?? 0);
    const reservedMemoryGB =
      activeReservations.reduce((sum, r) => sum + r.memoryGB, 0) + extraReservedGB;
    const availableMemoryGB = Math.max(0, rawAvailableRamGB - reservedMemoryGB);
    const safetyReserveGB =
      options?.safetyReserveGB ??
      (options?.safetyReservePercent ? (totalMemoryGB * options.safetyReservePercent) / 100 : 0);
    const usableRamGB = Math.max(0, availableMemoryGB - safetyReserveGB);

    let cpuLabel = computer.hardware.cpu;
    if (!cpuLabel || cpuLabel.toLowerCase() === 'cpu' || cpuLabel.toLowerCase() === 'unknown') {
      cpuLabel = computer.local !== false ? 'Local CPU' : 'Remote CPU';
    } else if (computer.local !== false && cpuLabel === 'Local CPU') {
      cpuLabel = 'Local CPU';
    }
    return `${cpuLabel} · ${totalMemoryGB.toFixed(1)}GB RAM (${usableRamGB.toFixed(1)}GB usable)`;
  }
}
