import { describe, it, expect } from 'vitest';
import { SessionPolicyTracker } from '../src/sessionPolicyHooks.js';

describe('SessionPolicyTracker', () => {
  it('triggers spend checkpoint ask every configured USD interval', () => {
    const tracker = new SessionPolicyTracker({ spendPauseIntervalUSD: 100 });
    tracker.recordSpend('s1', 60);
    expect(tracker.evaluate('s1', { tool: 'run_shell', input: { command: 'ls' } })).toBeNull();

    tracker.recordSpend('s1', 45);
    const decision = tracker.evaluate('s1', { tool: 'run_shell', input: { command: 'ls' } });
    expect(decision?.decision).toBe('ask');
    expect(decision?.rule).toBe('session-spend-checkpoint');

    tracker.acknowledgeSpendCheckpoint('s1');
    expect(tracker.evaluate('s1', { tool: 'run_shell', input: { command: 'ls' } })).toBeNull();
  });

  it('gates git push after a package install occurred in the session', () => {
    const tracker = new SessionPolicyTracker({ gateGitPushAfterPackageInstall: true });
    expect(tracker.evaluate('s2', { tool: 'run_shell', input: { command: 'git push origin main' } })).toBeNull();

    tracker.recordShellCommand('s2', 'npm install lodash');
    const decision = tracker.evaluate('s2', { tool: 'run_shell', input: { command: 'git push origin main' } });
    expect(decision?.decision).toBe('ask');
    expect(decision?.rule).toBe('session-git-push-after-package-install');
  });

  it('restricts writes to agent-created files when enabled', () => {
    const tracker = new SessionPolicyTracker({ restrictWritesToAgentCreated: true });
    tracker.recordAgentCreatedFile('s3', '/repo/docs/new-note.md');

    expect(tracker.evaluate('s3', { tool: 'write_file', input: { path: '/repo/docs/new-note.md' } })).toBeNull();
    const denied = tracker.evaluate('s3', { tool: 'edit_file', input: { path: '/repo/src/index.ts' } });
    expect(denied?.decision).toBe('deny');
    expect(denied?.rule).toBe('session-agent-created-files-only');
  });
});
