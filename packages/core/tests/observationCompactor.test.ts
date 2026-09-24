import { describe, expect, it } from 'vitest';
import { ObservationCompactor } from '../src/services/observationCompactor.js';

const noisyCompile = (): string => {
  const lines: string[] = [];
  for (let i = 0; i < 2000; i++) lines.push(`In file included from /usr/include/c++/13/bits/stl_algo.h:${i}: note: candidate template ignored`);
  lines.push("main.cpp:47:5: error: call to 'swap' is ambiguous");
  lines.push("main.cpp:52:9: error: use of undeclared identifier 'pivot'");
  lines.push("util.cpp:3:1: error: expected ';' after class");
  lines.push('3 errors generated.');
  return lines.join('\n');
};

describe('ObservationCompactor', () => {
  it('passes output within budget through verbatim', () => {
    const c = new ObservationCompactor({ maxChars: 4000 });
    const obs = c.compact('shell', { command: 'ls' }, { ok: true, output: 'a.cpp\nb.cpp', durationMs: 1 });
    expect(obs.compacted).toBe(false);
    expect(obs.text).toBe('a.cpp\nb.cpp');
  });

  it('reduces a huge compiler failure to exit code, failed files and primary errors', () => {
    const c = new ObservationCompactor({ maxChars: 4000, maxPrimaryErrors: 2 });
    const raw = noisyCompile();
    const obs = c.compact(
      'shell',
      { command: 'g++ main.cpp util.cpp -o main' },
      { ok: false, output: raw, error: 'g++ main.cpp util.cpp -o main exited with code 1', durationMs: 1 },
    );

    expect(obs.compacted).toBe(true);
    expect(obs.kind).toBe('check');
    expect(obs.rawChars).toBeGreaterThan(100_000);
    expect(obs.text.length).toBeLessThan(4000);
    expect(obs.text).toContain('exitCode: 1');
    expect(obs.text).toContain('failedCommand: g++ main.cpp util.cpp -o main');
    expect(obs.text).toContain('  - main.cpp');
    expect(obs.text).toContain('  - util.cpp');
    expect(obs.text).toContain("main.cpp:47: call to 'swap' is ambiguous");
    expect(obs.text).toContain('additionalErrors: 1');
    // The tail keeps the tool's own summary line.
    expect(obs.text).toContain('3 errors generated.');
  });

  it('summarizes large searches with a match count instead of truncating mid-line', () => {
    const c = new ObservationCompactor({ maxChars: 1000 });
    const output = Array.from({ length: 500 }, (_, i) => `src/file${i}.ts:1:match`).join('\n');
    const obs = c.compact('search', { pattern: 'match' }, { ok: true, output, durationMs: 1 });
    expect(obs.compacted).toBe(true);
    expect(obs.text.startsWith('matches: 500')).toBe(true);
    expect(obs.text).toMatch(/more matches omitted/);
    expect(obs.text.length).toBeLessThanOrEqual(1000);
  });

  it('lists changed files for a large git diff', () => {
    const c = new ObservationCompactor({ maxChars: 1500 });
    const body = Array.from({ length: 400 }, (_, i) => `+line ${i}`).join('\n');
    const output = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${body}\n-old\n`;
    const obs = c.compact('shell', { command: 'git diff' }, { ok: true, output, durationMs: 1 });
    expect(obs.kind).toBe('diff');
    expect(obs.text).toContain('src/a.ts (+400 -1)');
  });

  it('keeps head and tail of an oversized file read', () => {
    const c = new ObservationCompactor({ maxChars: 1000 });
    const output = `HEAD_MARKER\n${'x'.repeat(10_000)}\nTAIL_MARKER`;
    const obs = c.compact('read', { path: 'big.txt' }, { ok: true, output, durationMs: 1 });
    expect(obs.text).toContain('HEAD_MARKER');
    expect(obs.text).toContain('TAIL_MARKER');
    expect(obs.text).toContain('full output retained as execution evidence');
  });
});
