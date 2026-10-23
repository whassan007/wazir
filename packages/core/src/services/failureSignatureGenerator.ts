import type { ExecutionRecord } from '../types/execution.js';
import { isFailureClass } from '@wazir/shared';

export interface SignatureGeneratorOptions {
  /** Whether to include the specific error message in the signature if it's non-volatile. */
  includeErrorDetails?: boolean;
}

/** Structural error shape accepted by {@link FailureSignatureGenerator.fromError}. */
export interface SignatureErrorInput {
  code?: unknown;
  failureClass?: unknown;
  message?: unknown;
  details?: Record<string, unknown>;
}

const MAX_SLUG_LENGTH = 160;

/**
 * Volatile fragments that differ between otherwise identical failures. They are
 * replaced with stable placeholders so the same root cause yields the same
 * signature across attempts (no-progress detection depends on this).
 * Plain counts ("3 tests failed") are deliberately kept: a changing count is progress.
 */
const VOLATILE_PATTERNS: Array<[RegExp, string]> = [
  [/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})?/gi, '<ts>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b(sha256:)?[0-9a-f]{12,}\b/gi, '<hash>'],
  [/(?:\/private)?\/(?:tmp|var\/folders)\/[^\s'":)]+/gi, '<tmp>'],
  [/\b\d+(\.\d+)?\s?(ms|msec|milliseconds|s|sec|secs|seconds)\b/gi, '<dur>'],
  [/\b(pid|port)\s*[:=]?\s*\d+\b/gi, '$1 <n>'],
  [/(localhost|127\.0\.0\.1|\[::1\]):\d{2,5}\b/gi, '$1:<port>'],
  [/:\d+:\d+\b/g, ':<line>'],
];

export class FailureSignatureGenerator {
  /**
   * Generates a stable, deterministic signature for a failure based on its evidence.
   * Categorizes failures into types: compiler, test, tool, runtime, policy, etc.
   */
  static generate(record: ExecutionRecord, event: any): string | undefined {
    if (!event || typeof event !== 'object') return undefined;
    const rawType = (event as any).eventType ?? (event as any).type;
    if (typeof rawType !== 'string' || rawType.length === 0) return undefined;
    const type = rawType;

    switch (type) {
      case 'tool.call.failed':
        return this.generateToolSignature(event);
      case 'test.completed': // Assuming custom event types or check results
        return this.generateTestSignature(record, event);
      case 'verification.failed':
        return this.generateVerificationSignature(event);
      case 'action.validation_failed':
        return `action:validation:${this.normalizeActionError(event.data?.error)}`;
      default:
        // Fallback to a generic failure signature if the event type is unknown but it's an error-related event
        if (type.includes('failed') || type.includes('denied')) {
          return `${type}:${this.getGenericFailureClass(event)}`;
        }
    }

    return undefined;
  }

  /**
   * Signature for a structured error (e.g. a Goal Studio error or an ExecutionFailure).
   * `scope` (for example a target id) keeps signatures from different scopes apart.
   */
  static fromError(error: SignatureErrorInput | undefined, scope?: string): string {
    const prefix = scope ? `${scope}:` : '';
    if (!error) return `${prefix}error:none`;
    const detailsClass = error.details?.failureClass;
    const failureClass = isFailureClass(error.failureClass) ? error.failureClass
      : isFailureClass(detailsClass) ? detailsClass : undefined;
    const code = typeof error.code === 'string' && error.code ? error.code : 'UNKNOWN';
    const message = typeof error.message === 'string' ? this.slugify(error.message) : '';
    return `${prefix}error:${code}${failureClass ? `:${failureClass}` : ''}:${message || 'no-message'}`;
  }

  /** Replaces volatile fragments (timestamps, ids, hashes, temp paths, durations, ports, line:col). */
  static normalizeMessage(text: string): string {
    let out = String(text ?? '');
    for (const [pattern, replacement] of VOLATILE_PATTERNS) out = out.replace(pattern, replacement);
    return out.replace(/\s+/g, ' ').trim();
  }

  private static generateToolSignature(event: any): string {
    const tool = event.data?.tool || 'unknown';
    const failureClass = event.data?.failureClass || 'UNKNOWN_FAILURE';
    // For tools, we use the tool name and the normalized error class to create a stable signature
    return `tool:${tool}:${failureClass}`;
  }

  private static generateTestSignature(record: ExecutionRecord, event: any): string {
    const check = (record?.checks ?? []).find((c) => c.name === event.data?.testName);
    if (check && !check.ok) {
      return `test:${check.command}:${event.data?.assertionCategory || 'assertion'}`;
    }
    return 'test:unknown';
  }

  private static generateVerificationSignature(event: any): string {
    const name = event.data?.name || 'unknown';
    return `verification:${name}`;
  }

  private static normalizeActionError(error?: unknown): string {
    if (typeof error === 'string') return this.slugify(error) || 'unknown_action_error';
    if (error && typeof error === 'object' && 'message' in error) return this.slugify(String(error.message)) || 'unknown_action_error';
    return 'unknown_action_error';
  }

  private static getGenericFailureClass(event: any): string {
    const failureClass = event.data?.failureClass;
    if (typeof failureClass === 'string') return failureClass;
    return 'UNKNOWN';
  }

  private static slugify(text: string): string {
    return this.normalizeMessage(text)
      .toLowerCase()
      .replace(/<(\w+)>/g, '$1')
      .replace(/[^\w]+/g, '-')
      .replace(/(^-+|-+$)/g, '')
      .slice(0, MAX_SLUG_LENGTH)
      .replace(/-+$/g, '');
  }
}
