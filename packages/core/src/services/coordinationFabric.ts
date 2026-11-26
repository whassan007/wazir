import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fsSync, { type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { KeyValueStore } from '@wazir/shared';
import {
  COORDINATION_SCHEMA_VERSION,
  DEFAULT_MAX_INLINE_PAYLOAD_BYTES,
  type ArtifactStoreAdapter,
  type CircuitBreakerState,
  type ConsumerInfo,
  type CoordinationEventEnvelope,
  type CoordinationEventFilter,
  type CoordinationEventType,
  type CoordinationPublishInput,
  type CoordinationTransportAdapter,
  type CoordinationTransportKind,
  type FabricDiagnosticsReport,
  type FabricStatusReport,
  type InboxMessage,
  type OutboxEntry,
  type ResourceLease,
  normalizeCoordinationTransportKind,
} from '../types/coordination.js';

const MAX_WIRE_FRAME_BYTES = 4 * 1024 * 1024;
const SCHEMA_VERSION_RE = /^1\.\d+$/;
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DEFAULT_MAX_QUEUE_SIZE = 4096;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 25;
const DEFAULT_RETRY_MAX_DELAY_MS = 2000;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 5;
const DEFAULT_CONSUMER_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 250;
const MAX_SEEN_EVENT_IDS = 50_000;
const MAX_IN_MEMORY_EVENTS = 10_000;
const MAX_LATENCY_SAMPLES = 1000;

export function isCompatibleSchemaVersion(version: string): boolean {
  return typeof version === 'string' && SCHEMA_VERSION_RE.test(version);
}

export function validateCoordinationEnvelope(envelope: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { valid: false, errors: ['Envelope must be a non-null plain object'] };
  }

  const record = envelope as Record<string, unknown>;

  if (typeof record.event_id !== 'string' || record.event_id.trim().length === 0) {
    errors.push('event_id must be a non-empty string');
  }
  if (typeof record.schema_version !== 'string' || !isCompatibleSchemaVersion(record.schema_version)) {
    errors.push('schema_version must be compatible with 1.x');
  }
  if (typeof record.type !== 'string' || record.type.trim().length === 0) {
    errors.push('type must be a non-empty string');
  }
  if (typeof record.workflow_id !== 'string' || record.workflow_id.trim().length === 0) {
    errors.push('workflow_id must be a non-empty string');
  }
  if (typeof record.correlation_id !== 'string' || record.correlation_id.trim().length === 0) {
    errors.push('correlation_id must be a non-empty string');
  }
  if (
    typeof record.timestamp !== 'string' ||
    !ISO_8601_RE.test(record.timestamp) ||
    Number.isNaN(Date.parse(record.timestamp))
  ) {
    errors.push('timestamp must be a valid ISO-8601 string');
  }
  if (!('payload' in record) || record.payload === undefined) {
    errors.push('payload must be defined');
  }
  if (!Array.isArray(record.artifact_refs) || !record.artifact_refs.every((item) => typeof item === 'string')) {
    errors.push('artifact_refs must be an array of strings');
  }

  const optionalStringFields = ['task_id', 'source_agent', 'target_agent', 'causation_id', 'idempotency_key'] as const;
  for (const field of optionalStringFields) {
    if (record[field] !== undefined && typeof record[field] !== 'string') {
      errors.push(`${field} must be a string when present`);
    }
  }

  if (record.fencing_token !== undefined && (typeof record.fencing_token !== 'number' || !Number.isFinite(record.fencing_token))) {
    errors.push('fencing_token must be a finite number when present');
  }
  if (
    record.delegation_depth !== undefined &&
    (typeof record.delegation_depth !== 'number' || !Number.isInteger(record.delegation_depth) || record.delegation_depth < 0)
  ) {
    errors.push('delegation_depth must be a non-negative integer when present');
  }
  if (
    record.causation_chain !== undefined &&
    (!Array.isArray(record.causation_chain) || !record.causation_chain.every((item) => typeof item === 'string'))
  ) {
    errors.push('causation_chain must be an array of strings when present');
  }
  if (record.untrusted_peer_input !== undefined && typeof record.untrusted_peer_input !== 'boolean') {
    errors.push('untrusted_peer_input must be a boolean when present');
  }

  return { valid: errors.length === 0, errors };
}

function safeSegment(value: string): string {
  if (!value) return '_empty_';
  const clean = value.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (clean === value && clean.length <= 80) return clean;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12);
  const prefix = clean.slice(0, 48) || 'id';
  return `${prefix}_${digest}`;
}

function sanitizeNatsToken(value: string): string {
  const token = value.replace(/[^a-zA-Z0-9_-]/g, '_');
  return token.length > 0 ? token : 'unknown';
}

function isInsideDir(rootDir: string, candidatePath: string): boolean {
  const root = path.resolve(rootDir);
  const target = path.resolve(candidatePath);
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf8');
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

function computePercentiles(samples: number[]): { p50?: number; p95?: number } {
  if (samples.length === 0) return {};
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number): number => {
    if (sorted.length === 1) return Number(sorted[0].toFixed(4));
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return Number(sorted[lo].toFixed(4));
    const w = idx - lo;
    return Number((sorted[lo] * (1 - w) + sorted[hi] * w).toFixed(4));
  };
  return { p50: at(50), p95: at(95) };
}

export interface NatsWireTransportOptions {
  url: string;
  subjectPrefix?: string;
  connectTimeoutMs?: number;
  clientName?: string;
  authToken?: string;
  user?: string;
  pass?: string;
  verbose?: boolean;
  /**
   * Wait for the server's `PONG` to a `PING` sent after each batch before resolving
   * `publishBatch` (default `true`). This proves the server processed the `PUB` frames, so a
   * broker that dies mid-stream causes the batch to stay in the outbox instead of being lost
   * in a kernel socket buffer. Disabling it restores fire-and-forget writes.
   */
  confirmPublish?: boolean;
  /** Timeout for the publish confirmation `PONG` (default: connect timeout, min 1000ms). */
  publishAckTimeoutMs?: number;
}

interface NatsSubscriptionRecord {
  sid: string;
  subject: string;
  handler: (event: CoordinationEventEnvelope) => void;
}

/**
 * Zero-dependency NATS Core text-wire transport (`PUB`/`SUB`) over `node:net`.
 *
 * Delivery semantics:
 * - Wire: **at-most-once** (NATS Core). The server neither persists nor redelivers; a
 *   subscriber that is disconnected while a message is routed misses it. This is NOT
 *   JetStream (no streams, no consumer acks, no replay from the broker).
 * - Producer: `publishBatch` resolves only after the server's `PONG` to a trailing `PING`
 *   (unless `confirmPublish: false`), so the fabric's local outbox keeps every event that the
 *   server did not provably process and retries it. Because the failure may be ambiguous
 *   (server processed the PUB but the PONG was lost), retries can duplicate.
 * - Consumer: must deduplicate on `event_id` / `idempotency_key` for exactly-once effects.
 * - Reconnect: the transport does not reconnect on its own; `connect()` re-establishes the
 *   socket and re-sends every registered `SUB` (the fabric calls it during flush).
 */
export class NatsWireTransport implements CoordinationTransportAdapter {
  readonly kind: CoordinationTransportKind = 'nats-core';
  private readonly host: string;
  private readonly port: number;
  private readonly subjectPrefix: string;
  private readonly defaultConnectTimeoutMs: number;
  private readonly clientName: string;
  private readonly authToken?: string;
  private readonly user?: string;
  private readonly pass?: string;
  private readonly verbose: boolean;
  private readonly confirmPublish: boolean;
  private readonly publishAckTimeoutMs: number;
  private pongWaiters: Array<{ resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];

  private socket?: net.Socket;
  private connected = false;
  private closed = false;
  private connectingPromise?: Promise<void>;
  private rxBuffer: Buffer = Buffer.alloc(0);
  private nextSid = 0;
  private readonly subs = new Map<string, NatsSubscriptionRecord>();
  private serverInfo?: Record<string, unknown>;

  constructor(options: NatsWireTransportOptions) {
    const parsed = parseNatsUrl(options.url);
    this.host = parsed.host;
    this.port = parsed.port;
    this.subjectPrefix = (options.subjectPrefix ?? 'wazir.coord').replace(/\.+$/, '');
    this.defaultConnectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.clientName = options.clientName ?? 'wazir-coordination-fabric';
    this.authToken = options.authToken ?? parsed.token;
    this.user = options.user ?? parsed.user;
    this.pass = options.pass ?? parsed.pass;
    this.verbose = options.verbose ?? false;
    this.confirmPublish = options.confirmPublish ?? true;
    this.publishAckTimeoutMs = Math.max(1, options.publishAckTimeoutMs ?? Math.max(1000, this.defaultConnectTimeoutMs));
  }

  private failPongWaiters(err: Error): void {
    const waiters = this.pongWaiters;
    this.pongWaiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private waitForPong(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pongWaiters.findIndex((w) => w.timer === timer);
        if (idx !== -1) this.pongWaiters.splice(idx, 1);
        reject(new Error(`NATS publish confirmation (PONG) timed out after ${this.publishAckTimeoutMs}ms`));
      }, this.publishAckTimeoutMs);
      timer.unref();
      this.pongWaiters.push({ resolve, reject, timer });
    });
  }

  isConnected(): boolean {
    return this.connected && !this.closed && Boolean(this.socket) && !this.socket!.destroyed;
  }

  async connect(timeoutMs = this.defaultConnectTimeoutMs): Promise<void> {
    if (this.closed) {
      throw new Error('NatsWireTransport has been closed');
    }
    if (this.isConnected()) return;
    if (this.connectingPromise) return this.connectingPromise;

    this.connectingPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let socket: net.Socket | undefined;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        this.connectingPromise = undefined;
        if (err) {
          this.connected = false;
          if (socket && !socket.destroyed) {
            socket.destroy();
          }
          if (this.socket === socket) {
            this.socket = undefined;
          }
          reject(err);
        } else {
          resolve();
        }
      };

      timer = setTimeout(() => {
        finish(new Error(`NATS connection timed out after ${timeoutMs}ms (${this.host}:${this.port})`));
      }, Math.max(1, timeoutMs));
      timer.unref();

      socket = net.createConnection({ host: this.host, port: this.port });
      socket.setNoDelay(true);
      this.socket = socket;
      this.rxBuffer = Buffer.alloc(0);

      const onInfoReady = () => {
        if (!socket || socket.destroyed || settled) return;
        const connectPayload: Record<string, unknown> = {
          verbose: this.verbose,
          pedantic: false,
          tls_required: false,
          name: this.clientName,
          lang: 'typescript',
          version: '1.0.0',
          protocol: 1,
        };
        if (this.authToken) connectPayload.auth_token = this.authToken;
        if (this.user) connectPayload.user = this.user;
        if (this.pass) connectPayload.pass = this.pass;

        let frames = `CONNECT ${JSON.stringify(connectPayload)}\r\n`;
        for (const sub of this.subs.values()) {
          frames += `SUB ${sub.subject} ${sub.sid}\r\n`;
        }
        socket.write(frames, 'utf8', (writeErr) => {
          if (writeErr) {
            finish(writeErr);
            return;
          }
          this.connected = true;
          finish();
        });
      };

      socket.on('data', (chunk: Buffer) => {
        this.handleData(chunk, () => {
          onInfoReady();
        });
      });

      socket.on('error', (err: Error) => {
        this.connected = false;
        this.failPongWaiters(err);
        finish(err);
      });

      socket.on('close', () => {
        this.connected = false;
        this.failPongWaiters(new Error('NATS socket closed before publish was confirmed'));
        if (this.socket === socket) {
          this.socket = undefined;
        }
        finish(new Error('NATS socket closed before handshake completed'));
      });
    });

    return this.connectingPromise;
  }

  private handleData(chunk: Buffer, onInfo?: () => void): void {
    this.rxBuffer = this.rxBuffer.length === 0 ? chunk : Buffer.concat([this.rxBuffer, chunk]);

    while (this.rxBuffer.length > 0) {
      const crlf = this.rxBuffer.indexOf('\r\n');
      if (crlf === -1) break;

      const line = this.rxBuffer.subarray(0, crlf).toString('utf8');

      if (line.startsWith('MSG ') || line.startsWith('HMSG ')) {
        const parts = line.trim().split(/\s+/);
        const byteCount = Number.parseInt(parts[parts.length - 1] ?? '', 10);
        if (!Number.isFinite(byteCount) || byteCount < 0 || byteCount > MAX_WIRE_FRAME_BYTES) {
          this.rxBuffer = this.rxBuffer.subarray(crlf + 2);
          continue;
        }
        const totalNeeded = crlf + 2 + byteCount + 2;
        if (this.rxBuffer.length < totalNeeded) {
          break;
        }
        const payloadBuf = this.rxBuffer.subarray(crlf + 2, crlf + 2 + byteCount);
        this.rxBuffer = this.rxBuffer.subarray(totalNeeded);

        let payloadSlice = payloadBuf;
        if (line.startsWith('HMSG ') && parts.length >= 5) {
          const headerBytes = Number.parseInt(parts[parts.length - 2] ?? '0', 10);
          if (Number.isFinite(headerBytes) && headerBytes > 0 && headerBytes <= payloadBuf.length) {
            payloadSlice = payloadBuf.subarray(headerBytes);
          }
        }
        const sid = parts[2] ?? '';
        this.dispatchWireMessage(sid, payloadSlice.toString('utf8'));
        continue;
      }

      this.rxBuffer = this.rxBuffer.subarray(crlf + 2);

      if (line === 'PING') {
        if (this.socket && !this.socket.destroyed && this.socket.writable) {
          this.socket.write('PONG\r\n');
        }
      } else if (line.startsWith('INFO ')) {
        try {
          this.serverInfo = JSON.parse(line.slice(5)) as Record<string, unknown>;
        } catch {
          this.serverInfo = {};
        }
        onInfo?.();
      } else if (line === 'PONG') {
        const waiter = this.pongWaiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve();
        }
      } else if (line === '+OK') {
        // Handled control acknowledgement.
      } else if (line.startsWith('-ERR')) {
        // Server protocol error; disconnect if fatal, otherwise tolerate gracefully.
        if (/authorization|stale|permissions/i.test(line)) {
          this.connected = false;
        }
      }
    }
  }

  private dispatchWireMessage(sid: string, rawJson: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      return;
    }
    const validation = validateCoordinationEnvelope(parsed);
    if (!validation.valid) return;
    const envelope = parsed as CoordinationEventEnvelope;

    const exact = this.subs.get(sid);
    if (exact) {
      try {
        exact.handler(envelope);
      } catch {
        // Isolate subscriber failure
      }
      return;
    }
    for (const sub of this.subs.values()) {
      try {
        sub.handler(envelope);
      } catch {
        // Isolate subscriber failure
      }
    }
  }

  async publishBatch(events: CoordinationEventEnvelope[]): Promise<void> {
    if (events.length === 0) return;
    if (!this.isConnected() || !this.socket) {
      throw new Error('NatsWireTransport is not connected');
    }

    const chunks: Buffer[] = [];
    for (const event of events) {
      const subject = `${this.subjectPrefix}.${sanitizeNatsToken(event.workflow_id)}.${event.type}`;
      const body = Buffer.from(JSON.stringify(event), 'utf8');
      chunks.push(Buffer.from(`PUB ${subject} ${body.byteLength}\r\n`, 'utf8'), body, Buffer.from('\r\n', 'utf8'));
    }
    if (this.confirmPublish) {
      chunks.push(Buffer.from('PING\r\n', 'utf8'));
    }
    const wirePayload = Buffer.concat(chunks);
    const socket = this.socket;
    // Register the waiter before writing so a fast PONG cannot be missed.
    const confirmed = this.confirmPublish ? this.waitForPong() : undefined;
    confirmed?.catch(() => undefined);

    await new Promise<void>((resolve, reject) => {
      if (!socket || socket.destroyed || !socket.writable) {
        reject(new Error('NATS socket is not writable'));
        return;
      }
      socket.write(wirePayload, (err) => {
        if (err) {
          this.connected = false;
          reject(err);
        } else {
          resolve();
        }
      });
    });
    if (confirmed) {
      try {
        await confirmed;
      } catch (err) {
        // Ambiguous outcome: the server may or may not have routed the batch. Treat the
        // connection as unusable so the next flush reconnects and the outbox retries.
        this.connected = false;
        if (this.socket === socket && socket && !socket.destroyed) socket.destroy();
        throw err;
      }
    }
  }

  subscribe(handler: (event: CoordinationEventEnvelope) => void): () => void {
    const sid = String(++this.nextSid);
    const subject = `${this.subjectPrefix}.>`;
    this.subs.set(sid, { sid, subject, handler });
    if (this.isConnected() && this.socket && this.socket.writable) {
      this.socket.write(`SUB ${subject} ${sid}\r\n`);
    }
    return () => {
      if (!this.subs.delete(sid)) return;
      if (this.isConnected() && this.socket && !this.socket.destroyed && this.socket.writable) {
        this.socket.write(`UNSUB ${sid}\r\n`);
      }
    };
  }

  getServerInfo(): Record<string, unknown> | undefined {
    return this.serverInfo;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
    this.subs.clear();
    this.failPongWaiters(new Error('NatsWireTransport closed'));
    const sock = this.socket;
    this.socket = undefined;
    if (sock && !sock.destroyed) {
      sock.removeAllListeners();
      sock.destroy();
    }
  }
}

function parseNatsUrl(rawUrl: string): { host: string; port: number; user?: string; pass?: string; token?: string } {
  const normalized = rawUrl.includes('://') ? rawUrl : `nats://${rawUrl}`;
  const url = new URL(normalized.replace(/^nats:/i, 'http:').replace(/^tls:/i, 'https:'));
  const port = url.port ? Number.parseInt(url.port, 10) : 4222;
  return {
    host: url.hostname || '127.0.0.1',
    port: Number.isFinite(port) && port > 0 ? port : 4222,
    user: url.username ? decodeURIComponent(url.username) : undefined,
    pass: url.password ? decodeURIComponent(url.password) : undefined,
    token: !url.password && url.username ? decodeURIComponent(url.username) : undefined,
  };
}

export interface CoordinationFabricOptions {
  fabricDir?: string;
  store?: KeyValueStore;
  artifactStore?: ArtifactStoreAdapter;
  transport?: CoordinationTransportAdapter;
  natsUrl?: string;
  natsSubjectPrefix?: string;
  connectTimeoutMs?: number;
  maxInlinePayloadBytes?: number;
  maxQueueSize?: number;
  batchSize?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
  pollIntervalMs?: number;
  autoStartWatcher?: boolean;
  consumerTimeoutMs?: number;
  now?: () => number;
  getActiveLeaseCount?: () => number | Promise<number>;
  getInboxPendingCount?: () => number | Promise<number>;
}

export interface CoordinationFlushResult {
  flushed: number;
  failed: number;
  remaining: number;
}

interface InternalSubscription {
  id: string;
  filter: CoordinationEventFilter;
  handler: (event: CoordinationEventEnvelope) => void | Promise<void>;
}

export class CoordinationFabric {
  private readonly fabricDir?: string;
  private readonly eventsDir?: string;
  private readonly outboxDir?: string;
  private readonly dlqDir?: string;
  private readonly artifactsDir?: string;
  private readonly consumersDir?: string;
  private readonly inboxesDir?: string;
  private readonly leasesDir?: string;
  private readonly store?: KeyValueStore;
  private readonly artifactStore?: ArtifactStoreAdapter;
  private transport?: CoordinationTransportAdapter;
  private readonly natsUrl?: string;
  private readonly natsSubjectPrefix?: string;
  private readonly connectTimeoutMs: number;
  private readonly maxInlinePayloadBytes: number;
  private readonly maxQueueSize: number;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly circuitFailureThreshold: number;
  private readonly circuitCooldownMs: number;
  private readonly pollIntervalMs: number;
  private readonly consumerTimeoutMs: number;
  private readonly now: () => number;
  private readonly getActiveLeaseCount?: () => number | Promise<number>;
  private readonly getInboxPendingCount?: () => number | Promise<number>;

  private readonly ensuredDirs = new Set<string>();
  private readonly subscriptions = new Set<InternalSubscription>();
  private readonly seenEventIds = new Set<string>();
  private readonly seenEventOrder: string[] = [];
  private readonly inMemoryEvents: CoordinationEventEnvelope[] = [];
  private readonly inMemoryArtifacts = new Map<string, unknown>();
  private readonly inMemoryOutbox = new Map<string, OutboxEntry>();
  private readonly inMemoryDlq = new Map<string, OutboxEntry>();
  private readonly pendingQueue: OutboxEntry[] = [];
  private readonly consumers = new Map<string, ConsumerInfo>();
  private readonly trackedLeases = new Set<string>();
  private readonly latencySamples: number[] = [];

  private localSeq = 0;
  private totalEventsPublished = 0;
  private circuitState: CircuitBreakerState = 'closed';
  private consecutiveFailures = 0;
  private circuitOpenedAt = 0;
  private flushTimer?: NodeJS.Timeout;
  private flushingPromise?: Promise<CoordinationFlushResult>;
  private closed = false;
  private transportUnsub?: () => void;
  private transportInitialized = false;

  private watcherRunning = false;
  private fsWatcher?: FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private readonly observedFiles = new Set<string>();
  private scanning = false;
  private scanPending = false;

  constructor(options: CoordinationFabricOptions = {}) {
    this.fabricDir = options.fabricDir ? path.resolve(options.fabricDir) : undefined;
    if (this.fabricDir) {
      this.eventsDir = path.join(this.fabricDir, 'events');
      this.outboxDir = path.join(this.fabricDir, 'outbox');
      this.dlqDir = path.join(this.fabricDir, 'dlq');
      this.artifactsDir = path.join(this.fabricDir, 'artifacts');
      this.consumersDir = path.join(this.fabricDir, 'consumers');
      this.inboxesDir = path.join(this.fabricDir, 'inboxes');
      this.leasesDir = path.join(this.fabricDir, 'leases');
    }
    this.store = options.store;
    this.artifactStore = options.artifactStore;
    this.transport = options.transport;
    this.natsUrl = options.natsUrl;
    this.natsSubjectPrefix = options.natsSubjectPrefix;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.maxInlinePayloadBytes = options.maxInlinePayloadBytes ?? DEFAULT_MAX_INLINE_PAYLOAD_BYTES;
    this.maxQueueSize = Math.max(1, options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE);
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    this.maxRetries = Math.max(1, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.retryBaseDelayMs = Math.max(1, options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
    this.retryMaxDelayMs = Math.max(this.retryBaseDelayMs, options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS);
    this.circuitFailureThreshold = Math.max(1, options.circuitFailureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD);
    this.circuitCooldownMs = Math.max(1, options.circuitCooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS);
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.consumerTimeoutMs = Math.max(100, options.consumerTimeoutMs ?? DEFAULT_CONSUMER_TIMEOUT_MS);
    this.now = options.now ?? Date.now;
    this.getActiveLeaseCount = options.getActiveLeaseCount;
    this.getInboxPendingCount = options.getInboxPendingCount;

    if (options.autoStartWatcher) {
      this.startCrossProcessWatcher();
    }
  }

  getFabricDir(): string | undefined {
    return this.fabricDir;
  }

  getStore(): KeyValueStore | undefined {
    return this.store;
  }

  private hasRemoteBroker(): boolean {
    return Boolean(this.transport || this.natsUrl);
  }

  private ensureDirSync(dir: string): void {
    if (this.ensuredDirs.has(dir)) return;
    fsSync.mkdirSync(dir, { recursive: true });
    this.ensuredDirs.add(dir);
  }

  private async ensureDir(dir: string): Promise<void> {
    if (this.ensuredDirs.has(dir)) return;
    await fs.mkdir(dir, { recursive: true });
    this.ensuredDirs.add(dir);
  }

  private markSeen(eventId: string): void {
    if (this.seenEventIds.has(eventId)) return;
    this.seenEventIds.add(eventId);
    this.seenEventOrder.push(eventId);
    if (this.seenEventOrder.length > MAX_SEEN_EVENT_IDS) {
      const oldest = this.seenEventOrder.shift();
      if (oldest) this.seenEventIds.delete(oldest);
    }
  }

  private recordLatency(durationMs: number): void {
    this.latencySamples.push(durationMs);
    if (this.latencySamples.length > MAX_LATENCY_SAMPLES) {
      this.latencySamples.shift();
    }
  }

  private buildEnvelope<TPayload>(input: CoordinationPublishInput<TPayload>): CoordinationEventEnvelope<TPayload> {
    const eventId = input.event_id ?? input.eventId ?? `evt-${randomUUID()}`;
    const workflowId = input.workflow_id ?? input.workflowId ?? '';
    const envelope: CoordinationEventEnvelope<TPayload> = {
      event_id: eventId,
      schema_version: input.schema_version ?? input.schemaVersion ?? COORDINATION_SCHEMA_VERSION,
      type: input.type,
      workflow_id: workflowId,
      ...(input.task_id ?? input.taskId ? { task_id: input.task_id ?? input.taskId } : {}),
      ...(input.source_agent ?? input.sourceAgent ? { source_agent: input.source_agent ?? input.sourceAgent } : {}),
      ...(input.target_agent ?? input.targetAgent ? { target_agent: input.target_agent ?? input.targetAgent } : {}),
      correlation_id: input.correlation_id ?? input.correlationId ?? eventId,
      ...(input.causation_id ?? input.causationId ? { causation_id: input.causation_id ?? input.causationId } : {}),
      timestamp: input.timestamp ?? new Date(this.now()).toISOString(),
      payload: (input.payload !== undefined ? input.payload : {}) as TPayload,
      artifact_refs: [...(input.artifact_refs ?? input.artifactRefs ?? [])],
      ...(input.fencing_token !== undefined || input.fencingToken !== undefined
        ? { fencing_token: input.fencing_token ?? input.fencingToken }
        : {}),
      ...(input.idempotency_key ?? input.idempotencyKey
        ? { idempotency_key: input.idempotency_key ?? input.idempotencyKey }
        : {}),
      ...(input.delegation_depth !== undefined || input.delegationDepth !== undefined
        ? { delegation_depth: input.delegation_depth ?? input.delegationDepth }
        : {}),
      ...(input.causation_chain ?? input.causationChain
        ? { causation_chain: [...(input.causation_chain ?? input.causationChain ?? [])] }
        : {}),
      ...(input.untrusted_peer_input !== undefined || input.untrustedPeerInput !== undefined
        ? { untrusted_peer_input: input.untrusted_peer_input ?? input.untrustedPeerInput }
        : {}),
    };

    const validation = validateCoordinationEnvelope(envelope);
    if (!validation.valid) {
      throw new Error(`Invalid coordination event envelope: ${validation.errors.join('; ')}`);
    }
    return envelope;
  }

  /**
   * Synchronous zero-I/O in-memory dispatch (`p95 < 1ms`).
   */
  publishInProcess<TPayload = Record<string, unknown>>(
    input: CoordinationPublishInput<TPayload>,
  ): CoordinationEventEnvelope<TPayload> {
    const t0 = performance.now();
    const envelope = this.buildEnvelope(input);
    if (this.seenEventIds.has(envelope.event_id)) {
      return envelope;
    }
    this.markSeen(envelope.event_id);
    this.trackInMemoryEvent(envelope as CoordinationEventEnvelope);
    this.trackLeaseFromEvent(envelope as CoordinationEventEnvelope);
    this.totalEventsPublished += 1;
    this.dispatchLocal(envelope as CoordinationEventEnvelope);
    this.recordLatency(performance.now() - t0);
    return envelope;
  }

  async publish<TPayload = Record<string, unknown>>(
    input: CoordinationPublishInput<TPayload>,
    opts?: { durable?: boolean },
  ): Promise<CoordinationEventEnvelope<TPayload>> {
    const t0 = performance.now();
    const envelope = this.buildEnvelope(input);
    if (this.seenEventIds.has(envelope.event_id)) {
      return envelope;
    }
    this.markSeen(envelope.event_id);

    const durable = opts?.durable !== false;
    const rawPayload = JSON.stringify(envelope.payload);
    const payloadByteLength = Buffer.byteLength(rawPayload, 'utf8');

    let finalEnvelope: CoordinationEventEnvelope<unknown> = envelope as CoordinationEventEnvelope<unknown>;

    if (payloadByteLength > this.maxInlinePayloadBytes) {
      const ref = await this.offloadPayload(envelope.workflow_id, envelope.task_id, envelope.event_id, envelope.payload);
      finalEnvelope = {
        ...envelope,
        payload: { offloaded: true, byteLength: payloadByteLength },
        artifact_refs: envelope.artifact_refs.includes(ref) ? envelope.artifact_refs : [...envelope.artifact_refs, ref],
      };
    }

    this.trackInMemoryEvent(finalEnvelope as CoordinationEventEnvelope);
    this.trackLeaseFromEvent(finalEnvelope as CoordinationEventEnvelope);

    const hasBroker = this.hasRemoteBroker();
    const nowMs = this.now();
    const outboxEntry: OutboxEntry = {
      id: finalEnvelope.event_id,
      envelope: finalEnvelope as CoordinationEventEnvelope,
      status: hasBroker ? 'pending' : 'delivered',
      attempts: hasBroker ? 0 : 1,
      nextAttemptAt: nowMs,
      createdAt: nowMs,
      updatedAt: nowMs,
    };

    if (durable) {
      if (this.eventsDir && this.outboxDir) {
        await Promise.all([this.ensureDir(this.eventsDir), this.ensureDir(this.outboxDir)]);
        const seqPart = `${String(nowMs).padStart(15, '0')}-${String(process.pid).padStart(7, '0')}-${String(++this.localSeq).padStart(8, '0')}`;
        const eventFile = `${seqPart}-${safeSegment(finalEnvelope.event_id)}.json`;
        const eventPath = path.join(this.eventsDir, eventFile);
        const outboxPath = path.join(this.outboxDir, `${safeSegment(finalEnvelope.event_id)}.json`);
        this.observedFiles.add(eventFile);
        await Promise.all([
          writeFileAtomic(eventPath, JSON.stringify(finalEnvelope)),
          writeFileAtomic(outboxPath, JSON.stringify(outboxEntry)),
        ]);
      } else if (this.store) {
        const seqPart = `${String(nowMs).padStart(15, '0')}-${String(++this.localSeq).padStart(8, '0')}`;
        await Promise.all([
          this.store.put(`coord/events/${seqPart}-${finalEnvelope.event_id}`, finalEnvelope),
          this.store.put(`coord/outbox/${finalEnvelope.event_id}`, outboxEntry),
        ]);
      }
    }

    if (!this.fabricDir && !this.store) {
      this.inMemoryOutbox.set(outboxEntry.id, outboxEntry);
    }

    this.totalEventsPublished += 1;
    this.dispatchLocal(finalEnvelope as CoordinationEventEnvelope);

    if (hasBroker && !this.closed) {
      this.enqueueOutbox(outboxEntry);
      this.scheduleFlush(0);
    }

    this.recordLatency(performance.now() - t0);
    return finalEnvelope as CoordinationEventEnvelope<TPayload>;
  }

  private async offloadPayload(workflowId: string, taskId: string | undefined, eventId: string, data: unknown): Promise<string> {
    if (this.artifactStore) {
      return this.artifactStore.storeArtifact({ workflowId, taskId, eventId, data });
    }
    if (this.artifactsDir) {
      const wfDir = path.join(this.artifactsDir, safeSegment(workflowId));
      await this.ensureDir(wfDir);
      const target = path.join(wfDir, `${safeSegment(eventId)}.json`);
      await writeFileAtomic(target, JSON.stringify(data));
      return target;
    }
    if (this.store) {
      const key = `coord/artifacts/${safeSegment(workflowId)}/${safeSegment(eventId)}`;
      await this.store.put(key, data);
      return `store:${key}`;
    }
    const memRef = `memory://artifacts/${safeSegment(workflowId)}/${safeSegment(eventId)}`;
    this.inMemoryArtifacts.set(memRef, data);
    return memRef;
  }

  async loadArtifact(ref: string): Promise<unknown> {
    if (this.artifactStore) {
      return this.artifactStore.loadArtifact(ref);
    }
    if (ref.startsWith('memory://')) {
      return this.inMemoryArtifacts.get(ref);
    }
    if (ref.startsWith('store:') && this.store) {
      return this.store.get(ref.slice('store:'.length));
    }
    if (this.fabricDir) {
      const cleanRef = ref.startsWith('artifact://') ? path.join('artifacts', ref.slice('artifact://'.length)) : ref;
      const resolved = path.isAbsolute(cleanRef) ? path.resolve(cleanRef) : path.resolve(this.fabricDir, cleanRef);
      if (!isInsideDir(this.fabricDir, resolved)) {
        throw new Error(`Artifact reference '${ref}' escapes fabric directory`);
      }
      const raw = await fs.readFile(resolved, 'utf8');
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    if (this.inMemoryArtifacts.has(ref)) {
      return this.inMemoryArtifacts.get(ref);
    }
    throw new Error(`Cannot load artifact '${ref}': no artifact store or fabricDir configured`);
  }

  private trackInMemoryEvent(envelope: CoordinationEventEnvelope): void {
    this.inMemoryEvents.push(envelope);
    if (this.inMemoryEvents.length > MAX_IN_MEMORY_EVENTS) {
      this.inMemoryEvents.shift();
    }
  }

  private trackLeaseFromEvent(envelope: CoordinationEventEnvelope): void {
    const payload = envelope.payload as Record<string, unknown> | undefined;
    const leaseId = typeof payload?.leaseId === 'string' ? payload.leaseId : envelope.task_id ?? envelope.event_id;
    if (envelope.type === 'resource.acquired') {
      this.trackedLeases.add(leaseId);
    } else if (envelope.type === 'resource.released' || envelope.type === 'resource.expired') {
      this.trackedLeases.delete(leaseId);
    }
  }

  private enqueueOutbox(entry: OutboxEntry): void {
    if (this.pendingQueue.length >= this.maxQueueSize) {
      // Durable outbox entries remain on disk and are scanned during flush.
      return;
    }
    if (!this.pendingQueue.some((e) => e.id === entry.id)) {
      this.pendingQueue.push(entry);
    }
  }

  private getOrCreateTransport(): CoordinationTransportAdapter | undefined {
    if (this.transport) {
      this.attachTransportSubscriber();
      return this.transport;
    }
    if (!this.natsUrl) return undefined;
    this.transport = new NatsWireTransport({
      url: this.natsUrl,
      subjectPrefix: this.natsSubjectPrefix,
      connectTimeoutMs: this.connectTimeoutMs,
    });
    this.attachTransportSubscriber();
    return this.transport;
  }

  private attachTransportSubscriber(): void {
    if (this.transportInitialized || !this.transport) return;
    this.transportInitialized = true;
    const maybeUnsub = this.transport.subscribe((event) => {
      if (this.seenEventIds.has(event.event_id)) return;
      this.markSeen(event.event_id);
      this.trackInMemoryEvent(event);
      this.dispatchLocal(event);
    });
    if (typeof maybeUnsub === 'function') {
      this.transportUnsub = maybeUnsub;
    } else if (maybeUnsub && typeof maybeUnsub.then === 'function') {
      void maybeUnsub.then((fn) => {
        if (this.closed) fn();
        else this.transportUnsub = fn;
      }).catch(() => undefined);
    }
  }

  private currentCircuitState(): CircuitBreakerState {
    if (this.circuitState === 'open' && this.now() - this.circuitOpenedAt >= this.circuitCooldownMs) {
      return 'half-open';
    }
    return this.circuitState;
  }

  private scheduleFlush(delayMs: number): void {
    if (this.closed || !this.hasRemoteBroker()) return;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch(() => undefined);
    }, Math.max(0, delayMs));
    this.flushTimer.unref();
  }

  private computeRetryDelay(attempts: number): number {
    const exp = Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * Math.pow(2, Math.max(0, attempts - 1)));
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exp * 0.25)));
    return exp + jitter;
  }

  async flush(timeoutMs = 5000): Promise<CoordinationFlushResult> {
    if (this.flushingPromise) {
      return this.flushingPromise;
    }
    const run = this.performFlush(timeoutMs).finally(() => {
      if (this.flushingPromise === run) {
        this.flushingPromise = undefined;
      }
    });
    this.flushingPromise = run;
    return run;
  }

  private async performFlush(timeoutMs: number): Promise<CoordinationFlushResult> {
    const transport = this.getOrCreateTransport();
    if (!transport) {
      return { flushed: 0, failed: 0, remaining: 0 };
    }

    const deadline = this.now() + Math.max(1, timeoutMs);
    let flushed = 0;
    let failed = 0;

    // Collect pending items from memory queue + disk/store outbox.
    const candidates = await this.collectFlushCandidates();
    if (candidates.length === 0) {
      return { flushed: 0, failed: 0, remaining: 0 };
    }

    const effectiveCircuit = this.currentCircuitState();
    if (effectiveCircuit === 'open') {
      const waitMs = Math.max(1, this.circuitOpenedAt + this.circuitCooldownMs - this.now());
      this.scheduleFlush(waitMs);
      return { flushed: 0, failed: 0, remaining: candidates.length };
    }
    if (effectiveCircuit === 'half-open') {
      this.circuitState = 'half-open';
    }

    // Attempt batches up to deadline, one pass per candidate.
    let offset = 0;
    while (offset < candidates.length && this.now() < deadline && !this.closed) {
      const stateNow = this.currentCircuitState();
      if (stateNow === 'open') {
        break;
      }

      const batchLimit = stateNow === 'half-open' ? 1 : this.batchSize;
      const batch = candidates.slice(offset, offset + batchLimit);
      offset += batch.length;

      try {
        if (!transport.isConnected()) {
          const remainingBudget = Math.max(1, Math.min(this.connectTimeoutMs, deadline - this.now()));
          await transport.connect(remainingBudget);
        }
        await transport.publishBatch(batch.map((entry) => entry.envelope));

        // Delivery succeeded -> close circuit & mark outbox delivered.
        this.circuitState = 'closed';
        this.consecutiveFailures = 0;
        const deliveredAt = this.now();
        for (const entry of batch) {
          entry.status = 'delivered';
          entry.attempts += 1;
          entry.updatedAt = deliveredAt;
          entry.lastError = undefined;
          await this.persistOutboxEntry(entry);
          this.removeFromPendingQueue(entry.id);
          flushed += 1;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.consecutiveFailures += 1;
        if (this.circuitState === 'half-open' || this.consecutiveFailures >= this.circuitFailureThreshold) {
          this.circuitState = 'open';
          this.circuitOpenedAt = this.now();
        }

        const failedAt = this.now();
        for (const entry of batch) {
          entry.attempts += 1;
          entry.lastError = message;
          entry.updatedAt = failedAt;
          if (entry.attempts >= this.maxRetries) {
            await this.moveOutboxToDlq(entry, message);
          } else {
            entry.status = 'failed';
            entry.nextAttemptAt = failedAt + this.computeRetryDelay(entry.attempts);
            await this.persistOutboxEntry(entry);
            this.enqueueOutbox(entry);
          }
          failed += 1;
        }

        if (this.circuitState === 'open') {
          break;
        }
      }
    }

    const remainingEntries = await this.listOutbox();
    const stillPending = remainingEntries.filter((e) => e.status === 'pending' || e.status === 'failed');
    if (stillPending.length > 0 && !this.closed) {
      if (this.currentCircuitState() === 'open') {
        const waitMs = Math.max(1, this.circuitOpenedAt + this.circuitCooldownMs - this.now());
        this.scheduleFlush(waitMs);
      } else {
        const nextDue = Math.min(...stillPending.map((e) => e.nextAttemptAt));
        this.scheduleFlush(Math.max(1, nextDue - this.now()));
      }
    }

    return { flushed, failed, remaining: stillPending.length };
  }

  private async collectFlushCandidates(): Promise<OutboxEntry[]> {
    const byId = new Map<string, OutboxEntry>();
    for (const entry of this.pendingQueue) {
      if (entry.status === 'pending' || entry.status === 'failed') {
        byId.set(entry.id, entry);
      }
    }
    const diskEntries = await this.listOutbox();
    for (const entry of diskEntries) {
      if ((entry.status === 'pending' || entry.status === 'failed') && !byId.has(entry.id)) {
        byId.set(entry.id, entry);
      }
    }
    return Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  private removeFromPendingQueue(id: string): void {
    const idx = this.pendingQueue.findIndex((e) => e.id === id);
    if (idx !== -1) this.pendingQueue.splice(idx, 1);
  }

  private async persistOutboxEntry(entry: OutboxEntry): Promise<void> {
    if (this.outboxDir) {
      await this.ensureDir(this.outboxDir);
      const outboxPath = path.join(this.outboxDir, `${safeSegment(entry.id)}.json`);
      await writeFileAtomic(outboxPath, JSON.stringify(entry));
    } else if (this.store) {
      await this.store.put(`coord/outbox/${entry.id}`, entry);
    } else {
      this.inMemoryOutbox.set(entry.id, entry);
    }
  }

  private async moveOutboxToDlq(entry: OutboxEntry, reason: string): Promise<void> {
    const dlqEntry: OutboxEntry = {
      ...entry,
      status: 'dead_letter',
      lastError: reason,
      updatedAt: this.now(),
    };
    this.removeFromPendingQueue(entry.id);
    await this.persistOutboxEntry(dlqEntry);
    await this.persistDlqEntry(dlqEntry);

    this.publishInProcess({
      type: 'fabric.dead_letter',
      workflow_id: entry.envelope.workflow_id,
      task_id: entry.envelope.task_id,
      source_agent: entry.envelope.source_agent,
      target_agent: entry.envelope.target_agent,
      correlation_id: entry.envelope.correlation_id,
      causation_id: entry.envelope.event_id,
      payload: {
        deadLetterId: dlqEntry.id,
        originalType: entry.envelope.type,
        attempts: dlqEntry.attempts,
        error: reason,
      },
    });
  }

  async recordDeadLetter(
    envelope: CoordinationEventEnvelope,
    reason: string,
    attempts = 1,
    deadLetterId = envelope.event_id,
  ): Promise<OutboxEntry> {
    const nowMs = this.now();
    const dlqEntry: OutboxEntry = {
      id: deadLetterId,
      envelope,
      status: 'dead_letter',
      attempts,
      nextAttemptAt: nowMs,
      lastError: reason,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    await this.persistDlqEntry(dlqEntry);
    return dlqEntry;
  }

  private async persistDlqEntry(entry: OutboxEntry): Promise<void> {
    if (this.dlqDir) {
      await this.ensureDir(this.dlqDir);
      const dlqPath = path.join(this.dlqDir, `${safeSegment(entry.id)}.json`);
      await writeFileAtomic(dlqPath, JSON.stringify(entry));
    } else if (this.store) {
      await this.store.put(`coord/dlq/${entry.id}`, entry);
    } else {
      this.inMemoryDlq.set(entry.id, entry);
    }
  }

  async listOutbox(status?: OutboxEntry['status']): Promise<OutboxEntry[]> {
    let entries: OutboxEntry[] = [];
    if (this.outboxDir) {
      entries = await this.readJsonDir<OutboxEntry>(this.outboxDir);
    } else if (this.store) {
      const rows = await this.store.list('coord/outbox/');
      entries = rows.map((r) => r.value as OutboxEntry);
    } else {
      entries = Array.from(this.inMemoryOutbox.values());
    }
    if (status) {
      entries = entries.filter((entry) => entry.status === status);
    }
    return entries.sort((a, b) => a.createdAt - b.createdAt);
  }

  async listDeadLetters(): Promise<OutboxEntry[]> {
    let entries: OutboxEntry[] = [];
    if (this.dlqDir) {
      entries = await this.readJsonDir<OutboxEntry>(this.dlqDir);
    } else if (this.store) {
      const rows = await this.store.list('coord/dlq/');
      entries = rows.map((r) => r.value as OutboxEntry);
    } else {
      entries = Array.from(this.inMemoryDlq.values());
    }
    return entries.sort((a, b) => a.createdAt - b.createdAt);
  }

  private async readJsonDir<T>(dir: string): Promise<T[]> {
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const jsonFiles = files.filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort();
    const results: T[] = [];
    for (const file of jsonFiles) {
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        results.push(JSON.parse(raw) as T);
      } catch {
        // Ignore transiently removed or malformed files
      }
    }
    return results;
  }

  subscribe(
    topicOrFilter: string | CoordinationEventFilter,
    handler: (event: CoordinationEventEnvelope) => void | Promise<void>,
  ): () => void {
    const filter = parseTopicOrFilter(topicOrFilter);
    const sub: InternalSubscription = {
      id: randomUUID(),
      filter,
      handler,
    };
    this.subscriptions.add(sub);
    return () => {
      this.subscriptions.delete(sub);
    };
  }

  private dispatchLocal(envelope: CoordinationEventEnvelope): void {
    if (this.subscriptions.size === 0) return;
    for (const sub of Array.from(this.subscriptions)) {
      if (!matchesEventFilter(envelope, sub.filter)) continue;
      try {
        const result = sub.handler(envelope);
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          (result as Promise<unknown>).catch(() => undefined);
        }
      } catch {
        // Isolate throwing subscriber
      }
    }
  }

  startCrossProcessWatcher(options: { replayExisting?: boolean } = {}): void {
    if (this.watcherRunning || this.closed || !this.eventsDir) return;
    this.ensureDirSync(this.eventsDir);
    if (!options.replayExisting) {
      try {
        const existing = fsSync.readdirSync(this.eventsDir);
        for (const name of existing) {
          if (name.endsWith('.json') && !name.startsWith('.')) {
            this.observedFiles.add(name);
          }
        }
      } catch {
        // Ignore if unreadable
      }
    }

    this.watcherRunning = true;

    try {
      this.fsWatcher = fsSync.watch(this.eventsDir, { persistent: false }, () => {
        void this.scanEventsDir();
      });
      this.fsWatcher.on('error', () => undefined);
    } catch {
      // Poll fallback remains active even if fs.watch is unavailable
    }

    this.pollTimer = setInterval(() => {
      void this.scanEventsDir();
    }, this.pollIntervalMs);
    this.pollTimer.unref();
  }

  stopCrossProcessWatcher(): void {
    this.watcherRunning = false;
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = undefined;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async scanEventsDir(): Promise<void> {
    if (!this.watcherRunning || !this.eventsDir) return;
    if (this.scanning) {
      this.scanPending = true;
      return;
    }
    this.scanning = true;
    try {
      do {
        this.scanPending = false;
        let files: string[];
        try {
          files = await fs.readdir(this.eventsDir);
        } catch {
          break;
        }
        const pendingFiles = files
          .filter((f) => f.endsWith('.json') && !f.startsWith('.') && !this.observedFiles.has(f))
          .sort();

        for (const file of pendingFiles) {
          if (!this.watcherRunning) break;
          this.observedFiles.add(file);
          try {
            const raw = await fs.readFile(path.join(this.eventsDir, file), 'utf8');
            const parsed = JSON.parse(raw) as unknown;
            const validation = validateCoordinationEnvelope(parsed);
            if (!validation.valid) continue;
            const envelope = parsed as CoordinationEventEnvelope;
            if (this.seenEventIds.has(envelope.event_id)) continue;
            this.markSeen(envelope.event_id);
            this.trackInMemoryEvent(envelope);
            this.trackLeaseFromEvent(envelope);
            this.dispatchLocal(envelope);
          } catch {
            // Skip transient or unreadable files
          }
        }
      } while (this.scanPending && this.watcherRunning);
    } finally {
      this.scanning = false;
    }
  }

  async registerConsumer(
    consumerId: string,
    options: { workflowId?: string; group?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<ConsumerInfo> {
    const nowMs = this.now();
    const existing = this.consumers.get(consumerId);
    const info: ConsumerInfo = {
      consumerId,
      workflowId: options.workflowId ?? existing?.workflowId,
      group: options.group ?? existing?.group,
      lastHeartbeatAt: nowMs,
      lastEventId: existing?.lastEventId,
      lastEventTimestamp: existing?.lastEventTimestamp,
      processedCount: existing?.processedCount ?? 0,
      registeredAt: existing?.registeredAt ?? nowMs,
      metadata: options.metadata ?? existing?.metadata,
    };
    this.consumers.set(consumerId, info);
    await this.persistConsumer(info);
    return structuredClone(info);
  }

  async heartbeatConsumer(
    consumerId: string,
    update: {
      lastEventId?: string;
      lastEventTimestamp?: number | string;
      processedCount?: number;
      processedDelta?: number;
    } = {},
  ): Promise<ConsumerInfo> {
    const nowMs = this.now();
    const current = this.consumers.get(consumerId) ?? (await this.loadConsumer(consumerId));
    const parsedTs =
      typeof update.lastEventTimestamp === 'string'
        ? Date.parse(update.lastEventTimestamp)
        : update.lastEventTimestamp;

    const info: ConsumerInfo = {
      consumerId,
      workflowId: current?.workflowId,
      group: current?.group,
      lastHeartbeatAt: nowMs,
      lastEventId: update.lastEventId ?? current?.lastEventId,
      lastEventTimestamp:
        parsedTs !== undefined && Number.isFinite(parsedTs) ? parsedTs : current?.lastEventTimestamp,
      processedCount:
        update.processedCount !== undefined
          ? update.processedCount
          : (current?.processedCount ?? 0) + (update.processedDelta ?? 0),
      registeredAt: current?.registeredAt ?? nowMs,
      metadata: current?.metadata,
    };
    this.consumers.set(consumerId, info);
    await this.persistConsumer(info);
    return structuredClone(info);
  }

  async detectStaleConsumers(timeoutMs = this.consumerTimeoutMs): Promise<string[]> {
    const all = await this.listConsumers();
    const cutoff = this.now() - timeoutMs;
    return all.filter((c) => c.lastHeartbeatAt < cutoff).map((c) => c.consumerId);
  }

  private async persistConsumer(info: ConsumerInfo): Promise<void> {
    if (this.consumersDir) {
      await this.ensureDir(this.consumersDir);
      await writeFileAtomic(path.join(this.consumersDir, `${safeSegment(info.consumerId)}.json`), JSON.stringify(info));
    } else if (this.store) {
      await this.store.put(`coord/consumers/${info.consumerId}`, info);
    }
  }

  private async loadConsumer(consumerId: string): Promise<ConsumerInfo | undefined> {
    if (this.consumersDir) {
      try {
        const raw = await fs.readFile(path.join(this.consumersDir, `${safeSegment(consumerId)}.json`), 'utf8');
        return JSON.parse(raw) as ConsumerInfo;
      } catch {
        return undefined;
      }
    }
    if (this.store) {
      return this.store.get<ConsumerInfo>(`coord/consumers/${consumerId}`);
    }
    return undefined;
  }

  private async listConsumers(): Promise<ConsumerInfo[]> {
    const byId = new Map<string, ConsumerInfo>(this.consumers);
    if (this.consumersDir) {
      const disk = await this.readJsonDir<ConsumerInfo>(this.consumersDir);
      for (const c of disk) {
        const existing = byId.get(c.consumerId);
        if (!existing || c.lastHeartbeatAt > existing.lastHeartbeatAt) {
          byId.set(c.consumerId, c);
        }
      }
    } else if (this.store) {
      const rows = await this.store.list('coord/consumers/');
      for (const row of rows) {
        const c = row.value as ConsumerInfo;
        const existing = byId.get(c.consumerId);
        if (!existing || c.lastHeartbeatAt > existing.lastHeartbeatAt) {
          byId.set(c.consumerId, c);
        }
      }
    }
    return Array.from(byId.values());
  }

  async replayEvents(filter?: CoordinationEventFilter | string): Promise<CoordinationEventEnvelope[]> {
    const parsedFilter = filter ? parseTopicOrFilter(filter) : {};
    let events: CoordinationEventEnvelope[];

    if (this.eventsDir) {
      const rawEvents = await this.readJsonDir<unknown>(this.eventsDir);
      events = rawEvents.filter((item): item is CoordinationEventEnvelope => validateCoordinationEnvelope(item).valid);
    } else if (this.store) {
      const rows = await this.store.list('coord/events/');
      rows.sort((a, b) => a.key.localeCompare(b.key));
      events = rows
        .map((r) => r.value)
        .filter((item): item is CoordinationEventEnvelope => validateCoordinationEnvelope(item).valid);
    } else {
      events = [...this.inMemoryEvents];
    }

    const filtered = events.filter((event) => matchesEventFilter(event, parsedFilter));
    if (parsedFilter.limit !== undefined && parsedFilter.limit >= 0) {
      return filtered.slice(0, parsedFilter.limit);
    }
    return filtered;
  }

  private async estimateConsumerLag(consumers: ConsumerInfo[]): Promise<number> {
    if (consumers.length === 0) return 0;

    let events: CoordinationEventEnvelope[];
    if (this.eventsDir) {
      const rawEvents = await this.readJsonDir<unknown>(this.eventsDir);
      events = rawEvents.filter((item): item is CoordinationEventEnvelope => validateCoordinationEnvelope(item).valid);
    } else if (this.store) {
      const rows = await this.store.list('coord/events/');
      rows.sort((a, b) => a.key.localeCompare(b.key));
      events = rows
        .map((r) => r.value)
        .filter((item): item is CoordinationEventEnvelope => validateCoordinationEnvelope(item).valid);
    } else {
      events = this.inMemoryEvents;
    }

    let maxLag = 0;
    for (const consumer of consumers) {
      const scopedEvents = consumer.workflowId
        ? events.filter((e) => e.workflow_id === consumer.workflowId)
        : events;

      let lag = 0;
      if (consumer.lastEventId) {
        const idx = scopedEvents.findIndex((e) => e.event_id === consumer.lastEventId);
        if (idx !== -1) {
          lag = scopedEvents.length - 1 - idx;
        } else {
          lag = Math.max(0, scopedEvents.length - consumer.processedCount);
        }
      } else if (consumer.lastEventTimestamp !== undefined) {
        lag = scopedEvents.filter((e) => Date.parse(e.timestamp) > consumer.lastEventTimestamp!).length;
      } else {
        const totalKnown = consumer.workflowId ? scopedEvents.length : Math.max(scopedEvents.length, this.totalEventsPublished);
        lag = Math.max(0, totalKnown - consumer.processedCount);
      }

      if (lag > maxLag) maxLag = lag;
    }
    return maxLag;
  }

  private async countDiskInboxPending(): Promise<number> {
    if (this.getInboxPendingCount) {
      return this.getInboxPendingCount();
    }
    if (!this.inboxesDir) return 0;
    let agentDirs: string[];
    try {
      agentDirs = await fs.readdir(this.inboxesDir);
    } catch {
      return 0;
    }
    let count = 0;
    for (const dir of agentDirs) {
      if (dir.startsWith('_') || dir.startsWith('.')) continue;
      const inboxFile = path.join(this.inboxesDir, dir, 'inbox.json');
      try {
        const raw = await fs.readFile(inboxFile, 'utf8');
        const messages = JSON.parse(raw) as InboxMessage[];
        if (Array.isArray(messages)) {
          count += messages.filter((m) => m.status === 'queued' || m.status === 'delivered').length;
        }
      } catch {
        // Ignore missing/non-dir entries
      }
    }
    return count;
  }

  private async countActiveLeases(): Promise<number> {
    if (this.getActiveLeaseCount) {
      return this.getActiveLeaseCount();
    }
    if (this.leasesDir) {
      const leases = await this.readJsonDir<ResourceLease>(this.leasesDir);
      if (leases.length > 0) {
        const nowMs = this.now();
        return leases.filter((l) => l.status === 'active' && l.expiresAt > nowMs).length;
      }
    }
    return this.trackedLeases.size;
  }

  async getStatus(): Promise<FabricStatusReport> {
    const [outboxEntries, dlqEntries, consumers, inboxPending, activeLeases] = await Promise.all([
      this.listOutbox(),
      this.listDeadLetters(),
      this.listConsumers(),
      this.countDiskInboxPending(),
      this.countActiveLeases(),
    ]);

    const cutoff = this.now() - this.consumerTimeoutMs;
    const staleConsumers = consumers.filter((c) => c.lastHeartbeatAt < cutoff).map((c) => c.consumerId);
    const consumerLag = await this.estimateConsumerLag(consumers);

    const outboxPending = outboxEntries.filter((e) => e.status === 'pending' || e.status === 'failed').length;
    const outboxDeadLetters = outboxEntries.filter((e) => e.status === 'dead_letter').length;
    const circuitState = this.currentCircuitState();

    // Adapters are typed, but third-party/older adapters may still report the removed
    // 'nats-jetstream' kind at runtime; normalize it to the implemented 'nats-core'.
    const transportKind: CoordinationTransportKind =
      normalizeCoordinationTransportKind(this.transport?.kind) ??
      (this.natsUrl ? 'nats-core' : this.fabricDir || this.store ? 'durable-local' : 'in-process');

    const { p50, p95 } = computePercentiles(this.latencySamples);
    let totalPublished = this.totalEventsPublished;
    if (this.eventsDir) {
      try {
        const files = await fs.readdir(this.eventsDir);
        const diskCount = files.filter((f) => f.endsWith('.json') && !f.startsWith('.')).length;
        if (diskCount > totalPublished) totalPublished = diskCount;
      } catch {
        // Ignore missing dir
      }
    }

    return {
      healthy: !this.closed && circuitState !== 'open',
      transport: transportKind,
      natsConfigured: Boolean(this.natsUrl || transportKind === 'nats-core'),
      natsConnected: this.transport?.isConnected() ?? false,
      circuitState,
      outboxPending,
      outboxDeadLetters,
      inboxPending,
      dlqCount: dlqEntries.length,
      activeSubscriptions: this.subscriptions.size,
      staleConsumers,
      consumerLag,
      activeLeases,
      totalEventsPublished: totalPublished,
      metrics: {
        ...(p50 !== undefined ? { publishLatencyMsP50: p50 } : {}),
        ...(p95 !== undefined ? { publishLatencyMsP95: p95 } : {}),
      },
    };
  }

  async diagnose(): Promise<FabricDiagnosticsReport> {
    const checks: FabricDiagnosticsReport['checks'] = [];

    if (this.fabricDir) {
      const t0 = performance.now();
      try {
        await this.ensureDir(this.fabricDir);
        const probePath = path.join(this.fabricDir, `.diag-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
        await fs.writeFile(probePath, 'ok', 'utf8');
        await fs.unlink(probePath);
        checks.push({
          name: 'fabric-dir-writable',
          ok: true,
          detail: `Writable fabric directory at ${this.fabricDir}`,
          durationMs: Number((performance.now() - t0).toFixed(3)),
        });
      } catch (err) {
        checks.push({
          name: 'fabric-dir-writable',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
          durationMs: Number((performance.now() - t0).toFixed(3)),
        });
      }
    } else {
      checks.push({
        name: 'fabric-dir-writable',
        ok: true,
        detail: this.store ? 'Using KeyValueStore persistence' : 'Running in in-process mode (no fabricDir)',
        durationMs: 0,
      });
    }

    const tCircuit = performance.now();
    const circuit = this.currentCircuitState();
    checks.push({
      name: 'circuit-breaker',
      ok: circuit !== 'open',
      detail: `Circuit breaker state is '${circuit}'`,
      durationMs: Number((performance.now() - tCircuit).toFixed(3)),
    });

    if (this.natsUrl || this.transport) {
      const tNats = performance.now();
      const transport = this.getOrCreateTransport();
      if (transport && !transport.isConnected() && circuit !== 'open') {
        try {
          await transport.connect(this.connectTimeoutMs);
        } catch {
          // Recorded below as disconnected
        }
      }
      const connected = transport?.isConnected() ?? false;
      checks.push({
        name: 'broker-connectivity',
        ok: connected,
        detail: connected ? `Connected to ${transport?.kind ?? 'broker'}` : `Disconnected from ${transport?.kind ?? 'broker'}`,
        durationMs: Number((performance.now() - tNats).toFixed(3)),
      });
    }

    const status = await this.getStatus();

    const tDlq = performance.now();
    checks.push({
      name: 'dead-letter-queue',
      ok: status.dlqCount === 0,
      detail: status.dlqCount === 0 ? 'No dead-letter entries' : `${status.dlqCount} dead-letter entries present`,
      durationMs: Number((performance.now() - tDlq).toFixed(3)),
    });

    const tConsumers = performance.now();
    checks.push({
      name: 'consumer-liveness',
      ok: status.staleConsumers.length === 0,
      detail:
        status.staleConsumers.length === 0
          ? 'No stale consumers detected'
          : `Stale consumers: ${status.staleConsumers.join(', ')}`,
      durationMs: Number((performance.now() - tConsumers).toFixed(3)),
    });

    return {
      ok: checks.every((c) => c.ok),
      checkedAt: new Date(this.now()).toISOString(),
      ...(this.fabricDir ? { fabricDir: this.fabricDir } : {}),
      checks,
      status,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopCrossProcessWatcher();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.transportUnsub) {
      this.transportUnsub();
      this.transportUnsub = undefined;
    }
    this.subscriptions.clear();
    if (this.transport) {
      await this.transport.close().catch(() => undefined);
    }
  }
}

export function createCoordinationFabric(options: CoordinationFabricOptions = {}): CoordinationFabric {
  return new CoordinationFabric(options);
}

function parseTopicOrFilter(topicOrFilter: string | CoordinationEventFilter): CoordinationEventFilter {
  if (typeof topicOrFilter !== 'string') {
    return topicOrFilter;
  }
  const trimmed = topicOrFilter.trim();
  if (trimmed === '*' || trimmed === '') {
    return {};
  }
  if (trimmed.startsWith('workflow:')) {
    return { workflowId: trimmed.slice('workflow:'.length) };
  }
  if (trimmed.startsWith('task:')) {
    return { taskId: trimmed.slice('task:'.length) };
  }
  if (trimmed.startsWith('agent:')) {
    return { agentId: trimmed.slice('agent:'.length) };
  }
  if (trimmed.startsWith('type:')) {
    return { type: trimmed.slice('type:'.length) as CoordinationEventType };
  }
  if (trimmed.startsWith('correlation:')) {
    return { correlationId: trimmed.slice('correlation:'.length) };
  }
  return { type: trimmed as CoordinationEventType };
}

function matchesEventFilter(event: CoordinationEventEnvelope, filter: CoordinationEventFilter): boolean {
  if (filter.workflowId !== undefined && event.workflow_id !== filter.workflowId) return false;
  if (filter.taskId !== undefined && event.task_id !== filter.taskId) return false;
  if (filter.correlationId !== undefined && event.correlation_id !== filter.correlationId) return false;
  if (filter.sourceAgent !== undefined && event.source_agent !== filter.sourceAgent) return false;
  if (filter.targetAgent !== undefined && event.target_agent !== filter.targetAgent) return false;

  if (filter.agentId !== undefined) {
    if (event.target_agent !== undefined) {
      if (event.target_agent !== filter.agentId) return false;
    } else if (event.source_agent !== filter.agentId) {
      return false;
    }
  }

  if (filter.type !== undefined) {
    if (Array.isArray(filter.type)) {
      if (!filter.type.includes(event.type)) return false;
    } else if (filter.type.endsWith('.*')) {
      const prefix = filter.type.slice(0, -1);
      if (!event.type.startsWith(prefix)) return false;
    } else if (event.type !== filter.type) {
      return false;
    }
  }

  if (filter.since !== undefined) {
    const sinceMs = typeof filter.since === 'number' ? filter.since : Date.parse(filter.since);
    if (Number.isFinite(sinceMs) && Date.parse(event.timestamp) < sinceMs) return false;
  }

  if (filter.until !== undefined) {
    const untilMs = typeof filter.until === 'number' ? filter.until : Date.parse(filter.until);
    if (Number.isFinite(untilMs) && Date.parse(event.timestamp) > untilMs) return false;
  }

  return true;
}
