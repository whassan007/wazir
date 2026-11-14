import { afterEach, describe, expect, it } from 'vitest';
import { createIsolatedWorkspace, runWaConPty } from './e2eHarness.js';

describe('node-pty live harness', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => { await cleanup?.(); });

  it('captures terminal output and records successful wait and exit steps', async () => {
    const result = await runWaConPty(['--help'], {
      steps: [
        { op: 'wait', text: 'Usage: wa', timeout: 10 },
        { op: 'exit', expectCode: 0, timeout: 10 },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.steps.every((step) => step.ok)).toBe(true);
    expect(result.cleanOutput).toContain('Usage: wa');
    expect(result.cleanOutput).not.toContain('\x1b');
    expect(result.outputBytes).toBeGreaterThan(0);
    expect(result.timedOut).toBe(false);
    expect(result.killed).toBe(false);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('drives an isolated interactive chat with resize, delay, and send steps', async () => {
    const workspace = await createIsolatedWorkspace('wazir-conpty-');
    cleanup = workspace.cleanup;
    const result = await runWaConPty(['chat'], {
      cwd: workspace.workspaceDir, env: workspace.env,
      steps: [
        { op: 'wait', text: 'WAZIR', timeout: 15 },
        { op: 'resize', cols: 100, rows: 30 },
        { op: 'sleep', ms: 10 },
        { op: 'send', data: '/exit\r', delayBeforeMs: 10 },
        { op: 'exit', expectCode: 0, timeout: 15 },
      ],
    });
    expect(result.steps.every((step) => step.ok)).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.rawOutput).toContain('WAZIR');
    expect(result.timedOut).toBe(false);
  }, 35_000);

  it('reports a timed out wait and kills the remaining child', async () => {
    const workspace = await createIsolatedWorkspace('wazir-conpty-timeout-');
    cleanup = workspace.cleanup;
    const result = await runWaConPty(['chat'], {
      cwd: workspace.workspaceDir, env: workspace.env,
      steps: [
        { op: 'wait', text: 'WAZIR', timeout: 15 },
        { op: 'wait', text: 'impossible harness sentinel', timeout: 0.1 },
      ],
    });
    expect(result.steps[0].ok).toBe(true);
    expect(result.steps[1].ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.killed).toBe(true);
  }, 20_000);
});
