import { describe, expect, it } from 'vitest';
import { keepEnds } from '../src/text.js';

/**
 * Phase 24 live run (exec-muf672uw-1): the recorded test-check output was the first
 * 4000 characters of a vitest log — progress noise — so which tests failed was lost.
 */
describe('keepEnds', () => {
  it('keeps the verdict at the end of a long check log', () => {
    const log = `> npm run test\n${'[-] Running check (test)...\n'.repeat(5000)} FAIL  apps/cli/tests/x.test.ts > y\n Test Files  1 failed | 177 passed (178)\n`;
    const bounded = keepEnds(log, 4000);
    expect(bounded.length).toBeLessThan(4100);
    expect(bounded.startsWith('> npm run test')).toBe(true);
    expect(bounded).toContain('FAIL  apps/cli/tests/x.test.ts > y');
    expect(bounded).toContain('Test Files  1 failed | 177 passed (178)');
    expect(bounded).toContain('characters omitted');
  });

  it('returns short text unchanged', () => {
    expect(keepEnds('ok', 4000)).toBe('ok');
  });
});
