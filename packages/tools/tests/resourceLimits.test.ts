import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultResourceLimits, wrapWithResourceLimits } from '../src/resourceLimits.js';
import { runShell } from '../src/process.js';

describe('wrapWithResourceLimits (pure)', () => {
  it('is a no-op when no limits are set', () => {
    const result = wrapWithResourceLimits('echo', ['hi'], {});
    expect(result.applied).toBe(false);
    expect(result.file).toBe('echo');
    expect(result.args).toEqual(['hi']);
  });

  it('wraps with a ulimit-setting bash script that execs the original command', () => {
    const result = wrapWithResourceLimits('echo', ['hi'], { maxCpuSeconds: 30, maxFileSizeMB: 10 });
    expect(result.applied).toBe(true);
    expect(result.file).toBe('bash');
    expect(result.args[0]).toBe('-c');
    expect(result.args[1]).toContain('ulimit -t 30');
    expect(result.args[1]).toContain('ulimit -f 10240');
    expect(result.args[1]).toContain('exec "$@"');
    expect(result.args.slice(2)).toEqual(['wazir-limited', 'echo', 'hi']);
  });

  it('only emits ulimit lines for limits that are actually set', () => {
    const result = wrapWithResourceLimits('echo', [], { maxCpuSeconds: 5 });
    expect(result.args[1]).toContain('ulimit -t 5');
    expect(result.args[1]).not.toContain('ulimit -v');
    expect(result.args[1]).not.toContain('ulimit -u');
    expect(result.args[1]).not.toContain('ulimit -f');
  });
});

describe('defaultResourceLimits', () => {
  it('does not enable maxMemoryMB or maxProcesses by default (RLIMIT_AS/NPROC footguns — see doc comment)', () => {
    const limits = defaultResourceLimits();
    expect(limits.maxMemoryMB).toBeFalsy();
    expect(limits.maxProcesses).toBeFalsy();
    expect(limits.maxCpuSeconds).toBeGreaterThan(0);
    expect(limits.maxFileSizeMB).toBeGreaterThan(0);
  });

  it('WAZIR_RESOURCE_LIMITS=0 disables everything', () => {
    const prev = process.env.WAZIR_RESOURCE_LIMITS;
    process.env.WAZIR_RESOURCE_LIMITS = '0';
    try {
      expect(defaultResourceLimits()).toEqual({});
    } finally {
      if (prev === undefined) delete process.env.WAZIR_RESOURCE_LIMITS;
      else process.env.WAZIR_RESOURCE_LIMITS = prev;
    }
  });
});

describe('resource limits actually constrain the process (real rlimits, Linux/macOS)', () => {
  it.skipIf(process.platform === 'win32')('kills a CPU-bound busy loop once it exceeds maxCpuSeconds', async () => {
    const result = await runShell(
      'x=0; while true; do x=$((x+1)); done',
      {
        cwd: os.tmpdir(),
        unsandboxed: true,
        resourceLimits: { maxCpuSeconds: 1 },
        timeoutMs: 15_000,
      },
    );
    // RLIMIT_CPU delivers SIGXCPU (then SIGKILL) well before the 15s wall-clock
    // timeout would — the process must not have been the one to exit cleanly.
    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBe(0);
  }, 20_000);

  it.skipIf(process.platform === 'win32')('stops a write partway through once it exceeds maxFileSizeMB', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-fsize-'));
    const target = path.join(dir, 'big.txt');
    try {
      const result = await runShell(
        `yes "0123456789" | head -c 20000000 > ${target}`,
        { cwd: dir, unsandboxed: true, resourceLimits: { maxFileSizeMB: 1 } },
      );
      expect(result.code).not.toBe(0);
      const stat = await fs.stat(target).catch(() => undefined);
      // RLIMIT_FSIZE caps the file at ~1MB (the shell/head is killed with SIGXFSZ
      // once it crosses the limit), nowhere near the 20MB the command asked for.
      expect(stat?.size ?? 0).toBeLessThan(2 * 1024 * 1024);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
