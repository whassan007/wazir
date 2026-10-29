import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { KeyValueStore } from '@wazir/shared';
import type { ExecutionCheckpoint } from '../types/index.js';
import type { CheckpointService } from './checkpointService.js';
import type { ExecutionEngine } from './executionEngine.js';

export const DEFAULT_MAX_CHECKPOINT_BYTES = 50 * 1024 * 1024; // 50 MB
export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
export const DEFAULT_MAX_STORED_CHECKPOINTS = 100;
export const DEFAULT_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type SecretScrubPolicy = 'redact' | 'reject';

export interface CheckpointEnvelope {
  id: string;
  executionId: string;
  parentCheckpointId?: string;
  createdAt: string;
  workspaceRevision: number;
  workspaceRoot: string;
  worktreeState: {
    branch?: string;
    commitSha?: string;
    isGit: boolean;
    treeSha?: string;
  };
  contextSnapshot?: ExecutionCheckpoint['contextSnapshot'];
  planState?: ExecutionCheckpoint['planState'];
  verificationState: ExecutionCheckpoint['verificationState'];
  provenanceCursor?: number;
  evidenceReferences?: ExecutionCheckpoint['evidenceReferences'];
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface CheckpointTransferManifest {
  checkpointId: string;
  executionId: string;
  workspaceRevision: number;
  sourceWorkerId: string;
  targetWorkerId?: string;
  snapshotDigest: string;
  /** Mapping of workspace-relative file path -> SHA-256 content hash */
  blobHashes: Record<string, string>;
  totalBytes: number;
  createdAt: string;
  expiresAt: string;
  /** HMAC-SHA256 hex signature over canonical manifest fields when cluster/transport secret is used */
  authSignature?: string;
  checkpointEnvelope: CheckpointEnvelope;
  redactedSecretsCount?: number;
}

export interface CheckpointTransferReceipt {
  receiptId: string;
  checkpointId: string;
  executionId: string;
  workspaceRevision: number;
  sourceWorkerId: string;
  targetWorkerId?: string;
  snapshotDigest: string;
  totalBytes: number;
  blobCount: number;
  deduplicatedBlobCount: number;
  redactedSecretsCount: number;
  committedAt: string;
  downloadedByWorkerId?: string;
  downloadedAt?: string;
  restoredByWorkerId?: string;
  restoredAt?: string;
}

export interface CheckpointTransferBundle {
  manifest: CheckpointTransferManifest;
  /** Content-addressed map of blobHash (sha256) -> utf8 file content */
  blobs: Record<string, string>;
  receipt: CheckpointTransferReceipt;
}

export interface CheckpointPackageOptions {
  sourceWorkerId: string;
  targetWorkerId?: string;
  ttlMs?: number;
  secretPolicy?: SecretScrubPolicy;
  transportSecret?: string;
}

export interface CheckpointPackageResult {
  manifest: CheckpointTransferManifest;
  blobs: Record<string, string>;
  scrubbedCheckpoint: ExecutionCheckpoint;
  redactedSecretsCount: number;
  secretFindings: string[];
}

export interface CheckpointTransportServiceOptions {
  store?: KeyValueStore;
  executionEngine?: ExecutionEngine;
  /** Shared HMAC / Bearer secret for authenticating transfers across workers */
  transportSecret?: string;
  /** Optional additional valid bearer tokens or verifier callback */
  allowedBearerTokens?: string[] | ((token: string) => boolean);
  /** If true, unauthenticated transfer operations are rejected even if transportSecret is unset */
  requireAuth?: boolean;
  /** How embedded credentials/secrets in metadata/descriptions/env snapshots are handled */
  secretPolicy?: SecretScrubPolicy;
  /** Maximum total bytes across all files in a checkpoint (default 50 MB) */
  maxCheckpointBytes?: number;
  /** Maximum bytes for any single file blob (default 10 MB) */
  maxFileBytes?: number;
  /** Maximum number of committed checkpoints retained before LRU/FIFO eviction (default 100) */
  maxStoredCheckpoints?: number;
  /** Default manifest/checkpoint TTL in milliseconds (default 24 hours) */
  defaultTtlMs?: number;
  /** Clock source for deterministic testing */
  now?: () => number;
}

interface StoredManifestEntry {
  manifest: CheckpointTransferManifest;
  committed: boolean;
  deduplicatedBlobCount: number;
  registeredAtMs: number;
  committedAtMs?: number;
  receipt?: CheckpointTransferReceipt;
}

const SECRET_KEY_PATTERN =
  /(?:^|[_.-])(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?key|auth[_-]?token|bearer|credentials?)(?:$|[_.-])/i;

const INLINE_SECRET_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  {
    name: 'private_key_block',
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  {
    name: 'bearer_token',
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
    replacement: 'Bearer [REDACTED]',
  },
  {
    name: 'env_secret_assignment',
    regex: /\b([A-Za-z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)[A-Za-z0-9_]*)\s*([:=])\s*(['"]?)([^\s'",;]+)\3/gi,
    replacement: '$1$2$3[REDACTED]$3',
  },
  {
    name: 'provider_api_key',
    regex: /\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|nvapi-[A-Za-z0-9_-]{12,})\b/g,
    replacement: '[REDACTED]',
  },
];

export function computeBlobHash(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

export function computeSnapshotDigest(
  filesSnapshot: Record<string, string>,
  workspaceRevision: number,
): string {
  const hash = createHash('sha256');
  const sortedEntries = Object.entries(filesSnapshot ?? {}).sort(([a], [b]) => a.localeCompare(b));
  for (const [filePath, content] of sortedEntries) {
    hash.update(JSON.stringify([filePath, content]));
  }
  hash.update(`rev:${workspaceRevision}\n`);
  return hash.digest('hex');
}

export function validateSafeCheckpointPath(relative: string): void {
  const parts = relative.split('/');
  if (
    !relative ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    path.posix.isAbsolute(relative) ||
    path.win32.isAbsolute(relative) ||
    parts.some((p) => !p || p === '.' || p === '..' || ['.git', '.wazir', 'node_modules'].includes(p))
  ) {
    throw new Error(`UNSAFE_CHECKPOINT_PATH: ${relative}`);
  }
}

export function canonicalManifestPayload(
  manifest: Pick<
    CheckpointTransferManifest,
    | 'checkpointId'
    | 'executionId'
    | 'workspaceRevision'
    | 'sourceWorkerId'
    | 'targetWorkerId'
    | 'snapshotDigest'
    | 'blobHashes'
    | 'totalBytes'
    | 'createdAt'
    | 'expiresAt'
  >,
): string {
  const sortedBlobs = Object.entries(manifest.blobHashes ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    checkpointId: manifest.checkpointId,
    executionId: manifest.executionId,
    workspaceRevision: manifest.workspaceRevision,
    sourceWorkerId: manifest.sourceWorkerId,
    targetWorkerId: manifest.targetWorkerId ?? null,
    snapshotDigest: manifest.snapshotDigest,
    blobHashes: sortedBlobs,
    totalBytes: manifest.totalBytes,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
  });
}

export function signCheckpointManifest(
  manifest: Pick<
    CheckpointTransferManifest,
    | 'checkpointId'
    | 'executionId'
    | 'workspaceRevision'
    | 'sourceWorkerId'
    | 'targetWorkerId'
    | 'snapshotDigest'
    | 'blobHashes'
    | 'totalBytes'
    | 'createdAt'
    | 'expiresAt'
  >,
  secret: string,
): string {
  return createHmac('sha256', secret).update(canonicalManifestPayload(manifest)).digest('hex');
}

export function verifyCheckpointManifestSignature(
  manifest: CheckpointTransferManifest,
  secret: string,
): boolean {
  if (!manifest.authSignature || typeof manifest.authSignature !== 'string') {
    return false;
  }
  const expected = signCheckpointManifest(manifest, secret);
  const left = createHash('sha256').update(expected).digest();
  const right = createHash('sha256').update(manifest.authSignature).digest();
  return timingSafeEqual(left, right);
}

function safeTokenEquals(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

/**
 * Scrubs or rejects embedded secrets in checkpoint descriptions, metadata,
 * contextSnapshot, and planState before packaging for remote transport.
 */
export function scrubCheckpointSecrets(
  checkpoint: ExecutionCheckpoint,
  policy: SecretScrubPolicy = 'redact',
): { checkpoint: ExecutionCheckpoint; redactedCount: number; findings: string[] } {
  const cloned = structuredClone(checkpoint);
  let redactedCount = 0;
  const findings: string[] = [];

  const scrubString = (value: string, fieldPath: string): string => {
    let current = value;
    for (const pattern of INLINE_SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(current)) {
        findings.push(`${fieldPath}:${pattern.name}`);
        pattern.regex.lastIndex = 0;
        const next = current.replace(pattern.regex, (match, ...args) => {
          redactedCount++;
          if (pattern.name === 'env_secret_assignment') {
            const [key, sep, quote] = args;
            return `${key}${sep}${quote}[REDACTED]${quote}`;
          }
          return pattern.replacement;
        });
        current = next;
      }
    }
    return current;
  };

  const scrubValue = (val: unknown, fieldPath: string): unknown => {
    if (typeof val === 'string') {
      return scrubString(val, fieldPath);
    }
    if (Array.isArray(val)) {
      return val.map((item, idx) => scrubValue(item, `${fieldPath}[${idx}]`));
    }
    if (val && typeof val === 'object' && !(val instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        const childPath = `${fieldPath}.${k}`;
        if (SECRET_KEY_PATTERN.test(k) && v !== undefined && v !== null && v !== '[REDACTED]') {
          findings.push(`${childPath}:secret_key`);
          redactedCount++;
          out[k] = '[REDACTED]';
        } else {
          out[k] = scrubValue(v, childPath);
        }
      }
      return out;
    }
    return val;
  };

  if (typeof cloned.description === 'string') {
    cloned.description = scrubString(cloned.description, 'description');
  }
  if (cloned.metadata) {
    cloned.metadata = scrubValue(cloned.metadata, 'metadata') as Record<string, unknown>;
  }
  if (cloned.contextSnapshot?.metadata) {
    cloned.contextSnapshot.metadata = scrubValue(
      cloned.contextSnapshot.metadata,
      'contextSnapshot.metadata',
    ) as Record<string, unknown>;
  }
  if (cloned.planState?.metadata) {
    cloned.planState.metadata = scrubValue(
      cloned.planState.metadata,
      'planState.metadata',
    ) as Record<string, unknown>;
  }
  if (cloned.worktreeState?.filesSnapshot) {
    for (const [relPath, content] of Object.entries(cloned.worktreeState.filesSnapshot)) {
      if (typeof content === 'string') {
        cloned.worktreeState.filesSnapshot[relPath] = scrubString(
          content,
          `worktreeState.filesSnapshot[${relPath}]`,
        );
      }
    }
  }

  if (findings.length > 0 && policy === 'reject') {
    throw new Error(
      `CHECKPOINT_SECRET_DETECTED: Refusing to package checkpoint '${checkpoint.id}' due to embedded secret(s) at ${findings.join(', ')}`,
    );
  }

  return { checkpoint: cloned, redactedCount, findings };
}

export class CheckpointTransportService {
  private readonly store?: KeyValueStore;
  private readonly executionEngine?: ExecutionEngine;
  private readonly transportSecret?: string;
  private readonly allowedBearerTokens?: string[] | ((token: string) => boolean);
  private readonly requireAuth: boolean;
  private readonly secretPolicy: SecretScrubPolicy;
  private readonly maxCheckpointBytes: number;
  private readonly maxFileBytes: number;
  private readonly maxStoredCheckpoints: number;
  private readonly defaultTtlMs: number;
  private readonly now: () => number;

  private readonly manifests = new Map<string, StoredManifestEntry>();
  private readonly blobs = new Map<string, string>();
  private readonly receipts = new Map<string, CheckpointTransferReceipt>();

  constructor(options: CheckpointTransportServiceOptions = {}) {
    this.store = options.store;
    this.executionEngine = options.executionEngine;
    this.transportSecret = options.transportSecret;
    this.allowedBearerTokens = options.allowedBearerTokens;
    this.requireAuth =
      options.requireAuth ?? Boolean(options.transportSecret || options.allowedBearerTokens);
    this.secretPolicy = options.secretPolicy ?? 'redact';
    this.maxCheckpointBytes = options.maxCheckpointBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxStoredCheckpoints = options.maxStoredCheckpoints ?? DEFAULT_MAX_STORED_CHECKPOINTS;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_CHECKPOINT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Verifies bearer token and/or manifest HMAC signature.
   */
  public verifyAuthentication(params: {
    authToken?: string;
    manifest?: CheckpointTransferManifest;
  }): void {
    const rawToken = params.authToken?.replace(/^Bearer\s+/i, '').trim();

    if (params.manifest?.authSignature && this.transportSecret) {
      if (!verifyCheckpointManifestSignature(params.manifest, this.transportSecret)) {
        throw new Error('UNAUTHORIZED_CHECKPOINT_TRANSFER: Invalid manifest HMAC signature');
      }
    }

    if (!this.requireAuth) {
      return;
    }

    // Check valid bearer token if presented
    if (rawToken) {
      if (this.transportSecret && safeTokenEquals(rawToken, this.transportSecret)) {
        return;
      }
      if (typeof this.allowedBearerTokens === 'function' && this.allowedBearerTokens(rawToken)) {
        return;
      }
      if (
        Array.isArray(this.allowedBearerTokens) &&
        this.allowedBearerTokens.some((allowed) => safeTokenEquals(rawToken, allowed))
      ) {
        return;
      }
      throw new Error('UNAUTHORIZED_CHECKPOINT_TRANSFER: Invalid bearer token');
    }

    // Check manifest HMAC signature if transportSecret is configured
    if (
      params.manifest &&
      this.transportSecret &&
      verifyCheckpointManifestSignature(params.manifest, this.transportSecret)
    ) {
      return;
    }

    throw new Error('UNAUTHORIZED_CHECKPOINT_TRANSFER: Missing authentication credentials');
  }

  /**
   * Splits an ExecutionCheckpoint into content-addressed blobs and an authenticated manifest,
   * scrubbing or rejecting embedded secrets and enforcing file/checkpoint byte limits.
   */
  public packageCheckpoint(
    checkpoint: ExecutionCheckpoint,
    options: CheckpointPackageOptions,
  ): CheckpointPackageResult {
    if (!options.sourceWorkerId || typeof options.sourceWorkerId !== 'string') {
      throw new Error('INVALID_CHECKPOINT_MANIFEST: sourceWorkerId is required');
    }

    const policy = options.secretPolicy ?? this.secretPolicy;
    const {
      checkpoint: scrubbedCheckpoint,
      redactedCount,
      findings,
    } = scrubCheckpointSecrets(checkpoint, policy);

    const filesSnapshot = scrubbedCheckpoint.worktreeState?.filesSnapshot ?? {};
    const blobHashes: Record<string, string> = {};
    const blobs: Record<string, string> = {};
    let totalBytes = 0;

    for (const [relativePath, content] of Object.entries(filesSnapshot)) {
      validateSafeCheckpointPath(relativePath);
      if (typeof content !== 'string') {
        throw new Error(`INVALID_CHECKPOINT_FILE: File '${relativePath}' content must be a UTF-8 string`);
      }
      const fileBytes = Buffer.byteLength(content, 'utf8');
      if (fileBytes > this.maxFileBytes) {
        throw new Error(
          `CHECKPOINT_FILE_TOO_LARGE: File '${relativePath}' (${fileBytes} bytes) exceeds maxFileBytes (${this.maxFileBytes} bytes)`,
        );
      }
      totalBytes += fileBytes;
      if (totalBytes > this.maxCheckpointBytes) {
        throw new Error(
          `CHECKPOINT_SIZE_LIMIT_EXCEEDED: Checkpoint '${checkpoint.id}' (${totalBytes} bytes) exceeds maxCheckpointBytes (${this.maxCheckpointBytes} bytes)`,
        );
      }
      const hash = computeBlobHash(content);
      blobHashes[relativePath] = hash;
      blobs[hash] = content;
    }

    const snapshotDigest = computeSnapshotDigest(filesSnapshot, scrubbedCheckpoint.workspaceRevision);
    const nowMs = this.now();
    const createdAt =
      scrubbedCheckpoint.createdAt instanceof Date
        ? scrubbedCheckpoint.createdAt.toISOString()
        : new Date(scrubbedCheckpoint.createdAt ?? nowMs).toISOString();
    const expiresAt = new Date(nowMs + (options.ttlMs ?? this.defaultTtlMs)).toISOString();

    const { filesSnapshot: _omittedFiles, ...worktreeMeta } = scrubbedCheckpoint.worktreeState;
    const checkpointEnvelope: CheckpointEnvelope = {
      id: scrubbedCheckpoint.id,
      executionId: scrubbedCheckpoint.executionId,
      parentCheckpointId: scrubbedCheckpoint.parentCheckpointId,
      createdAt,
      workspaceRevision: scrubbedCheckpoint.workspaceRevision,
      workspaceRoot: scrubbedCheckpoint.workspaceRoot,
      worktreeState: worktreeMeta,
      contextSnapshot: scrubbedCheckpoint.contextSnapshot,
      planState: scrubbedCheckpoint.planState,
      verificationState: scrubbedCheckpoint.verificationState,
      provenanceCursor: scrubbedCheckpoint.provenanceCursor,
      evidenceReferences: scrubbedCheckpoint.evidenceReferences,
      description: scrubbedCheckpoint.description,
      metadata: scrubbedCheckpoint.metadata,
    };

    const manifest: CheckpointTransferManifest = {
      checkpointId: scrubbedCheckpoint.id,
      executionId: scrubbedCheckpoint.executionId,
      workspaceRevision: scrubbedCheckpoint.workspaceRevision,
      sourceWorkerId: options.sourceWorkerId,
      targetWorkerId: options.targetWorkerId,
      snapshotDigest,
      blobHashes,
      totalBytes,
      createdAt,
      expiresAt,
      checkpointEnvelope,
      redactedSecretsCount: redactedCount,
    };

    const signingSecret = options.transportSecret ?? this.transportSecret;
    if (signingSecret) {
      manifest.authSignature = signCheckpointManifest(manifest, signingSecret);
    }

    return {
      manifest,
      blobs,
      scrubbedCheckpoint,
      redactedSecretsCount: redactedCount,
      secretFindings: findings,
    };
  }

  /**
   * Computes which unique blob hashes required by a manifest are currently missing from the store.
   */
  public missingBlobs(manifestOrCheckpointId: CheckpointTransferManifest | string): string[] {
    const manifest =
      typeof manifestOrCheckpointId === 'string'
        ? this.manifests.get(manifestOrCheckpointId)?.manifest
        : manifestOrCheckpointId;
    if (!manifest) {
      throw new Error(`CHECKPOINT_MANIFEST_NOT_FOUND: '${String(manifestOrCheckpointId)}'`);
    }
    const uniqueHashes = [...new Set(Object.values(manifest.blobHashes ?? {}))];
    return uniqueHashes.filter((hash) => !this.blobs.has(hash));
  }

  /**
   * Registers a checkpoint manifest on the control plane and returns which content-addressed
   * blobs are missing vs. already deduplicated.
   */
  public async registerManifest(
    manifest: CheckpointTransferManifest,
    options: { authToken?: string } = {},
  ): Promise<{
    checkpointId: string;
    missingBlobHashes: string[];
    deduplicatedBlobHashes: string[];
    alreadyCommitted: boolean;
  }> {
    this.verifyAuthentication({ authToken: options.authToken, manifest });

    if (!manifest?.checkpointId || !manifest.executionId || !manifest.sourceWorkerId) {
      throw new Error('INVALID_CHECKPOINT_MANIFEST: checkpointId, executionId, and sourceWorkerId are required');
    }
    if (!Number.isSafeInteger(manifest.workspaceRevision) || manifest.workspaceRevision < 0) {
      throw new Error('INVALID_CHECKPOINT_MANIFEST: workspaceRevision must be a non-negative integer');
    }

    const expiresAtMs = Date.parse(manifest.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) {
      throw new Error(`CHECKPOINT_MANIFEST_EXPIRED: Manifest for '${manifest.checkpointId}' has expired`);
    }

    if (manifest.totalBytes > this.maxCheckpointBytes) {
      throw new Error(
        `CHECKPOINT_SIZE_LIMIT_EXCEEDED: Manifest '${manifest.checkpointId}' (${manifest.totalBytes} bytes) exceeds maxCheckpointBytes (${this.maxCheckpointBytes} bytes)`,
      );
    }

    for (const [relativePath, hash] of Object.entries(manifest.blobHashes ?? {})) {
      validateSafeCheckpointPath(relativePath);
      if (!/^[a-f0-9]{64}$/i.test(hash)) {
        throw new Error(`INVALID_BLOB_HASH: Invalid SHA-256 hash '${hash}' for '${relativePath}'`);
      }
    }

    const existing = this.manifests.get(manifest.checkpointId);
    const uniqueHashes = [...new Set(Object.values(manifest.blobHashes ?? {}))];
    const missingBlobHashes = uniqueHashes.filter((h) => !this.blobs.has(h));
    const deduplicatedBlobHashes = uniqueHashes.filter((h) => this.blobs.has(h));

    if (existing?.committed) {
      return {
        checkpointId: manifest.checkpointId,
        missingBlobHashes: [],
        deduplicatedBlobHashes: uniqueHashes,
        alreadyCommitted: true,
      };
    }

    const entry: StoredManifestEntry = {
      manifest: structuredClone(manifest),
      committed: false,
      deduplicatedBlobCount: existing
        ? Math.max(existing.deduplicatedBlobCount, deduplicatedBlobHashes.length)
        : deduplicatedBlobHashes.length,
      registeredAtMs: existing?.registeredAtMs ?? this.now(),
    };
    this.manifests.set(manifest.checkpointId, entry);
    await this.store?.put(`checkpoint-transport/manifest/${manifest.checkpointId}`, entry);

    return {
      checkpointId: manifest.checkpointId,
      missingBlobHashes,
      deduplicatedBlobHashes,
      alreadyCommitted: false,
    };
  }

  /**
   * Uploads and verifies a single content-addressed blob by its SHA-256 hash.
   */
  public async putBlob(
    blobHash: string,
    content: string,
    options: { authToken?: string } = {},
  ): Promise<{ blobHash: string; sizeBytes: number; deduplicated: boolean }> {
    this.verifyAuthentication({ authToken: options.authToken });

    if (!/^[a-f0-9]{64}$/i.test(blobHash)) {
      throw new Error(`INVALID_BLOB_HASH: '${blobHash}' is not a valid SHA-256 hex digest`);
    }
    if (typeof content !== 'string') {
      throw new Error('INVALID_BLOB_CONTENT: Blob content must be a string');
    }

    const sizeBytes = Buffer.byteLength(content, 'utf8');
    if (sizeBytes > this.maxFileBytes) {
      throw new Error(
        `CHECKPOINT_FILE_TOO_LARGE: Blob '${blobHash}' (${sizeBytes} bytes) exceeds maxFileBytes (${this.maxFileBytes} bytes)`,
      );
    }

    const computed = computeBlobHash(content);
    if (computed !== blobHash.toLowerCase()) {
      throw new Error(
        `CHECKPOINT_BLOB_HASH_MISMATCH: Expected SHA-256 '${blobHash}', got '${computed}'`,
      );
    }

    const normalizedHash = blobHash.toLowerCase();
    const deduplicated = this.blobs.has(normalizedHash);
    if (!deduplicated) {
      this.blobs.set(normalizedHash, content);
      await this.store?.put(`checkpoint-transport/blob/${normalizedHash}`, content);
    }

    return {
      blobHash: normalizedHash,
      sizeBytes,
      deduplicated,
    };
  }

  public hasBlob(blobHash: string): boolean {
    return this.blobs.has(blobHash.toLowerCase());
  }

  public getBlob(blobHash: string): string | undefined {
    return this.blobs.get(blobHash.toLowerCase());
  }

  public get blobCount(): number {
    return this.blobs.size;
  }

  public get storedCheckpointCount(): number {
    return [...this.manifests.values()].filter((m) => m.committed).length;
  }

  /**
   * Finalizes a checkpoint transfer after all blobs are present, verifying the complete
   * snapshot digest, enforcing retention limits, and issuing a transfer receipt.
   */
  public async commitCheckpoint(
    checkpointId: string,
    options: { authToken?: string; sourceWorkerId?: string } = {},
  ): Promise<CheckpointTransferReceipt> {
    const entry = this.manifests.get(checkpointId);
    if (!entry) {
      throw new Error(`CHECKPOINT_MANIFEST_NOT_FOUND: '${checkpointId}'`);
    }

    this.verifyAuthentication({ authToken: options.authToken });

    if (
      options.sourceWorkerId &&
      options.sourceWorkerId !== entry.manifest.sourceWorkerId
    ) {
      throw new Error(
        `CHECKPOINT_WORKER_IDENTITY_MISMATCH: Manifest sourceWorkerId '${entry.manifest.sourceWorkerId}' does not match committing worker '${options.sourceWorkerId}'`,
      );
    }

    const expiresAtMs = Date.parse(entry.manifest.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) {
      throw new Error(`CHECKPOINT_MANIFEST_EXPIRED: Checkpoint '${checkpointId}' has expired`);
    }

    if (entry.committed && entry.receipt) {
      return structuredClone(entry.receipt);
    }

    const missing = this.missingBlobs(entry.manifest);
    if (missing.length > 0) {
      throw new Error(
        `CHECKPOINT_INCOMPLETE_BLOBS: Cannot commit '${checkpointId}'; missing ${missing.length} blob(s): ${missing.join(', ')}`,
      );
    }

    // Reconstruct filesSnapshot and verify actual total bytes & snapshot digest
    const filesSnapshot: Record<string, string> = {};
    let actualTotalBytes = 0;
    for (const [relativePath, blobHash] of Object.entries(entry.manifest.blobHashes)) {
      const content = this.blobs.get(blobHash.toLowerCase());
      if (content === undefined) {
        throw new Error(`CHECKPOINT_INCOMPLETE_BLOBS: Missing blob '${blobHash}'`);
      }
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > this.maxFileBytes) {
        throw new Error(`CHECKPOINT_FILE_TOO_LARGE: File '${relativePath}' exceeds maxFileBytes`);
      }
      actualTotalBytes += bytes;
      filesSnapshot[relativePath] = content;
    }

    if (actualTotalBytes > this.maxCheckpointBytes) {
      throw new Error(
        `CHECKPOINT_SIZE_LIMIT_EXCEEDED: Checkpoint '${checkpointId}' (${actualTotalBytes} bytes) exceeds maxCheckpointBytes (${this.maxCheckpointBytes} bytes)`,
      );
    }

    const actualDigest = computeSnapshotDigest(filesSnapshot, entry.manifest.workspaceRevision);
    if (actualDigest !== entry.manifest.snapshotDigest) {
      throw new Error(
        `CHECKPOINT_DIGEST_MISMATCH: Snapshot digest mismatch for '${checkpointId}'. Expected '${entry.manifest.snapshotDigest}', got '${actualDigest}'`,
      );
    }

    const uniqueBlobsCount = new Set(Object.values(entry.manifest.blobHashes)).size;
    const nowIso = new Date(this.now()).toISOString();
    const receipt: CheckpointTransferReceipt = {
      receiptId: `rcpt-${randomUUID()}`,
      checkpointId,
      executionId: entry.manifest.executionId,
      workspaceRevision: entry.manifest.workspaceRevision,
      sourceWorkerId: entry.manifest.sourceWorkerId,
      targetWorkerId: entry.manifest.targetWorkerId,
      snapshotDigest: actualDigest,
      totalBytes: actualTotalBytes,
      blobCount: uniqueBlobsCount,
      deduplicatedBlobCount: entry.deduplicatedBlobCount,
      redactedSecretsCount: entry.manifest.redactedSecretsCount ?? 0,
      committedAt: nowIso,
    };

    entry.committed = true;
    entry.committedAtMs = this.now();
    entry.receipt = receipt;
    this.receipts.set(checkpointId, receipt);

    await this.store?.put(`checkpoint-transport/manifest/${checkpointId}`, entry);
    await this.store?.put(`checkpoint-transport/receipt/${checkpointId}`, receipt);

    await this.enforceRetentionLimits();

    return structuredClone(receipt);
  }

  /**
   * Downloads a committed checkpoint bundle (manifest + content-addressed blobs + receipt)
   * for target worker restoration. Validates destination worker identity if restricted.
   */
  public async getBundle(
    checkpointId: string,
    options: { authToken?: string; requestingWorkerId?: string } = {},
  ): Promise<CheckpointTransferBundle> {
    const entry = this.manifests.get(checkpointId);
    if (!entry || !entry.committed || !entry.receipt) {
      throw new Error(`CHECKPOINT_NOT_FOUND: Committed checkpoint '${checkpointId}' not found`);
    }

    this.verifyAuthentication({ authToken: options.authToken });

    const expiresAtMs = Date.parse(entry.manifest.expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= this.now()) {
      await this.pruneExpired();
      throw new Error(`CHECKPOINT_EXPIRED: Checkpoint '${checkpointId}' has expired`);
    }

    if (
      entry.manifest.targetWorkerId &&
      options.requestingWorkerId &&
      entry.manifest.targetWorkerId !== options.requestingWorkerId
    ) {
      throw new Error(
        `CHECKPOINT_TARGET_WORKER_MISMATCH: Checkpoint '${checkpointId}' is designated for targetWorkerId '${entry.manifest.targetWorkerId}', not '${options.requestingWorkerId}'`,
      );
    }

    const blobs: Record<string, string> = {};
    for (const blobHash of new Set(Object.values(entry.manifest.blobHashes))) {
      const normalized = blobHash.toLowerCase();
      const content = this.blobs.get(normalized);
      if (content === undefined) {
        throw new Error(`CHECKPOINT_BLOB_MISSING: Blob '${normalized}' missing for '${checkpointId}'`);
      }
      blobs[normalized] = content;
    }

    if (options.requestingWorkerId) {
      entry.receipt.downloadedByWorkerId = options.requestingWorkerId;
      entry.receipt.downloadedAt = new Date(this.now()).toISOString();
      await this.store?.put(`checkpoint-transport/receipt/${checkpointId}`, entry.receipt);
    }

    return {
      manifest: structuredClone(entry.manifest),
      blobs,
      receipt: structuredClone(entry.receipt),
    };
  }

  /**
   * Reconstructs and cryptographically validates an ExecutionCheckpoint from a transfer bundle.
   */
  public reconstructCheckpoint(bundle: {
    manifest: CheckpointTransferManifest;
    blobs: Record<string, string>;
  }): ExecutionCheckpoint {
    const { manifest, blobs } = bundle;
    if (this.transportSecret && manifest.authSignature) {
      if (!verifyCheckpointManifestSignature(manifest, this.transportSecret)) {
        throw new Error('UNAUTHORIZED_CHECKPOINT_TRANSFER: Invalid manifest HMAC signature');
      }
    }

    const filesSnapshot: Record<string, string> = {};
    let totalBytes = 0;

    for (const [relativePath, expectedHash] of Object.entries(manifest.blobHashes ?? {})) {
      validateSafeCheckpointPath(relativePath);
      const normalizedHash = expectedHash.toLowerCase();
      const content = blobs[normalizedHash] ?? blobs[expectedHash];
      if (typeof content !== 'string') {
        throw new Error(
          `CHECKPOINT_BLOB_MISSING: Missing content for file '${relativePath}' (blob '${expectedHash}')`,
        );
      }
      const actualHash = computeBlobHash(content);
      if (actualHash !== normalizedHash) {
        throw new Error(
          `CHECKPOINT_BLOB_HASH_MISMATCH: Tampered blob for '${relativePath}'. Expected '${normalizedHash}', got '${actualHash}'`,
        );
      }
      totalBytes += Buffer.byteLength(content, 'utf8');
      filesSnapshot[relativePath] = content;
    }

    if (totalBytes > this.maxCheckpointBytes) {
      throw new Error(
        `CHECKPOINT_SIZE_LIMIT_EXCEEDED: Reconstructed checkpoint (${totalBytes} bytes) exceeds maxCheckpointBytes (${this.maxCheckpointBytes} bytes)`,
      );
    }

    const actualDigest = computeSnapshotDigest(filesSnapshot, manifest.workspaceRevision);
    if (actualDigest !== manifest.snapshotDigest) {
      throw new Error(
        `CHECKPOINT_DIGEST_MISMATCH: Reconstructed snapshot digest '${actualDigest}' does not match manifest digest '${manifest.snapshotDigest}'`,
      );
    }

    const env = manifest.checkpointEnvelope;
    return {
      id: env.id,
      executionId: env.executionId,
      parentCheckpointId: env.parentCheckpointId,
      createdAt: new Date(env.createdAt),
      workspaceRevision: env.workspaceRevision,
      workspaceRoot: env.workspaceRoot,
      worktreeState: {
        ...env.worktreeState,
        filesSnapshot,
      },
      contextSnapshot: env.contextSnapshot,
      planState: env.planState,
      verificationState: env.verificationState,
      provenanceCursor: env.provenanceCursor,
      evidenceReferences: env.evidenceReferences,
      description: env.description,
      metadata: env.metadata,
    };
  }

  /**
   * Validates that restoring a checkpoint onto a target execution does not overwrite a newer
   * confirmed workspaceRevision unless allowRollback: true is explicitly specified.
   */
  public async validateTargetRestoration(params: {
    checkpoint: ExecutionCheckpoint;
    manifest?: CheckpointTransferManifest;
    targetWorkerId?: string;
    targetExecutionRevision?: number;
    allowRollback?: boolean;
  }): Promise<void> {
    if (
      params.manifest?.targetWorkerId &&
      params.targetWorkerId &&
      params.manifest.targetWorkerId !== params.targetWorkerId
    ) {
      throw new Error(
        `CHECKPOINT_TARGET_WORKER_MISMATCH: Checkpoint '${params.checkpoint.id}' expects targetWorkerId '${params.manifest.targetWorkerId}', got '${params.targetWorkerId}'`,
      );
    }

    let currentRevision = params.targetExecutionRevision;
    if (currentRevision === undefined && this.executionEngine) {
      const record = await this.executionEngine.get(params.checkpoint.executionId);
      if (record?.workspaceState?.revision !== undefined) {
        currentRevision = record.workspaceState.revision;
      }
    }

    if (
      currentRevision !== undefined &&
      currentRevision > params.checkpoint.workspaceRevision &&
      params.allowRollback !== true
    ) {
      throw new Error(
        `STALE_CHECKPOINT_RESTORATION: Target execution '${params.checkpoint.executionId}' is at confirmed workspaceRevision ${currentRevision}, which is newer than checkpoint '${params.checkpoint.id}' revision ${params.checkpoint.workspaceRevision}`,
      );
    }
  }

  /**
   * Restores a transferred checkpoint onto a target worker directory via CheckpointService.materializeOnTarget,
   * enforcing authentication, digest verification, worker identity, and stale checkpoint protection.
   */
  public async restoreOnTarget(params: {
    checkpointId?: string;
    bundle?: { manifest: CheckpointTransferManifest; blobs: Record<string, string> };
    targetDir: string;
    checkpointService: CheckpointService;
    targetWorkerId: string;
    targetExecutionRevision?: number;
    allowRollback?: boolean;
    authToken?: string;
  }): Promise<{
    checkpoint: ExecutionCheckpoint;
    receipt?: CheckpointTransferReceipt;
    digest: string;
    filesRestored: string[];
  }> {
    const resolvedBundle =
      params.bundle ??
      (params.checkpointId
        ? await this.getBundle(params.checkpointId, {
            authToken: params.authToken,
            requestingWorkerId: params.targetWorkerId,
          })
        : undefined);

    if (!resolvedBundle) {
      throw new Error('INVALID_RESTORE_REQUEST: Either checkpointId or bundle must be provided');
    }

    const checkpoint = this.reconstructCheckpoint(resolvedBundle);
    await this.validateTargetRestoration({
      checkpoint,
      manifest: resolvedBundle.manifest,
      targetWorkerId: params.targetWorkerId,
      targetExecutionRevision: params.targetExecutionRevision,
      allowRollback: params.allowRollback,
    });

    const materialized = await params.checkpointService.materializeOnTarget(
      params.targetDir,
      checkpoint,
      resolvedBundle.manifest.snapshotDigest,
    );

    const existingReceipt = this.receipts.get(checkpoint.id);
    if (existingReceipt) {
      existingReceipt.restoredByWorkerId = params.targetWorkerId;
      existingReceipt.restoredAt = new Date(this.now()).toISOString();
      await this.store?.put(`checkpoint-transport/receipt/${checkpoint.id}`, existingReceipt);
    }

    return {
      checkpoint,
      receipt: existingReceipt ? structuredClone(existingReceipt) : undefined,
      digest: materialized.digest,
      filesRestored: materialized.filesRestored,
    };
  }

  public getReceipt(checkpointId: string): CheckpointTransferReceipt | undefined {
    const receipt = this.receipts.get(checkpointId);
    return receipt ? structuredClone(receipt) : undefined;
  }

  public getManifest(checkpointId: string): CheckpointTransferManifest | undefined {
    const entry = this.manifests.get(checkpointId);
    return entry ? structuredClone(entry.manifest) : undefined;
  }

  /**
   * Prunes expired manifests/checkpoints and garbage-collects unreferenced blobs.
   */
  public async pruneExpired(nowMs = this.now()): Promise<{
    prunedCheckpoints: string[];
    prunedBlobs: number;
  }> {
    const prunedCheckpoints: string[] = [];
    for (const [checkpointId, entry] of this.manifests.entries()) {
      const expiresAtMs = Date.parse(entry.manifest.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
        this.manifests.delete(checkpointId);
        this.receipts.delete(checkpointId);
        prunedCheckpoints.push(checkpointId);
        await this.store?.delete(`checkpoint-transport/manifest/${checkpointId}`);
        await this.store?.delete(`checkpoint-transport/receipt/${checkpointId}`);
      }
    }

    const prunedBlobs = await this.garbageCollectUnreferencedBlobs();
    return { prunedCheckpoints, prunedBlobs };
  }

  private async enforceRetentionLimits(): Promise<void> {
    const committedEntries = [...this.manifests.entries()]
      .filter(([, entry]) => entry.committed)
      .sort((a, b) => (a[1].committedAtMs ?? 0) - (b[1].committedAtMs ?? 0));

    while (committedEntries.length > this.maxStoredCheckpoints) {
      const [oldestId] = committedEntries.shift()!;
      this.manifests.delete(oldestId);
      this.receipts.delete(oldestId);
      await this.store?.delete(`checkpoint-transport/manifest/${oldestId}`);
      await this.store?.delete(`checkpoint-transport/receipt/${oldestId}`);
    }

    if (committedEntries.length <= this.maxStoredCheckpoints) {
      await this.garbageCollectUnreferencedBlobs();
    }
  }

  private async garbageCollectUnreferencedBlobs(): Promise<number> {
    const referencedHashes = new Set<string>();
    for (const entry of this.manifests.values()) {
      for (const hash of Object.values(entry.manifest.blobHashes ?? {})) {
        referencedHashes.add(hash.toLowerCase());
      }
    }

    let prunedBlobs = 0;
    for (const hash of [...this.blobs.keys()]) {
      if (!referencedHashes.has(hash)) {
        this.blobs.delete(hash);
        prunedBlobs++;
        await this.store?.delete(`checkpoint-transport/blob/${hash}`);
      }
    }
    return prunedBlobs;
  }
}
