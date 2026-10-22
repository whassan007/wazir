import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import type { GPUInfo, HardwareInfo, OSInfo } from '@wazir/core';

export interface HardwareReport {
  hardware: HardwareInfo;
  os: OSInfo;
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

function discoverCpu(): string {
  try {
    if (process.platform === 'win32') {
      const model = os.cpus()[0]?.model?.trim();
      if (model && model !== 'Unknown CPU') return model;
      try {
        const out = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Processor).Name"', {
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).toString().trim();
        if (out) return out.split('\n')[0].trim();
      } catch {
        // powershell or CIM unavailable
      }
      try {
        const out = execSync('wmic cpu get name /value', { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        const match = out.match(/Name=(.+)/);
        if (match) return match[1].trim();
      } catch {
        // wmic deprecated or not installed
      }
    }
    if (process.platform === 'darwin') {
      return execSync('sysctl -n machdep.cpu.brand_string', { timeout: 5000 }).toString().trim();
    }
    if (process.platform === 'linux') {
      try {
        const info = readFileSync('/proc/cpuinfo', 'utf8');
        const match = info.match(/model name\s*:\s*(.+)/);
        if (match) return match[1].trim();
      } catch {
        // /proc/cpuinfo read failed
      }
      // On ARM64 (e.g. DGX Spark / Grace / Ampere), /proc/cpuinfo often lacks 'model name'
      try {
        const lscpu = execSync('lscpu', { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        const matchLscpu = lscpu.match(/Model name:\s*(.+)/);
        if (matchLscpu) return matchLscpu[1].trim();
      } catch {
        // lscpu unavailable
      }
    }
  } catch {
    // fall through
  }
  const defaultModel = os.cpus()[0]?.model?.trim();
  return defaultModel && defaultModel !== 'unknown' ? defaultModel : 'Unknown CPU';
}

let cachedGpuInfo: { resolved: boolean; value?: GPUInfo } = { resolved: false };
let cachedGpuLoad: { expiresAt: number; value: { gpuMemoryAvailableGB?: number; gpuMemoryUsedGB?: number; gpuUtilizationPercent?: number } } | undefined;

async function discoverGpu(): Promise<GPUInfo | undefined> {
  if (cachedGpuInfo.resolved) {
    return cachedGpuInfo.value;
  }
  try {
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      // Apple Silicon: unified memory is shared with the GPU
      const totalGB = Math.max(1, Math.round(os.totalmem() / (1024 ** 3)));
      const info: GPUInfo = {
        vendor: 'apple',
        model: 'Apple GPU (unified memory)',
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
        const [model, memoryMB] = info.split(',').map((part) => part.trim());
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
  const totalGB = Math.round(os.totalmem() / (1024 ** 3) * 10) / 10;
  const freeGB = Math.round(os.freemem() / (1024 ** 3) * 10) / 10;
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
    memoryUsedGB: Math.max(0, Math.round((totalGB - freeGB) * 10) / 10),
    memoryAvailableGB: freeGB,
  };
}
