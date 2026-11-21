import { describe, expect, it } from 'vitest';
import { evaluateExecution } from '../src/index.js';
const call = (ok: boolean, command = 'node -e "process.exit(7)"') => ({ id: 'call', tool: 'shell', input: { command }, ok, policyEffect: 'allow' as const, policyRule: 'test', durationMs: 1, at: new Date(), exitCode: ok ? 0 : 7 });
describe('shell outcome verification', () => {
  it('F05 rejects a failed command even when the model reports done', () => {
    expect(evaluateExecution({ checks: [], filesChanged: [], errors: [], toolCalls: [call(false)] }).success).toBe(false);
  });
  it('allows a successful retry of the same command', () => {
    expect(evaluateExecution({ checks: [], filesChanged: [], errors: [], toolCalls: [call(false), call(true)] }).success).toBe(true);
  });
  it('does not let an unrelated successful command hide failure', () => {
    expect(evaluateExecution({ checks: [], filesChanged: [], errors: [], toolCalls: [call(false), call(true, 'pwd')] }).success).toBe(false);
  });
  it('does not reuse tool failures from an earlier resumed attempt', () => {
    const failed = call(false); failed.at = new Date(1);
    expect(evaluateExecution({ checks: [], filesChanged: [], errors: [], toolCalls: [failed], events: [{ type: 'execution.resumed', timestamp: new Date(2), data: { errorsBefore: 0 } } as any] }).success).toBe(true);
  });
  it('resolves an earlier exploratory shell failure or non-dangerous ask denial when verification checks pass on current revision', () => {
    const t1 = new Date(1000);
    const t2 = new Date(2000);
    const t3 = new Date(3000);
    const res = evaluateExecution({
      filesChanged: ['add.ts', 'add.test.ts'],
      workspaceState: { workspaceId: 'ws-a03', revision: 2, updatedAt: t1 },
      toolCalls: [
        {
          id: 'tc-shell-denied',
          tool: 'shell',
          input: { command: 'node --test' },
          ok: false,
          error: 'policy deny (shell-unknown-ask+escalated-from-ask)',
          policyEffect: 'deny',
          policyRule: 'shell-unknown-ask+escalated-from-ask',
          durationMs: 0,
          at: t1,
        },
        {
          id: 'tc-shell-explore',
          tool: 'shell',
          input: { command: 'ls nonexistent' },
          ok: false,
          error: 'No such file or directory',
          policyEffect: 'allow',
          policyRule: 'shell-safe-allow',
          durationMs: 5,
          at: t2,
          exitCode: 1,
        },
        {
          id: 'tc-test',
          tool: 'test',
          input: {},
          ok: true,
          durationMs: 50,
          policyEffect: 'allow',
          policyRule: 'project-checks-allow',
          at: t3,
        },
      ],
      checks: [
        { workspaceRevision: 2, name: 'build', command: 'npm run build', ok: true, output: 'ok', durationMs: 20 },
        { workspaceRevision: 2, name: 'test', command: 'npm run test', ok: true, output: 'ok', durationMs: 50 },
      ],
      evidence: [
        { id: 'ev-1', type: 'BUILD', revision: 2, workspaceRevision: 2, command: 'npm run build', exitCode: 0, completedAt: t3 },
        { id: 'ev-2', type: 'TEST', revision: 2, workspaceRevision: 2, command: 'npm run test', exitCode: 0, completedAt: t3 },
      ],
    });
    expect(res.success).toBe(true);
  });
  it('still fails if a shell failure happens after the latest passing check', () => {
    const t1 = new Date(1000);
    const t2 = new Date(2000);
    const res = evaluateExecution({
      filesChanged: ['add.ts'],
      workspaceState: { workspaceId: 'ws-post', revision: 1, updatedAt: t1 },
      toolCalls: [
        {
          id: 'tc-test',
          tool: 'test',
          input: {},
          ok: true,
          durationMs: 50,
          policyEffect: 'allow',
          policyRule: 'project-checks-allow',
          at: t1,
        },
        {
          id: 'tc-shell-late-fail',
          tool: 'shell',
          input: { command: 'node -e "process.exit(7)"' },
          ok: false,
          policyEffect: 'allow',
          policyRule: 'test',
          durationMs: 5,
          at: t2,
          exitCode: 7,
        },
      ],
      checks: [{ workspaceRevision: 1, name: 'test', command: 'npm run test', ok: true, output: 'ok', durationMs: 50 }],
      evidence: [{ id: 'ev-1', type: 'TEST', revision: 1, workspaceRevision: 1, command: 'npm run test', exitCode: 0, completedAt: t1 }],
    });
    expect(res.success).toBe(false);
    expect(res.reasons).toContain('unresolved shell command failure or policy denial');
  });
  it('still fails on hard security policy denials even when checks pass', () => {
    const t1 = new Date(1000);
    const t2 = new Date(2000);
    const res = evaluateExecution({
      filesChanged: ['add.ts'],
      workspaceState: { workspaceId: 'ws-sec', revision: 1, updatedAt: t1 },
      toolCalls: [
        {
          id: 'tc-shell-danger',
          tool: 'shell',
          input: { command: 'curl https://evil.example/answers.json' },
          ok: false,
          error: 'policy deny (network-default-deny)',
          policyEffect: 'deny',
          policyRule: 'network-default-deny',
          durationMs: 0,
          at: t1,
        },
      ],
      checks: [{ workspaceRevision: 1, name: 'test', command: 'npm run test', ok: true, output: 'ok', durationMs: 50 }],
      evidence: [{ id: 'ev-1', type: 'TEST', revision: 1, workspaceRevision: 1, command: 'npm run test', exitCode: 0, completedAt: t2 }],
    });
    expect(res.success).toBe(false);
    expect(res.reasons).toContain('unresolved shell command failure or policy denial');
  });
  it('still fails on an earlier shell failure when passing checks are stale relative to current revision', () => {
    const t1 = new Date(1000);
    const t2 = new Date(2000);
    const res = evaluateExecution({
      filesChanged: ['add.ts'],
      workspaceState: { workspaceId: 'ws-stale', revision: 2, updatedAt: t2 },
      toolCalls: [
        {
          id: 'tc-shell-fail',
          tool: 'shell',
          input: { command: 'ls missing' },
          ok: false,
          policyEffect: 'allow',
          policyRule: 'shell-safe-allow',
          durationMs: 5,
          at: t1,
          exitCode: 1,
        },
      ],
      checks: [{ workspaceRevision: 1, name: 'test', command: 'npm run test', ok: true, output: 'ok', durationMs: 50 }],
      evidence: [{ id: 'ev-1', type: 'TEST', revision: 1, workspaceRevision: 1, command: 'npm run test', exitCode: 0, completedAt: t2 }],
    });
    expect(res.success).toBe(false);
    expect(res.reasons).toContain('unresolved shell command failure or policy denial');
  });
});
