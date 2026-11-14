import { describe, expect, it } from 'vitest';
import { CLI_VERSION, tryHandleFastCliFlags } from '../src/index.js';

describe('CLI Startup Fast Path (Agent 01)', () => {
  it('handles --version and -V in <1ms without booting subcommand trees or engine', () => {
    const out1: string[] = [];
    const t0 = performance.now();
    const handled1 = tryHandleFastCliFlags(['--version'], '0.2.13', (t) => out1.push(t));
    const dt1 = performance.now() - t0;

    expect(handled1).toBe(true);
    expect(out1).toEqual(['0.2.13\n']);
    expect(dt1).toBeLessThan(5);

    const out2: string[] = [];
    const handled2 = tryHandleFastCliFlags(['-V'], '0.2.13', (t) => out2.push(t));
    expect(handled2).toBe(true);
    expect(out2).toEqual(['0.2.13\n']);
  });

  it('handles version, version --json, and version -j via fast path', () => {
    const plainOut: string[] = [];
    expect(tryHandleFastCliFlags(['version'], CLI_VERSION, (t) => plainOut.push(t))).toBe(true);
    expect(plainOut).toEqual([`${CLI_VERSION}\n`]);

    const jsonOut1: string[] = [];
    expect(
      tryHandleFastCliFlags(['version', '--json'], '0.2.13', (t) => jsonOut1.push(t)),
    ).toBe(true);
    expect(JSON.parse(jsonOut1.join(''))).toEqual({ version: '0.2.13' });

    const jsonOut2: string[] = [];
    expect(tryHandleFastCliFlags(['version', '-j'], '0.2.13', (t) => jsonOut2.push(t))).toBe(
      true,
    );
    expect(JSON.parse(jsonOut2.join(''))).toEqual({ version: '0.2.13' });
  });

  it('returns false for --help, run, ask, banner, and multi-flag invocations so Commander handles them normally', () => {
    const out: string[] = [];
    const writer = (t: string) => out.push(t);

    expect(tryHandleFastCliFlags([], '0.2.13', writer)).toBe(false);
    expect(tryHandleFastCliFlags(['--help'], '0.2.13', writer)).toBe(false);
    expect(tryHandleFastCliFlags(['-h'], '0.2.13', writer)).toBe(false);
    expect(tryHandleFastCliFlags(['run', 'task'], '0.2.13', writer)).toBe(false);
    expect(tryHandleFastCliFlags(['banner', '--json'], '0.2.13', writer)).toBe(false);
    expect(tryHandleFastCliFlags(['--version', '--help'], '0.2.13', writer)).toBe(false);
    expect(out).toEqual([]);
  });
});
