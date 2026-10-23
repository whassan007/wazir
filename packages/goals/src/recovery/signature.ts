import { createHash } from 'node:crypto';
import { FailureSignatureGenerator } from '@wazir/core';
import type { FailureClass, GoalStudioError, TargetId } from '../contracts.js';
import type { FailureClassification } from './classify.js';

/**
 * Stable fingerprint for no-progress detection. Built from the target id, failure
 * class, error code, failing criteria (when known) and the volatility-normalized error
 * message. Identical root causes give identical signatures across attempts, process
 * restarts and machines.
 */
export function computeFailureSignature(targetId: TargetId, classification: Pick<FailureClassification, 'failureClass' | 'coreCategory' | 'failedCriteria'>, error?: GoalStudioError): string {
  const parts: Record<string, unknown> = {
    target: targetId,
    class: classification.failureClass satisfies FailureClass,
    category: classification.coreCategory,
    code: error?.code ?? 'NONE',
  };
  if (classification.failedCriteria.length > 0) {
    // Gate failures are identified by which criteria fail, not by free-text reasons.
    parts.criteria = classification.failedCriteria;
  } else {
    parts.error = FailureSignatureGenerator.fromError(error ? { code: error.code, message: error.message, details: error.details } : undefined);
  }
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
  return `fs1:${classification.failureClass}:${digest}`;
}
