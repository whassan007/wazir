/**
 * apps/cli/src/serviceManager.ts
 *
 * Cross-platform system service manager for Wazir.
 * Supports:
 *  - systemd (Linux: system & user units)
 *  - launchd (macOS: LaunchAgents & LaunchDaemons)
 *  - Windows Task Scheduler / Service (Windows)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { configDir } from './config.js';

export type ServiceType = 'worker' | 'api';

export interface ServiceOptions {
  type?: ServiceType;
  user?: string;
  port?: number;
  apiUrl?: string;
  name?: string;
}

export interface ServiceStatusResult {
  installed: boolean;
  active: boolean;
  platform: string;
  backend: string;
  serviceName: string;
  unitFile?: string;
  pid?: number;
  details?: string;
}

function getExecutablePath(): string {
  // Use current process argv[0] or process.execPath
  return process.argv[1] && existsSync(process.argv[1])
    ? process.argv[1]
    : process.execPath;
}

function resolveServiceBackend(): 'systemd' | 'launchd' | 'windows' | 'unsupported' {
  if (process.platform === 'linux') return 'systemd';
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'win32') return 'windows';
  return 'unsupported';
}

function isRootUser(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

export class ServiceManager {
  private readonly backend: 'systemd' | 'launchd' | 'windows' | 'unsupported';
  private readonly baseConfigDir: string;
  private readonly defaultServiceName = 'wazir';

  constructor() {
    this.backend = resolveServiceBackend();
    this.baseConfigDir = configDir();
  }

  getBackend(): string {
    return this.backend;
  }

  // --- 1. INSTALL ---
  async install(options: ServiceOptions = {}): Promise<{ success: boolean; message: string; unitPath?: string }> {
    const serviceType = options.type || 'worker';
    const serviceName = options.name || this.defaultServiceName;
    const execPath = getExecutablePath();
    const envFile = path.join(this.baseConfigDir, '.env');
    const logsDir = path.join(this.baseConfigDir, 'logs');
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

    const execCommand = execPath.endsWith('.js')
      ? `"${process.execPath}" "${execPath}"`
      : `"${execPath}"`;

    const startArgs = serviceType === 'api'
      ? `${execCommand} api start${options.port ? ` --port ${options.port}` : ''}`
      : `${execCommand} worker start${options.apiUrl ? ` --api-url ${options.apiUrl}` : ''}`;

    if (this.backend === 'systemd') {
      const isRoot = isRootUser();
      const unitDir = isRoot
        ? '/etc/systemd/system'
        : path.join(os.homedir(), '.config/systemd/user');

      if (!existsSync(unitDir)) mkdirSync(unitDir, { recursive: true });
      const unitPath = path.join(unitDir, `${serviceName}.service`);

      const unitContent = `[Unit]
Description=Wazir Autonomous AI Fleet Service (${serviceType})
Documentation=https://github.com/whassan007/wazir
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${isRoot && options.user ? `User=${options.user}\n` : ''}WorkingDirectory=${this.baseConfigDir}
ExecStart=${startArgs}
Restart=always
RestartSec=5
${existsSync(envFile) ? `EnvironmentFile=-${envFile}\n` : ''}Environment=NODE_ENV=production
Environment=WAZIR_HOME=${this.baseConfigDir}
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=${isRoot ? 'multi-user.target' : 'default.target'}
`;

      writeFileSync(unitPath, unitContent, 'utf8');

      try {
        const cmd = isRoot ? 'systemctl daemon-reload' : 'systemctl --user daemon-reload';
        execSync(cmd, { stdio: 'ignore' });
        const enableCmd = isRoot ? `systemctl enable ${serviceName}` : `systemctl --user enable ${serviceName}`;
        execSync(enableCmd, { stdio: 'ignore' });
      } catch (err: any) {
        // Systemctl might not be active (e.g. in minimal chroot/docker); file is written
      }

      return {
        success: true,
        message: `systemd unit installed successfully at ${unitPath}`,
        unitPath,
      };
    }

    if (this.backend === 'launchd') {
      const isRoot = isRootUser();
      const plistDir = isRoot
        ? '/Library/LaunchDaemons'
        : path.join(os.homedir(), 'Library/LaunchAgents');

      if (!existsSync(plistDir)) mkdirSync(plistDir, { recursive: true });
      const label = `ai.wazir.${serviceName}`;
      const plistPath = path.join(plistDir, `${label}.plist`);

      const stdoutLog = path.join(logsDir, `${serviceName}.stdout.log`);
      const stderrLog = path.join(logsDir, `${serviceName}.stderr.log`);

      const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        ${execPath.endsWith('.js') ? `<string>${process.execPath}</string>\n        <string>${execPath}</string>` : `<string>${execPath}</string>`}
        <string>${serviceType === 'api' ? 'api' : 'worker'}</string>
        <string>start</string>${serviceType === 'api' && options.port ? `\n        <string>--port</string>\n        <string>${options.port}</string>` : ''}${serviceType !== 'api' && options.apiUrl ? `\n        <string>--api-url</string>\n        <string>${options.apiUrl}</string>` : ''}
    </array>
    <key>WorkingDirectory</key>
    <string>${this.baseConfigDir}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>WAZIR_HOME</key>
        <string>${this.baseConfigDir}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${stdoutLog}</string>
    <key>StandardErrorPath</key>
    <string>${stderrLog}</string>
    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
`;

      writeFileSync(plistPath, plistContent, 'utf8');

      try {
        execSync(`launchctl load "${plistPath}"`, { stdio: 'ignore' });
      } catch {
        // ignore if not loaded yet
      }

      return {
        success: true,
        message: `launchd agent installed successfully at ${plistPath}`,
        unitPath: plistPath,
      };
    }

    if (this.backend === 'windows') {
      const taskName = `Wazir_${serviceName}`;
      try {
        const createCmd = `schtasks /Create /TN "${taskName}" /TR "${startArgs}" /SC ONSTART /RU "SYSTEM" /F`;
        execSync(createCmd, { stdio: 'ignore' });
      } catch {
        // Fallback to user logon task if SYSTEM privileges are denied
        const userCmd = `schtasks /Create /TN "${taskName}" /TR "${startArgs}" /SC ONLOGON /F`;
        execSync(userCmd, { stdio: 'ignore' });
      }

      return {
        success: true,
        message: `Windows Scheduled Task '${taskName}' created successfully.`,
      };
    }

    return {
      success: false,
      message: `System services are not supported on platform: ${process.platform}`,
    };
  }

  // --- 2. START ---
  async start(serviceName = this.defaultServiceName): Promise<{ success: boolean; message: string }> {
    if (this.backend === 'systemd') {
      const isRoot = isRootUser();
      const cmd = isRoot ? `systemctl start ${serviceName}` : `systemctl --user start ${serviceName}`;
      execSync(cmd, { stdio: 'inherit' });
      return { success: true, message: `Started service ${serviceName} via systemd.` };
    }
    if (this.backend === 'launchd') {
      const label = `ai.wazir.${serviceName}`;
      execSync(`launchctl start "${label}"`, { stdio: 'inherit' });
      return { success: true, message: `Started service ${label} via launchd.` };
    }
    if (this.backend === 'windows') {
      const taskName = `Wazir_${serviceName}`;
      execSync(`schtasks /Run /TN "${taskName}"`, { stdio: 'inherit' });
      return { success: true, message: `Triggered start for task ${taskName}.` };
    }
    throw new Error(`Unsupported service platform: ${process.platform}`);
  }

  // --- 3. STOP ---
  async stop(serviceName = this.defaultServiceName): Promise<{ success: boolean; message: string }> {
    if (this.backend === 'systemd') {
      const isRoot = isRootUser();
      const cmd = isRoot ? `systemctl stop ${serviceName}` : `systemctl --user stop ${serviceName}`;
      execSync(cmd, { stdio: 'inherit' });
      return { success: true, message: `Stopped service ${serviceName} via systemd.` };
    }
    if (this.backend === 'launchd') {
      const label = `ai.wazir.${serviceName}`;
      execSync(`launchctl stop "${label}"`, { stdio: 'inherit' });
      return { success: true, message: `Stopped service ${label} via launchd.` };
    }
    if (this.backend === 'windows') {
      const taskName = `Wazir_${serviceName}`;
      execSync(`schtasks /End /TN "${taskName}"`, { stdio: 'inherit' });
      return { success: true, message: `Stopped task ${taskName}.` };
    }
    throw new Error(`Unsupported service platform: ${process.platform}`);
  }

  // --- 4. RESTART ---
  async restart(serviceName = this.defaultServiceName): Promise<{ success: boolean; message: string }> {
    if (this.backend === 'systemd') {
      const isRoot = isRootUser();
      const cmd = isRoot ? `systemctl restart ${serviceName}` : `systemctl --user restart ${serviceName}`;
      execSync(cmd, { stdio: 'inherit' });
      return { success: true, message: `Restarted service ${serviceName} via systemd.` };
    }
    if (this.backend === 'launchd') {
      await this.stop(serviceName);
      await this.start(serviceName);
      return { success: true, message: `Restarted service via launchd.` };
    }
    if (this.backend === 'windows') {
      try { await this.stop(serviceName); } catch {}
      await this.start(serviceName);
      return { success: true, message: `Restarted task via Windows Task Scheduler.` };
    }
    throw new Error(`Unsupported service platform: ${process.platform}`);
  }

  // --- 5. STATUS ---
  async status(serviceName = this.defaultServiceName): Promise<ServiceStatusResult> {
    const result: ServiceStatusResult = {
      installed: false,
      active: false,
      platform: process.platform,
      backend: this.backend,
      serviceName,
    };

    if (this.backend === 'systemd') {
      const isRoot = isRootUser();
      const unitPath = isRoot
        ? path.join('/etc/systemd/system', `${serviceName}.service`)
        : path.join(os.homedir(), '.config/systemd/user', `${serviceName}.service`);

      result.unitFile = unitPath;
      result.installed = existsSync(unitPath);

      if (result.installed) {
        try {
          const checkCmd = isRoot ? `systemctl is-active ${serviceName}` : `systemctl --user is-active ${serviceName}`;
          const out = execSync(checkCmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
          result.active = out === 'active';
          result.details = out;
        } catch {
          result.active = false;
          result.details = 'inactive';
        }
      }
      return result;
    }

    if (this.backend === 'launchd') {
      const isRoot = isRootUser();
      const label = `ai.wazir.${serviceName}`;
      const plistPath = isRoot
        ? path.join('/Library/LaunchDaemons', `${label}.plist`)
        : path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);

      result.unitFile = plistPath;
      result.installed = existsSync(plistPath);

      if (result.installed) {
        try {
          const listOut = execSync(`launchctl list | grep "${label}"`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
          result.active = listOut.includes(label);
          result.details = listOut.trim();
        } catch {
          result.active = false;
          result.details = 'not running';
        }
      }
      return result;
    }

    if (this.backend === 'windows') {
      const taskName = `Wazir_${serviceName}`;
      try {
        const queryOut = execSync(`schtasks /Query /TN "${taskName}"`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        result.installed = queryOut.includes(taskName);
        result.active = queryOut.includes('Running');
        result.details = queryOut.trim();
      } catch {
        result.installed = false;
        result.active = false;
      }
      return result;
    }

    return result;
  }

  // --- 6. UNINSTALL ---
  async uninstall(serviceName = this.defaultServiceName): Promise<{ success: boolean; message: string }> {
    try {
      await this.stop(serviceName);
    } catch {
      // Ignore failure to stop non-running service
    }

    if (this.backend === 'systemd') {
      const isRoot = isRootUser();
      const unitPath = isRoot
        ? path.join('/etc/systemd/system', `${serviceName}.service`)
        : path.join(os.homedir(), '.config/systemd/user', `${serviceName}.service`);

      try {
        const disableCmd = isRoot ? `systemctl disable ${serviceName}` : `systemctl --user disable ${serviceName}`;
        execSync(disableCmd, { stdio: 'ignore' });
      } catch {}

      if (existsSync(unitPath)) {
        rmSync(unitPath, { force: true });
        try {
          const reloadCmd = isRoot ? 'systemctl daemon-reload' : 'systemctl --user daemon-reload';
          execSync(reloadCmd, { stdio: 'ignore' });
        } catch {}
      }

      return { success: true, message: `systemd unit ${serviceName} uninstalled cleanly.` };
    }

    if (this.backend === 'launchd') {
      const isRoot = isRootUser();
      const label = `ai.wazir.${serviceName}`;
      const plistPath = isRoot
        ? path.join('/Library/LaunchDaemons', `${label}.plist`)
        : path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);

      try {
        execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' });
      } catch {}

      if (existsSync(plistPath)) {
        rmSync(plistPath, { force: true });
      }

      return { success: true, message: `launchd agent ${label} uninstalled cleanly.` };
    }

    if (this.backend === 'windows') {
      const taskName = `Wazir_${serviceName}`;
      try {
        execSync(`schtasks /Delete /TN "${taskName}" /F`, { stdio: 'ignore' });
      } catch {}
      return { success: true, message: `Windows task ${taskName} uninstalled cleanly.` };
    }

    throw new Error(`Unsupported service platform: ${process.platform}`);
  }
}
