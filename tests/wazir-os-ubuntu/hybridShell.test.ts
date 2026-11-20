import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HybridShellSession,
  classifyHybridInput,
  computePercentiles,
} from '../../packages/ubuntu-os/src/index.js';

describe('Wazir OS Hybrid Shell (Agent 02 & 05)', () => {
  it('classifies standard Linux commands deterministically without an LLM', () => {
    for (const cmd of ['ls -la', 'pwd', 'git status', 'df -h', 'sudo apt update', 'echo hello | wc -c']) {
      const c = classifyHybridInput(cmd);
      expect(c.route).toBe('shell');
      expect(c.classifiedInMs).toBeLessThan(50);
    }
  });

  it('classifies natural-language requests for Wazir orchestration', () => {
    const prompts = [
      'Find the largest files in Downloads',
      'Diagnose my Wi-Fi problem',
      'Install Python and configure a development environment',
      'Optimize this repository using local models',
    ];
    for (const p of prompts) {
      const c = classifyHybridInput(p);
      expect(c.route).toBe('ai');
      expect(c.kind).toBe('natural-language');
    }
  });

  it('supports explicit !, ?, and /mode overrides and never guesses ambiguous input', () => {
    expect(classifyHybridInput('!Find something').route).toBe('shell');
    expect(classifyHybridInput('?ls -la').route).toBe('ai');
    expect(classifyHybridInput('xyzzy_unknown_token').route).toBe('ambiguous');
  });

  it('executes real shell commands with pipes, cd tracking, history, and offline AI resilience', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-shell-'));
    const historyFile = path.join(tmpDir, 'history');
    const session = new HybridShellSession({
      cwd: tmpDir,
      historyFile,
      // Simulate failed/offline AI orchestrator
      aiHandler: async () => {
        throw new Error('daemon offline');
      },
    });

    const pipeRes = await session.executeLine('echo "wazir ubuntu" | wc -w');
    expect(pipeRes.executedAs).toBe('shell');
    expect(pipeRes.exitCode).toBe(0);
    expect(pipeRes.stdout.trim()).toBe('2');

    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir);
    await session.executeLine(`cd ${subDir}`);
    expect(fs.realpathSync(session.getCwd())).toBe(fs.realpathSync(subDir));

    // Failed AI daemon does not prevent native commands
    const aiFail = await session.executeLine('?diagnose disk');
    expect(aiFail.executedAs).toBe('ai');
    expect(aiFail.exitCode).toBe(1);
    expect(aiFail.stderr).toContain('Ubuntu shell unaffected');

    const afterFail = await session.executeLine('pwd');
    expect(afterFail.exitCode).toBe(0);
    expect(afterFail.stdout.trim()).toBe(fs.realpathSync(subDir));

    // Mode switching
    const modeRes = await session.executeLine('/mode shell');
    expect(modeRes.executedAs).toBe('control');
    expect(session.getMode()).toBe('shell');
    expect(session.getHistory().length).toBeGreaterThanOrEqual(4);

    // Tier 0 p95 dispatch latency target (< 50 ms)
    const overheads: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await session.executeLine('true');
      overheads.push(r.dispatchOverheadMs);
    }
    const summary = computePercentiles(overheads);
    expect(summary.p95Ms).toBeLessThan(50);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
