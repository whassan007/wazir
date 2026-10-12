import { describe, it, expect } from 'vitest';
import {
  renderContextView,
  renderPromptCacheSection,
  promptCacheSource,
  promptCacheReuse,
  type ContextSampleItem,
  type PromptCacheMetrics,
} from '../src/tui/observabilityViews.js';
import { FleetTui } from '../src/tui/fleetTui.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function sample(gen: number, cache?: PromptCacheMetrics): ContextSampleItem {
  return {
    generation: gen, currentTokens: 4000 + (gen % 10) * 1000, effectiveMax: 32768, targetTokens: 16000,
    deduplicated: 0, compressed: 0, offloaded: 0, stablePrefix: 1000, volatilePortion: 3000, cache,
  };
}

const observed: PromptCacheMetrics = {
  inputTokens: { value: 18420, status: 'OBSERVED' },
  cacheReadTokens: { value: 9810, status: 'OBSERVED' },
  cacheWriteTokens: { value: 1240, status: 'OBSERVED' },
  provider: 'LM Studio',
};

const render = (samples: ContextSampleItem[], width = 100, maxRows = 60) =>
  strip(renderContextView({ samples, selectedIndex: samples.length - 1, width, maxRows }).join('\n'));

function why(samples: ContextSampleItem[]) {
  const fake = { agents: new Map(), getAgents: () => [], contextSamples: samples, selectedTaskId: undefined };
  return (FleetTui.prototype as any).buildWhyExplanation.call(fake, 'context');
}

describe('Prompt cache telemetry in Mission Control context view', () => {
  it('renders observed metrics', () => {
    const out = render([sample(1, observed)]);
    expect(out).toContain('PROMPT CACHE');
    expect(out).toMatch(/Input Tokens\s+18,420/);
    expect(out).toMatch(/Cache Read\s+9,810/);
    expect(out).toMatch(/Cache Write\s+1,240/);
    expect(out).toMatch(/Effective Reuse\s+53\.3%/);
    expect(out).toMatch(/Source\s+OBSERVED/);
    expect(out).toMatch(/Provider\s+LM Studio/);
  });

  it('renders UNKNOWN when no cache telemetry exists, never zero', () => {
    const out = render([sample(1)]);
    expect(out).toMatch(/Cache Read\s+UNKNOWN/);
    expect(out).toMatch(/Cache Write\s+UNKNOWN/);
    expect(out).toMatch(/Effective Reuse\s+UNKNOWN/);
    expect(out).not.toMatch(/Cache (Read|Write)\s+0\b/);
  });

  it('renders UNSUPPORTED distinctly and ignores stray values on non-observed metrics', () => {
    const out = render([sample(1, {
      inputTokens: { value: 5000, status: 'OBSERVED' },
      cacheReadTokens: { status: 'UNKNOWN', value: 0 },
      cacheWriteTokens: { status: 'UNSUPPORTED', value: 0 },
    })]);
    expect(out).toMatch(/Cache Read\s+UNKNOWN/);
    expect(out).toMatch(/Cache Write\s+UNSUPPORTED/);
    expect(out).toMatch(/Source\s+UNKNOWN/);
  });

  it('shows a real observed zero cache hit as 0 / 0.0%', () => {
    const m: PromptCacheMetrics = { ...observed, cacheReadTokens: { value: 0, status: 'OBSERVED' } };
    const out = render([sample(1, m)]);
    expect(out).toMatch(/Cache Read\s+0\b/);
    expect(out).toMatch(/Effective Reuse\s+0\.0%/);
    expect(promptCacheSource(m)).toBe('OBSERVED');
    expect(promptCacheReuse(m)).toBe(0);
  });

  it('labels estimated metrics as ESTIMATED', () => {
    expect(promptCacheSource({ ...observed, cacheReadTokens: { value: 100, status: 'ESTIMATED' } })).toBe('ESTIMATED');
  });

  it('stays within width across resizes', () => {
    const samples = Array.from({ length: 40 }, (_, i) => sample(i + 1, observed));
    for (const [w, h] of [[60, 20], [80, 35], [140, 50], [40, 12]]) {
      const lines = renderContextView({ samples, selectedIndex: 0, width: w, maxRows: h });
      expect(lines.length).toBe(h);
      for (const l of lines) expect(strip(l).length).toBeLessThanOrEqual(w);
    }
  });

  it('trend is bounded by the sample window and terminal width', () => {
    const samples = Array.from({ length: 100 }, (_, i) =>
      sample(i + 1, { ...observed, cacheReadTokens: { value: (i * 150) % 18000, status: 'OBSERVED' } }));
    const sec = renderPromptCacheSection(samples, 60).map(strip);
    const trend = sec.find((l) => l.includes('Reuse Trend'))!;
    expect(trend).toBeDefined();
    expect(trend.length).toBeLessThanOrEqual(60);
    expect(renderPromptCacheSection([sample(1, observed)], 60).some((l) => l.includes('Reuse Trend'))).toBe(false);
  });

  it('survives high-frequency updates through the bounded ring buffer', () => {
    const fake: any = { contextSamples: [], selectedContextSampleIndex: 0, draw: () => {} };
    const t0 = performance.now();
    for (let i = 1; i <= 2000; i++) {
      (FleetTui.prototype as any).recordContextSample.call(fake, sample(i, i % 3 ? observed : undefined));
      if (i % 50 === 0) render(fake.contextSamples, 100, 40);
    }
    expect(fake.contextSamples.length).toBe(100);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('why context explains OBSERVED / ESTIMATED / UNKNOWN from controller telemetry only', () => {
    expect(why([sample(1, observed)]).decision).toBe('Cache savings: OBSERVED');
    expect(why([sample(1, { ...observed, inputTokens: { value: 18000, status: 'ESTIMATED' } })]).decision).toBe('Cache savings: ESTIMATED');
    expect(why([sample(1)]).decision).toBe('Cache savings: UNKNOWN');
    const unsup = why([sample(1, { ...observed, cacheReadTokens: { status: 'UNSUPPORTED' } })]);
    expect(unsup.decision).toBe('Cache savings: UNKNOWN');
    expect(unsup.rationale.join(' ')).toContain('does not support');
    const empty = why([]);
    expect(empty.decision).toBe('Cache savings: UNKNOWN');
    expect(empty.evidence.find((e: any) => e.label === 'Cache Read').value).toBe('UNKNOWN');
  });
});
