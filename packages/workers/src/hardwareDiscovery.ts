import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statfsSync } from 'node:fs';
import os from 'node:os';
import type { GPUInfo, HardwareInfo, OSInfo } from '@wazir/core';

export interface HardwareReport {
  hardware: HardwareInfo;
  os: OSInfo;
}

export type DiscoveryExecRunner = (command: string, timeoutMs?: number) => string | Promise<string>;

export interface StableMachineIdOptions {
  platform?: string;
  arch?: string;
  hostname?: string;
  execRunner?: (command: string, timeoutMs?: number) => string;
  readFile?: (filePath: string) => string;
}

export interface DiscoveredGpuDevice {
  gpuId: string;
  index: number;
  vendor: 'nvidia' | 'apple' | 'amd' | 'intel' | 'unknown';
  model: string;
  driverVersion?: string;
  cudaVersion?: string;
  metalSupported?: boolean;
  mpsSupported?: boolean;
  unifiedMemory: boolean;
  totalMemoryGB: number;
  availableMemoryGB?: number;
  usedMemoryGB?: number;
  utilizationPercent?: number;
  temperatureCelsius?: number;
}

export interface DiscoveredWorkloadConflict {
  pid?: number;
  processName: string;
  kind: 'simulation' | 'rendering' | 'training' | 'inference' | 'other';
  gpuId?: string;
  reservedVramGB: number;
  reservedRamGB: number;
  doNotInterrupt: boolean;
}

export interface DiscoveredCpuTopology {
  brand: string;
  architecture: string;
  logicalCores: number;
  physicalCores?: number;
  performanceCores?: number;
  efficiencyCores?: number;
  utilizationPercent: number;
}

export interface DiscoveredMemoryInventory {
  totalGB: number;
  availableGB: number;
  usedGB: number;
  unifiedMemory: boolean;
  pressureLevel: 'normal' | 'warn' | 'critical' | 'unknown';
  reservedBySystemGB: number;
  reservedByUserGB: number;
}

export interface DiscoveredDiskInventory {
  mountPoint: string;
  totalGB: number;
  freeGB: number;
  usedPercent: number;
}

export interface DetectedRuntimeDaemon {
  runtimeType: 'lmstudio' | 'ollama' | 'vllm' | 'llama-cpp' | 'other';
  pid?: number;
  command: string;
}

export type HostDiscoveryProvenance =
  | 'local_introspection'
  | 'registered_worker'
  | 'authorized_ssh'
  | 'tailscale_probe'
  | 'configured_endpoint'
  | 'runtime_discovery'
  | 'cloud_provider_api';

/**
 * Rich cross-platform physical host inventory structurally matching `@wazir/core` `PhysicalHostNode`,
 * augmented with live daemon & reachability diagnostics.
 */
export interface DetailedHostInventory {
  kind: 'physical_host';
  machineId: string;
  hostId: string;
  hostname: string;
  aliases: string[];
  os: {
    platform: 'linux' | 'darwin' | 'win32' | string;
    release: string;
    architecture: string;
    appleSiliconGeneration?: string;
  };
  cpu: DiscoveredCpuTopology;
  gpus: DiscoveredGpuDevice[];
  memory: DiscoveredMemoryInventory;
  disk: DiscoveredDiskInventory;
  thermalState?: 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';
  networkIdentityIds: string[];
  localWorkerAvailable: boolean;
  workerIds: string[];
  runtimeIds: string[];
  workloadConflicts: DiscoveredWorkloadConflict[];
  resourceReservationsGB: {
    ramGB: number;
    vramByGpuId: Record<string, number>;
  };
  lastDiscoveredAt: string;
  provenance: HostDiscoveryProvenance[];
  confidence: number;
  reachable: boolean;
  sshTarget?: string;
  detectedDaemons: DetectedRuntimeDaemon[];
  diagnosticError?: string;
}

export interface DiscoverDetailedLocalHostOptions {
  hostId?: string;
  aliases?: string[];
  platform?: 'linux' | 'darwin' | 'win32' | string;
  arch?: string;
  hostname?: string;
  release?: string;
  reservedByUserGB?: number;
  execRunner?: DiscoveryExecRunner;
}

export interface AuthorizedSshHostSpec {
  hostId: string;
  sshTarget: string;
  aliases?: string[];
  timeoutMs?: number;
  reservedByUserGB?: number;
  execRunner?: DiscoveryExecRunner;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function defaultSyncExec(command: string, timeoutMs = 4000): string {
  return execSync(command, {
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();
}

function hashMachineSeed(seed: string): string {
  const hex = createHash('sha256').update(seed.trim().toLowerCase()).digest('hex').slice(0, 16);
  return `host-${hex}`;
}

export function parseDarwinVmStatAvailableBytes(vmStatOutput: string): number | undefined {
  if (!vmStatOutput) return undefined;
  const pageSizeMatch = vmStatOutput.match(/page size of\s+(\d+)\s+bytes/i);
  const pageSize = pageSizeMatch ? Number.parseInt(pageSizeMatch[1], 10) : 16384;
  if (!Number.isFinite(pageSize) || pageSize <= 0) return undefined;

  const readPages = (label: string): number | undefined => {
    const match = vmStatOutput.match(new RegExp(`${label}:\\s*(\\d+)`, 'i'));
    return match ? Number.parseInt(match[1], 10) : undefined;
  };

  const freePages = readPages('Pages free');
  const inactivePages = readPages('Pages inactive');
  const speculativePages = readPages('Pages speculative') ?? 0;
  if (freePages === undefined && inactivePages === undefined) {
    return undefined;
  }
  return ((freePages ?? 0) + (inactivePages ?? 0) + speculativePages) * pageSize;
}

export function parseLinuxMeminfoBytes(meminfo: string): { totalBytes?: number; availableBytes?: number } {
  if (!meminfo) return {};
  const totalMatch = meminfo.match(/^MemTotal:\s*(\d+)\s*kB/im);
  const availMatch = meminfo.match(/^MemAvailable:\s*(\d+)\s*kB/im);
  const freeMatch = meminfo.match(/^MemFree:\s*(\d+)\s*kB/im);
  const buffersMatch = meminfo.match(/^Buffers:\s*(\d+)\s*kB/im);
  const cachedMatch = meminfo.match(/^Cached:\s*(\d+)\s*kB/im);

  const totalBytes = totalMatch ? Number.parseInt(totalMatch[1], 10) * 1024 : undefined;
  let availableBytes: number | undefined;
  if (availMatch) {
    availableBytes = Number.parseInt(availMatch[1], 10) * 1024;
  } else if (freeMatch) {
    const kb =
      Number.parseInt(freeMatch[1], 10) +
      (buffersMatch ? Number.parseInt(buffersMatch[1], 10) : 0) +
      (cachedMatch ? Number.parseInt(cachedMatch[1], 10) : 0);
    availableBytes = kb * 1024;
  }
  return { totalBytes, availableBytes };
}

function extractUuidFromOutput(output: string): string | undefined {
  if (!output) return undefined;
  const darwinMatch = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/i);
  if (darwinMatch?.[1]?.trim()) {
    return darwinMatch[1].trim();
  }
  const winMatch = output.match(/MachineGuid\s+REG_SZ\s+([A-Za-z0-9-]+)/i);
  if (winMatch?.[1]?.trim()) {
    return winMatch[1].trim();
  }
  const firstLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^[0-9a-f]{16,64}$/i.test(line) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(line));
  return firstLine;
}

/**
 * Computes a deterministic hardware machine identifier (`host-<16hex>`) hashed with SHA-256
 * from OS hardware UUIDs (`IOPlatformUUID`, `/etc/machine-id`, or Windows `MachineGuid`),
 * falling back deterministically to `hostname+platform+arch` only when OS UUIDs are unavailable.
 */
export function discoverStableMachineId(
  execOverride?: ((command: string, timeoutMs?: number) => string) | StableMachineIdOptions,
): string {
  const opts: StableMachineIdOptions =
    typeof execOverride === 'function' ? { execRunner: execOverride } : (execOverride ?? {});
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const hostname = opts.hostname ?? os.hostname();
  const hasCustomRunner = Boolean(opts.execRunner || opts.readFile);
  const runCmd = opts.execRunner ?? defaultSyncExec;
  const readText = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  const tryDarwin = (): string | undefined => {
    try {
      return extractUuidFromOutput(runCmd('ioreg -rd1 -c IOPlatformExpertDevice', 3000));
    } catch {
      return undefined;
    }
  };

  const tryLinux = (): string | undefined => {
    for (const candidatePath of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      if (!opts.execRunner || opts.readFile) {
        try {
          const content = extractUuidFromOutput(readText(candidatePath));
          if (content) return content;
        } catch {
          // try command fallback when custom execRunner is supplied
        }
      }
      if (opts.execRunner) {
        try {
          const content = extractUuidFromOutput(runCmd(`cat ${candidatePath}`, 2000));
          if (content) return content;
        } catch {
          // ignore
        }
      }
    }
    return undefined;
  };

  const tryWindows = (): string | undefined => {
    try {
      return extractUuidFromOutput(
        runCmd('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', 3000),
      );
    } catch {
      return undefined;
    }
  };

  let rawUuid: string | undefined;
  if (platform === 'darwin') {
    rawUuid = tryDarwin();
  } else if (platform === 'linux') {
    rawUuid = tryLinux();
  } else if (platform === 'win32') {
    rawUuid = tryWindows();
  }

  // Support cross-platform deterministic unit tests passing an execOverride on any host OS
  if (!rawUuid && hasCustomRunner && !opts.platform) {
    rawUuid = tryDarwin() ?? tryLinux() ?? tryWindows();
  }

  if (rawUuid) {
    return hashMachineSeed(`uuid:${rawUuid}`);
  }
  return hashMachineSeed(`fallback:${hostname}:${platform}:${arch}`);
}

export async function discoverHardware(): Promise<HardwareReport> {
  const osInfo: OSInfo = {
    platform: process.platform,
    architecture: process.arch,
    version: process.version,
  };

  const hardware: HardwareInfo = {
    cpu: discoverCpu(),
    cpuCores: os.cpus().length,
    memoryGB: Math.max(1, Math.round(os.totalmem() / (1024 ** 3))),
    gpu: await discoverGpu(),
  };

  return { hardware, os: osInfo };
}

let cachedCpuModel: string | undefined;

function discoverCpu(): string {
  if (cachedCpuModel !== undefined) {
    return cachedCpuModel;
  }
  const nodeModel = os.cpus()[0]?.model?.trim();
  if (nodeModel && nodeModel !== 'Unknown CPU' && nodeModel !== 'unknown' && !/^generic|^arm$|^aarch64$/i.test(nodeModel)) {
    cachedCpuModel = nodeModel;
    return cachedCpuModel;
  }
  try {
    if (process.platform === 'win32') {
      try {
        const out = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Processor).Name"', {
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).toString().trim();
        if (out) {
          cachedCpuModel = out.split('\n')[0].trim();
          return cachedCpuModel;
        }
      } catch {
        // powershell or CIM unavailable
      }
      try {
        const out = execSync('wmic cpu get name /value', { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        const match = out.match(/Name=(.+)/);
        if (match) {
          cachedCpuModel = match[1].trim();
          return cachedCpuModel;
        }
      } catch {
        // wmic deprecated or not installed
      }
    }
    if (process.platform === 'darwin') {
      cachedCpuModel = execSync('sysctl -n machdep.cpu.brand_string', { timeout: 5000 }).toString().trim();
      return cachedCpuModel;
    }
    if (process.platform === 'linux') {
      try {
        const info = readFileSync('/proc/cpuinfo', 'utf8');
        const match = info.match(/model name\s*:\s*(.+)/);
        if (match) {
          cachedCpuModel = match[1].trim();
          return cachedCpuModel;
        }
      } catch {
        // /proc/cpuinfo read failed
      }
      // On ARM64 (e.g. DGX Spark / Grace / Ampere), /proc/cpuinfo often lacks 'model name'
      try {
        const lscpu = execSync('lscpu', { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        const matchLscpu = lscpu.match(/Model name:\s*(.+)/);
        if (matchLscpu) {
          cachedCpuModel = matchLscpu[1].trim();
          return cachedCpuModel;
        }
      } catch {
        // lscpu unavailable
      }
    }
  } catch {
    // fall through
  }
  const defaultModel = os.cpus()[0]?.model?.trim();
  cachedCpuModel = defaultModel && defaultModel !== 'unknown' ? defaultModel : 'Unknown CPU';
  return cachedCpuModel;
}

let cachedGpuInfo: { resolved: boolean; value?: GPUInfo } = { resolved: false };
let cachedGpuLoad: { expiresAt: number; value: { gpuMemoryAvailableGB?: number; gpuMemoryUsedGB?: number; gpuUtilizationPercent?: number } } | undefined;

/** Estimate reclaimable unified memory from vm_stat's free, inactive and
 * speculative queues. Purgeable pages can overlap those queues, so must not
 * be added again. Keep the scheduler's safety reserve for reclaim uncertainty. */
export function macAvailableMemoryGB(vmStat: string): number | undefined {
  const pageSize = Number(vmStat.match(/page size of (\d+) bytes/i)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return undefined;
  let foundCounter = false;
  const pages = ['free', 'inactive', 'speculative'].map((name) => {
    const value = vmStat.match(new RegExp(`Pages ${name}:\\s*([\\d,]+)`, 'i'))?.[1];
    if (value === undefined) return 0;
    foundCounter = true;
    return Number(value.replaceAll(',', ''));
  });
  if (!foundCounter || pages.some((value) => !Number.isFinite(value) || value < 0)) return undefined;
  return pages.reduce((sum, value) => sum + value, 0) * pageSize / (1024 ** 3);
}

async function discoverGpu(): Promise<GPUInfo | undefined> {
  if (cachedGpuInfo.resolved) {
    return cachedGpuInfo.value;
  }
  try {
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      // Apple Silicon: unified memory is shared with the GPU (measured strictly via os.totalmem())
      const totalGB = Math.max(1, Math.round(os.totalmem() / (1024 ** 3)));
      const cpuBrand = discoverCpu();
      const chipLabel = cpuBrand && /apple/i.test(cpuBrand) ? `${cpuBrand} GPU (unified memory)` : 'Apple GPU (unified memory)';
      const info: GPUInfo = {
        vendor: 'apple',
        model: chipLabel,
        memoryGB: totalGB,
        unifiedMemory: true,
      };
      cachedGpuInfo = { resolved: true, value: info };
      return info;
    }
    if (process.platform === 'linux' || process.platform === 'win32') {
      const info = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader', {
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim();
      if (info) {
        const [model, memoryMB] = info.split('\n')[0].split(',').map((part) => part.trim());
        const dedicatedMiB = Number.parseFloat(memoryMB ?? '');
        const report = !Number.isFinite(dedicatedMiB)
          ? execSync('nvidia-smi -q', { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString() : '';
        // ATS alone can coexist with discrete memory. Require absent framebuffer
        // capacity and a coherent CPU/GPU link before treating the pool as shared.
        const unifiedMemory = !Number.isFinite(dedicatedMiB) && /Addressing Mode\s*:\s*ATS/.test(report) && /GPU C2C Mode\s*:\s*Enabled/.test(report);
        const memGB = unifiedMemory
          ? Math.max(1, Math.round(os.totalmem() / (1024 ** 3)))
          : Number.isFinite(dedicatedMiB)
            ? Math.max(0, Math.round(dedicatedMiB / 1024))
            : 0;
        const gpuInfo: GPUInfo = {
          vendor: 'nvidia',
          model: model ?? 'NVIDIA GPU',
          memoryGB: memGB,
          unifiedMemory,
          cuda: true,
        };
        cachedGpuInfo = { resolved: true, value: gpuInfo };
        return gpuInfo;
      }
    }
  } catch {
    // no GPU tooling available
  }
  cachedGpuInfo = { resolved: true, value: undefined };
  return undefined;
}

function measureTrueAvailableMemoryBytes(): number {
  if (process.platform === 'darwin') {
    try {
      const vmStat = execSync('vm_stat', { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const parsed = parseDarwinVmStatAvailableBytes(vmStat);
      if (parsed !== undefined && parsed > 0) {
        return Math.min(os.totalmem(), parsed);
      }
    } catch {
      // fall back to os.freemem()
    }
  } else if (process.platform === 'linux') {
    try {
      const meminfo = readFileSync('/proc/meminfo', 'utf8');
      const { availableBytes } = parseLinuxMeminfoBytes(meminfo);
      if (availableBytes !== undefined && availableBytes >= 0) {
        return Math.min(os.totalmem(), availableBytes);
      }
    } catch {
      // fall back to os.freemem()
    }
  }
  return os.freemem();
}

export function currentLoad(): {
  cpuPercent: number;
  memoryUsedGB: number;
  memoryAvailableGB: number;
  gpuMemoryAvailableGB?: number;
  gpuMemoryUsedGB?: number;
  gpuUtilizationPercent?: number;
} {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
    idle += cpu.times.idle;
  }
  const cpuPercent = total > 0 ? Math.round(100 * (1 - idle / total)) : 0;
  const totalGB = round1(os.totalmem() / (1024 ** 3));
  const availBytes = measureTrueAvailableMemoryBytes();
  const availableGB = Math.min(totalGB, round1(availBytes / (1024 ** 3)));
  let gpu: { gpuMemoryAvailableGB?: number; gpuMemoryUsedGB?: number; gpuUtilizationPercent?: number } = {};
  if (process.platform === 'linux' || process.platform === 'win32') {
    const now = Date.now();
    if (cachedGpuLoad && cachedGpuLoad.expiresAt > now) {
      gpu = cachedGpuLoad.value;
    } else {
      try {
        const values = execSync('nvidia-smi --query-gpu=memory.free,memory.used,utilization.gpu --format=csv,noheader,nounits', { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')[0].split(',').map(Number);
        if (Number.isFinite(values[0])) gpu.gpuMemoryAvailableGB = values[0] / 1024;
        if (Number.isFinite(values[1])) gpu.gpuMemoryUsedGB = values[1] / 1024;
        if (Number.isFinite(values[2])) gpu.gpuUtilizationPercent = values[2];
      } catch { /* Unknown GPU availability must not become zero or total capacity. */ }
      cachedGpuLoad = { expiresAt: now + 3000, value: gpu };
    }
  }
  return {
    ...gpu,
    cpuPercent,
    memoryUsedGB: Math.max(0, round1(totalGB - availableGB)),
    memoryAvailableGB: availableGB,
  };
}

function classifyMemoryPressure(totalGB: number, availableGB: number, pressureRaw?: string): 'normal' | 'warn' | 'critical' | 'unknown' {
  if (pressureRaw) {
    const freePctMatch = pressureRaw.match(/System-wide memory free percentage:\s*(\d+)%/i);
    if (freePctMatch) {
      const pct = Number.parseInt(freePctMatch[1], 10);
      if (pct <= 8) return 'critical';
      if (pct <= 18) return 'warn';
      return 'normal';
    }
  }
  if (totalGB <= 0) return 'unknown';
  const ratio = availableGB / totalGB;
  if (ratio <= 0.08) return 'critical';
  if (ratio <= 0.18) return 'warn';
  return 'normal';
}

function classifyComputeConflict(
  pid: number | undefined,
  processName: string,
  usedMiB: number,
  gpuId?: string,
): DiscoveredWorkloadConflict {
  const lower = processName.toLowerCase();
  const vramGB = Number.isFinite(usedMiB) && usedMiB > 0 ? round2(usedMiB / 1024) : 0;
  if (/isaac[-_]?sim|kit\.exe|omni\.|carlaue4|carla|mujoco|gazebo|gzserver|airsim|habitat/.test(lower)) {
    return {
      pid,
      processName,
      kind: 'simulation',
      gpuId,
      reservedVramGB: vramGB,
      reservedRamGB: 0,
      doNotInterrupt: true,
    };
  }
  if (/blender|unreal|ue4|ue5|unity/.test(lower)) {
    return {
      pid,
      processName,
      kind: 'rendering',
      gpuId,
      reservedVramGB: vramGB,
      reservedRamGB: 0,
      doNotInterrupt: true,
    };
  }
  if (/torchrun|deepspeed|accelerate|train\.py/.test(lower)) {
    return {
      pid,
      processName,
      kind: 'training',
      gpuId,
      reservedVramGB: vramGB,
      reservedRamGB: 0,
      doNotInterrupt: true,
    };
  }
  if (/ollama|lmstudio|lms\b|llmster|llama-server|vllm|sglang|tgi/.test(lower)) {
    return {
      pid,
      processName,
      kind: 'inference',
      gpuId,
      reservedVramGB: vramGB,
      reservedRamGB: 0,
      doNotInterrupt: false,
    };
  }
  return {
    pid,
    processName,
    kind: 'other',
    gpuId,
    reservedVramGB: vramGB,
    reservedRamGB: 0,
    doNotInterrupt: false,
  };
}

export function parseNvidiaGpusAndConflicts(params: {
  nvidiaGpuCsv: string;
  nvidiaQueryDetail?: string;
  nvidiaComputeAppsCsv?: string;
  hostTotalMemoryGB: number;
  hostAvailableMemoryGB: number;
}): {
  gpus: DiscoveredGpuDevice[];
  conflicts: DiscoveredWorkloadConflict[];
  isUnifiedNvidia: boolean;
} {
  const { nvidiaGpuCsv, nvidiaQueryDetail = '', nvidiaComputeAppsCsv = '', hostTotalMemoryGB, hostAvailableMemoryGB } = params;
  const gpus: DiscoveredGpuDevice[] = [];
  let isUnifiedNvidia = false;
  const cudaMatch = nvidiaQueryDetail.match(/CUDA Version\s*:\s*([0-9.]+)/i);
  const cudaVersion = cudaMatch?.[1];
  const hasAtsAndC2C =
    /Addressing Mode\s*:\s*ATS/i.test(nvidiaQueryDetail) &&
    /GPU C2C Mode\s*:\s*Enabled/i.test(nvidiaQueryDetail);

  const lines = nvidiaGpuCsv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 5) continue;
    const index = Number.parseInt(parts[0], 10);
    const gpuId = parts[1] || `nvidia-gpu-${Number.isFinite(index) ? index : gpus.length}`;
    const model = parts[2] || 'NVIDIA GPU';
    const driverVersion = parts[3] && !/n\/a/i.test(parts[3]) ? parts[3] : undefined;
    const totalMiB = Number.parseFloat(parts[4]);
    const freeMiB = parts[5] !== undefined ? Number.parseFloat(parts[5]) : Number.NaN;
    const usedMiB = parts[6] !== undefined ? Number.parseFloat(parts[6]) : Number.NaN;
    const utilPct = parts[7] !== undefined ? Number.parseFloat(parts[7]) : Number.NaN;
    const tempC = parts[8] !== undefined ? Number.parseFloat(parts[8]) : Number.NaN;

    const unified = !Number.isFinite(totalMiB) && hasAtsAndC2C;
    if (unified) {
      isUnifiedNvidia = true;
    }
    const totalMemoryGB = unified
      ? hostTotalMemoryGB
      : Number.isFinite(totalMiB)
        ? round2(totalMiB / 1024)
        : 0;
    const availableMemoryGB = unified
      ? hostAvailableMemoryGB
      : Number.isFinite(freeMiB)
        ? round2(freeMiB / 1024)
        : undefined;
    const usedMemoryGB = unified
      ? Math.max(0, round2(hostTotalMemoryGB - hostAvailableMemoryGB))
      : Number.isFinite(usedMiB)
        ? round2(usedMiB / 1024)
        : undefined;

    gpus.push({
      gpuId,
      index: Number.isFinite(index) ? index : gpus.length,
      vendor: 'nvidia',
      model,
      driverVersion,
      cudaVersion,
      unifiedMemory: unified,
      totalMemoryGB,
      availableMemoryGB,
      usedMemoryGB,
      utilizationPercent: Number.isFinite(utilPct) ? utilPct : undefined,
      temperatureCelsius: Number.isFinite(tempC) ? tempC : undefined,
    });
  }

  const conflicts: DiscoveredWorkloadConflict[] = [];
  const defaultGpuId = gpus[0]?.gpuId;
  for (const rawLine of nvidiaComputeAppsCsv.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^no running/i.test(line)) continue;
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length >= 4) {
      const pid = Number.parseInt(cols[0], 10);
      const gpuUuid = cols[1] || defaultGpuId;
      const procName = cols[2];
      const usedMiB = Number.parseFloat(cols[3]);
      if (procName) {
        conflicts.push(classifyComputeConflict(Number.isFinite(pid) ? pid : undefined, procName, usedMiB, gpuUuid));
      }
    } else if (cols.length === 3) {
      const pid = Number.parseInt(cols[0], 10);
      const procName = cols[1];
      const usedMiB = Number.parseFloat(cols[2]);
      if (procName) {
        conflicts.push(classifyComputeConflict(Number.isFinite(pid) ? pid : undefined, procName, usedMiB, defaultGpuId));
      }
    }
  }

  return { gpus, conflicts, isUnifiedNvidia };
}

function parseRunningDaemons(psOutput: string): DetectedRuntimeDaemon[] {
  const daemons: DetectedRuntimeDaemon[] = [];
  const seen = new Set<string>();
  for (const rawLine of psOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let pid: number | undefined;
    let cmd = line;
    const posixMatch = line.match(/^(\d+)\s+(.+)$/);
    if (posixMatch) {
      pid = Number.parseInt(posixMatch[1], 10);
      cmd = posixMatch[2].trim();
    } else if (line.startsWith('"')) {
      // Windows tasklist /FO CSV: "ollama.exe","1234","Console",...
      const csvParts = line.split('","').map((s) => s.replace(/^"|"$/g, ''));
      if (csvParts.length >= 2) {
        cmd = csvParts[0];
        const parsedPid = Number.parseInt(csvParts[1], 10);
        if (Number.isFinite(parsedPid)) pid = parsedPid;
      }
    }
    const lower = cmd.toLowerCase();
    if (/grep\s+/.test(lower)) continue;

    let runtimeType: DetectedRuntimeDaemon['runtimeType'] | undefined;
    if (/\bollama(\.exe)?\b/.test(lower) && (/serve|ollama\.exe|ollama_llama_server|\/ollama(\s|$)/.test(lower) || cmd === 'ollama')) {
      runtimeType = 'ollama';
    } else if (/lm\s*studio|llmster|\blms(\.exe)?\s+server/.test(lower)) {
      runtimeType = 'lmstudio';
    } else if (/\bvllm\b/.test(lower)) {
      runtimeType = 'vllm';
    } else if (/llama-server(\.exe)?/.test(lower)) {
      runtimeType = 'llama-cpp';
    }

    if (runtimeType && !seen.has(runtimeType)) {
      seen.add(runtimeType);
      daemons.push({ runtimeType, pid, command: cmd });
    }
  }
  return daemons;
}

function parsePosixDfRoot(dfOutput: string): DiscoveredDiskInventory | undefined {
  const lines = dfOutput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^filesystem/i.test(l));
  if (lines.length === 0) return undefined;
  const cols = lines[lines.length - 1].split(/\s+/);
  // df -kP /: Filesystem 1024-blocks Used Available Capacity Mounted-on
  if (cols.length < 6) return undefined;
  const totalKB = Number.parseFloat(cols[1]);
  const availKB = Number.parseFloat(cols[3]);
  const mountPoint = cols[5] || '/';
  if (!Number.isFinite(totalKB) || totalKB <= 0) return undefined;
  const totalGB = round1((totalKB * 1024) / (1024 ** 3));
  const freeGB = Number.isFinite(availKB) ? round1((availKB * 1024) / (1024 ** 3)) : 0;
  const usedPercent = totalGB > 0 ? Math.min(100, Math.max(0, round1(((totalGB - freeGB) / totalGB) * 100))) : 0;
  return { mountPoint, totalGB, freeGB, usedPercent };
}

async function safeExec(runner: DiscoveryExecRunner, cmd: string, timeoutMs = 3000): Promise<string> {
  try {
    const out = await runner(cmd, timeoutMs);
    return typeof out === 'string' ? out : '';
  } catch {
    return '';
  }
}

/**
 * Discovers rich cross-platform local hardware inventory without ever inferring RAM/VRAM from model names.
 */
export async function discoverDetailedLocalHost(
  options: DiscoverDetailedLocalHostOptions = {},
): Promise<DetailedHostInventory> {
  const hasCustomRunner = Boolean(options.execRunner);
  const runner: DiscoveryExecRunner = options.execRunner ?? ((cmd, timeout) => defaultSyncExec(cmd, timeout));
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const hostname = options.hostname ?? os.hostname();
  const release = options.release ?? os.release();
  const hostId = options.hostId ?? hostname;

  // Compute machine ID deterministically
  let machineUuidOut = '';
  if (platform === 'darwin') {
    machineUuidOut = await safeExec(runner, 'ioreg -rd1 -c IOPlatformExpertDevice', 3000);
  } else if (platform === 'linux') {
    if (!hasCustomRunner) {
      try {
        machineUuidOut = readFileSync('/etc/machine-id', 'utf8');
      } catch {
        try {
          machineUuidOut = readFileSync('/var/lib/dbus/machine-id', 'utf8');
        } catch {
          machineUuidOut = '';
        }
      }
    } else {
      machineUuidOut =
        (await safeExec(runner, 'cat /etc/machine-id', 2000)) ||
        (await safeExec(runner, 'cat /var/lib/dbus/machine-id', 2000));
    }
  } else if (platform === 'win32') {
    machineUuidOut = await safeExec(
      runner,
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
      3000,
    );
  }
  const uuid = extractUuidFromOutput(machineUuidOut);
  const machineId = uuid
    ? hashMachineSeed(`uuid:${uuid}`)
    : hashMachineSeed(`fallback:${hostname}:${platform}:${arch}`);

  let cpuBrand = 'Unknown CPU';
  let logicalCores = hasCustomRunner ? 0 : os.cpus().length;
  let physicalCores: number | undefined;
  let performanceCores: number | undefined;
  let efficiencyCores: number | undefined;
  let cpuUtilPct = 0;
  let appleSiliconGeneration: string | undefined;

  let totalMemoryGB = 0;
  let availableMemoryGB = 0;
  let unifiedMemory = false;
  let pressureRaw = '';

  const gpus: DiscoveredGpuDevice[] = [];
  const workloadConflicts: DiscoveredWorkloadConflict[] = [];

  if (platform === 'darwin') {
    const [brandOut, logicalOut, physOut, perfOut, effOut, memsizeOut, vmStatOut, pressureOut] = await Promise.all([
      safeExec(runner, 'sysctl -n machdep.cpu.brand_string', 2000),
      safeExec(runner, 'sysctl -n hw.logicalcpu', 2000),
      safeExec(runner, 'sysctl -n hw.physicalcpu', 2000),
      safeExec(runner, 'sysctl -n hw.perflevel0.physicalcpu', 2000),
      safeExec(runner, 'sysctl -n hw.perflevel1.physicalcpu', 2000),
      safeExec(runner, 'sysctl -n hw.memsize', 2000),
      safeExec(runner, 'vm_stat', 2000),
      safeExec(runner, 'memory_pressure', 2000),
    ]);

    cpuBrand = brandOut.trim() || (!hasCustomRunner ? discoverCpu() : 'Unknown CPU');
    const genMatch = cpuBrand.match(/Apple\s+(M\d+(?:\s+(?:Pro|Max|Ultra))?)/i);
    if (genMatch) appleSiliconGeneration = genMatch[1];

    const parsedLogical = Number.parseInt(logicalOut.trim(), 10);
    if (Number.isFinite(parsedLogical) && parsedLogical > 0) logicalCores = parsedLogical;
    const parsedPhys = Number.parseInt(physOut.trim(), 10);
    if (Number.isFinite(parsedPhys) && parsedPhys > 0) physicalCores = parsedPhys;
    const parsedPerf = Number.parseInt(perfOut.trim(), 10);
    if (Number.isFinite(parsedPerf) && parsedPerf > 0) performanceCores = parsedPerf;
    const parsedEff = Number.parseInt(effOut.trim(), 10);
    if (Number.isFinite(parsedEff) && parsedEff > 0) efficiencyCores = parsedEff;

    const memBytes = Number.parseFloat(memsizeOut.trim());
    const effectiveTotalBytes = Number.isFinite(memBytes) && memBytes > 0 ? memBytes : (!hasCustomRunner ? os.totalmem() : 0);
    totalMemoryGB = round2(effectiveTotalBytes / (1024 ** 3));

    const vmAvailBytes = parseDarwinVmStatAvailableBytes(vmStatOut);
    const effectiveAvailBytes =
      vmAvailBytes !== undefined
        ? Math.min(effectiveTotalBytes, vmAvailBytes)
        : (!hasCustomRunner ? os.freemem() : 0);
    availableMemoryGB = Math.min(totalMemoryGB, round2(effectiveAvailBytes / (1024 ** 3)));
    pressureRaw = pressureOut;

    if (arch === 'arm64' || arch === 'aarch64' || Boolean(appleSiliconGeneration)) {
      unifiedMemory = true;
      const gpuLabel = /apple/i.test(cpuBrand) ? `${cpuBrand} GPU (unified memory)` : 'Apple GPU (unified memory)';
      gpus.push({
        gpuId: `${hostId}-apple-gpu-0`,
        index: 0,
        vendor: 'apple',
        model: gpuLabel,
        metalSupported: true,
        mpsSupported: true,
        unifiedMemory: true,
        totalMemoryGB,
        availableMemoryGB,
        usedMemoryGB: Math.max(0, round2(totalMemoryGB - availableMemoryGB)),
      });
    }
  } else if (platform === 'linux') {
    const meminfoText = !hasCustomRunner
      ? (() => {
          try {
            return readFileSync('/proc/meminfo', 'utf8');
          } catch {
            return '';
          }
        })()
      : await safeExec(runner, 'cat /proc/meminfo', 2000);
    const { totalBytes, availableBytes } = parseLinuxMeminfoBytes(meminfoText);
    const effectiveTotal = totalBytes ?? (!hasCustomRunner ? os.totalmem() : 0);
    const effectiveAvail = availableBytes ?? (!hasCustomRunner ? os.freemem() : 0);
    totalMemoryGB = round2(effectiveTotal / (1024 ** 3));
    availableMemoryGB = Math.min(totalMemoryGB, round2(effectiveAvail / (1024 ** 3)));

    const [cpuinfoText, lscpuText, nvidiaCsv, nvidiaAppsCsv] = await Promise.all([
      !hasCustomRunner
        ? Promise.resolve(
            (() => {
              try {
                return readFileSync('/proc/cpuinfo', 'utf8');
              } catch {
                return '';
              }
            })(),
          )
        : safeExec(runner, 'cat /proc/cpuinfo', 2000),
      safeExec(runner, 'lscpu', 2000),
      safeExec(
        runner,
        'nvidia-smi --query-gpu=index,uuid,name,driver_version,memory.total,memory.free,memory.used,utilization.gpu,temperature.gpu --format=csv,noheader,nounits',
        4000,
      ),
      safeExec(
        runner,
        'nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits',
        3000,
      ),
    ]);

    const cpuMatch = cpuinfoText.match(/model name\s*:\s*(.+)/i) ?? lscpuText.match(/Model name:\s*(.+)/i);
    if (cpuMatch?.[1]) cpuBrand = cpuMatch[1].trim();
    const lscpuLogical = lscpuText.match(/^CPU\(s\):\s*(\d+)/im);
    if (lscpuLogical) logicalCores = Number.parseInt(lscpuLogical[1], 10);
    const coresPerSocket = lscpuText.match(/Core\(s\) per socket:\s*(\d+)/i);
    const sockets = lscpuText.match(/Socket\(s\):\s*(\d+)/i);
    if (coresPerSocket && sockets) {
      physicalCores = Number.parseInt(coresPerSocket[1], 10) * Number.parseInt(sockets[1], 10);
    }

    if (nvidiaCsv.trim()) {
      const nvidiaDetail = await safeExec(runner, 'nvidia-smi -q', 4000);
      const parsedNvidia = parseNvidiaGpusAndConflicts({
        nvidiaGpuCsv: nvidiaCsv,
        nvidiaQueryDetail: nvidiaDetail,
        nvidiaComputeAppsCsv: nvidiaAppsCsv,
        hostTotalMemoryGB: totalMemoryGB,
        hostAvailableMemoryGB: availableMemoryGB,
      });
      gpus.push(...parsedNvidia.gpus);
      workloadConflicts.push(...parsedNvidia.conflicts);
      if (parsedNvidia.isUnifiedNvidia) {
        unifiedMemory = true;
      }
    }
  } else if (platform === 'win32') {
    const [cimOut, nvidiaCsv, nvidiaAppsCsv] = await Promise.all([
      safeExec(
        runner,
        'powershell -NoProfile -Command "$os = Get-CimInstance Win32_OperatingSystem; $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1; $vc = Get-CimInstance Win32_VideoController; [pscustomobject]@{ TotalVisibleMemoryKB = $os.TotalVisibleMemorySize; FreePhysicalMemoryKB = $os.FreePhysicalMemory; CpuName = $cpu.Name; PhysicalCores = $cpu.NumberOfCores; LogicalCores = $cpu.NumberOfLogicalProcessors; CpuLoad = $cpu.LoadPercentage; VideoControllers = @($vc | Select-Object Name,DriverVersion,AdapterRAM) } | ConvertTo-Json -Compress"',
        5000,
      ),
      safeExec(
        runner,
        'nvidia-smi --query-gpu=index,uuid,name,driver_version,memory.total,memory.free,memory.used,utilization.gpu,temperature.gpu --format=csv,noheader,nounits',
        4000,
      ),
      safeExec(
        runner,
        'nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits',
        3000,
      ),
    ]);

    let cimControllers: Array<{ Name?: string; DriverVersion?: string; AdapterRAM?: number }> = [];
    if (cimOut.trim()) {
      try {
        const parsed = JSON.parse(cimOut.trim()) as {
          TotalVisibleMemoryKB?: number;
          FreePhysicalMemoryKB?: number;
          CpuName?: string;
          PhysicalCores?: number;
          LogicalCores?: number;
          CpuLoad?: number;
          VideoControllers?: Array<{ Name?: string; DriverVersion?: string; AdapterRAM?: number }>;
        };
        if (parsed.CpuName) cpuBrand = parsed.CpuName.trim();
        if (typeof parsed.LogicalCores === 'number' && parsed.LogicalCores > 0) logicalCores = parsed.LogicalCores;
        if (typeof parsed.PhysicalCores === 'number' && parsed.PhysicalCores > 0) physicalCores = parsed.PhysicalCores;
        if (typeof parsed.CpuLoad === 'number') cpuUtilPct = parsed.CpuLoad;
        if (typeof parsed.TotalVisibleMemoryKB === 'number' && parsed.TotalVisibleMemoryKB > 0) {
          totalMemoryGB = round2((parsed.TotalVisibleMemoryKB * 1024) / (1024 ** 3));
        }
        if (typeof parsed.FreePhysicalMemoryKB === 'number' && parsed.FreePhysicalMemoryKB >= 0) {
          availableMemoryGB = Math.min(totalMemoryGB, round2((parsed.FreePhysicalMemoryKB * 1024) / (1024 ** 3)));
        }
        if (Array.isArray(parsed.VideoControllers)) {
          cimControllers = parsed.VideoControllers;
        }
      } catch {
        // ignore malformed CIM output
      }
    }
    if (totalMemoryGB === 0 && !hasCustomRunner) {
      totalMemoryGB = round2(os.totalmem() / (1024 ** 3));
      availableMemoryGB = round2(os.freemem() / (1024 ** 3));
    }

    if (nvidiaCsv.trim()) {
      const nvidiaDetail = await safeExec(runner, 'nvidia-smi -q', 4000);
      const parsedNvidia = parseNvidiaGpusAndConflicts({
        nvidiaGpuCsv: nvidiaCsv,
        nvidiaQueryDetail: nvidiaDetail,
        nvidiaComputeAppsCsv: nvidiaAppsCsv,
        hostTotalMemoryGB: totalMemoryGB,
        hostAvailableMemoryGB: availableMemoryGB,
      });
      gpus.push(...parsedNvidia.gpus);
      workloadConflicts.push(...parsedNvidia.conflicts);
    } else if (cimControllers.length > 0) {
      cimControllers.forEach((vc, idx) => {
        const name = vc.Name?.trim() || 'Windows GPU';
        if (/microsoft basic|remote desktop/i.test(name)) return;
        const lower = name.toLowerCase();
        const vendor: DiscoveredGpuDevice['vendor'] = lower.includes('nvidia')
          ? 'nvidia'
          : lower.includes('amd') || lower.includes('radeon')
            ? 'amd'
            : lower.includes('intel')
              ? 'intel'
              : 'unknown';
        // Never infer VRAM from the adapter name; only report finite measured bytes when non-truncated.
        const measuredGB =
          typeof vc.AdapterRAM === 'number' && vc.AdapterRAM > 0 && vc.AdapterRAM < 4_293_918_720
            ? round2(vc.AdapterRAM / (1024 ** 3))
            : 0;
        gpus.push({
          gpuId: `${hostId}-win-gpu-${idx}`,
          index: idx,
          vendor,
          model: name,
          driverVersion: vc.DriverVersion,
          unifiedMemory: false,
          totalMemoryGB: measuredGB,
        });
      });
    }
  }

  if (!hasCustomRunner && cpuUtilPct === 0) {
    const loadSnap = currentLoad();
    cpuUtilPct = loadSnap.cpuPercent;
  }

  // Disk inventory
  let disk: DiscoveredDiskInventory = { mountPoint: platform === 'win32' ? 'C:\\' : '/', totalGB: 0, freeGB: 0, usedPercent: 0 };
  if (!hasCustomRunner) {
    try {
      const targetMount = platform === 'win32' ? process.cwd().slice(0, 3) || 'C:\\' : '/';
      const st = statfsSync(targetMount);
      const totalDiskGB = round1((Number(st.blocks) * Number(st.bsize)) / (1024 ** 3));
      const freeDiskGB = round1((Number(st.bavail) * Number(st.bsize)) / (1024 ** 3));
      const usedPercent = totalDiskGB > 0 ? round1(((totalDiskGB - freeDiskGB) / totalDiskGB) * 100) : 0;
      disk = { mountPoint: targetMount, totalGB: totalDiskGB, freeGB: freeDiskGB, usedPercent };
    } catch {
      // fall back to df
    }
  }
  if (disk.totalGB === 0) {
    if (platform === 'win32') {
      const diskOut = await safeExec(
        runner,
        'powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk -Filter \\"DeviceID=\'C:\'\\" | Select-Object Size,FreeSpace | ConvertTo-Json -Compress"',
        3000,
      );
      try {
        const parsedDisk = JSON.parse(diskOut.trim()) as { Size?: number; FreeSpace?: number };
        if (typeof parsedDisk.Size === 'number' && parsedDisk.Size > 0) {
          const totalDiskGB = round1(parsedDisk.Size / (1024 ** 3));
          const freeDiskGB = typeof parsedDisk.FreeSpace === 'number' ? round1(parsedDisk.FreeSpace / (1024 ** 3)) : 0;
          disk = {
            mountPoint: 'C:\\',
            totalGB: totalDiskGB,
            freeGB: freeDiskGB,
            usedPercent: round1(((totalDiskGB - freeDiskGB) / totalDiskGB) * 100),
          };
        }
      } catch {
        // leave 0
      }
    } else {
      const dfOut = await safeExec(runner, 'df -kP /', 2000);
      const parsedDf = parsePosixDfRoot(dfOut);
      if (parsedDf) disk = parsedDf;
    }
  }

  // Running runtime daemons
  const psOutput =
    platform === 'win32'
      ? await safeExec(runner, 'tasklist /FO CSV /NH', 3000)
      : await safeExec(runner, 'ps -axo pid=,args=', 3000);
  const detectedDaemons = parseRunningDaemons(psOutput);

  const vramByGpuId: Record<string, number> = {};
  for (const conflict of workloadConflicts) {
    if (conflict.doNotInterrupt && conflict.gpuId) {
      vramByGpuId[conflict.gpuId] = round2((vramByGpuId[conflict.gpuId] ?? 0) + conflict.reservedVramGB);
    }
  }
  const reservedRamFromConflicts = workloadConflicts
    .filter((c) => c.doNotInterrupt)
    .reduce((sum, c) => sum + c.reservedRamGB, 0);

  const usedMemoryGB = Math.max(0, round2(totalMemoryGB - availableMemoryGB));
  const maxTemp = gpus.reduce((max, g) => Math.max(max, g.temperatureCelsius ?? 0), 0);
  const thermalState: DetailedHostInventory['thermalState'] =
    maxTemp >= 90 ? 'critical' : maxTemp >= 82 ? 'serious' : maxTemp >= 72 ? 'fair' : maxTemp > 0 ? 'nominal' : 'unknown';

  return {
    kind: 'physical_host',
    machineId,
    hostId,
    hostname,
    aliases: options.aliases ? [...new Set([hostname, ...options.aliases])] : [hostname],
    os: {
      platform,
      release,
      architecture: arch,
      appleSiliconGeneration,
    },
    cpu: {
      brand: cpuBrand,
      architecture: arch,
      logicalCores,
      physicalCores,
      performanceCores,
      efficiencyCores,
      utilizationPercent: cpuUtilPct,
    },
    gpus,
    memory: {
      totalGB: totalMemoryGB,
      availableGB: availableMemoryGB,
      usedGB: usedMemoryGB,
      unifiedMemory,
      pressureLevel: classifyMemoryPressure(totalMemoryGB, availableMemoryGB, pressureRaw),
      reservedBySystemGB: totalMemoryGB > 0 ? round2(Math.min(4, totalMemoryGB * 0.08)) : 0,
      reservedByUserGB: options.reservedByUserGB ?? 0,
    },
    disk,
    thermalState,
    networkIdentityIds: [],
    localWorkerAvailable: true,
    workerIds: [],
    runtimeIds: [],
    workloadConflicts,
    resourceReservationsGB: {
      ramGB: round2(reservedRamFromConflicts + (options.reservedByUserGB ?? 0)),
      vramByGpuId,
    },
    lastDiscoveredAt: new Date().toISOString(),
    provenance: ['local_introspection'],
    confidence: totalMemoryGB > 0 ? 1.0 : 0.4,
    reachable: true,
    detectedDaemons,
  };
}

const SSH_REMOTE_PROBE_SCRIPT = [
  'echo ===UNAME===',
  'uname -srm 2>/dev/null || ver 2>/dev/null || true',
  'echo ===HOSTNAME===',
  'hostname 2>/dev/null || true',
  'echo ===MACHINE_ID===',
  'cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null || ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null || reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid 2>/dev/null || true',
  'echo ===MEM===',
  'cat /proc/meminfo 2>/dev/null || (sysctl -n hw.memsize 2>/dev/null && vm_stat 2>/dev/null) || powershell -NoProfile -Command "$os = Get-CimInstance Win32_OperatingSystem; Write-Output (\'WIN_MEM:\' + $os.TotalVisibleMemorySize + \',\' + $os.FreePhysicalMemory)" 2>/dev/null || true',
  'echo ===CPU===',
  'lscpu 2>/dev/null || cat /proc/cpuinfo 2>/dev/null || sysctl machdep.cpu.brand_string hw.logicalcpu hw.physicalcpu hw.perflevel0.physicalcpu hw.perflevel1.physicalcpu 2>/dev/null || powershell -NoProfile -Command "$c = Get-CimInstance Win32_Processor | Select-Object -First 1; Write-Output (\'WIN_CPU:\' + $c.Name + \'|\' + $c.NumberOfCores + \'|\' + $c.NumberOfLogicalProcessors + \'|\' + $c.LoadPercentage)" 2>/dev/null || true',
  'echo ===NVIDIA_GPU===',
  'nvidia-smi --query-gpu=index,uuid,name,driver_version,memory.total,memory.free,memory.used,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>/dev/null || true',
  'echo ===NVIDIA_Q===',
  'nvidia-smi -q 2>/dev/null | grep -E "CUDA Version|Addressing Mode|GPU C2C Mode" || true',
  'echo ===NVIDIA_APPS===',
  'nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null || true',
  'echo ===DISK===',
  'df -kP / 2>/dev/null || powershell -NoProfile -Command "$d = Get-CimInstance Win32_LogicalDisk -Filter \\"DeviceID=\'C:\'\\"; Write-Output (\'WIN_DISK:\' + $d.Size + \',\' + $d.FreeSpace)" 2>/dev/null || true',
  'echo ===DAEMONS===',
  'ps -axo pid=,args= 2>/dev/null | grep -E "[o]llama|[l]mstudio|[L]M Studio|[l]lmster|[v]llm|[l]lama-server" || tasklist /FO CSV /NH 2>/dev/null || true',
].join('\n');

function splitSshSections(rawOutput: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const regex = /^===([A-Z_]+)===\r?\n?/gm;
  let lastKey: string | undefined;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(rawOutput)) !== null) {
    if (lastKey !== undefined) {
      sections[lastKey] = rawOutput.slice(lastIndex, match.index).trim();
    }
    lastKey = match[1];
    lastIndex = regex.lastIndex;
  }
  if (lastKey !== undefined) {
    sections[lastKey] = rawOutput.slice(lastIndex).trim();
  }
  return sections;
}

/**
 * Executes a single read-only BatchMode SSH command against an explicitly authorized SSH host
 * and parses Linux, macOS, or Windows hardware + GPU + conflict state into `DetailedHostInventory`.
 */
export async function discoverAuthorizedSshHost(spec: AuthorizedSshHostSpec): Promise<DetailedHostInventory> {
  const { hostId, sshTarget, aliases = [], timeoutMs = 10000, reservedByUserGB = 0 } = spec;
  if (!sshTarget || /[\s;&|`$<>]/.test(sshTarget)) {
    throw new Error(`Invalid or unsafe sshTarget: '${sshTarget}'`);
  }
  const connectTimeoutSec = Math.max(1, Math.min(10, Math.ceil(timeoutMs / 1000)));
  const sshCommand = `ssh -o BatchMode=yes -o ConnectTimeout=${connectTimeoutSec} ${sshTarget} '${SSH_REMOTE_PROBE_SCRIPT.replace(/'/g, `'\\''`)}'`;
  const runner: DiscoveryExecRunner = spec.execRunner ?? ((cmd, timeout) => defaultSyncExec(cmd, timeout));

  let rawOutput: string;
  try {
    rawOutput = await runner(sshCommand, timeoutMs + 1000);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      kind: 'physical_host',
      machineId: hashMachineSeed(`ssh-unreachable:${hostId}:${sshTarget}`),
      hostId,
      hostname: sshTarget,
      aliases: [...new Set([hostId, sshTarget, ...aliases])],
      os: { platform: 'unknown', release: 'unknown', architecture: 'unknown' },
      cpu: { brand: 'Unknown CPU', architecture: 'unknown', logicalCores: 0, utilizationPercent: 0 },
      gpus: [],
      memory: {
        totalGB: 0,
        availableGB: 0,
        usedGB: 0,
        unifiedMemory: false,
        pressureLevel: 'unknown',
        reservedBySystemGB: 0,
        reservedByUserGB,
      },
      disk: { mountPoint: '/', totalGB: 0, freeGB: 0, usedPercent: 0 },
      thermalState: 'unknown',
      networkIdentityIds: [],
      localWorkerAvailable: false,
      workerIds: [],
      runtimeIds: [],
      workloadConflicts: [],
      resourceReservationsGB: { ramGB: reservedByUserGB, vramByGpuId: {} },
      lastDiscoveredAt: new Date().toISOString(),
      provenance: ['authorized_ssh'],
      confidence: 0,
      reachable: false,
      sshTarget,
      detectedDaemons: [],
      diagnosticError: errMsg,
    };
  }

  const sections = splitSshSections(rawOutput);
  const unameText = sections.UNAME ?? rawOutput;
  const hostname = (sections.HOSTNAME?.split(/\r?\n/)[0]?.trim()) || hostId;
  const machineIdText = sections.MACHINE_ID ?? rawOutput;
  const memText = sections.MEM ?? rawOutput;
  const cpuText = sections.CPU ?? rawOutput;
  const nvidiaGpuText = sections.NVIDIA_GPU ?? '';
  const nvidiaQText = sections.NVIDIA_Q ?? rawOutput;
  const nvidiaAppsText = sections.NVIDIA_APPS ?? '';
  const diskText = sections.DISK ?? '';
  const daemonsText = sections.DAEMONS ?? '';

  // Detect platform/arch/release from uname -srm or Windows markers
  let platform: 'linux' | 'darwin' | 'win32' | string = 'linux';
  let release = 'unknown';
  let arch = 'x86_64';

  const unameLine = unameText.split(/\r?\n/)[0]?.trim() ?? '';
  if (/^darwin\b/i.test(unameLine)) {
    platform = 'darwin';
    const parts = unameLine.split(/\s+/);
    release = parts[1] ?? 'unknown';
    arch = parts[2] === 'arm64' ? 'arm64' : (parts[2] ?? 'x86_64');
  } else if (/^linux\b/i.test(unameLine)) {
    platform = 'linux';
    const parts = unameLine.split(/\s+/);
    release = parts[1] ?? 'unknown';
    arch = parts[2] === 'aarch64' ? 'arm64' : (parts[2] ?? 'x86_64');
  } else if (/windows|microsoft/i.test(unameLine) || /WIN_MEM:|WIN_CPU:|REG_SZ/i.test(rawOutput)) {
    platform = 'win32';
    release = unameLine || 'windows';
    arch = 'x64';
  }

  const uuid = extractUuidFromOutput(machineIdText);
  const machineId = uuid
    ? hashMachineSeed(`uuid:${uuid}`)
    : hashMachineSeed(`fallback:${hostname}:${platform}:${arch}`);

  // Parse memory
  let totalMemoryGB = 0;
  let availableMemoryGB = 0;
  let unifiedMemory = false;

  if (platform === 'linux') {
    const { totalBytes, availableBytes } = parseLinuxMeminfoBytes(memText);
    if (totalBytes) totalMemoryGB = round2(totalBytes / (1024 ** 3));
    if (availableBytes !== undefined) availableMemoryGB = Math.min(totalMemoryGB, round2(availableBytes / (1024 ** 3)));
  } else if (platform === 'darwin') {
    const memLines = memText.split(/\r?\n/);
    const memsizeLine = memLines.find((l) => /^\d{9,}$/.test(l.trim())) ?? memText.match(/hw\.memsize:\s*(\d+)/)?.[1];
    if (memsizeLine) {
      const bytes = Number.parseFloat(memsizeLine.trim());
      if (Number.isFinite(bytes) && bytes > 0) totalMemoryGB = round2(bytes / (1024 ** 3));
    }
    const vmAvail = parseDarwinVmStatAvailableBytes(memText);
    if (vmAvail !== undefined) {
      availableMemoryGB = Math.min(totalMemoryGB, round2(vmAvail / (1024 ** 3)));
    }
  } else if (platform === 'win32') {
    const winMem = memText.match(/WIN_MEM:(\d+),(\d+)/);
    if (winMem) {
      totalMemoryGB = round2((Number.parseFloat(winMem[1]) * 1024) / (1024 ** 3));
      availableMemoryGB = Math.min(totalMemoryGB, round2((Number.parseFloat(winMem[2]) * 1024) / (1024 ** 3)));
    }
  }

  // Parse CPU
  let cpuBrand = 'Unknown CPU';
  let logicalCores = 0;
  let physicalCores: number | undefined;
  let performanceCores: number | undefined;
  let efficiencyCores: number | undefined;
  let cpuUtilPct = 0;
  let appleSiliconGeneration: string | undefined;

  if (platform === 'darwin') {
    const brandMatch = cpuText.match(/machdep\.cpu\.brand_string:\s*(.+)/i);
    if (brandMatch?.[1]) cpuBrand = brandMatch[1].trim();
    const genMatch = cpuBrand.match(/Apple\s+(M\d+(?:\s+(?:Pro|Max|Ultra))?)/i);
    if (genMatch) appleSiliconGeneration = genMatch[1];
    const logMatch = cpuText.match(/hw\.logicalcpu:\s*(\d+)/i);
    if (logMatch) logicalCores = Number.parseInt(logMatch[1], 10);
    const physMatch = cpuText.match(/hw\.physicalcpu:\s*(\d+)/i);
    if (physMatch) physicalCores = Number.parseInt(physMatch[1], 10);
    const perfMatch = cpuText.match(/hw\.perflevel0\.physicalcpu:\s*(\d+)/i);
    if (perfMatch) performanceCores = Number.parseInt(perfMatch[1], 10);
    const effMatch = cpuText.match(/hw\.perflevel1\.physicalcpu:\s*(\d+)/i);
    if (effMatch) efficiencyCores = Number.parseInt(effMatch[1], 10);
  } else if (platform === 'linux') {
    const brandMatch = cpuText.match(/Model name:\s*(.+)/i) ?? cpuText.match(/model name\s*:\s*(.+)/i);
    if (brandMatch?.[1]) cpuBrand = brandMatch[1].trim();
    const logMatch = cpuText.match(/^CPU\(s\):\s*(\d+)/im);
    if (logMatch) {
      logicalCores = Number.parseInt(logMatch[1], 10);
    } else {
      const procMatches = cpuText.match(/^processor\s*:/gim);
      if (procMatches) logicalCores = procMatches.length;
    }
    const cps = cpuText.match(/Core\(s\) per socket:\s*(\d+)/i);
    const socks = cpuText.match(/Socket\(s\):\s*(\d+)/i);
    if (cps && socks) physicalCores = Number.parseInt(cps[1], 10) * Number.parseInt(socks[1], 10);
  } else if (platform === 'win32') {
    const winCpu = cpuText.match(/WIN_CPU:([^|]*)\|(\d*)\|(\d*)\|(\d*)/);
    if (winCpu) {
      if (winCpu[1].trim()) cpuBrand = winCpu[1].trim();
      if (winCpu[2]) physicalCores = Number.parseInt(winCpu[2], 10);
      if (winCpu[3]) logicalCores = Number.parseInt(winCpu[3], 10);
      if (winCpu[4]) cpuUtilPct = Number.parseInt(winCpu[4], 10);
    }
  }

  // Parse GPUs + conflicts
  const gpus: DiscoveredGpuDevice[] = [];
  const workloadConflicts: DiscoveredWorkloadConflict[] = [];

  if (platform === 'darwin' && (arch === 'arm64' || Boolean(appleSiliconGeneration))) {
    unifiedMemory = true;
    const gpuLabel = /apple/i.test(cpuBrand) ? `${cpuBrand} GPU (unified memory)` : 'Apple GPU (unified memory)';
    gpus.push({
      gpuId: `${hostId}-apple-gpu-0`,
      index: 0,
      vendor: 'apple',
      model: gpuLabel,
      metalSupported: true,
      mpsSupported: true,
      unifiedMemory: true,
      totalMemoryGB,
      availableMemoryGB,
      usedMemoryGB: Math.max(0, round2(totalMemoryGB - availableMemoryGB)),
    });
  } else if (nvidiaGpuText.trim()) {
    const parsedNvidia = parseNvidiaGpusAndConflicts({
      nvidiaGpuCsv: nvidiaGpuText,
      nvidiaQueryDetail: nvidiaQText,
      nvidiaComputeAppsCsv: nvidiaAppsText,
      hostTotalMemoryGB: totalMemoryGB,
      hostAvailableMemoryGB: availableMemoryGB,
    });
    gpus.push(...parsedNvidia.gpus);
    workloadConflicts.push(...parsedNvidia.conflicts);
    if (parsedNvidia.isUnifiedNvidia) {
      unifiedMemory = true;
    }
  }

  // Parse Disk
  let disk: DiscoveredDiskInventory = { mountPoint: platform === 'win32' ? 'C:\\' : '/', totalGB: 0, freeGB: 0, usedPercent: 0 };
  const winDisk = diskText.match(/WIN_DISK:(\d+),(\d+)/);
  if (winDisk) {
    const totalDiskGB = round1(Number.parseFloat(winDisk[1]) / (1024 ** 3));
    const freeDiskGB = round1(Number.parseFloat(winDisk[2]) / (1024 ** 3));
    disk = {
      mountPoint: 'C:\\',
      totalGB: totalDiskGB,
      freeGB: freeDiskGB,
      usedPercent: totalDiskGB > 0 ? round1(((totalDiskGB - freeDiskGB) / totalDiskGB) * 100) : 0,
    };
  } else {
    const parsedDf = parsePosixDfRoot(diskText);
    if (parsedDf) disk = parsedDf;
  }

  const detectedDaemons = parseRunningDaemons(daemonsText);

  const vramByGpuId: Record<string, number> = {};
  for (const conflict of workloadConflicts) {
    if (conflict.doNotInterrupt && conflict.gpuId) {
      vramByGpuId[conflict.gpuId] = round2((vramByGpuId[conflict.gpuId] ?? 0) + conflict.reservedVramGB);
    }
  }
  const reservedRamFromConflicts = workloadConflicts
    .filter((c) => c.doNotInterrupt)
    .reduce((sum, c) => sum + c.reservedRamGB, 0);

  const maxTemp = gpus.reduce((max, g) => Math.max(max, g.temperatureCelsius ?? 0), 0);
  const thermalState: DetailedHostInventory['thermalState'] =
    maxTemp >= 90 ? 'critical' : maxTemp >= 82 ? 'serious' : maxTemp >= 72 ? 'fair' : maxTemp > 0 ? 'nominal' : 'unknown';

  return {
    kind: 'physical_host',
    machineId,
    hostId,
    hostname,
    aliases: [...new Set([hostname, sshTarget, ...aliases])],
    os: {
      platform,
      release,
      architecture: arch,
      appleSiliconGeneration,
    },
    cpu: {
      brand: cpuBrand,
      architecture: arch,
      logicalCores,
      physicalCores,
      performanceCores,
      efficiencyCores,
      utilizationPercent: cpuUtilPct,
    },
    gpus,
    memory: {
      totalGB: totalMemoryGB,
      availableGB: availableMemoryGB,
      usedGB: Math.max(0, round2(totalMemoryGB - availableMemoryGB)),
      unifiedMemory,
      pressureLevel: classifyMemoryPressure(totalMemoryGB, availableMemoryGB),
      reservedBySystemGB: totalMemoryGB > 0 ? round2(Math.min(4, totalMemoryGB * 0.08)) : 0,
      reservedByUserGB,
    },
    disk,
    thermalState,
    networkIdentityIds: [],
    localWorkerAvailable: false,
    workerIds: [],
    runtimeIds: [],
    workloadConflicts,
    resourceReservationsGB: {
      ramGB: round2(reservedRamFromConflicts + reservedByUserGB),
      vramByGpuId,
    },
    lastDiscoveredAt: new Date().toISOString(),
    provenance: ['authorized_ssh'],
    confidence: totalMemoryGB > 0 ? 0.95 : 0.3,
    reachable: true,
    sshTarget,
    detectedDaemons,
  };
}
