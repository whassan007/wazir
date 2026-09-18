import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bwrapArgs, seatbeltProfile, sandboxStatus, resetSandboxProbe, wrapInSandbox, seccompFilter, SECCOMP_SYSCALLS, SandboxUnavailableError } from '../src/sandbox.js';
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

  it('bwrap: masks other users\' homes and mount points', () => {
    const joined = bwrapArgs({ projectRoot: project, cwd: project }, home, '/tmp').join(' ');
    for (const dir of ['/home', '/mnt', '/media', '/srv']) {
      if (existsSync(dir)) expect(joined).toContain(`--tmpfs ${dir}`);
    }
    // the project bind comes after every mask so it stays visible
    const args = bwrapArgs({ projectRoot: project, cwd: project }, home, '/tmp');
    expect(args.lastIndexOf('--tmpfs')).toBeLessThan(args.lastIndexOf(project));
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
      expect(sandboxStatus().required).toBe(true);
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

describe('WAZIR_SANDBOX=required fails closed', () => {
  const previous = process.env.WAZIR_SANDBOX;
  afterEach(() => {
    if (previous === undefined) delete process.env.WAZIR_SANDBOX;
    else process.env.WAZIR_SANDBOX = previous;
    resetSandboxProbe();
  });

  it('refuses to run tool processes when no backend is usable', async () => {
    process.env.WAZIR_SANDBOX = 'required';
    resetSandboxProbe();
    const status = sandboxStatus();
    if (status.mode !== 'none') {
      // A backend works here: `required` behaves exactly like `auto`.
      expect(status.required).toBeUndefined();
      const result = await runShell('echo ok', { cwd: os.tmpdir(), projectRoot: os.tmpdir() });
      expect(result.sandbox).toBe(status.mode);
      return;
    }
    expect(status.required).toBe(true);
    expect(() => wrapInSandbox('sh', ['-c', 'true'], { projectRoot: os.tmpdir(), cwd: os.tmpdir() })).toThrow(SandboxUnavailableError);
    await expect(runShell('echo ok', { cwd: os.tmpdir(), projectRoot: os.tmpdir() })).rejects.toThrow(/tool sandbox required/);
    // orchestrator-internal calls that opt out are still allowed
    const internal = await runShell('echo ok', { cwd: os.tmpdir(), projectRoot: os.tmpdir(), unsandboxed: true });
    expect(internal.stdout.trim()).toBe('ok');
  });

  it('an explicitly named backend that cannot start is also fatal', () => {
    process.env.WAZIR_SANDBOX = process.platform === 'darwin' ? 'bwrap' : 'sandbox-exec';
    resetSandboxProbe();
    expect(sandboxStatus()).toMatchObject({ mode: 'none', required: true });
  });
});

describe('seccomp filter (pure BPF assembly)', () => {
  const decode = (program: Buffer) =>
    Array.from({ length: program.length / 8 }, (_, i) => ({
      code: program.readUInt16LE(i * 8),
      jt: program.readUInt8(i * 8 + 2),
      jf: program.readUInt8(i * 8 + 3),
      k: program.readUInt32LE(i * 8 + 4),
    }));

  it.each([
    ['x64', 0xc000003e, 0],
    ['arm64', 0xc00000b7, 1],
  ] as const)('%s: checks the arch, denies the syscall table, allows everything else', (arch, audit, column) => {
    const program = seccompFilter(arch);
    expect(program).toBeDefined();
    const insns = decode(program!);
    expect(insns[0]).toMatchObject({ code: 0x20, k: 4 }); // ld arch
    expect(insns[1]).toMatchObject({ code: 0x15, k: audit });
    expect(insns[2]).toMatchObject({ code: 0x06, k: 0x80000000 }); // kill on foreign arch
    const denied = new Set(Object.values(SECCOMP_SYSCALLS).map((n) => n[column]));
    const jeqs = insns.filter((i) => i.code === 0x15).map((i) => i.k);
    for (const nr of denied) expect(jeqs).toContain(nr);
    // every jump lands inside the program and the last instructions are returns
    insns.forEach((insn, index) => {
      if ((insn.code & 0x07) === 0x05) {
        expect(index + 1 + insn.jt).toBeLessThan(insns.length);
        expect(index + 1 + insn.jf).toBeLessThan(insns.length);
      }
    });
    const rets = insns.filter((i) => i.code === 0x06).map((i) => i.k);
    expect(rets).toContain(0x7fff0000); // ALLOW
    expect(rets).toContain(0x00050000 | 1); // ERRNO(EPERM)
    expect(rets).toContain(0x00050000 | 38); // ERRNO(ENOSYS) for clone3
  });

  it('x64 kills x32-ABI syscalls; arm64 does not need that check', () => {
    const x64 = decode(seccompFilter('x64')!);
    expect(x64.some((i) => i.code === 0x35 && i.k === 0x40000000)).toBe(true);
    const arm64 = decode(seccompFilter('arm64')!);
    expect(arm64.some((i) => i.code === 0x35)).toBe(false);
  });

  it('returns nothing for an unsupported architecture', () => {
    expect(seccompFilter('ia32')).toBeUndefined();
  });

  it('is attached to bwrap via fd 3 when the backend is active', () => {
    resetSandboxProbe();
    const status = sandboxStatus();
    const wrapped = wrapInSandbox('sh', ['-c', 'true'], { projectRoot: os.tmpdir(), cwd: os.tmpdir() });
    if (status.mode !== 'bwrap' || !status.seccomp) return;
    const at = wrapped.args.indexOf('--seccomp');
    expect(at).toBeGreaterThan(0);
    expect(wrapped.args[at + 1]).toBe('3');
    expect(wrapped.args.indexOf('--')).toBeGreaterThan(at);
    expect(wrapped.seccomp).toBeInstanceOf(Buffer);
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

  it('fleet mode: git commit inside a worktree whose .git lives in the main repository', async () => {
    const git = (cmd: string, cwd: string) => runShell(`git ${cmd}`, { cwd, projectRoot: cwd, unsandboxed: true });
    const main = path.join(sandbox, 'main');
    await fs.mkdir(main);
    for (const cmd of ['init -q -b main', 'config user.email t@t', 'config user.name t', 'commit -q --allow-empty -m init']) {
      expect((await git(cmd, main)).code).toBe(0);
    }
    const worktree = path.join(sandbox, 'wt');
    expect((await git(`worktree add -q ${worktree} -b feature`, main)).code).toBe(0);

    // The worktree is the sandbox's project root; its index/HEAD are under main/.git.
    const commit = await runShell(
      'git config user.email t@t && git config user.name t && echo change > f.txt && git add f.txt && git commit -q -m sandboxed && git rev-parse --short HEAD',
      { cwd: worktree, projectRoot: worktree },
    );
    expect(commit.stderr).toBe('');
    expect(commit.code).toBe(0);
    expect(commit.sandbox).not.toBe('none');
    const log = await git('log --oneline feature', main);
    expect(log.stdout).toContain('sandboxed');
    // ...but the rest of the main repository's working tree is still read-only.
    const escape = await runShell(`echo pwned > ${path.join(main, 'README')}`, { cwd: worktree, projectRoot: worktree });
    expect(escape.code).not.toBe(0);
  });

  it.skipIf(process.platform !== 'linux')('seccomp: mount, ptrace and namespace creation are refused', async () => {
    if (!sandboxStatus().seccomp) return;
    const mount = await runShell('mount -t tmpfs none /tmp 2>&1; echo "exit=$?"', { cwd: project, projectRoot: project });
    expect(mount.stdout).toMatch(/exit=[1-9]/);
    expect(mount.stdout).toMatch(/not permitted|Operation not permitted|permission/i);
    // unshare(1) uses unshare(2)/clone with CLONE_NEW*: both paths are EPERM
    const ns = await runShell('unshare -U true 2>&1; echo "exit=$?"', { cwd: project, projectRoot: project });
    expect(ns.stdout).toMatch(/exit=[1-9]/);
    // threads (clone without namespace flags, or clone3 → ENOSYS → clone) still work
    const threads = await runShell('node -e "require(\'node:worker_threads\'); new (require(\'node:worker_threads\').Worker)(\'process.exit(0)\', { eval: true }).on(\'exit\', (c) => console.log(\'worker\', c))"', { cwd: project, projectRoot: project });
    expect(threads.stdout.trim()).toBe('worker 0');
  });
});
