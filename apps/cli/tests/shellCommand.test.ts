import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WAZIR_SHELL_COMMANDS, classifyShellInput } from '@wazir/core';
import { createInitialShellState, executeShellLine } from '../src/commands/shellCommand.js';

describe('Wazir universal shell session', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-shell-cmd-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves working directory, env vars, aliases, and exit codes', async () => {
    const state = createInitialShellState(os.tmpdir());
    expect(await executeShellLine('export WAZIR_TEST_VAR=hello_wazir', state)).toBe(0);
    expect(state.env.WAZIR_TEST_VAR).toBe('hello_wazir');

    expect(await executeShellLine('alias ll="ls -la"', state)).toBe(0);
    expect(state.aliases.ll).toBe('ls -la');

    expect(await executeShellLine(`cd ${os.tmpdir()}`, state)).toBe(0);
    expect(path.resolve(state.cwd)).toBe(path.resolve(os.tmpdir()));

    const failCode = await executeShellLine('! false', state);
    expect(failCode).toBe(1);
    expect(state.lastExitCode).toBe(1);

    expect(await executeShellLine('unset WAZIR_TEST_VAR', state)).toBe(0);
    expect(state.env.WAZIR_TEST_VAR).toBeUndefined();
  });

  it('routes natural language and ? requests to AI handler and falls back offline', async () => {
    const state = createInitialShellState(process.cwd());
    const routed: string[] = [];
    const code = await executeShellLine('? summarize git status', state, async (req) => {
      routed.push(req);
      return 0;
    });
    expect(code).toBe(0);
    expect(routed).toEqual(['summarize git status']);

    // Offline fallback: ordinary shell commands still succeed when AI handler is absent
    expect(await executeShellLine('echo offline_ok', state)).toBe(0);
    expect(await executeShellLine('explain this', state)).toBe(1);
  });

  it('executes OS commands with quotes, pipelines, and collision escapes (\\jobs, ! jobs, os:status, sh:history)', async () => {
    const spaced = path.join(tmpDir, 'dir with spaces');
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(spaced, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    const marker = path.join(tmpDir, 'os-status-ran.txt');
    const fakeStatus = path.join(binDir, process.platform === 'win32' ? 'status.cmd' : 'status');
    fs.writeFileSync(fakeStatus, `#!/bin/sh\necho "OS_STATUS_OK" > "${marker}"\n`, { mode: 0o755 });

    const state = createInitialShellState({
      initialCwd: tmpDir,
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
    });

    expect(await executeShellLine(`cd "${spaced}"`, state)).toBe(0);
    expect(fs.realpathSync(state.cwd)).toBe(fs.realpathSync(spaced));

    const pipeOut = path.join(tmpDir, 'pipe-count.txt');
    expect(await executeShellLine(`printf "one\\ntwo\\nthree\\n" | grep -E "one|three" | wc -l > "${pipeOut}"`, state)).toBe(0);
    expect(fs.readFileSync(pipeOut, 'utf8').trim()).toBe('2');

    // Collision escapes always route to OS shell rather than Wazir Shell commands
    expect(classifyShellInput('\\jobs')).toMatchObject({ mode: 'shell', explicit: true, command: 'jobs' });
    expect(classifyShellInput('! jobs')).toMatchObject({ mode: 'shell', explicit: true, command: 'jobs' });
    expect(classifyShellInput('os:status')).toMatchObject({ mode: 'shell', explicit: true, command: 'status' });
    expect(classifyShellInput('sh:history')).toMatchObject({ mode: 'shell', explicit: true, command: 'history' });

    expect(await executeShellLine('\\jobs', state)).toBe(0);
    expect(await executeShellLine('! jobs', state)).toBe(0);
    expect(await executeShellLine('os:status', state)).toBe(0);
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe('OS_STATUS_OK');
    expect(await executeShellLine('sh:history', state)).toBe(0);
  });

  it('recognizes all reserved Wazir commands and handles Wazir session builtins cleanly', async () => {
    const state = createInitialShellState(tmpDir);

    for (const cmd of WAZIR_SHELL_COMMANDS) {
      expect(classifyShellInput(cmd)).toMatchObject({
        mode: 'wazir',
        wazirCommand: cmd,
        explicit: true,
      });
    }

    expect(classifyShellInput('loop "Improve X && test it"')).toMatchObject({
      mode: 'wazir',
      wazirCommand: 'loop',
      wazirArgs: '"Improve X && test it"',
    });

    expect(await executeShellLine('jobs', state)).toBe(0);
    expect(await executeShellLine('history', state)).toBe(0);
    expect(state.history).toContain('jobs');
    expect(state.history).toContain('history');
  });
});
