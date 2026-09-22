import { describe, it, expect } from 'vitest';
import { resolvePreset, RUNTIME_PRESETS } from '../src/presets.js';

describe('Runtime Presets', () => {
  it('resolves standard preset by default', () => {
    const standard = resolvePreset();
    expect(standard.name).toBe('standard');
    expect(standard.tools).toBe('all');

    const standardExplicit = resolvePreset('standard');
    expect(standardExplicit.name).toBe('standard');
    expect(standardExplicit.tools).toBe('all');
  });

  it('resolves minimal preset', () => {
    const minimal = resolvePreset('minimal');
    expect(minimal.name).toBe('minimal');
    expect(minimal.tools).toEqual(['shell', 'edit']);
    expect(minimal.agentOptions.contextCompactionRatio).toBe(1);
    expect(minimal.agentOptions.maxRepairCycles).toBe(1);
  });

  it('throws for unknown preset', () => {
    expect(() => resolvePreset('unknown-preset-xyz')).toThrow(/Unknown runtime preset/);
  });

  it('is case-insensitive', () => {
    const min = resolvePreset('MINIMAL');
    expect(min.name).toBe('minimal');
  });
});
