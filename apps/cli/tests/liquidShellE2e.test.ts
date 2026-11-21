import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIQUID_SHELL_MODEL_ID,
  LIQUID_SHELL_PROVIDER,
  shutdownLiquidEmbeddedServer,
} from '@wazir/core';
import {
  createInitialShellState,
  createShellAiHandler,
  executeShellLine,
} from '../src/commands/shellCommand.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('Wazir Shell Built-In Liquid AI E2E Verification (Offline Zero-Config)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-liquid-e2e-home-'));
  });

  afterAll(async () => {
    await shutdownLiquidEmbeddedServer();
  });

  it('executes all required Path A deterministic and Path B Liquid AI shell requests offline without Ollama, LM Studio, or cloud keys', async () => {
    const state = createInitialShellState({
      initialCwd: REPO_ROOT,
      env: {
        ...process.env,
        WAZIR_HOME: tmpHome,
        WAZIR_EMBEDDED_ROOT: REPO_ROOT,
        WAZIR_SKIP_RUNTIME_DISCOVERY: '1',
        NVIDIA_API_KEY: '',
        NVAPI_KEY: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        GEMINI_API_KEY: '',
      },
    });

    const aiHandler = createShellAiHandler({
      interactive: false,
      fastStartup: true,
      skipRuntimeDiscovery: true,
    });

    const runCaptured = async (line: string): Promise<{ code: number; stdout: string }> => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
      try {
        const code = await executeShellLine(line, state, aiHandler);
        return { code, stdout: logs.join('\n') };
      } finally {
        spy.mockRestore();
      }
    };

    // 1. what time is it (Path A deterministic)
    const timeRes = await runCaptured('what time is it');
    expect(timeRes.code).toBe(0);
    expect(timeRes.stdout).toMatch(/\d{1,2}:\d{2}\s*(?:AM|PM)/i);

    // 2. what directory am I in (Path A deterministic)
    const dirRes = await runCaptured('what directory am I in');
    expect(dirRes.code).toBe(0);
    expect(dirRes.stdout.trim()).toBe(REPO_ROOT);

    // 3. pwd (Path A deterministic)
    const pwdRes = await runCaptured('pwd');
    expect(pwdRes.code).toBe(0);
    expect(pwdRes.stdout.trim()).toBe(REPO_ROOT);

    // 4. ls -la (Path A deterministic native shell)
    const lsCode = await executeShellLine('ls -la > /dev/null', state, aiHandler);
    expect(lsCode).toBe(0);

    // 5. show the largest files (Path B bundled Liquid AI LFM2.5-350M-Q4_K_M)
    const largestRes = await runCaptured('show the largest files');
    expect(largestRes.code).toBe(0);
    expect(largestRes.stdout).toContain('LFM2.5-350M-Q4_K_M.gguf');
    expect(state.lastAiOutcome?.modelId).toBe(LIQUID_SHELL_MODEL_ID);
    expect(state.lastAiOutcome?.runtimeId).toBe(LIQUID_SHELL_PROVIDER);

    // 6. find TypeScript files (Path B bundled Liquid AI LFM2.5-350M-Q4_K_M)
    const findTsRes = await runCaptured('find TypeScript files');
    expect(findTsRes.code).toBe(0);
    expect(findTsRes.stdout).toMatch(/\.ts\b/);
    expect(state.lastAiOutcome?.modelId).toBe(LIQUID_SHELL_MODEL_ID);
    expect(state.lastAiOutcome?.runtimeId).toBe(LIQUID_SHELL_PROVIDER);

    // 7. summarize git status (Path B bundled Liquid AI LFM2.5-350M-Q4_K_M)
    const gitStatusRes = await runCaptured('summarize git status');
    expect(gitStatusRes.code).toBe(0);
    expect(gitStatusRes.stdout).toMatch(/Branch/i);
    expect(state.lastAiOutcome?.modelId).toBe(LIQUID_SHELL_MODEL_ID);
    expect(state.lastAiOutcome?.runtimeId).toBe(LIQUID_SHELL_PROVIDER);

    // 8. version (Path A deterministic)
    const verRes = await runCaptured('version');
    expect(verRes.code).toBe(0);
    expect(verRes.stdout).toMatch(/^Wazir v\d+\.\d+\.\d+/);
  }, 30_000);
});
