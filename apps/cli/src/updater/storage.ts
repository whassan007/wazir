import { closeSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir } from '../config.js';
import type { UpdateConfig, UpdateRecord } from './types.js';

export const DEFAULT_UPDATE_CONFIG: UpdateConfig = {
  enabled: false,
  intervalSeconds: 300,
  channel: 'stable',
  automaticDownload: true,
  automaticInstall: true,
  deferWhileJobsRunning: true,
  automaticRollback: true,
  verifyArtifacts: true,
  managedFleetRollout: false,
  retainPreviousVersions: 2,
  releaseRepository: 'whassan007/wazir',
};

export function updateDir(): string { return path.join(configDir(), 'updates'); }
export function updateConfigPath(): string { return path.join(updateDir(), 'config.json'); }
export function historyPath(): string { return path.join(updateDir(), 'history.jsonl'); }
export function journalPath(): string { return path.join(updateDir(), 'journal.json'); }
export function lockPath(): string { return path.join(updateDir(), 'updater.lock'); }

function ensureDir(): void {
  mkdirSync(updateDir(), { recursive: true, mode: 0o700 });
  try { chmodSync(updateDir(), 0o700); } catch {}
}

export function loadUpdateConfig(): UpdateConfig {
  ensureDir();
  if (!existsSync(updateConfigPath())) return { ...DEFAULT_UPDATE_CONFIG };
  const raw = JSON.parse(readFileSync(updateConfigPath(), 'utf8')) as Partial<UpdateConfig>;
  const config = { ...DEFAULT_UPDATE_CONFIG, ...raw };
  return validateUpdateConfig(config);
}

export function validateUpdateConfig(config: UpdateConfig): UpdateConfig {
  if (!Number.isInteger(config.intervalSeconds) || config.intervalSeconds < 300 || config.intervalSeconds > 3600) throw new Error('updates.intervalSeconds must be between 300 and 3600 seconds');
  if (!['stable', 'prerelease', 'development'].includes(config.channel)) throw new Error('updates.channel must be stable, prerelease, or development');
  if (config.releaseRepository !== 'whassan007/wazir') throw new Error('Only the official Wazir GitHub repository is a trusted release source');
  if (config.verifyArtifacts !== true) throw new Error('updates.verifyArtifacts must remain enabled');
  if (!Number.isInteger(config.retainPreviousVersions) || config.retainPreviousVersions < 1 || config.retainPreviousVersions > 10) throw new Error('updates.retainPreviousVersions must be between 1 and 10');
  if (config.channel === 'development' && process.env.WAZIR_ALLOW_DEVELOPMENT_UPDATES !== '1') throw new Error('Development updates require WAZIR_ALLOW_DEVELOPMENT_UPDATES=1');
  return config;
}

export function saveUpdateConfig(config: UpdateConfig): void {
  ensureDir();
  const temp = `${updateConfigPath()}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, updateConfigPath());
}

export function appendUpdateRecord(record: UpdateRecord): void {
  ensureDir();
  writeFileSync(historyPath(), `${JSON.stringify(record)}\n`, { flag: 'a', mode: 0o600 });
  try { chmodSync(historyPath(), 0o600); } catch {}
  writeFileSync(journalPath(), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(journalPath(), 0o600); } catch {}
}

export function readUpdateHistory(limit = 50): UpdateRecord[] {
  ensureDir();
  if (!existsSync(historyPath())) return [];
  return readFileSync(historyPath(), 'utf8').split('\n').filter(Boolean).slice(-limit).flatMap((line) => {
    try { return [JSON.parse(line) as UpdateRecord]; } catch { return []; }
  }).reverse();
}

export function acquireUpdateLock(): (() => void) | undefined {
  ensureDir();
  try {
    const fd = openSync(lockPath(), 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    return () => { try { closeSync(fd); } catch {} try { unlinkSync(lockPath()); } catch {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      const lock = JSON.parse(readFileSync(lockPath(), 'utf8')) as { pid?: number };
      if (typeof lock.pid === 'number') {
        try { process.kill(lock.pid, 0); return undefined; } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === 'EPERM') return undefined;
          // Dead owner: recover an abandoned lock.
        }
      }
      unlinkSync(lockPath());
      return acquireUpdateLock();
    } catch { return undefined; }
  }
}

export function hostId(): string { return `${os.hostname()}:${os.platform()}:${os.arch()}`; }
