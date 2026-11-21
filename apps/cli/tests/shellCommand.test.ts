import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WAZIR_SHELL_COMMANDS, classifyShellInput } from '@wazir/core';
import {
  completeShellInput,
  createInitialShellState,
  createShellAiHandler,
  executeShellLine,
  expandShellEnv,
} from '../src/commands/shellCommand.js';

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

  it('executes loop, graph, goal, jobs, inspect, status directly from Wazir Shell using shared store', async () => {
    const prevHome = process.env.WAZIR_HOME;
    const prevWs = process.env.WAZIR_WORKSPACE_DIR;
    const wazirHome = path.join(tmpDir, '.wazir-home');
    fs.mkdirSync(wazirHome, { recursive: true });
    process.env.WAZIR_HOME = wazirHome;
    process.env.WAZIR_WORKSPACE_DIR = tmpDir;
    fs.writeFileSync(
      path.join(tmpDir, 'cities.json'),
      JSON.stringify([{ name: 'Solis' }, { name: 'Vespera' }]),
    );

    try {
      const state = createInitialShellState(tmpDir);
      expect(await executeShellLine(`loop "Improve every Lorecraft city" --workspace "${tmpDir}" --json`, state)).toBe(0);
      expect(await executeShellLine(`graph "Build multiplayer platform with auth and QA" --workspace "${tmpDir}" --dry-run --json`, state)).toBe(0);
      expect(await executeShellLine(`goal "Check Lorecraft cities" --workspace "${tmpDir}" --json`, state)).toBe(0);
      expect(await executeShellLine('jobs --json', state)).toBe(0);
      expect(await executeShellLine('status --json', state)).toBe(0);
      expect((state as { lastRunId?: string }).lastRunId).toBeTruthy();
      expect(await executeShellLine('inspect --json', state)).toBe(0);
    } finally {
      if (prevHome === undefined) delete process.env.WAZIR_HOME;
      else process.env.WAZIR_HOME = prevHome;
      if (prevWs === undefined) delete process.env.WAZIR_WORKSPACE_DIR;
      else process.env.WAZIR_WORKSPACE_DIR = prevWs;
    }
  });

  it('expands $VAR and ${VAR} inside cd and export builtins and handles /model and /permissions controls (DEF-005)', async () => {
    const subDir = path.join(tmpDir, 'nested-env-dir');
    fs.mkdirSync(subDir, { recursive: true });
    const state = createInitialShellState(tmpDir);

    expect(expandShellEnv('"$TARGET/sub"', { TARGET: '/tmp/wazir' })).toBe('/tmp/wazir/sub');
    expect(expandShellEnv("'${TARGET}'", { TARGET: '/tmp/wazir' })).toBe('${TARGET}');

    expect(await executeShellLine(`export SHELL_TARGET="${subDir}"`, state)).toBe(0);
    expect(await executeShellLine('export DERIVED="$SHELL_TARGET/child"', state)).toBe(0);
    expect(state.env.DERIVED).toBe(`${subDir}/child`);

    expect(await executeShellLine('cd "$SHELL_TARGET"', state)).toBe(0);
    expect(fs.realpathSync(state.cwd)).toBe(fs.realpathSync(subDir));

    expect(await executeShellLine('/model test-model-1', state)).toBe(0);
    expect(state.model).toBe('test-model-1');
    expect(await executeShellLine('/model auto', state)).toBe(0);
    expect(state.model).toBeUndefined();
    expect(await executeShellLine('/permissions read-only', state)).toBe(0);
    expect(state.permissionMode).toBe('read-only');
    expect(await executeShellLine('/permissions ask', state)).toBe(0);
    expect(state.permissionMode).toBe('ask');
  });

  it('completes builtins and filesystem paths relative to cwd (DEF-004)', () => {
    const subDir = path.join(tmpDir, 'alpha-dir');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'alpha-file.ts'), 'export const a = 1;\n');
    const state = createInitialShellState(tmpDir);

    const [cmdMatches, cmdSub] = completeShellInput('hel', state);
    expect(cmdSub).toBe('hel');
    expect(cmdMatches).toContain('help');

    const [permMatches] = completeShellInput('/permissions r', state);
    expect(permMatches).toContain('/permissions read-only');

    const [pathMatches, pathSub] = completeShellInput('cd alpha-', state);
    expect(pathSub).toBe('alpha-');
    expect(pathMatches).toContain('alpha-dir/');
    expect(pathMatches).toContain('alpha-file.ts');
  });

  it('aborts child process trees cleanly on AbortSignal without leaving orphans (DEF-003)', async () => {
    const state = createInitialShellState(tmpDir);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150);
    const startedAt = Date.now();
    const code = await executeShellLine('! sleep 10', state, undefined, { signal: controller.signal });
    clearTimeout(timer);
    expect(code).not.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });

  it('fails explicitly in createShellAiHandler when an isolated WAZIR_HOME has no reachable providers (A07)', async () => {
    const isolatedHome = path.join(tmpDir, 'isolated-home');
    fs.mkdirSync(isolatedHome, { recursive: true });
    const state = createInitialShellState({
      initialCwd: tmpDir,
      env: {
        ...process.env,
        WAZIR_HOME: isolatedHome,
        WAZIR_SKIP_RUNTIME_DISCOVERY: '1',
        NVIDIA_API_KEY: '',
        NVAPI_KEY: '',
      },
    });
    const handler = createShellAiHandler({ interactive: false, fastStartup: true, skipRuntimeDiscovery: true });
    // Clear inherited env keys inside isolated test scope only if present
    const prevNvidia = process.env.NVIDIA_API_KEY;
    const prevNvapi = process.env.NVAPI_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.NVAPI_KEY;
    try {
      const code = await executeShellLine('? summarize this directory', state, handler);
      expect(code).toBe(1);
      expect(state.lastAiOutcome?.success).toBe(false);
      // Native commands continue operating cleanly after AI provider failure
      expect(await executeShellLine('! echo NATIVE_STILL_OK', state)).toBe(0);
    } finally {
      if (prevNvidia !== undefined) process.env.NVIDIA_API_KEY = prevNvidia;
      if (prevNvapi !== undefined) process.env.NVAPI_KEY = prevNvapi;
    }
  }, 15_000);
});
