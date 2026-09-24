import { describe, it, expect, beforeEach } from 'vitest';
import { BrowserVerificationService } from '../src/services/browserVerificationService.js';
import type { BrowserScenarioSpec } from '../src/types/browserVerification.js';

describe('Gate 20: Browser / UI Verification & Revision Fencing', () => {
  let browserService: BrowserVerificationService;

  beforeEach(() => {
    browserService = new BrowserVerificationService();
  });

  it('executes interactive scenarios: navigation, filling inputs, clicking buttons, and asserting DOM state transitions', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Wazir App UI</title></head>
        <body>
          <div id="app">
            <header>
              <h1 id="header-title">Welcome to Wazir</h1>
            </header>
            <form id="login-form">
              <input id="username" type="text" value="" />
              <input id="role" type="text" value="" />
              <button id="submit-btn" data-state="idle" data-update-text="#status-msg:Active Session">Submit</button>
            </form>
            <div id="status-msg">Disconnected</div>
            <div id="extra-panel" class="hidden">Secret Panel</div>
            <button id="toggle-panel-btn" data-toggle="#extra-panel">Toggle</button>
          </div>
        </body>
      </html>
    `;

    const scenarioSpec: BrowserScenarioSpec = {
      initialUrl: 'https://wazir.local/login',
      htmlContent: html,
      workspaceRevision: 42,
      actions: [
        { type: 'navigate', url: 'https://wazir.local/login' },
        { type: 'fill', selector: '#username', value: 'admin' },
        { type: 'fill', selector: '#role', value: 'operator' },
        { type: 'click', selector: '#submit-btn' },
        { type: 'click', selector: '#toggle-panel-btn' },
      ],
      assertions: [
        { selector: '#header-title', expectedText: 'Welcome to Wazir' },
        { selector: '#username', expectedAttribute: { name: 'value', value: 'admin' } },
        { selector: '#role', expectedAttribute: { name: 'value', value: 'operator' } },
        { selector: '#status-msg', expectedText: 'Active Session' },
        { selector: '#submit-btn', expectedAttribute: { name: 'data-state', value: 'active' } },
      ],
    };

    const evidence = await browserService.executeScenario(scenarioSpec);

    expect(evidence.passed).toBe(true);
    expect(evidence.domPassed).toBe(true);
    expect(evidence.workspaceRevision).toBe(42);
    expect(evidence.screenshotHash).toBeDefined();
    expect(typeof evidence.screenshotHash).toBe('string');
    expect(evidence.reasons.length).toBeGreaterThan(0);
    expect(evidence.reasons.some((r) => r.includes("Filled '#username' with 'admin'"))).toBe(true);
    expect(evidence.reasons.some((r) => r.includes("Clicked selector '#submit-btn'"))).toBe(true);
  });

  it('enforces revision fencing: evidence valid at revision R becomes invalid when workspace advances to R+1', async () => {
    const html = `
      <html>
        <body>
          <div id="content">Stable v1 UI</div>
        </body>
      </html>
    `;

    const scenarioSpec: BrowserScenarioSpec = {
      initialUrl: 'https://wazir.local/dashboard',
      htmlContent: html,
      workspaceRevision: 10,
      assertions: [
        { selector: '#content', expectedText: 'Stable v1 UI' },
      ],
    };

    const evidence = await browserService.executeScenario(scenarioSpec);
    expect(evidence.passed).toBe(true);

    // At revision 10: Evidence is strictly valid
    const isValidAtRev10 = browserService.isEvidenceValid(evidence, 10);
    expect(isValidAtRev10).toBe(true);

    // Mutation occurred: workspace advances to revision 11 (R -> R+1)
    // Critical Invariant: Prior browser verification evidence is invalid at R+1
    const isValidAtRev11 = browserService.isEvidenceValid(evidence, 11);
    expect(isValidAtRev11).toBe(false);

    // Flagged stale evidence is also rejected even if revision matched
    const staleEvidence = { ...evidence, stale: true };
    expect(browserService.isEvidenceValid(staleEvidence, 10)).toBe(false);
  });

  it('fails verification and captures diagnostic reasons when assertions fail after interactions', async () => {
    const html = `
      <html>
        <body>
          <button id="broken-btn">Click me</button>
          <div id="target">Unchanged</div>
        </body>
      </html>
    `;

    const scenarioSpec: BrowserScenarioSpec = {
      htmlContent: html,
      workspaceRevision: 5,
      actions: [
        { type: 'click', selector: '#broken-btn' },
      ],
      assertions: [
        { selector: '#target', expectedText: 'Expected Mutated Text That Was Never Updated' },
      ],
    };

    const evidence = await browserService.executeScenario(scenarioSpec);
    expect(evidence.passed).toBe(false);
    expect(evidence.domPassed).toBe(false);
    expect(evidence.reasons.some((r) => r.includes('DOM assertion failed'))).toBe(true);
  });
});
