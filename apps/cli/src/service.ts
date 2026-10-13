import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `wa service`: run the Wazir control plane (`wa dashboard`, loopback only) as a per-user
 * background service. Never privileged, never created during package installation:
 *   Linux   systemd --user unit   ~/.config/systemd/user/<name>.service
 *   macOS   launchd LaunchAgent    ~/Library/LaunchAgents/com.whassan007.<name>.plist
 *   Windows logon scheduled task   \<name> (runs as the current user; no admin needed)
 */
export interface ServiceOptions {
  name?: string;
  port?: number;
  platform?: NodeJS.Platform;
  home?: string;
  /** Command runner (tests inject one). */
  exec?: (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
}

export interface ServicePlan {
  platform: NodeJS.Platform;
  name: string;
  /** File written by install (none on Windows). */
  file?: string;
  contents?: string;
  /** The command the service runs. */
  command: string[];
}

const defaultExec = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.error ? r.error.message : r.stderr ?? '' };
};

/** How to start this very `wa`: the standalone executable, or node + the script. */
export function selfCommand(): string[] {
  const sea = (process.getBuiltinModule?.('node:sea') as { isSea?: () => boolean } | undefined)?.isSea?.() === true;
  if (sea) return [process.execPath];
  const script = process.argv[1];
  if (!script) throw new Error('cannot locate the wa entry point');
  return [process.execPath, realpathSync(script)];
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const quoteSystemd = (s: string) => (/[\s"\\]/.test(s) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s);

export function planService(options: ServiceOptions = {}, self: string[] = selfCommand()): ServicePlan {
  const platform = options.platform ?? process.platform;
  const name = options.name ?? 'wazir';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new Error(`invalid service name '${name}'`);
  const home = options.home ?? os.homedir();
  const command = [...self, 'dashboard', '--no-open', '--port', String(options.port ?? 4801)];
  const wazirHome = process.env.WAZIR_HOME;
  if (platform === 'linux') {
    const file = path.join(home, '.config/systemd/user', `${name}.service`);
    const contents = [
      '[Unit]',
      'Description=Wazir control plane (wa dashboard, loopback only)',
      'Documentation=https://github.com/whassan007/wazir',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${command.map(quoteSystemd).join(' ')}`,
      ...(wazirHome ? [`Environment=WAZIR_HOME=${quoteSystemd(wazirHome)}`] : []),
      'Restart=on-failure',
      'RestartSec=5',
      'NoNewPrivileges=true',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    return { platform, name, file, contents, command };
  }
  if (platform === 'darwin') {
    const label = `com.whassan007.${name}`;
    const file = path.join(home, 'Library/LaunchAgents', `${label}.plist`);
    const logs = path.join(wazirHome ?? path.join(home, '.wazir'), 'logs');
    const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((c) => `    <string>${xml(c)}</string>`).join('\n')}
  </array>
${wazirHome ? `  <key>EnvironmentVariables</key><dict><key>WAZIR_HOME</key><string>${xml(wazirHome)}</string></dict>\n` : ''}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(path.join(logs, `${name}.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, `${name}.log`))}</string>
</dict>
</plist>
`;
    return { platform, name, file, contents, command };
  }
  if (platform === 'win32') return { platform, name, command };
  throw new Error(`wa service is not supported on ${platform}`);
}

export type ServiceAction = 'install' | 'uninstall' | 'start' | 'stop' | 'status';

/** Performs one action and returns a human-readable result. Throws on failure. */
export function runService(action: ServiceAction, options: ServiceOptions = {}, self?: string[]): string {
  const plan = planService(options, self);
  const exec = options.exec ?? defaultExec;
  const must = (cmd: string, args: string[]) => {
    const r = exec(cmd, args);
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    return r.stdout;
  };
  const uid = () => String(process.getuid?.() ?? execFileSync('id', ['-u'], { encoding: 'utf8' }).trim());
  const label = `com.whassan007.${plan.name}`;

  if (plan.platform === 'linux') {
    const unit = `${plan.name}.service`;
    switch (action) {
      case 'install':
        mkdirSync(path.dirname(plan.file!), { recursive: true });
        writeFileSync(plan.file!, plan.contents!);
        must('systemctl', ['--user', 'daemon-reload']);
        must('systemctl', ['--user', 'enable', unit]);
        return `installed ${plan.file} (enabled for your user; start with: wa service start)`;
      case 'uninstall':
        exec('systemctl', ['--user', 'disable', '--now', unit]);
        if (existsSync(plan.file!)) rmSync(plan.file!);
        must('systemctl', ['--user', 'daemon-reload']);
        return `removed ${unit}; your data in ~/.wazir was kept`;
      case 'start': must('systemctl', ['--user', 'start', unit]); return `started ${unit}`;
      case 'stop': must('systemctl', ['--user', 'stop', unit]); return `stopped ${unit}`;
      case 'status': {
        const r = exec('systemctl', ['--user', 'is-active', unit]);
        return `${unit}: ${r.stdout.trim() || 'unknown'}${existsSync(plan.file!) ? '' : ' (not installed)'}`;
      }
    }
  }
  if (plan.platform === 'darwin') {
    const domain = `gui/${uid()}`;
    switch (action) {
      case 'install':
        mkdirSync(path.dirname(plan.file!), { recursive: true });
        mkdirSync(path.join(process.env.WAZIR_HOME ?? path.join(options.home ?? os.homedir(), '.wazir'), 'logs'), { recursive: true });
        writeFileSync(plan.file!, plan.contents!);
        return `installed ${plan.file} (start with: wa service start)`;
      case 'uninstall':
        exec('launchctl', ['bootout', `${domain}/${label}`]);
        if (existsSync(plan.file!)) rmSync(plan.file!);
        return `removed ${label}; your data in ~/.wazir was kept`;
      case 'start': must('launchctl', ['bootstrap', domain, plan.file!]); return `started ${label}`;
      case 'stop': must('launchctl', ['bootout', `${domain}/${label}`]); return `stopped ${label}`;
      case 'status': {
        const r = exec('launchctl', ['print', `${domain}/${label}`]);
        const state = /state = (\w+)/.exec(r.stdout)?.[1];
        return `${label}: ${r.status === 0 ? state ?? 'loaded' : existsSync(plan.file!) ? 'not running' : 'not installed'}`;
      }
    }
  }
  // Windows: a scheduled task that starts at logon as the current user (no administrator rights).
  const task = `\\${plan.name}`;
  switch (action) {
    case 'install': {
      const tr = plan.command.map((c) => (/\s/.test(c) ? `"${c}"` : c)).join(' ');
      must('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', task, '/TR', tr]);
      return `installed scheduled task ${task} (runs at logon; start now with: wa service start)`;
    }
    case 'uninstall':
      exec('schtasks', ['/End', '/TN', task]);
      must('schtasks', ['/Delete', '/F', '/TN', task]);
      return `removed scheduled task ${task}; your data in %USERPROFILE%\\.wazir was kept`;
    case 'start': must('schtasks', ['/Run', '/TN', task]); return `started ${task}`;
    case 'stop': must('schtasks', ['/End', '/TN', task]); return `stopped ${task}`;
    case 'status': {
      const r = exec('schtasks', ['/Query', '/TN', task, '/FO', 'LIST']);
      return r.status === 0 ? `${task}: ${/Status:\s*(.+)/.exec(r.stdout)?.[1]?.trim() ?? 'installed'}` : `${task}: not installed`;
    }
  }
  throw new Error(`unknown action ${action}`);
}
