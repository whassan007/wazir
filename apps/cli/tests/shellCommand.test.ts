import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { createInitialShellState, executeShellLine } from '../src/commands/shellCommand.js';

describe('Wazir universal shell session', () => {
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
});
