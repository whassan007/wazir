import { describe, expect, it } from 'vitest';
import { detectOracleWeakening, isVerificationAsset, taskAuthorizesVerificationChanges } from '../src/services/verificationIntegrity.js';

const suite = `import { expect, it } from 'vitest';
it('sorts', () => { expect(sort([3, 1])).toEqual([1, 3]); });
it('handles empty', () => { expect(sort([])).toEqual([]); });
`;

describe('verification integrity', () => {
  it('recognizes tests, fixtures, golden outputs and runner config', () => {
    for (const p of ['src/sort.test.ts', 'tests/test_sort.py', 'pkg/sort_test.go', 'test/sort.cpp', 'golden/out.txt', 'cases/out.expected', 'vitest.config.ts']) {
      expect(isVerificationAsset(p), p).toBe(true);
    }
    for (const p of ['src/sort.ts', 'main.cpp', 'README.md', 'src/testing_utils_impl.ts']) {
      expect(isVerificationAsset(p), p).toBe(false);
    }
  });

  it('flags deleting a test file', () => {
    expect(detectOracleWeakening('src/sort.test.ts', suite, null).map((f) => f.kind)).toEqual(['verification_asset_deleted']);
  });

  it('flags removing a failing test case and its assertion', () => {
    const weakened = suite.replace(/it\('handles empty'.*\n/, '');
    const kinds = detectOracleWeakening('src/sort.test.ts', suite, weakened).map((f) => f.kind);
    expect(kinds).toContain('test_cases_removed');
    expect(kinds).toContain('assertions_removed');
  });

  it('flags skipping a test', () => {
    const skipped = suite.replace("it('handles empty'", "it.skip('handles empty'");
    expect(detectOracleWeakening('src/sort.test.ts', suite, skipped).map((f) => f.kind)).toContain('tests_skipped');
  });

  it('flags replacing a real assertion with one that cannot fail', () => {
    const trivial = suite.replace('expect(sort([])).toEqual([])', 'expect(true).toBe(true)');
    expect(detectOracleWeakening('src/sort.test.ts', suite, trivial).map((f) => f.kind)).toContain('trivial_assertion_added');
  });

  it('flags changing an expected output to match broken behavior', () => {
    expect(detectOracleWeakening('golden/sorted.txt', '1 2 3\n', '3 1 2\n').map((f) => f.kind)).toEqual(['expected_output_changed']);
  });

  it('does not flag adding coverage, new test files, or ordinary source edits', () => {
    const extended = `${suite}it('handles dupes', () => { expect(sort([2, 2])).toEqual([2, 2]); });\n`;
    expect(detectOracleWeakening('src/sort.test.ts', suite, extended)).toEqual([]);
    expect(detectOracleWeakening('src/new.test.ts', null, suite)).toEqual([]);
    expect(detectOracleWeakening('src/sort.ts', 'a', '')).toEqual([]);
  });

  it('recognizes only explicit requests to change the oracle', () => {
    expect(taskAuthorizesVerificationChanges('Update the expected output for the new format')).toBe(true);
    expect(taskAuthorizesVerificationChanges('Remove the obsolete tests for the v1 API')).toBe(true);
    expect(taskAuthorizesVerificationChanges('Fix the sort bug and add a regression test')).toBe(false);
    expect(taskAuthorizesVerificationChanges('Make the tests pass')).toBe(false);
  });
});
