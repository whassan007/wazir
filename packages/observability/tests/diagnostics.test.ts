import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DiagnosticQueue,
  hasAcceptedDiagnostics,
  recordConsentAcceptance,
  recordConsentDecline,
  redactDiagnosticPayload,
  redactText,
} from '../src/index.js';

describe('@wazir/observability diagnostics & privacy', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-diag-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('never queues or emits telemetry before affirmative consent', () => {
    expect(hasAcceptedDiagnostics(tmpHome)).toBe(false);
    const queue = new DiagnosticQueue(tmpHome);
    const evt = queue.enqueue({
      errorCode: 'ERR_SHELL_PTY',
      failureCategory: 'crash',
      component: 'wazir-shell',
      exceptionCategory: 'PtySpawnError',
    });
    expect(evt).toBeNull();
    expect(queue.readAllValid()).toHaveLength(0);
  });

  it('blocks telemetry when user declines', () => {
    recordConsentDecline(tmpHome);
    expect(hasAcceptedDiagnostics(tmpHome)).toBe(false);
    const queue = new DiagnosticQueue(tmpHome);
    expect(
      queue.enqueue({
        errorCode: 'ERR_NET',
        failureCategory: 'network',
        component: 'worker',
        exceptionCategory: 'TimeoutError',
      }),
    ).toBeNull();
  });

  it('queues sanitized diagnostic event after acceptance and redacts adversarial leakage', () => {
    recordConsentAcceptance({ richAnalytics: false, wazirHome: tmpHome });
    expect(hasAcceptedDiagnostics(tmpHome)).toBe(true);
    const queue = new DiagnosticQueue(tmpHome);
    const evt = queue.enqueue({
      errorCode: 'ERR_MODEL',
      failureCategory: 'model_failure',
      component: 'router',
      exceptionCategory: 'AuthError',
      sanitizedNote: 'Failed with sk-1234567890abcdef and /Users/wael/secret.txt for wael@example.com at 100.113.62.112',
    });
    expect(evt).not.toBeNull();
    expect(evt!.sanitizedNote).not.toContain('sk-1234567890abcdef');
    expect(evt!.sanitizedNote).not.toContain('/Users/wael');
    expect(evt!.sanitizedNote).not.toContain('wael@example.com');
    expect(evt!.sanitizedNote).not.toContain('100.113.62.112');
    expect(queue.readAllValid()).toHaveLength(1);
  });

  it('drops non-allowlisted fields and enforces payload bounds', () => {
    const redacted = redactDiagnosticPayload({
      component: 'shell',
      errorCode: 'ERR_ROUTE',
      failureCategory: 'command_routing',
      exceptionCategory: 'ParseError',
      rawShellHistory: ['export AWS_SECRET=12345', 'cat ~/.ssh/id_rsa'],
      env: { OPENAI_API_KEY: 'sk-secret99999999' },
      sanitizedNote: 'Bearer super_secret_token_12345',
    });
    expect(redacted).not.toBeNull();
    expect((redacted as unknown as Record<string, unknown>).rawShellHistory).toBeUndefined();
    expect((redacted as unknown as Record<string, unknown>).env).toBeUndefined();
    expect(redactText('token=ghp_1234567890abcdef')).toContain('[REDACTED]');
  });
});
