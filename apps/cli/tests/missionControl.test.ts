import { describe, expect, it } from 'vitest';
import { renderMissionControl, type MissionSnapshot } from '../src/tui/missionControl.js';
import { stripAnsi } from '../src/tui/unicode.js';

const empty: MissionSnapshot = {
  workspace: '/workspace', agents: 0, running: 0, ready: 0, installed: 0,
  computers: 0, jobs: [], models: [], runtimes: [], approvals: 0,
  inputTokens: 0, outputTokens: 0, events: [], evidence: [],
};

describe('Mission Control projection', () => {
  it('keeps operational sections visible in a 64x24 terminal', () => {
    const rows = renderMissionControl(empty, 64, 16);
    const screen = stripAnsi(rows.join('\n'));
    for (const title of ['EXECUTION MONITOR', 'MODELS & PROVIDERS', 'ACTIVITY & TOOL CALLS', 'VERIFICATION EVIDENCE']) expect(screen).toContain(title);
    expect(rows.length).toBeLessThanOrEqual(16);
    expect(screen).toContain('No models discovered');
    expect(screen).toContain('Cost: unreported');
    expect(screen).not.toContain('PASS');
    expect(screen).not.toContain('H100');
  });

  it('projects real execution, provider, approval, usage and evidence values', () => {
    const screen = stripAnsi(renderMissionControl({ ...empty, agents: 2, running: 1, ready: 1, installed: 2,
      jobs: [{ id: 'job-real', title: 'Fix compiler error', status: 'failed' }],
      models: [{ name: 'configured-model', provider: 'configured-provider', ready: true }],
      approvals: 3, inputTokens: 123, outputTokens: 45,
      events: [{ time: '12:34', kind: 'tool', text: 'npm test exit 1' }],
      evidence: ['TEST failed: exit 1'],
    }, 120, 42).join('\n'));
    for (const value of ['╱▲╲', 'MISSION CONTROL', 'job-real', 'FAILED', 'configured-provider', '3 approvals', '123 in / 45 out', 'npm test exit 1', 'TEST failed']) expect(screen).toContain(value);
  });
});
