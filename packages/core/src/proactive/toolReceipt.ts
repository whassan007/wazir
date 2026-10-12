/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 * Adapted for Wazir.
 */

import { createHash } from 'node:crypto';

export type ProactiveReceiptOperation =
  | 'create_task'
  | 'update_task'
  | 'cancel_task'
  | 'execute_tool'
  | 'apply_patch';

export interface ProactiveReceiptResult {
  op: ProactiveReceiptOperation;
  success: boolean;
  taskId?: string;
  toolName?: string;
  fingerprint?: string;
  output?: string;
  error?: string;
  timestamp: number;
}

export interface ProactiveToolReceipt {
  receiptId: string;
  atomic: true;
  committed: boolean;
  results: ProactiveReceiptResult[];
  fingerprint: string;
}

export class ToolReceiptManager {
  private readonly receipts = new Map<string, ProactiveToolReceipt>();

  computeFingerprint(toolName: string, input: Record<string, unknown>): string {
    const serialized = JSON.stringify({ toolName, input }, Object.keys(input).sort());
    return createHash('sha256').update(serialized).digest('hex');
  }

  hasReceipt(fingerprint: string): boolean {
    return this.receipts.has(fingerprint);
  }

  getReceipt(fingerprint: string): ProactiveToolReceipt | undefined {
    return this.receipts.get(fingerprint);
  }

  createReceipt(params: {
    toolName: string;
    op: ProactiveReceiptOperation;
    input: Record<string, unknown>;
    output?: string;
    error?: string;
    success: boolean;
  }): ProactiveToolReceipt {
    const fingerprint = this.computeFingerprint(params.toolName, params.input);
    const existing = this.receipts.get(fingerprint);
    if (existing) {
      return existing;
    }

    const receipt: ProactiveToolReceipt = {
      receiptId: `rcpt-${Date.now()}-${fingerprint.slice(0, 8)}`,
      atomic: true,
      committed: params.success,
      fingerprint,
      results: [
        {
          op: params.op,
          toolName: params.toolName,
          success: params.success,
          output: params.output,
          error: params.error,
          fingerprint,
          timestamp: Date.now(),
        },
      ],
    };

    this.receipts.set(fingerprint, receipt);
    return receipt;
  }

  clear(): void {
    this.receipts.clear();
  }
}
