import { describe, it, expect, beforeEach } from 'vitest';
import { BrowserVerificationService, BrowserOracle } from '../src/index.js';

describe('Gate 9: Browser + Visual Verification', () => {
  let browserService: BrowserVerificationService;
  let browserOracle: BrowserOracle;

  beforeEach(() => {
    browserService = new BrowserVerificationService();
    browserOracle = new BrowserOracle();
  });

  describe('DOM Assertions', () => {
    const sampleHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>App Dashboard</title></head>
        <body>
          <header class="app-header">
            <h1 id="title">Wazir Control Plane</h1>
          </header>
          <main>
            <div class="metrics-grid">
              <div class="metric-card" data-metric="tasks">42</div>
              <div class="metric-card" data-metric="cost">$0.15</div>
            </div>
            <button id="deploy-btn" class="btn primary" disabled>Deploy</button>
          </main>
        </body>
      </html>
    `;

    it('verifies element existence, text content, attributes, and counts in DOM', async () => {
      const res = await browserService.verify({
        htmlContent: sampleHtml,
        domAssertions: [
          { selector: 'h1#title', expectedText: 'Wazir Control Plane' },
          { selector: '.metric-card', expectedCount: 2 },
          { selector: 'button#deploy-btn', expectedAttribute: { name: 'disabled', value: 'disabled' } },
          { selector: '.error-banner', shouldExist: false },
        ],
      });

      expect(res.ok).toBe(true);
      expect(res.domPassed).toBe(true);
      expect(res.reasons.length).toBe(4);
    });

    it('detects and reports failing DOM assertions', async () => {
      const res = await browserService.verify({
        htmlContent: sampleHtml,
        domAssertions: [
          { selector: 'h1#title', expectedText: 'Wrong Title' },
          { selector: '.non-existent-element' },
        ],
      });

      expect(res.ok).toBe(false);
      expect(res.domPassed).toBe(false);
      expect(res.reasons.some((r) => r.includes('expected text'))).toBe(true);
      expect(res.reasons.some((r) => r.includes('not found in DOM'))).toBe(true);
    });
  });

  describe('Console Log Assertions', () => {
    it('verifies clean console logs and fails on uncaught console errors', async () => {
      const cleanRes = await browserService.verify({
        htmlContent: '<div>hello</div>',
        consoleLogs: [
          { type: 'info', message: 'App initialized', timestamp: new Date() },
          { type: 'log', message: 'Data loaded', timestamp: new Date() },
        ],
      });
      expect(cleanRes.ok).toBe(true);
      expect(cleanRes.consolePassed).toBe(true);

      const errorRes = await browserService.verify({
        htmlContent: '<div>hello</div>',
        consoleLogs: [
          { type: 'error', message: 'Uncaught TypeError: Cannot read property of undefined', timestamp: new Date() },
        ],
      });
      expect(errorRes.ok).toBe(false);
      expect(errorRes.consolePassed).toBe(false);
      expect(errorRes.reasons.some((r) => r.includes('Console assertion failed'))).toBe(true);
    });
  });

  describe('Network Failure Assertions', () => {
    it('verifies passing network calls and rejects failed network requests', async () => {
      const passingRes = await browserService.verify({
        htmlContent: '<div>app</div>',
        networkRequests: [
          { url: '/api/v1/health', method: 'GET', status: 200, ok: true, timestamp: new Date() },
          { url: '/api/v1/jobs', method: 'POST', status: 201, ok: true, timestamp: new Date() },
        ],
      });
      expect(passingRes.ok).toBe(true);
      expect(passingRes.networkPassed).toBe(true);

      const failingRes = await browserService.verify({
        htmlContent: '<div>app</div>',
        networkRequests: [
          { url: '/api/v1/health', method: 'GET', status: 200, ok: true, timestamp: new Date() },
          { url: '/api/v1/orders', method: 'POST', status: 500, ok: false, error: 'Internal Server Error', timestamp: new Date() },
        ],
      });
      expect(failingRes.ok).toBe(false);
      expect(failingRes.networkPassed).toBe(false);
      expect(failingRes.reasons.some((r) => r.includes('network request(s) failed'))).toBe(true);
    });
  });

  describe('Visual Screenshots & Visual / Layout Diff Assertions', () => {
    it('captures screenshots and performs visual diff assertions', async () => {
      const baseline = browserService.captureScreenshot({
        name: 'homepage-baseline',
        width: 1280,
        height: 800,
        htmlContent: '<div class="header">Title</div><div class="content">Welcome</div>',
      });

      const candidateIdentical = browserService.captureScreenshot({
        name: 'homepage-candidate',
        width: 1280,
        height: 800,
        htmlContent: '<div class="header">Title</div><div class="content">Welcome</div>',
      });

      const candidateMutated = browserService.captureScreenshot({
        name: 'homepage-drift',
        width: 1280,
        height: 800,
        htmlContent: '<div class="header broken">Completely Altered Layout With Massive Drift</div>',
      });

      // Identical visual diff
      const resMatch = await browserService.verify({
        baselineScreenshot: baseline,
        candidateScreenshot: candidateIdentical,
      });
      expect(resMatch.ok).toBe(true);
      expect(resMatch.visualPassed).toBe(true);
      expect(resMatch.visualDiff?.match).toBe(true);
      expect(resMatch.visualDiff?.differenceScore).toBe(0.0);

      // Mutated visual diff exceeding 5% threshold
      const resDrift = await browserService.verify({
        baselineScreenshot: baseline,
        candidateScreenshot: candidateMutated,
        visualToleranceThreshold: 0.05,
      });
      expect(resDrift.ok).toBe(false);
      expect(resDrift.visualPassed).toBe(false);
      expect(resDrift.visualDiff?.tolerated).toBe(false);
      expect(resDrift.visualDiff?.differenceScore).toBeGreaterThan(0.05);
    });
  });

  describe('BrowserOracle Integration', () => {
    it('integrates seamlessly with BrowserOracle and VerificationEngine', async () => {
      const oracleRes = await browserOracle.verify({
        metadata: {
          spec: {
            htmlContent: '<html><body><span class="status">active</span></body></html>',
            domAssertions: [
              { selector: 'span.status', expectedText: 'active' },
            ],
            consoleLogs: [],
          },
        },
      });

      expect(oracleRes.status).toBe('PASS');
      expect(oracleRes.exitCode).toBe(0);
      expect(oracleRes.reasons.some((r) => r.includes('DOM verified'))).toBe(true);
    });
  });
});
