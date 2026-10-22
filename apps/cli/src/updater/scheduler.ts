import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configDir } from '../config.js';
import { journalPath, loadUpdateConfig, readUpdateHistory, updateDir } from './storage.js';
import { UpdateService, type ApplyStagedUpdateOptions, type CheckForUpdatesOptions, type UpdateServiceOptions } from './service.js';
import type { DrainAndApplyOptions, UpdateRecord } from './types.js';

function schedulerId(id = ''): string { return id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24); }
function serviceName(id = ''): string { const suffix = schedulerId(id); return `wazir-update${suffix ? `-${suffix}` : ''}`; }
function taskName(id = ''): string { const suffix = schedulerId(id); return `WazirAutoUpdate${suffix ? `-${suffix}` : ''}`; }
const quoteSystemd = (s: string) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export function scheduledCommand(): string[] {
  const entry = process.argv[1] && existsSync(process.argv[1]) ? path.resolve(process.argv[1]) : undefined;
  if (!entry) throw new Error('Cannot determine the installed Wazir launcher path for the persistent scheduler');
  if ((process as NodeJS.Process & { isSea?: () => boolean }).isSea?.()) return [process.execPath, 'update', 'check', '--scheduled', '--json'];
  return [process.execPath, entry, 'update', 'check', '--scheduled', '--json'];
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed${result.status === null ? '' : ` (${result.status})`}: ${(result.stderr || result.error?.message || '').trim()}`);
}

export function installUpdateScheduler(intervalSeconds = 300, id = ''): { backend: string; path: string } {
  const args = scheduledCommand();
  const home = os.homedir();
  const suffix = schedulerId(id);
  if (process.platform === 'darwin') {
    const dir = path.join(home, 'Library', 'LaunchAgents');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const label = `ai.wazir.updater${suffix ? `.${suffix}` : ''}`;
    const plist = path.join(dir, `${label}.plist`);
    const command = [...args, ...(suffix ? [] : ['--jitter'])].map((arg) => `    <string>${xml(arg)}</string>`).join('\n');
    const value = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array>\n${command}\n</array>\n<key>EnvironmentVariables</key><dict><key>WAZIR_HOME</key><string>${xml(configDir())}</string></dict>\n<key>StartInterval</key><integer>${intervalSeconds}</integer>\n<key>RunAtLoad</key><true/>\n<key>WorkingDirectory</key><string>${xml(configDir())}</string>\n<key>StandardOutPath</key><string>${xml(path.join(configDir(), 'updates', 'scheduler.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(configDir(), 'updates', 'scheduler.log'))}</string>\n</dict></plist>\n`;
    writeFileSync(plist, value, { mode: 0o600 });
    try { run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, plist]); } catch {}
    run('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 0}`, plist]);
    return { backend: 'launchd-user-agent', path: plist };
  }
  if (process.platform === 'linux') {
    const dir = path.join(home, '.config', 'systemd', 'user');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const servicePath = path.join(dir, `${serviceName(id)}.service`);
    const timerPath = path.join(dir, `${serviceName(id)}.timer`);
    const exec = args.map(quoteSystemd).join(' ');
    writeFileSync(servicePath, `[Unit]\nDescription=Wazir automatic update check\nAfter=network-online.target\n\n[Service]\nType=oneshot\nExecStart=${exec}\nEnvironment=WAZIR_HOME=${quoteSystemd(configDir())}\nNoNewPrivileges=true\nPrivateTmp=true\n\n`, { mode: 0o600 });
    writeFileSync(timerPath, `[Unit]\nDescription=Check Wazir updates every ${intervalSeconds} seconds\n\n[Timer]\nOnBootSec=1min\nOnUnitActiveSec=${intervalSeconds}s\nRandomizedDelaySec=45s\nPersistent=true\nUnit=${serviceName(id)}.service\n\n[Install]\nWantedBy=timers.target\n`, { mode: 0o600 });
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', `${serviceName(id)}.timer`]);
    return { backend: 'systemd-user-timer', path: timerPath };
  }
  if (process.platform === 'win32') {
    mkdirSync(updateDir(), { recursive: true, mode: 0o700 });
    const scriptPath = path.join(updateDir(), 'scheduled-run.ps1');
    const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const command = [...args, ...(suffix ? [] : ['--jitter'])].map(psQuote).join(', ');
    writeFileSync(scriptPath, `$env:WAZIR_HOME = ${psQuote(configDir())}\n$command = @(${command})\n& $command[0] $command[1..($command.Length - 1)]\nexit $LASTEXITCODE\n`, { mode: 0o600 });
    const taskRun = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`;
    run('schtasks.exe', ['/Create', '/TN', taskName(id), '/TR', taskRun, '/SC', 'MINUTE', '/MO', String(Math.max(5, Math.ceil(intervalSeconds / 60))), '/F']);
    run('schtasks.exe', ['/Run', '/TN', taskName(id)]);
    return { backend: 'windows-task-scheduler-user', path: taskName(id) };
  }
  throw new Error(`Persistent automatic updates are unsupported on ${process.platform}`);
}

export function removeUpdateScheduler(id = ''): { backend: string; path: string } {
  const home = os.homedir();
  const suffix = schedulerId(id);
  if (process.platform === 'darwin') {
    const label = `ai.wazir.updater${suffix ? `.${suffix}` : ''}`;
    const plist = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    try { run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, plist]); } catch {}
    try { rmSync(plist, { force: true }); } catch {}
    return { backend: 'launchd-user-agent', path: plist };
  }
  if (process.platform === 'linux') {
    const dir = path.join(home, '.config', 'systemd', 'user');
    try { run('systemctl', ['--user', 'disable', '--now', `${serviceName(id)}.timer`]); } catch {}
    for (const file of [`${serviceName(id)}.service`, `${serviceName(id)}.timer`]) try { rmSync(path.join(dir, file), { force: true }); } catch {}
    try { run('systemctl', ['--user', 'daemon-reload']); } catch {}
    return { backend: 'systemd-user-timer', path: path.join(dir, `${serviceName(id)}.timer`) };
  }
  if (process.platform === 'win32') {
    try { run('schtasks.exe', ['/Delete', '/TN', taskName(id), '/F']); } catch {}
    return { backend: 'windows-task-scheduler-user', path: taskName(id) };
  }
  return { backend: 'unsupported', path: '' };
}

export function schedulerInstalled(id = ''): boolean {
  const home = os.homedir();
  const suffix = schedulerId(id);
  if (process.platform === 'darwin') return existsSync(path.join(home, 'Library', 'LaunchAgents', `ai.wazir.updater${suffix ? `.${suffix}` : ''}.plist`));
  if (process.platform === 'linux') return existsSync(path.join(home, '.config', 'systemd', 'user', `${serviceName(id)}.timer`));
  if (process.platform === 'win32') {
    const result = spawnSync('schtasks.exe', ['/Query', '/TN', taskName(id)], { stdio: 'ignore', timeout: 5000 });
    return result.status === 0;
  }
  return false;
}

export interface UpdateSchedulerOptions extends UpdateServiceOptions {
  service?: UpdateService | {
    checkForUpdates: (options?: CheckForUpdatesOptions) => Promise<UpdateRecord>;
    applyStagedUpdate?: (options?: ApplyStagedUpdateOptions) => Promise<UpdateRecord>;
    drainAndApply?: (options?: DrainAndApplyOptions) => Promise<UpdateRecord>;
  };
  intervalSeconds?: number;
  intervalMs?: number;
  applyOnTick?: boolean;
  drainBeforeApply?: boolean;
  drainTimeoutMs?: number;
  drainPollIntervalMs?: number;
  onTick?: (record: UpdateRecord) => void | Promise<void>;
}

export interface UpdateSchedulerTickOptions extends DrainAndApplyOptions {
  apply?: boolean;
  drain?: boolean;
}

function hasPendingStagedUpdate(): boolean {
  if (existsSync(journalPath())) {
    try {
      const journal = JSON.parse(readFileSync(journalPath(), 'utf8')) as UpdateRecord;
      if ((journal.phase === 'STAGED' || journal.phase === 'WAITING_FOR_SAFE_ACTIVATION') && Boolean(journal.availableVersion)) {
        return true;
      }
    } catch {}
  }
  return readUpdateHistory(20).some(
    (entry) => (entry.phase === 'STAGED' || entry.phase === 'WAITING_FOR_SAFE_ACTIVATION') && Boolean(entry.availableVersion),
  );
}

export class UpdateScheduler {
  private readonly options: UpdateSchedulerOptions;
  private readonly service: NonNullable<UpdateSchedulerOptions['service']>;
  private timer?: ReturnType<typeof setInterval>;
  private lastResult?: UpdateRecord;

  constructor(options: UpdateSchedulerOptions = {}) {
    this.options = { ...options };
    this.service = options.service ?? new UpdateService(options);
  }

  async tick(tickOptions: UpdateSchedulerTickOptions = {}): Promise<UpdateRecord> {
    const useDrain = tickOptions.drain ?? this.options.drainBeforeApply ?? false;
    const shouldApply = tickOptions.apply ?? this.options.applyOnTick ?? loadUpdateConfig().automaticInstall;
    const mergedOptions: CheckForUpdatesOptions = {
      store: tickOptions.store ?? this.options.store,
      configDir: tickOptions.configDir ?? this.options.configDir,
      storePath: tickOptions.storePath ?? this.options.storePath,
      executions: tickOptions.executions ?? this.options.executions,
      jobs: tickOptions.jobs ?? this.options.jobs,
      dispatches: tickOptions.dispatches ?? this.options.dispatches,
      checkProcesses: tickOptions.checkProcesses ?? this.options.checkProcesses,
      processProbe: tickOptions.processProbe ?? this.options.processProbe,
      isProcessAlive: tickOptions.isProcessAlive ?? this.options.isProcessAlive,
      now: tickOptions.now ?? this.options.now,
      scheduled: true,
      apply: shouldApply,
      force: tickOptions.force,
      drain: useDrain,
      timeoutMs: tickOptions.timeoutMs ?? this.options.drainTimeoutMs,
      pollIntervalMs: tickOptions.pollIntervalMs ?? this.options.drainPollIntervalMs,
    };

    let result: UpdateRecord;
    if (useDrain && this.service.drainAndApply) {
      result = await this.service.drainAndApply(mergedOptions);
    } else if (!this.options.releases && hasPendingStagedUpdate() && shouldApply && this.service.applyStagedUpdate) {
      result = await this.service.applyStagedUpdate(mergedOptions);
    } else {
      result = await this.service.checkForUpdates(mergedOptions);
    }

    this.lastResult = result;
    if (this.options.onTick) {
      await this.options.onTick(result);
    }
    return result;
  }

  start(): this {
    if (this.timer) return this;
    const intervalMs = this.options.intervalMs ?? (this.options.intervalSeconds ?? loadUpdateConfig().intervalSeconds ?? 300) * 1000;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, Math.max(50, intervalMs));
    this.timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  isRunning(): boolean {
    return this.timer !== undefined;
  }

  getLastResult(): UpdateRecord | undefined {
    return this.lastResult;
  }
}
