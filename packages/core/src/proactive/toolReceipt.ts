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
  /**
   * True only when the receipt was settled through the store's atomic compare-and-set
   * (`begin`/`settle`). `createReceipt` records an outcome after the fact and gives no
   * check-then-execute atomicity, so its receipts report `false`.
   */
  atomic: boolean;
  /** True only when the receipt lives in a store that survives a process restart. */
  durable: boolean;
  committed: boolean;
  results: ProactiveReceiptResult[];
  fingerprint: string;
}

/**
 * What makes two tool calls "the same operation". Two calls deduplicate only when every
 * field matches: a duplicate delivery of one logical operation is suppressed, while an
 * intentional repeat (a new idempotency key, or a different scope or execution) still runs.
 */
export interface ReceiptIdentity {
  toolName: string;
  input: Record<string, unknown>;
  op?: ProactiveReceiptOperation;
  /** Operation scope, e.g. a project root, session or task id. */
  scope?: string;
  /** The logical execution this call belongs to (task/execution/step id). */
  executionId?: string;
  /**
   * Caller-assigned identity of one intended operation, stable across transport
   * redelivery and retries of that same intent (e.g. a tool call id or step id).
   * A deliberate second execution with identical arguments must use a new key.
   */
  idempotencyKey?: string;
}

/**
 * Deterministic, injective canonical serialization: object keys sorted at every depth,
 * arrays kept in order, `undefined` object members dropped (JSON semantics). Values JSON
 * cannot represent are encoded as single-key `$`-tagged objects, and a plain object key
 * that itself starts with `$` is escaped with one more `$`, so no input can produce the
 * encoding of a tag. Values with no faithful encoding (functions, symbols, cycles,
 * class instances) are refused rather than collapsed into `{}`.
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
    if (Array.isArray(object)) {
      // Holes read as undefined, which is tagged, so [ , 1] and [undefined, 1] agree.
      return `[${Array.from(object, (item) => canonicalize(item, seen)).join(',')}]`;
    }
    if (object instanceof Date) {
      const time = object.getTime();
      return `{"$date":${Number.isNaN(time) ? '"invalid"' : JSON.stringify(object.toISOString())}}`;
    }
    if (object instanceof Map) {
      const entries = [...object].map(([k, v]) => [canonicalize(k, seen), canonicalize(v, seen)] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{"$map":[${entries.map(([k, v]) => `[${k},${v}]`).join(',')}]}`;
    }
    if (object instanceof Set) {
      return `{"$set":[${[...object].map((item) => canonicalize(item, seen)).sort().join(',')}]}`;
    }
    if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) {
      const bytes = object instanceof ArrayBuffer
        ? new Uint8Array(object)
        : new Uint8Array(object.buffer, object.byteOffset, object.byteLength);
      return `{"$bytes":{"type":${JSON.stringify(object.constructor.name)},"base64":"${Buffer.from(bytes).toString('base64')}"}}`;
    }
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`canonicalize: cannot serialize an instance of ${proto?.constructor?.name ?? 'an unknown class'}`);
    }
    const record = object as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .map((key) => [key.startsWith('$') ? `$${key}` : key, key] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([encoded, key]) => `${JSON.stringify(encoded)}:${canonicalize(record[key], seen)}`);
    return `{${members.join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

export function receiptFingerprint(identity: ReceiptIdentity): string {
  const serialized = canonicalize({
    v: 3,
    toolName: identity.toolName,
    op: identity.op ?? null,
    scope: identity.scope ?? null,
    executionId: identity.executionId ?? null,
    idempotencyKey: identity.idempotencyKey ?? null,
    input: identity.input,
  });
  return createHash('sha256').update(serialized).digest('hex');
}

/** Side-effect classes, matching ToolSideEffectClass in types/tool.ts. */
export type ReceiptSideEffectClass = 'READ_ONLY' | 'IDEMPOTENT_WRITE' | 'NON_IDEMPOTENT_WRITE';

/** Stored state of one fingerprint. Only `committed` short-circuits a later attempt. */
interface ReceiptRecord {
  /**
   * `outcome_unknown`: an attempt of a non-idempotent operation lost its lease without
   * settling (the executor crashed or hung). It may or may not have taken effect, so it
   * blocks every further attempt until `reconcile` records physical evidence.
   */
  state: 'pending' | 'committed' | 'failed' | 'outcome_unknown';
  fingerprint: string;
  attempt: number;
  sideEffectClass?: ReceiptSideEffectClass;
  /** Fencing token of the attempt currently allowed to settle. */
  attemptToken?: string;
  leaseExpiresAt?: number;
  receipt?: ProactiveToolReceipt;
  lastError?: string;
  evidence?: string;
}

export type ReceiptBeginResult =
  | { status: 'acquired'; fingerprint: string; attemptToken: string; attempt: number }
  | { status: 'committed'; fingerprint: string; receipt: ProactiveToolReceipt }
  | { status: 'in_flight'; fingerprint: string; leaseExpiresAt: number }
  | { status: 'outcome_unknown'; fingerprint: string; attempt: number };

export interface ToolReceiptManagerOptions {
  /**
   * Storage for `begin`/`settle`; must implement the atomic `update`. Defaults to process
   * memory, which does not survive a restart.
   */
  store?: KeyValueStore;
  /**
   * Whether `store` survives a process restart. Defaults to false for the in-memory
   * default and for a MemoryStore, true otherwise. Only reported on receipts; it never
   * changes behaviour.
   */
  durable?: boolean;
  /** How long an unsettled attempt blocks duplicates before a crash is assumed (default 10 min). */
  leaseMs?: number;
  now?: () => number;
}

const KEY_PREFIX = 'tool_receipt/';

/**
 * Receipt ledger for proactive tool operations. Not wired into the production tool path:
 * the authoritative record of dispatched tool calls is ExecutionEngine's durable event log
 * (tool.started / tool.completed, see toolCheckpoints and reconcileToolCall). This class
 * is a standalone at-most-once-commit primitive and must not become a second source of truth.
 *
 * Guarantees, for callers that go through `begin`/`settle` on an atomic store:
 *   - at most one attempt per fingerprint holds the right to execute at a time;
 *   - at most one successful outcome is committed per fingerprint;
 *   - a settle from an attempt whose lease was taken over is rejected (fencing);
 *   - a non-idempotent attempt that lost its lease is never silently re-acquired.
 * It does NOT make the side effect itself exactly-once: an executor can crash after the
 * effect and before `settle`, which is exactly what `outcome_unknown` represents.
 */
export class ToolReceiptManager {
  private readonly receipts = new Map<string, ProactiveToolReceipt>();
  private readonly store: KeyValueStore;
  private readonly durable: boolean;
  private readonly leaseMs: number;
  private readonly now: () => number;

  constructor(options: ToolReceiptManagerOptions = {}) {
    if (options.store && !options.store.update) throw new Error('ATOMIC_STORE_REQUIRED');
    this.store = options.store ?? new MemoryStore();
    this.durable = options.durable ?? !(this.store instanceof MemoryStore);
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
   * Records the result of an already-executed operation in this process's memory. A
   * committed receipt for the same identity is returned unchanged. A failed attempt is
   * returned with `committed: false` but is NOT cached, so a retry is recorded as a new
   * attempt. Neither atomic nor durable: use `begin`/`settle` to guard a side effect.
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
    const receipt = buildReceipt(fingerprint, params, this.now(), { atomic: false, durable: false });
    if (receipt.committed) this.receipts.set(fingerprint, receipt);
    return receipt;
  }

  /**
   * Step 1, before executing a side effect. Atomically either acquires the right to
   * execute (`acquired`, with a fencing token), reports an existing committed receipt
   * (`committed`: do not execute again), reports another attempt holding an unexpired
   * lease (`in_flight`), or reports an attempt that may have taken effect
   * (`outcome_unknown`: reconcile before anything runs).
   *
   * An attempt whose lease expired without settling is re-acquirable only when the
   * operation is READ_ONLY or IDEMPOTENT_WRITE. For a NON_IDEMPOTENT_WRITE (the default)
   * it becomes `outcome_unknown`, because the crashed attempt may already have run.
   */
  async begin(identity: ReceiptIdentity, options: { sideEffectClass?: ReceiptSideEffectClass } = {}): Promise<ReceiptBeginResult> {
    const fingerprint = receiptFingerprint(identity);
    const sideEffectClass = options.sideEffectClass ?? 'NON_IDEMPOTENT_WRITE';
    const token = randomUUID();
    const record = await this.store.update!<ReceiptRecord>(KEY_PREFIX + fingerprint, (current) => {
      if (current?.state === 'committed' || current?.state === 'outcome_unknown') return current;
      if (current?.state === 'pending') {
        if ((current.leaseExpiresAt ?? 0) > this.now()) return current;
        if ((current.sideEffectClass ?? 'NON_IDEMPOTENT_WRITE') === 'NON_IDEMPOTENT_WRITE') {
          return { state: 'outcome_unknown', fingerprint, attempt: current.attempt, sideEffectClass: current.sideEffectClass,
            lastError: `attempt ${current.attempt} lost its lease without settling` };
        }
      }
      return {
        state: 'pending',
        fingerprint,
        attempt: (current?.attempt ?? 0) + 1,
        sideEffectClass,
        attemptToken: token,
        leaseExpiresAt: this.now() + this.leaseMs,
        lastError: current?.lastError,
      };
    });
    if (record.state === 'committed' && record.receipt) {
      this.receipts.set(fingerprint, record.receipt);
      return { status: 'committed', fingerprint, receipt: record.receipt };
    }
    if (record.state === 'outcome_unknown') return { status: 'outcome_unknown', fingerprint, attempt: record.attempt };
    if (record.attemptToken !== token) {
      return { status: 'in_flight', fingerprint, leaseExpiresAt: record.leaseExpiresAt ?? 0 };
    }
    return { status: 'acquired', fingerprint, attemptToken: token, attempt: record.attempt };
  }

  /**
   * Step 2, after executing. Only the attempt holding the current fencing token may
   * settle: a late result from an attempt whose lease was taken over, or that was
   * declared `outcome_unknown`, is rejected (`LEASE_LOST`). Success commits the receipt
   * permanently; failure releases the fingerprint so a retry can run.
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
    const receipt = buildReceipt(fingerprint, identity, this.now(), { atomic: true, durable: this.durable });
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

  /**
   * Resolves an `outcome_unknown` fingerprint from physical evidence. APPLIED commits a
   * receipt (the effect happened; it must not run again). NOT_APPLIED releases the
   * fingerprint for a new attempt. There is no "undetermined" resolution: without proof
   * it stays blocked for an operator.
   */
  async reconcile(params: {
    fingerprint: string;
    toolName: string;
    op: ProactiveReceiptOperation;
    outcome: 'APPLIED' | 'NOT_APPLIED';
    evidence: string;
  }): Promise<'committed' | 'failed'> {
    const { fingerprint } = params;
    const receipt = buildReceipt(fingerprint, { ...params, success: true, output: `reconciled: ${params.evidence}` }, this.now(), { atomic: true, durable: this.durable });
    const record = await this.store.update!<ReceiptRecord>(KEY_PREFIX + fingerprint, (current) => {
      if (current?.state !== 'outcome_unknown') throw new Error(`NOTHING_TO_RECONCILE: ${current?.state ?? 'absent'}`);
      return params.outcome === 'APPLIED'
        ? { state: 'committed', fingerprint, attempt: current.attempt, receipt, evidence: params.evidence }
        : { state: 'failed', fingerprint, attempt: current.attempt, lastError: current.lastError, evidence: params.evidence };
    });
    if (record.state === 'committed' && record.receipt) this.receipts.set(fingerprint, record.receipt);
    return record.state === 'committed' ? 'committed' : 'failed';
  }

  /** Clears the in-process cache only; receipts in the store are kept. */
  clear(): void {
    this.receipts.clear();
  }
}

function buildReceipt(fingerprint: string, params: {
  op: ProactiveReceiptOperation; toolName: string; success: boolean; output?: string; error?: string; taskId?: string;
}, timestamp: number, guarantees: { atomic: boolean; durable: boolean }): ProactiveToolReceipt {
  return {
    receiptId: `rcpt-${timestamp}-${fingerprint.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
    ...guarantees,
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
