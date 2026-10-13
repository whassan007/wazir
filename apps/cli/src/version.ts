import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { color } from './colors.js';
import type { DoctorCheck } from './doctor.js';

declare const __WAZIR_VERSION__: string | undefined;
declare const __WAZIR_COMMIT__: string | undefined;
declare const __WAZIR_BUILD_DATE__: string | undefined;

export interface BuildInfo {
  version: string;
  commit: string;
  buildDate: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  channel: string;
}

export function detectInstallChannel(): string {
  if (process.env.WAZIR_INSTALL_CHANNEL) return process.env.WAZIR_INSTALL_CHANNEL;
  if (existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true') {
    return 'docker';
  }
  const execPath = process.argv[1] || process.execPath;
  if (execPath.includes('/Cellar/wazir') || execPath.includes('/opt/homebrew/') || (process.env.HOMEBREW_PREFIX && execPath.startsWith(process.env.HOMEBREW_PREFIX))) {
    return 'homebrew';
  }
  if (execPath.toLowerCase().includes('scoop\\apps\\wazir') || execPath.toLowerCase().includes('scoop/apps/wazir')) {
    return 'scoop';
  }
  if (execPath.includes('WinGet') || execPath.includes('WindowsApps')) {
    return 'winget';
  }
  if (execPath.startsWith('/usr/bin/wa') || execPath.startsWith('/usr/lib/wazir')) {
    if (existsSync('/etc/debian_version')) return 'deb';
    if (existsSync('/etc/redhat-release') || existsSync('/etc/fedora-release')) return 'rpm';
  }
  if (execPath.includes('node_modules') || execPath.includes('.npm') || execPath.includes('npm/bin')) {
    return 'npm';
  }
  if ((process as any).isSea?.()) {
    return 'standalone-binary';
  }
  return 'source';
}

export function getBuildInfo(): BuildInfo {
  let version = typeof __WAZIR_VERSION__ !== 'undefined' ? __WAZIR_VERSION__ : '0.1.60';
  let commit = typeof __WAZIR_COMMIT__ !== 'undefined' ? __WAZIR_COMMIT__ : '';
  let buildDate = typeof __WAZIR_BUILD_DATE__ !== 'undefined' ? __WAZIR_BUILD_DATE__ : '';

  if (!commit) {
    try {
      commit = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 }).toString().trim();
    } catch {
      commit = process.env.WAZIR_BUILD_COMMIT ?? 'unknown';
    }
  }

  if (!buildDate) {
    buildDate = process.env.WAZIR_BUILD_DATE ?? new Date().toISOString();
  }

  return {
    version,
    commit,
    buildDate,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    channel: detectInstallChannel(),
  };
}

export function formatBuildInfo(info: BuildInfo): string {
  const pad = 20;
  return [
    `${color.bold('Wazir version:'.padEnd(pad))} ${info.version}`,
    `${color.bold('Source commit:'.padEnd(pad))} ${info.commit ? info.commit.slice(0, 12) : 'unknown'}`,
    `${color.bold('Build date:'.padEnd(pad))} ${info.buildDate}`,
    `${color.bold('Platform:'.padEnd(pad))} ${info.platform} (${info.arch})`,
    `${color.bold('Node.js runtime:'.padEnd(pad))} ${info.nodeVersion}`,
    `${color.bold('Install channel:'.padEnd(pad))} ${info.channel}`,
  ].join('\n');
}

export function checkRuntimeDependencies(): DoctorCheck {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const ok = (major > 22) || (major === 22 && minor >= 5);
  if (!ok) {
    return {
      name: 'runtime dependencies',
      status: 'FAIL',
      message: `Node.js ${process.version} is unsupported (requires >= 22.5.0)`,
      details: 'Please upgrade Node.js to >= 22.5.0',
    };
  }
  return {
    name: 'runtime dependencies',
    status: 'PASS',
    message: `Node.js ${process.version} (${process.arch})`,
  };
}

export function checkGitAvailability(): DoctorCheck {
  try {
    const gitVer = execSync('git --version', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
    return {
      name: 'git availability',
      status: 'PASS',
      message: gitVer,
    };
  } catch (error) {
    return {
      name: 'git availability',
      status: 'WARN',
      message: 'git executable not found on PATH',
      details: 'Git is required for worktree isolation, branch management, and repository operations.',
    };
  }
}

export function checkPackageVersion(): DoctorCheck {
  const info = getBuildInfo();
  return {
    name: 'package version',
    status: 'PASS',
    message: `v${info.version} (channel: ${info.channel}, commit: ${info.commit.slice(0, 7) || 'n/a'})`,
  };
}
