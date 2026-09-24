export interface ConsoleLogEntry {
  type: 'log' | 'info' | 'warn' | 'error' | 'debug';
  message: string;
  timestamp: Date;
}

export interface NetworkRequestEntry {
  url: string;
  method: string;
  status: number;
  ok: boolean;
  durationMs?: number;
  error?: string;
  timestamp: Date;
}

export interface DomAssertion {
  selector: string;
  expectedText?: string;
  expectedAttribute?: { name: string; value: string };
  expectedCount?: number;
  shouldExist?: boolean;
}

export interface VisualScreenshot {
  id: string;
  name: string;
  dimensions: { width: number; height: number };
  imageHash: string;
  format: 'png' | 'jpeg' | 'webp';
  domSnapshot?: string;
  base64Data?: string;
  createdAt: Date;
}

export interface VisualDiffResult {
  match: boolean;
  differenceScore: number; // 0.0 (identical) to 1.0 (completely different)
  tolerated: boolean;
  details: string;
}

export interface BrowserVerificationSpec {
  url?: string;
  htmlContent?: string;
  domAssertions?: DomAssertion[];
  baselineScreenshot?: VisualScreenshot;
  candidateScreenshot?: VisualScreenshot;
  consoleLogs?: ConsoleLogEntry[];
  networkRequests?: NetworkRequestEntry[];
  maxAllowedConsoleErrors?: number;
  allowNetworkFailures?: boolean;
  visualToleranceThreshold?: number; // default 0.05 (5%)
}

export interface BrowserVerificationResult {
  ok: boolean;
  domPassed: boolean;
  consolePassed: boolean;
  networkPassed: boolean;
  visualPassed: boolean;
  reasons: string[];
  screenshot?: VisualScreenshot;
  visualDiff?: VisualDiffResult;
}

export type BrowserActionType =
  | 'navigate'
  | 'click'
  | 'type'
  | 'fill'
  | 'press'
  | 'waitFor'
  | 'screenshot';

export interface BrowserAction {
  type: BrowserActionType;
  selector?: string;
  value?: string;
  url?: string;
  timeoutMs?: number;
}

export interface BrowserScenarioSpec {
  initialUrl?: string;
  htmlContent?: string;
  actions?: BrowserAction[];
  assertions: DomAssertion[];
  maxAllowedConsoleErrors?: number;
  workspaceRevision: number;
}

export interface BrowserEvidence {
  id: string;
  workspaceRevision: number;
  url?: string;
  passed: boolean;
  domPassed: boolean;
  consolePassed: boolean;
  networkPassed: boolean;
  screenshotHash?: string;
  reasons: string[];
  evaluatedAt: Date;
  stale: boolean;
}
