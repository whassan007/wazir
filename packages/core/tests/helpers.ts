import assert from 'node:assert';

export function describe(name: string, fn: () => void) {
  console.log(`\n--- ${name} ---`);
  fn();
}

export function it(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}`);
    throw err;
  }
}

export const expect = (actual: unknown) => ({
  toBe(expected: unknown) {
    assert.strictEqual(actual, expected);
  },
  toContain(expected: unknown) {
    if (typeof actual === 'string') {
      assert.ok(actual.includes(expected as string), `Expected "${actual}" to contain "${expected}"`);
    } else if (Array.isArray(actual)) {
      assert.ok(actual.includes(expected), `Expected array to contain ${expected}`);
    } else {
      assert.fail(`Expected ${actual} to contain ${expected}`);
    }
  },
  toBeDefined() {
    assert.notStrictEqual(actual, undefined);
  },
  toBeUndefined() {
    assert.strictEqual(actual, undefined);
  },
  toBeGreaterThan(expected: number) {
    assert.ok((actual as number) > expected, `Expected ${actual} > ${expected}`);
  }
});
