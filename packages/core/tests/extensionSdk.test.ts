import { describe, expect, it } from 'vitest';
import { BUILTIN_REFERENCE_EXTENSIONS, WazirExtensionRegistry } from '../src/sdk/index.js';

describe('Wazir Extension SDK', () => {
  it('registers all 6 required domain extensions outside Wazir Core', () => {
    const registry = new WazirExtensionRegistry();
    const ids = registry.list().map((m) => m.id);
    expect(BUILTIN_REFERENCE_EXTENSIONS).toHaveLength(6);
    for (const expected of ['lorecraft', '90nf-forge', 'bazaar', 'robotics-simulation', 'research-evaluation', 'software-development']) {
      expect(ids).toContain(expected);
    }
  });
});
