import path from 'node:path';

/**
 * Verification integrity (protected oracle).
 *
 * A model must not reach "tests pass" by weakening the tests. This recognizes
 * verification assets — tests, fixtures, golden/expected outputs, test-runner
 * configuration — and compares a proposed change against the current content
 * for the signatures of oracle weakening: deleted test files, fewer test cases,
 * fewer assertions, newly skipped tests, trivially-true assertions, and edited
 * expected outputs. Adding tests or assertions is never flagged.
 *
 * This is a controller check. Whether a finding blocks the change is decided by
 * the caller (the tool pipeline blocks unless the task explicitly authorizes
 * verification changes); the model cannot argue past it.
 */

export type OracleWeakeningKind =
  | 'verification_asset_deleted'
  | 'test_cases_removed'
  | 'assertions_removed'
  | 'tests_skipped'
  | 'trivial_assertion_added'
  | 'expected_output_changed';

export interface OracleWeakeningFinding {
  kind: OracleWeakeningKind;
  path: string;
  detail: string;
}

const TEST_DIR_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'testdata', '__snapshots__']);
const EXPECTED_DIR_SEGMENTS = new Set(['golden', 'goldens', 'expected', 'fixtures', '__fixtures__', 'snapshots', '__snapshots__']);
const TEST_FILE_RES: RegExp[] = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /^test_.+\.py$/,
  /_test\.(py|go|rs|cc|cpp)$/,
  /(^|[._-])tests?\.(cpp|cc|c|h|hpp)$/i,
  /Tests?\.(java|kt|cs)$/,
];
const EXPECTED_FILE_RES: RegExp[] = [/\.golden$/, /\.expected(\.\w+)?$/, /\.snap$/, /^expected[._-]/i];
const RUNNER_CONFIG_RES: RegExp[] = [
  /^(vitest|jest|playwright|karma|mocha)\.config\.[cm]?[jt]s$/,
  /^\.mocharc(\.\w+)?$/,
  /^(pytest\.ini|tox\.ini|conftest\.py|CTestTestfile\.cmake)$/,
];

// Counted per file; a drop means cases/assertions were removed.
const TEST_CASE_RE = /\b(?:it|test)\s*\(|\bdef\s+test_\w*|\bfunc\s+Test\w*\s*\(|\bTEST(?:_F|_P)?\s*\(|@Test\b|#\[test\]/g;
const ASSERTION_RE = /\bexpect\s*\(|\bassert\w*\s*[(\s]|\bself\.assert\w+\s*\(|\b(?:EXPECT|ASSERT|REQUIRE|CHECK)_\w+\s*\(|\b(?:REQUIRE|CHECK)\s*\(|\bt\.(?:Error|Fatal)f?\s*\(/g;
const SKIP_RE = /\b(?:it|test|describe)\.(?:skip|todo)\s*\(|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip|\bt\.Skip(?:Now|f)?\s*\(|\bGTEST_SKIP\s*\(|\bDISABLED_\w+|#\[ignore\]|@Disabled\b|@Ignore\b/g;
const TRIVIAL_ASSERTION_RE = /expect\s*\(\s*(true|1)\s*\)\s*\.\s*(toBe|toEqual|toBeTruthy)\s*\(\s*(true|1)?\s*\)|\bassert\s*\(?\s*True\s*\)?\s*$|\bassert\s*\(\s*(true|1)\s*\)|\b(?:EXPECT|ASSERT)_TRUE\s*\(\s*(true|1)\s*\)|self\.assertTrue\s*\(\s*True\s*\)/gm;

function count(re: RegExp, text: string): number {
  return (text.match(re) ?? []).length;
}

/** True for tests, fixtures, golden/expected outputs and test-runner configuration. */
export function isVerificationAsset(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/');
  const segments = normalized.split('/');
  const base = segments[segments.length - 1];
  if (segments.slice(0, -1).some((s) => TEST_DIR_SEGMENTS.has(s) || EXPECTED_DIR_SEGMENTS.has(s))) return true;
  return [...TEST_FILE_RES, ...EXPECTED_FILE_RES, ...RUNNER_CONFIG_RES].some((re) => re.test(base));
}

function isExpectedOutput(relativePath: string): boolean {
  const segments = relativePath.split(path.sep).join('/').split('/');
  const base = segments[segments.length - 1];
  return segments.slice(0, -1).some((s) => EXPECTED_DIR_SEGMENTS.has(s)) || EXPECTED_FILE_RES.some((re) => re.test(base));
}

/**
 * Compares `before` (current content, or null when the file does not exist) with
 * `after` (proposed content, or null for deletion). Returns an empty list for
 * non-verification paths and for changes that only add coverage.
 */
export function detectOracleWeakening(relativePath: string, before: string | null, after: string | null): OracleWeakeningFinding[] {
  if (!isVerificationAsset(relativePath) || before === null || before === after) return [];
  const findings: OracleWeakeningFinding[] = [];
  const add = (kind: OracleWeakeningKind, detail: string) => findings.push({ kind, path: relativePath, detail });

  if (after === null) {
    add('verification_asset_deleted', 'deletes an existing verification asset');
    return findings;
  }
  if (isExpectedOutput(relativePath)) {
    add('expected_output_changed', 'modifies an expected/golden output the implementation is checked against');
    return findings;
  }
  const casesBefore = count(TEST_CASE_RE, before);
  const casesAfter = count(TEST_CASE_RE, after);
  if (casesAfter < casesBefore) add('test_cases_removed', `test cases ${casesBefore} -> ${casesAfter}`);
  const assertsBefore = count(ASSERTION_RE, before);
  const assertsAfter = count(ASSERTION_RE, after);
  if (assertsAfter < assertsBefore) add('assertions_removed', `assertions ${assertsBefore} -> ${assertsAfter}`);
  const skipsBefore = count(SKIP_RE, before);
  const skipsAfter = count(SKIP_RE, after);
  if (skipsAfter > skipsBefore) add('tests_skipped', `skip/disable markers ${skipsBefore} -> ${skipsAfter}`);
  const trivialBefore = count(TRIVIAL_ASSERTION_RE, before);
  const trivialAfter = count(TRIVIAL_ASSERTION_RE, after);
  if (trivialAfter > trivialBefore) add('trivial_assertion_added', 'adds an assertion that cannot fail');
  return findings;
}

// Wording that explicitly asks for the oracle itself to change ("update the
// expected output", "remove the obsolete test"). Merely asking to *add* a test
// doesn't need this — adding coverage is never flagged.
const AUTHORIZES_VERIFICATION_CHANGES_RE =
  /\b(update|change|modify|fix|rewrite|remove|delete|replace|regenerate|refresh)\s+(?:(?!and\b|then\b|or\b)[\w-]+\s+){0,3}?(tests?|specs?|fixtures?|golden( files?)?|snapshots?|expected (output|results?)|assertions?)\b/i;

/** True when the task text explicitly asks for verification assets themselves to change. */
export function taskAuthorizesVerificationChanges(taskDescription: string): boolean {
  return AUTHORIZES_VERIFICATION_CHANGES_RE.test(taskDescription);
}
