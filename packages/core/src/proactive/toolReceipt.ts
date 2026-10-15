/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 * Adapted for Wazir.
 */

import { createHash, randomUUID } from 'node:crypto';
import { MemoryStore, type KeyValueStore } from '@wazir/shared';

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

/**
 * What makes two tool calls "the same operation". Two calls deduplicate only when every
 * field matches: a retry of one logical execution is suppressed, while an independent
 * execution (different scope or execution id) with identical arguments still runs.
 */
export interface ReceiptIdentity {
  toolName: string;
  input: Record<string, unknown>;
  op?: ProactiveReceiptOperation;
  /** Operation scope, e.g. a project root, session or task id. */
  scope?: string;
  /** The logical execution this call belongs to (task/execution/step id). */
  executionId?: string;
}

/**
 * Deterministic canonical serialization: object keys sorted at every depth, arrays kept
 * in order, `undefined` object members dropped (JSON semantics), and values JSON cannot
 * represent faithfully either tagged or refused, so distinct inputs never serialize alike.
 */
export function canonicalize(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'number': return Number.isFinite(value) ? JSON.stringify(value) : `{"$num":"${String(value)}"}`;
    case 'bigint': return `{"$bigint":"${value.toString()}"}`;
    case 'undefined': return '{"$undefined":true}';
    case 'function':
    case 'symbol':
      throw new TypeError(`canonicalize: cannot serialize a ${typeof value}`);
  }
  const object = value as object;
  if (seen.has(object)) throw new TypeError('canonicalize: cyclic structure');
  seen.add(object);
  try {
    if (Array.isArray(object)) return `[${object.map((item) => canonicalize(item, seen)).join(',')}]`;
    if (object instanceof Date) return `{"$date":${JSON.stringify(object.toISOString())}}`;
    const record = object as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`);
    return `{${members.join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

export function receiptFingerprint(identity: ReceiptIdentity): string {
  const serialized = canonicalize({
    v: 2,
    toolName: identity.toolName,
    op: identity.op ?? null,
    scope: identity.scope ?? null,
    executionId: identity.executionId ?? null,
    input: identity.input,
  });
  return createHash('sha256').update(serialized).digest('hex');
}

/** Durable state of one fingerprint. Only `committed` short-circuits a later attempt. */
interface ReceiptRecord {
  state: 'pending' | 'committed' | 'failed';
  fingerprint: string;
  attempt: number;
  /** Fencing token of the attempt currently allowed to settle. */
  attemptToken?: string;
  leaseExpiresAt?: number;
  receipt?: ProactiveToolReceipt;
  lastError?: string;
}

export type ReceiptBeginResult =
  | { status: 'acquired'; fingerprint: string; attemptToken: string; attempt: number }
  | { status: 'committed'; fingerprint: string; receipt: ProactiveToolReceipt }
  | { status: 'in_flight'; fingerprint: string; leaseExpiresAt: number };

export interface ToolReceiptManagerOptions {
  /**
   * Durable storage for `begin`/`settle`; must implement the atomic `update`. Defaults to
   * process memory, which does not survive a restart.
   */
  store?: KeyValueStore;
  /** How long an unsettled attempt blocks duplicates before a crash is assumed (default 10 min). */
  leaseMs?: number;
  now?: () => number;
}

const KEY_PREFIX = 'tool_receipt/';

export class ToolReceiptManager {
  private readonly receipts = new Map<string, ProactiveToolReceipt>();
  private readonly store: KeyValueStore;
  private readonly leaseMs: number;
  private readonly now: () => number;

  constructor(options: ToolReceiptManagerOptions = {}) {
    if (options.store && !options.store.update) throw new Error('ATOMIC_STORE_REQUIRED');
    this.store = options.store ?? new MemoryStore();
    this.leaseMs = options.leaseMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  computeFingerprint(toolName: string, input: Record<string, unknown>, scope?: Omit<ReceiptIdentity, 'toolName' | 'input'>): string {
    return receiptFingerprint({ toolName, input, ...scope });
  }

  /** True only for a committed (successful) receipt: a failed attempt never deduplicates. */
  hasReceipt(fingerprint: string): boolean {
    return this.receipts.has(fingerprint);
  }

  getReceipt(fingerprint: string): ProactiveToolReceipt | undefined {
    return this.receipts.get(fingerprint);
  }

  /**
   * Records the result of an already-executed operation. A committed receipt for the same
   * identity is returned unchanged (idempotent). A failed attempt is returned with
   * `committed: false` but is NOT cached, so a retry is recorded as a new attempt.
   */
  createReceipt(params: ReceiptIdentity & {
    op: ProactiveReceiptOperation;
    output?: string;
    error?: string;
    success: boolean;
    taskId?: string;
  }): ProactiveToolReceipt {
    const fingerprint = receiptFingerprint(params);
    const existing = this.receipts.get(fingerprint);
    if (existing) return existing;
    const receipt = buildReceipt(fingerprint, params, this.now());
    if (receipt.committed) this.receipts.set(fingerprint, receipt);
    return receipt;
  }

  /**
   * Durable step 1, before executing a side effect. Atomically either acquires the right
   * to execute (`acquired`, with a fencing token), reports an existing committed receipt
   * (`committed`: do not execute again), or reports another attempt holding an unexpired
   * lease (`in_flight`). An attempt whose lease expired (the executor crashed) is
   * re-acquirable; the side effect itself must then be idempotent or reconciled, since
   * the crashed attempt may have partially run.
   */
  async begin(identity: ReceiptIdentity): Promise<ReceiptBeginResult> {
    const fingerprint = receiptFingerprint(identity);
    const token = randomUUID();
    const record = await this.store.update!<ReceiptRecord>(KEY_PREFIX + fingerprint, (current) => {
      if (current?.state === 'committed') return current;
      if (current?.state === 'pending' && (current.leaseExpiresAt ?? 0) > this.now()) return current;
      return {
        state: 'pending',
        fingerprint,
        attempt: (current?.attempt ?? 0) + 1,
        attemptToken: token,
        leaseExpiresAt: this.now() + this.leaseMs,
        lastError: current?.lastError,
      };
    });
    if (record.state === 'committed' && record.receipt) {
      this.receipts.set(fingerprint, record.receipt);
      return { status: 'committed', fingerprint, receipt: record.receipt };
    }
    if (record.attemptToken !== token) {
      return { status: 'in_flight', fingerprint, leaseExpiresAt: record.leaseExpiresAt ?? 0 };
    }
    return { status: 'acquired', fingerprint, attemptToken: token, attempt: record.attempt };
  }

  /**
   * Durable step 2, after executing. Only the attempt holding the current fencing token may
   * settle: a late result from an attempt whose lease was taken over is rejected
   * (`LEASE_LOST`). Success commits the receipt permanently; failure releases the
   * fingerprint so a retry can run.
   */
  async settle(identity: {
    /** The fingerprint `begin` returned. */
    fingerprint: string;
    attemptToken: string;
    toolName: string;
    op: ProactiveReceiptOperation;
    success: boolean;
    output?: string;
    error?: string;
    taskId?: string;
  }): Promise<ProactiveToolReceipt> {
    const { fingerprint } = identity;
    const receipt = buildReceipt(fingerprint, identity, this.now());
    const record = await this.store.update!<ReceiptRecord>(KEY_PREFIX + fingerprint, (current) => {
      if (current?.state === 'committed') return current;
      if (!current || current.state !== 'pending' || current.attemptToken !== identity.attemptToken) {
        throw new Error('LEASE_LOST');
      }
      return identity.success
        ? { state: 'committed', fingerprint, attempt: current.attempt, receipt }
        : { state: 'failed', fingerprint, attempt: current.attempt, lastError: identity.error ?? 'failed' };
    });
    if (record.state === 'committed' && record.receipt) {
      this.receipts.set(fingerprint, record.receipt);
      return record.receipt;
    }
    return receipt;
  }

  /** Clears the in-process cache only; durable receipts in the store are kept. */
  clear(): void {
    this.receipts.clear();
  }
}

function buildReceipt(fingerprint: string, params: {
  op: ProactiveReceiptOperation; toolName: string; success: boolean; output?: string; error?: string; taskId?: string;
}, timestamp: number): ProactiveToolReceipt {
  return {
    receiptId: `rcpt-${timestamp}-${fingerprint.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
    atomic: true,
    committed: params.success,
    fingerprint,
    results: [
      {
        op: params.op,
        toolName: params.toolName,
        taskId: params.taskId,
        success: params.success,
        output: params.output,
        error: params.error,
        fingerprint,
        timestamp,
      },
    ],
  };
}
