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
});
