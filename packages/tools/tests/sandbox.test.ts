import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bwrapArgs, seatbeltProfile, sandboxStatus, resetSandboxProbe, wrapInSandbox } from '../src/sandbox.js';
import { runShell } from '../src/process.js';
import { shellTool } from '../src/process-tools.js';

/** Security review F-27: OS-level isolation of tool subprocesses. */
describe('sandbox argument construction (pure)', () => {
  let home: string;
  let project: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-sbx-home-'));
    project = path.join(home, 'code', 'proj');
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(path.join(home, '.nvm'), { recursive: true });
    await fs.mkdir(path.join(home, '.npm'), { recursive: true });
    await fs.mkdir(path.join(home, '.ssh'), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('bwrap: read-only root, masked home with toolchains re-exposed, writable project, no network by default', () => {
    const args = bwrapArgs({ projectRoot: project, cwd: project }, home, '/tmp');
    const joined = args.join(' ');
    expect(args.slice(0, 2)).toEqual(['--ro-bind', '/']);
    expect(joined).toContain(`--tmpfs ${home}`);
    expect(joined).toContain(`--ro-bind ${path.join(home, '.nvm')} ${path.join(home, '.nvm')}`);
    expect(joined).toContain(`--bind ${path.join(home, '.npm')} ${path.join(home, '.npm')}`);
    expect(joined).not.toContain('.ssh');
    expect(joined).toContain('--tmpfs /run');
    expect(joined).toContain('--tmpfs /tmp');
    expect(joined).toContain('--unshare-net');
    expect(joined).toContain('--die-with-parent');
    expect(args[args.length - 1]).toBe('--');
    // project bind must come AFTER the home mask so it is visible
    expect(args.indexOf(`--tmpfs`)).toBeLessThan(args.lastIndexOf(project));
    expect(joined).toContain(`--bind ${project} ${project}`);
    expect(joined).toContain(`--chdir ${project}`);
  });

  it('bwrap: shares the network only when the policy allows it', () => {
    const args = bwrapArgs({ projectRoot: project, cwd: project, networkAllowed: true }, home, '/tmp');
    expect(args).not.toContain('--unshare-net');
    expect(args).toContain('--unshare-pid');
  });

  it('bwrap: a cwd outside the project falls back to the project root', () => {
    const args = bwrapArgs({ projectRoot: project, cwd: '/etc' }, home, '/tmp');
    expect(args[args.indexOf('--chdir') + 1]).toBe(project);
  });

  it('seatbelt: denies home, allows project + tmp writes, denies network by default', () => {
    const profile = seatbeltProfile({ projectRoot: project, cwd: project }, home, '/tmp');
    expect(profile).toContain('(version 1)');
    expect(profile).toContain(`(deny file-read* file-write* (subpath "${home}"))`);
    expect(profile).toContain(`(allow file-read* (subpath "${path.join(home, '.nvm')}"))`);
    expect(profile).toContain(`(allow file-write* (subpath "${project}"))`);
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain('(deny network*)');
    expect(profile).not.toContain('.ssh');
    expect(seatbeltProfile({ projectRoot: project, cwd: project, networkAllowed: true }, home, '/tmp')).not.toContain('(deny network*)');
  });

  it('honours WAZIR_SANDBOX=none and reports an unknown value', () => {
    const previous = process.env.WAZIR_SANDBOX;
    try {
      process.env.WAZIR_SANDBOX = 'none';
      resetSandboxProbe();
      expect(sandboxStatus()).toMatchObject({ mode: 'none', requested: 'none' });
      expect(wrapInSandbox('sh', ['-c', 'true'], { projectRoot: project, cwd: project })).toEqual({ file: 'sh', args: ['-c', 'true'], mode: 'none' });

      process.env.WAZIR_SANDBOX = 'bogus';
      resetSandboxProbe();
      expect(sandboxStatus().reason).toMatch(/unknown WAZIR_SANDBOX/);
    } finally {
      if (previous === undefined) delete process.env.WAZIR_SANDBOX;
      else process.env.WAZIR_SANDBOX = previous;
      resetSandboxProbe();
    }
  });

  it('a probe result is cached and every command result carries the mode', async () => {
    resetSandboxProbe();
    const status = sandboxStatus();
    expect(['bwrap', 'sandbox-exec', 'none']).toContain(status.mode);
    const result = await runShell('echo hi', { cwd: project, projectRoot: project });
    expect(result.sandbox).toBe(status.mode);
    expect(result.stdout.trim()).toBe('hi');
    const tool = await shellTool.execute({ command: 'echo tool' }, { projectRoot: project, executionId: 'e' });
    expect(tool.metadata?.sandbox).toBe(status.mode);
  });
});

// The enforcement checks below need a working backend; they are skipped (not
// faked) where user namespaces are unavailable, and `sandboxStatus().reason`
// says why. `wa doctor` reports the same.
const live = (() => {
  resetSandboxProbe();
  return sandboxStatus().mode !== 'none';
})();

describe.skipIf(!live)('sandbox enforcement (live backend)', () => {
  let sandbox: string;
  let project: string;
  let outside: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-sbx-live-'));
    project = path.join(sandbox, 'project');
    outside = path.join(sandbox, 'outside');
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret');
  });
  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('can write inside the project and /tmp but nowhere else', async () => {
    const inside = await runShell('echo x > made.txt && echo ok', { cwd: project, projectRoot: project });
    expect(inside.code).toBe(0);
    expect(await fs.readFile(path.join(project, 'made.txt'), 'utf8')).toBe('x\n');

    const tmp = await runShell('echo x > /tmp/wazir-sbx-probe && echo ok', { cwd: project, projectRoot: project });
    expect(tmp.code).toBe(0);
    await expect(fs.access('/tmp/wazir-sbx-probe')).rejects.toThrow(); // private tmpfs, not the host's

    const out = await runShell(`echo pwned > ${path.join(outside, 'secret.txt')}`, { cwd: project, projectRoot: project });
    expect(out.code).not.toBe(0);
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });

  it('hides the home directory except toolchains', async () => {
    const home = os.homedir();
    const listing = await runShell(`ls -A "${home}"`, { cwd: project, projectRoot: project });
    expect(listing.code).toBe(0);
    const entries = listing.stdout.split('\n').filter(Boolean);
    for (const secret of ['.ssh', '.aws', '.gnupg', '.wazir', '.config']) expect(entries).not.toContain(secret);
  });

  it('has no network unless allowed', async () => {
    const denied = await runShell('cat /proc/net/route | tail -n +2 | wc -l', { cwd: project, projectRoot: project });
    expect(denied.stdout.trim()).toBe('0'); // no routes in a fresh net namespace
    const allowed = await runShell('cat /proc/net/route | tail -n +2 | wc -l', { cwd: project, projectRoot: project, networkAllowed: true });
    expect(Number(allowed.stdout.trim())).toBeGreaterThan(0);
  });

  it('runs in its own PID namespace', async () => {
    const result = await runShell('echo $$', { cwd: project, projectRoot: project });
    expect(Number(result.stdout.trim())).toBeLessThan(50);
  });
});
