import { describe, expect, it } from 'vitest';
import { answerLocalUtilityQuestion } from '../src/tui/localUtilityAnswers.js';

describe('deterministic interactive shell answers', () => {
  const now = new Date('2026-11-21T22:02:00.000Z');

  it('answers the exact failing question without invoking a model', () => {
    const answer = answerLocalUtilityQuestion('what time is it today', now);
    expect(answer).toContain('Local time:');
    expect(answer).toContain('2026');
  });

  it('supports date questions without a model', () => {
    expect(answerLocalUtilityQuestion("what's today's date?", now)).toContain('Local date:');
  });

  it('never intercepts arbitrary prompts or model verification canaries', () => {
    expect(answerLocalUtilityQuestion('Reply with exactly WAZIR_OK', now)).toBeUndefined();
    expect(answerLocalUtilityQuestion('explain scheduling', now)).toBeUndefined();
    expect(answerLocalUtilityQuestion('what time is it in Tokyo', now)).toBeUndefined();
  });
});
