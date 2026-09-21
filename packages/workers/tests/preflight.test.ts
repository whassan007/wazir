import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runWorkerPreflight } from '../src/preflight.js';

describe('runWorkerPreflight', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-preflight-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('fails with WORKSPACE_NOT_FOUND if workspace directory does not exist', async () => {
    const nonExistent = path.join(tmpDir, 'does-not-exist');
    const result = await runWorkerPreflight({
      workspace: nonExistent,
      taskPrompt: 'echo test',
      skipCompilerProbe: true,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('WORKSPACE_NOT_FOUND');
    expect(result.reason).toContain('Workspace path does not exist');
  });

  it('fails with WORKSPACE_NOT_FOUND if workspace is a file rather than directory', async () => {
    const filePath = path.join(tmpDir, 'some-file.txt');
    fs.writeFileSync(filePath, 'hello');

    const result = await runWorkerPreflight({
      workspace: filePath,
      taskPrompt: 'echo test',
      skipCompilerProbe: true,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('WORKSPACE_NOT_FOUND');
    expect(result.reason).toContain('not a directory');
  });

  it('passes and creates .wazir subdirectories in a valid workspace', async () => {
    const result = await runWorkerPreflight({
      workspace: tmpDir,
      taskPrompt: 'simple task',
      skipCompilerProbe: true,
    });

    expect(result.ok).toBe(true);
    expect(result.tmpDir).toBe(path.join(tmpDir, '.wazir', 'tmp'));
    expect(fs.existsSync(path.join(tmpDir, '.wazir', 'tmp'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.wazir', 'home'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.wazir', 'cache'))).toBe(true);
  });

  it('passes compiler probe for C++ prompts when compiler is available', async () => {
    const result = await runWorkerPreflight({
      workspace: tmpDir,
      taskPrompt: 'write a C++ program with main.cpp and sort array',
      skipCompilerProbe: false,
    });

    // If host has g++ or clang++, probe passes; if not, fails cleanly with COMPILER_PROBE_FAILED
    if (result.ok) {
      expect(result.compilerAvailable).toBe(true);
    } else {
      expect(result.code).toBe('COMPILER_PROBE_FAILED');
    }
  });

  it('skips compiler probe when skipCompilerProbe is true even for C++ prompt', async () => {
    const result = await runWorkerPreflight({
      workspace: tmpDir,
      taskPrompt: 'build C++ project with clang++',
      skipCompilerProbe: true,
    });

    expect(result.ok).toBe(true);
    expect(result.compilerAvailable).toBe(false);
  });
});
