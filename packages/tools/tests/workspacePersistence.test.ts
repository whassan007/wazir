import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PolicyEngine } from '@wazir/core';
import { shellTool } from '../src/process-tools.js';

describe('Shell Execution & Workspace Persistence Diagnostic Sequence', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-persist-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('runs the 4-step execution persistence sequence: touch, cat, compile, execute', async () => {
    const ctx = {
      projectRoot: tmpDir,
      env: {},
      networkAllowed: false,
    };

    // Step 1: touch wazir-persistence-test && ls -li wazir-persistence-test
    const res1 = await shellTool.execute(
      { command: 'touch wazir-persistence-test && ls -li wazir-persistence-test' },
      ctx,
    );
    expect(res1.ok).toBe(true);
    expect(res1.metadata?.exitCode).toBe(0);
    expect(typeof res1.metadata?.shellInvocationId).toBe('string');
    expect((res1.metadata?.shellInvocationId as string).startsWith('sh-')).toBe(true);
    expect(res1.metadata?.cwd).toBe(tmpDir);
    expect(res1.metadata?.projectRoot).toBe(tmpDir);
    expect(res1.output).toContain('wazir-persistence-test');

    // Step 2: ls -li wazir-persistence-test && cat wazir-persistence-test
    const res2 = await shellTool.execute(
      { command: 'ls -li wazir-persistence-test && cat wazir-persistence-test' },
      ctx,
    );
    expect(res2.ok).toBe(true);
    expect(res2.output).toContain('wazir-persistence-test');

    // Create source file for compilation
    const cppCode = '#include <iostream>\nint main() { std::cout << "PERSISTENCE_SUCCESS" << std::endl; return 0; }\n';
    await fs.writeFile(path.join(tmpDir, 'main.cpp'), cppCode, 'utf8');

    // Step 3: g++ main.cpp -o main && echo $? && ls -li main && file main
    const res3 = await shellTool.execute(
      { command: 'g++ main.cpp -o main && echo $? && ls -li main && file main' },
      ctx,
    );
    expect(res3.ok).toBe(true);
    expect(res3.output).toContain('main');

    // Step 4: ls -li main && file main && ./main
    const res4 = await shellTool.execute(
      { command: 'ls -li main && file main && ./main' },
      ctx,
    );
    expect(res4.ok).toBe(true);
    expect(res4.output).toContain('PERSISTENCE_SUCCESS');
  });

  it('contextual policy authorizes ./main execution under shell-workspace-artifact-allow', async () => {
    const policy = new PolicyEngine({
      projectRoot: tmpDir,
      allowWorkspaceArtifactExecution: true,
    });

    const decision = policy.classify({
      tool: 'shell',
      input: { command: './main' },
    });

    expect(decision.decision).toBe('allow');
    expect(decision.rule).toBe('shell-workspace-artifact-allow');
  });
});
