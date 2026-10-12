/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 * Adapted for Wazir.
 */

import {
  pickLeastEscalating,
  pickPersistentGrant,
  redactPermissionText,
  stripControlSequences,
  type PermissionOption,
} from './adaptorUtils.js';
import {
  isImportantPermissionOperation,
  type PermissionDetails,
} from './importantOperation.js';

export type PermissionBrokerMode = 'ask' | 'allow-all';
export type SpokenPermissionDecision = 'allow' | 'allow_always' | 'deny';
export type DeliveryOutcome = 'delivered' | 'already_resolved' | 'skipped';

export interface PendingPermission {
  requestHandle: string;
  requestId: string;
  backendName: string;
  sessionId: string;
  jobRef?: string;
  title: string;
  options: readonly PermissionOption[];
  details?: PermissionDetails;
  permissionMode: PermissionBrokerMode;
  createdAt: number;
}

export interface PermissionDecisionEvent {
  pending: PendingPermission;
  requestedDecision: SpokenPermissionDecision;
  auto: boolean;
  outcome: DeliveryOutcome;
  selectedOptionId?: string;
  reason?: string;
}

export interface PermissionBrokerOptions {
  getPermissionMode?: () => PermissionBrokerMode;
  onDecision?: (event: PermissionDecisionEvent) => void;
  onAsk?: (pending: PendingPermission) => void;
  log?: (type: string, payload: Record<string, unknown>) => void;
}

export class PermissionBroker {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly resolvers = new Map<
    string,
    (result: { optionId?: string; cancelled?: boolean }) => void
  >();
  private seq = 0;

  constructor(private readonly options: PermissionBrokerOptions = {}) {}

  getMode(): PermissionBrokerMode {
    return this.options.getPermissionMode?.() === 'allow-all'
      ? 'allow-all'
      : 'ask';
  }

  async requestPermission(params: {
    requestId: string;
    backendName: string;
    sessionId: string;
    jobRef?: string;
    title: string;
    options: readonly PermissionOption[];
    details?: PermissionDetails;
  }): Promise<{ optionId?: string; cancelled?: boolean }> {
    const requestHandle = `perm-${++this.seq}-${params.requestId}`;
    const mode = this.getMode();

    const title = redactPermissionText(stripControlSequences(params.title));
    const pendingRecord: PendingPermission = {
      requestHandle,
      requestId: params.requestId,
      backendName: params.backendName,
      sessionId: params.sessionId,
      jobRef: params.jobRef,
      title,
      options: params.options,
      details: params.details,
      permissionMode: mode,
      createdAt: Date.now(),
    };

    // Auto-allow if mode is allow-all or if operation is verified safe/read-only
    const isImportant = isImportantPermissionOperation(params.details);
    if (mode === 'allow-all' || !isImportant) {
      const option = pickLeastEscalating(params.options, 'proceed');
      const selectedOptionId = option?.optionId;
      this.options.onDecision?.({
        pending: pendingRecord,
        requestedDecision: 'allow',
        auto: true,
        outcome: 'delivered',
        selectedOptionId,
        reason: mode === 'allow-all' ? 'allow-all-mode' : 'safe-read-only-operation',
      });
      return { optionId: selectedOptionId };
    }

    // Otherwise, park and wait for explicit decision
    this.pending.set(requestHandle, pendingRecord);
    this.options.onAsk?.(pendingRecord);

    return new Promise((resolve) => {
      this.resolvers.set(requestHandle, resolve);
    });
  }

  decide(
    requestHandle: string,
    decision: SpokenPermissionDecision,
  ): DeliveryOutcome {
    const pending = this.pending.get(requestHandle);
    const resolver = this.resolvers.get(requestHandle);

    if (!pending || !resolver) {
      return 'already_resolved';
    }

    this.pending.delete(requestHandle);
    this.resolvers.delete(requestHandle);

    if (decision === 'deny') {
      const option = pickLeastEscalating(pending.options, 'reject');
      resolver({ optionId: option?.optionId, cancelled: true });
      this.options.onDecision?.({
        pending,
        requestedDecision: 'deny',
        auto: false,
        outcome: 'delivered',
        selectedOptionId: option?.optionId,
      });
      return 'delivered';
    }

    const wanted = 'proceed';
    const option =
      (decision === 'allow_always'
        ? pickPersistentGrant(pending.options, wanted)
        : undefined) ?? pickLeastEscalating(pending.options, wanted);

    const selectedOptionId = option?.optionId;
    resolver({ optionId: selectedOptionId });

    this.options.onDecision?.({
      pending,
      requestedDecision: decision,
      auto: false,
      outcome: 'delivered',
      selectedOptionId,
    });
    return 'delivered';
  }

  cancelAll(): void {
    for (const [handle, resolver] of this.resolvers) {
      resolver({ cancelled: true });
    }
    this.pending.clear();
    this.resolvers.clear();
  }

  getPending(): PendingPermission[] {
    return Array.from(this.pending.values());
  }
}
