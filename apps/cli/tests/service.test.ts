import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planService, runService } from '../src/service.js';

const self = ['/usr/bin/node', '/opt/wazir app/bin/wa.js'];
function recorder() {
  const calls: string[] = [];
  return { calls, exec: (cmd: string, args: string[]) => { calls.push([cmd, ...args].join(' ')); return { status: 0, stdout: cmd === 'systemctl' ? 'active\n' : 'state = running', stderr: '' }; } };
}

describe('wa service', () => {
  it('linux: a systemd --user unit running wa dashboard on loopback, never root', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'svc-'));
    const r = recorder();
    runService('install', { platform: 'linux', home, port: 4999, exec: r.exec }, self);
    const unit = readFileSync(path.join(home, '.config/systemd/user/wazir.service'), 'utf8');
    expect(unit).toContain('ExecStart=/usr/bin/node "/opt/wazir app/bin/wa.js" dashboard --no-open --port 4999');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toMatch(/^User=/m);
    expect(r.calls).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable wazir.service']);
    expect(r.calls.some((c) => c.includes('start'))).toBe(false); // install does not start
    runService('uninstall', { platform: 'linux', home, exec: r.exec }, self);
    expect(existsSync(path.join(home, '.config/systemd/user/wazir.service'))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it('macOS: a LaunchAgent in the user domain', () => {
    const plan = planService({ platform: 'darwin', home: '/Users/u' }, self);
    expect(plan.file).toBe('/Users/u/Library/LaunchAgents/com.whassan007.wazir.plist');
    expect(plan.contents).toContain('<string>/opt/wazir app/bin/wa.js</string>');
    expect(plan.contents).toContain('<string>--no-open</string>');
  });

  it('Windows: a logon task as the current user with limited rights', () => {
    const r = recorder();
    runService('install', { platform: 'win32', exec: r.exec }, ['C:\\Program Files\\Wazir\\wa.exe']);
    expect(r.calls[0]).toBe('schtasks /Create /F /SC ONLOGON /RL LIMITED /TN \\wazir /TR "C:\\Program Files\\Wazir\\wa.exe" dashboard --no-open --port 4801');
  });

  it('rejects unsafe service names', () => {
    expect(() => planService({ platform: 'linux', name: '../evil' }, self)).toThrow(/invalid service name/);
  });
});
