import { describe, expect, it } from 'vitest';
import { currentAttemptErrors, evaluateExecution } from '../src/index.js';

const resumed = (errorsBefore: number) => ({ id: 'e', executionId: 'x', type: 'execution.resumed', eventType: 'execution.resumed', timestamp: new Date(), data: { errorsBefore } });

describe('currentAttemptErrors', () => {
  it('counts every error when the execution never resumed', () => {
    expect(currentAttemptErrors({ errors: ['a', 'b'], events: [] })).toEqual(['a', 'b']);
  });

  it('keeps earlier attempts\' errors as history but only counts those after the latest resumption', () => {
    const record = { errors: ['attempt 1 failed', 'attempt 2 failed', 'attempt 3 broke'], events: [resumed(1), resumed(2)] as never };
    expect(currentAttemptErrors(record)).toEqual(['attempt 3 broke']);
  });

  it('a clean resumed attempt evaluates without the earlier attempt\'s error', () => {
    const base = { filesChanged: ['NOTES.txt'], checks: [], errors: ['NO_PROGRESS: attempt 1'] };
    expect(evaluateExecution({ ...base, events: [] as never }).success).toBe(false);
    expect(evaluateExecution({ ...base, events: [resumed(1)] as never }).success).toBe(true);
  });
});
