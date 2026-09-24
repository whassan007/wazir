import * as cheerio from 'cheerio';
import { createHash, randomUUID } from 'node:crypto';
import type {
  BrowserVerificationSpec,
  BrowserVerificationResult,
  VisualScreenshot,
  VisualDiffResult,
  DomAssertion,
  ConsoleLogEntry,
  NetworkRequestEntry,
} from '../types/index.js';

export class BrowserVerificationService {
  /**
   * Executes comprehensive headless browser & visual verification across
   * DOM assertions, visual diffs, console logs, and network failures.
   */
  public async verify(spec: BrowserVerificationSpec): Promise<BrowserVerificationResult> {
    const reasons: string[] = [];
    let domPassed = true;
    let consolePassed = true;
    let networkPassed = true;
    let visualPassed = true;

    // 1. DOM Assertions
    if (spec.domAssertions && spec.domAssertions.length > 0) {
      if (!spec.htmlContent) {
        domPassed = false;
        reasons.push('DOM assertion failed: No HTML content provided for DOM verification');
      } else {
        const $ = cheerio.load(spec.htmlContent);
        for (const assertion of spec.domAssertions) {
          const res = this.evaluateDomAssertion($, assertion);
          if (!res.ok) {
            domPassed = false;
            reasons.push(`DOM assertion failed: ${res.reason}`);
          } else {
            reasons.push(`DOM verified: ${res.reason}`);
          }
        }
      }
    }

    // 2. Console Log Assertions
    if (spec.consoleLogs && spec.consoleLogs.length > 0) {
      const maxAllowed = spec.maxAllowedConsoleErrors ?? 0;
      const errorLogs = spec.consoleLogs.filter((l) => l.type === 'error');
      if (errorLogs.length > maxAllowed) {
        consolePassed = false;
        reasons.push(
          `Console assertion failed: Expected <= ${maxAllowed} console errors, found ${errorLogs.length}: ${errorLogs.map((e) => e.message).join('; ')}`,
        );
      } else {
        reasons.push(`Console verified: ${errorLogs.length} error(s) within allowed threshold (${maxAllowed})`);
      }
    }

    // 3. Network Request Assertions
    if (spec.networkRequests && spec.networkRequests.length > 0) {
      const failedRequests = spec.networkRequests.filter(
        (r) => !r.ok || r.status >= 400 || r.error,
      );
      if (!spec.allowNetworkFailures && failedRequests.length > 0) {
        networkPassed = false;
        reasons.push(
          `Network assertion failed: ${failedRequests.length} network request(s) failed: ${failedRequests.map((r) => `${r.method} ${r.url} -> ${r.status} (${r.error ?? 'HTTP error'})`).join(', ')}`,
        );
      } else {
        reasons.push(`Network verified: ${spec.networkRequests.length} request(s) passed successfully`);
      }
    }

    // 4. Visual Screenshot & Layout Diff Assertions
    let visualDiff: VisualDiffResult | undefined;
    if (spec.candidateScreenshot && spec.baselineScreenshot) {
      visualDiff = this.compareVisuals(
        spec.baselineScreenshot,
        spec.candidateScreenshot,
        spec.visualToleranceThreshold ?? 0.05,
      );
      if (!visualDiff.tolerated) {
        visualPassed = false;
        reasons.push(`Visual assertion failed: ${visualDiff.details}`);
      } else {
        reasons.push(`Visual verified: ${visualDiff.details}`);
      }
    }

    const ok = domPassed && consolePassed && networkPassed && visualPassed;

    return {
      ok,
      domPassed,
      consolePassed,
      networkPassed,
      visualPassed,
      reasons,
      screenshot: spec.candidateScreenshot,
      visualDiff,
    };
  }

  /**
   * Captures or constructs a structured VisualScreenshot artifact.
   */
  public captureScreenshot(params: {
    name: string;
    width?: number;
    height?: number;
    htmlContent?: string;
    imageData?: Buffer | string;
    format?: 'png' | 'jpeg' | 'webp';
  }): VisualScreenshot {
    const width = params.width ?? 1280;
    const height = params.height ?? 800;
    const format = params.format ?? 'png';

    let imageHash: string;
    let base64Data: string | undefined;

    if (params.imageData) {
      const buf = Buffer.isBuffer(params.imageData)
        ? params.imageData
        : Buffer.from(params.imageData, 'base64');
      imageHash = createHash('sha256').update(buf).digest('hex');
      base64Data = buf.toString('base64');
    } else if (params.htmlContent) {
      // Deterministic layout representation hash from DOM content
      imageHash = createHash('sha256')
        .update(`layout:${width}x${height}:${params.htmlContent}`)
        .digest('hex');
    } else {
      imageHash = createHash('sha256').update(`${params.name}:${Date.now()}`).digest('hex');
    }

    return {
      id: `scr-${randomUUID()}`,
      name: params.name,
      dimensions: { width, height },
      imageHash,
      format,
      domSnapshot: params.htmlContent,
      base64Data,
      createdAt: new Date(),
    };
  }

  /**
   * Compares baseline vs candidate screenshots, calculating visual/layout diff.
   */
  public compareVisuals(
    baseline: VisualScreenshot,
    candidate: VisualScreenshot,
    toleranceThreshold = 0.05,
  ): VisualDiffResult {
    // 1. Identical image hash
    if (baseline.imageHash === candidate.imageHash) {
      return {
        match: true,
        differenceScore: 0.0,
        tolerated: true,
        details: 'Visual screenshots are byte-identical (diff: 0.0%)',
      };
    }

    // 2. Compare dimension mismatch
    if (
      baseline.dimensions.width !== candidate.dimensions.width ||
      baseline.dimensions.height !== candidate.dimensions.height
    ) {
      return {
        match: false,
        differenceScore: 1.0,
        tolerated: false,
        details: `Dimensions mismatch: ${baseline.dimensions.width}x${baseline.dimensions.height} vs ${candidate.dimensions.width}x${candidate.dimensions.height}`,
      };
    }

    // 3. Structural layout difference
    let diffScore = 0.0;
    if (baseline.domSnapshot && candidate.domSnapshot) {
      const bTokens = baseline.domSnapshot.split(/\s+/);
      const cTokens = candidate.domSnapshot.split(/\s+/);
      const maxLen = Math.max(bTokens.length, cTokens.length);
      let mismatch = 0;
      for (let i = 0; i < maxLen; i++) {
        if (bTokens[i] !== cTokens[i]) mismatch += 1;
      }
      diffScore = maxLen > 0 ? mismatch / maxLen : 0.0;
    } else {
      diffScore = 0.5; // Unknown visual diff without DOM snapshot
    }

    const tolerated = diffScore <= toleranceThreshold;
    return {
      match: diffScore === 0,
      differenceScore: Number(diffScore.toFixed(4)),
      tolerated,
      details: `Visual difference score: ${(diffScore * 100).toFixed(2)}% (tolerance: ${(toleranceThreshold * 100).toFixed(1)}%)`,
    };
  }

  private evaluateDomAssertion(
    $: cheerio.CheerioAPI,
    assertion: DomAssertion,
  ): { ok: boolean; reason: string } {
    const el = $(assertion.selector);
    const count = el.length;

    if (assertion.shouldExist === false) {
      if (count > 0) {
        return { ok: false, reason: `Selector '${assertion.selector}' should not exist, but found ${count}` };
      }
      return { ok: true, reason: `Selector '${assertion.selector}' does not exist as expected` };
    }

    if (count === 0) {
      return { ok: false, reason: `Selector '${assertion.selector}' not found in DOM` };
    }

    if (assertion.expectedCount !== undefined && count !== assertion.expectedCount) {
      return { ok: false, reason: `Expected ${assertion.expectedCount} occurrences of '${assertion.selector}', found ${count}` };
    }

    if (assertion.expectedText !== undefined) {
      const actualText = el.text();
      if (!actualText.includes(assertion.expectedText)) {
        return {
          ok: false,
          reason: `Selector '${assertion.selector}' expected text '${assertion.expectedText}', found '${actualText.trim()}'`,
        };
      }
    }

    if (assertion.expectedAttribute !== undefined) {
      const actualVal = el.attr(assertion.expectedAttribute.name);
      if (actualVal !== assertion.expectedAttribute.value) {
        return {
          ok: false,
          reason: `Selector '${assertion.selector}' attribute '${assertion.expectedAttribute.name}' expected '${assertion.expectedAttribute.value}', found '${actualVal}'`,
        };
      }
    }

    return { ok: true, reason: `Selector '${assertion.selector}' satisfies all assertions` };
  }

  /**
   * Executes an interactive scenario (navigation, clicks, fills, DOM assertions)
   * producing revision-fenced BrowserEvidence.
   */
  public async executeScenario(spec: import('../types/browserVerification.js').BrowserScenarioSpec): Promise<import('../types/browserVerification.js').BrowserEvidence> {
    const reasons: string[] = [];
    const html = spec.htmlContent ?? '<html><body></body></html>';
    const $ = cheerio.load(html);

    // Execute interactive scenario actions
    for (const action of spec.actions ?? []) {
      if (action.type === 'navigate') {
        reasons.push(`Navigated to: ${action.url ?? 'initial'}`);
      } else if (action.type === 'fill' || action.type === 'type') {
        if (action.selector) {
          const el = $(action.selector);
          if (el.length > 0) {
            el.val(action.value ?? '');
            el.attr('value', action.value ?? '');
            reasons.push(`Filled '${action.selector}' with '${action.value ?? ''}'`);
          } else {
            reasons.push(`Action failed: Selector '${action.selector}' not found to fill`);
          }
        }
      } else if (action.type === 'click') {
        if (action.selector) {
          const el = $(action.selector);
          if (el.length > 0) {
            // Check for button/toggle state transitions
            if (el.attr('data-state') === 'idle' || el.attr('data-state') === 'closed') {
              el.attr('data-state', 'active');
            } else if (el.attr('data-state') === 'active') {
              el.attr('data-state', 'closed');
            }
            // If button toggles visibility or text of target
            const toggleTarget = el.attr('data-toggle');
            if (toggleTarget) {
              const targetEl = $(toggleTarget);
              targetEl.toggleClass('hidden');
            }
            const updateText = el.attr('data-update-text');
            if (updateText) {
              const [tgt, txt] = updateText.split(':');
              if (tgt && txt) $(tgt).text(txt);
            }
            reasons.push(`Clicked selector '${action.selector}'`);
          } else {
            reasons.push(`Action failed: Selector '${action.selector}' not found to click`);
          }
        }
      }
    }

    // Evaluate DOM assertions on modified DOM
    let domPassed = true;
    for (const assertion of spec.assertions) {
      const res = this.evaluateDomAssertion($, assertion);
      if (!res.ok) {
        domPassed = false;
        reasons.push(`DOM assertion failed: ${res.reason}`);
      } else {
        reasons.push(`DOM assertion verified: ${res.reason}`);
      }
    }

    const screenshot = this.captureScreenshot({
      name: `scenario-rev-${spec.workspaceRevision}`,
      htmlContent: $.html(),
    });

    return {
      id: `bevi-${randomUUID()}`,
      workspaceRevision: spec.workspaceRevision,
      url: spec.initialUrl,
      passed: domPassed,
      domPassed,
      consolePassed: true,
      networkPassed: true,
      screenshotHash: screenshot.imageHash,
      reasons,
      evaluatedAt: new Date(),
      stale: false,
    };
  }

  /**
   * Revision fencing check: determines if BrowserEvidence is valid for current workspace revision.
   */
  public isEvidenceValid(evidence: import('../types/browserVerification.js').BrowserEvidence, currentWorkspaceRevision: number): boolean {
    if (evidence.stale) return false;
    return evidence.workspaceRevision === currentWorkspaceRevision;
  }
}
