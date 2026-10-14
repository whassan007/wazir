import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectPolicy } from '../src/commands.js';
import { LMStudioAdapter } from '@wazir/runtimes-lmstudio';

const cliPath = path.resolve(__dirname, '../../../bin/wa.js');

describe('post-audit defect remediation & regression suite', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'wazir-remediation-test-'));
  });

  afterEach(() => {
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  it('DEF-01: inspectPolicy safely handles rules missing scope or pattern without throwing TypeError', () => {
    const mockEngine = {
      policy: {
        rules: [
          { id: 'custom-rule-1', description: 'Rule without scope or pattern', effect: 'allow' as const },
          { id: 'custom-rule-2', scope: 'filesystem', description: 'Rule with scope only', effect: 'deny' as const },
        ],
      },
      projectRoot: '/tmp/test-project',
      config: {
        networkAllowed: false,
        allowCommands: [],
        denyCommands: [],
        allowedMcpServers: [],
      },
    } as any;

    expect(() => inspectPolicy(mockEngine)).not.toThrow();
    const output = inspectPolicy(mockEngine);
    expect(output).toContain('Policy rules');
    expect(output).toContain('custom-rule-1');
    expect(output).toContain('filesystem');
  });

  it('DEF-04: LMStudioAdapter default baseURL defaults to port 1234', () => {
    const originalEnv = process.env.WAZIR_LMSTUDIO_URL;
    try {
      delete process.env.WAZIR_LMSTUDIO_URL;
      const adapter = new LMStudioAdapter();
      expect(adapter.baseURL).toBe('http://localhost:1234/v1');
    } finally {
      if (originalEnv !== undefined) process.env.WAZIR_LMSTUDIO_URL = originalEnv;
    }
  });

  it('DEF-02: wa task status <bogus> exits with code 1 and outputs not found', () => {
    const res = spawnSync(process.execPath, [cliPath, 'task', 'status', 'bogus-task-nonexistent-12345'], {
      env: { ...process.env, WAZIR_HOME: tempHome },
      encoding: 'utf8',
      timeout: 10000,
    });

    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toContain("Task 'bogus-task-nonexistent-12345' not found");
  });

  it('DEF-05: wa computers inspect <bogus> exits with code 1', () => {
    const res = spawnSync(process.execPath, [cliPath, 'computers', 'inspect', 'nonexistent-computer-xyz'], {
      env: { ...process.env, WAZIR_HOME: tempHome },
      encoding: 'utf8',
      timeout: 10000,
    });

    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toContain("computer 'nonexistent-computer-xyz' not found");
  });

  it('DEF-05: wa executions inspect <bogus> exits with code 1', () => {
    const res = spawnSync(process.execPath, [cliPath, 'executions', 'inspect', 'nonexistent-exec-xyz'], {
      env: { ...process.env, WAZIR_HOME: tempHome },
      encoding: 'utf8',
      timeout: 10000,
    });

    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toContain("execution 'nonexistent-exec-xyz' not found");
  });

  it('DEF-05: wa artifacts inspect <bogus> exits with code 1', () => {
    const res = spawnSync(process.execPath, [cliPath, 'artifacts', 'inspect', 'nonexistent-artifact-xyz'], {
      env: { ...process.env, WAZIR_HOME: tempHome },
      encoding: 'utf8',
      timeout: 10000,
    });

    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toContain('artifact not found');
  });

  it('DEF-05: wa runtimes inspect <bogus> exits with code 1', () => {
    const res = spawnSync(process.execPath, [cliPath, 'runtimes', 'inspect', 'nonexistent-runtime-xyz'], {
      env: { ...process.env, WAZIR_HOME: tempHome },
      encoding: 'utf8',
      timeout: 10000,
    });

    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toContain("Runtime 'nonexistent-runtime-xyz' not found");
  });

  it('DEF-05: wa models inspect <bogus> exits with code 1', () => {
    const res = spawnSync(process.execPath, [cliPath, 'models', 'inspect', 'nonexistent-model-xyz'], {
      env: { ...process.env, WAZIR_HOME: tempHome },
      encoding: 'utf8',
      timeout: 10000,
    });

    expect(res.status).toBe(1);
  });
});
