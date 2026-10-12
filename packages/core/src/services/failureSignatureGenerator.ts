import type { ExecutionRecord, ExecutionEventType } from '../types/execution.js';
import type { FailureClass } from '@wazir/shared';

export interface SignatureGeneratorOptions {
  /** Whether to include the specific error message in the signature if it's non-volatile. */
  includeErrorDetails?: boolean;
}

export class FailureSignatureGenerator {
  /** 
   * Generates a stable, deterministic signature for a failure based on its evidence.
   * Categorizes failures into types: compiler, test, tool, runtime, policy, etc.
   */
  static generate(record: ExecutionRecord, event: any): string | undefined {
    const type = (event as any).eventType ?? (event as any).type;

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

  private static generateToolSignature(event: any): string {
    const tool = event.data?.tool || 'unknown';
    const failureClass = event.data?.failureClass || 'UNKNOWN_FAILURE';
    // For tools, we use the tool name and the normalized error class to create a stable signature
    return `tool:${tool}:${failureClass}`;
  }

  private static generateTestSignature(record: ExecutionRecord, event: any): string {
    const check = record.checks.find((c) => c.name === event.data?.testName);
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
    if (typeof error === 'string') return this.slugify(error);
    if (error && typeof error === 'object' && 'message' in error) return this.slugify(String(error.message));
    return 'unknown_action_error';
  }

  private static getGenericFailureClass(event: any): string {
    const failureClass = event.data?.failureClass;
    if (typeof failureClass === 'string') return failureClass;
    return 'UNKNOWN';
  }

  private static slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }
}
