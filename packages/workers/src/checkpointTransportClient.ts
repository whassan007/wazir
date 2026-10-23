import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { ExecutionCheckpoint, CheckpointService } from '@wazir/core';

export interface ClientCheckpointEnvelope {
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

export interface ClientCheckpointTransferManifest {
  checkpointId: string;
  executionId: string;
  workspaceRevision: number;
  sourceWorkerId: string;
  targetWorkerId?: string;
  snapshotDigest: string;
  blobHashes: Record<string, string>;
  totalBytes: number;
  createdAt: string;
  expiresAt: string;
  authSignature?: string;
  checkpointEnvelope: ClientCheckpointEnvelope;
  redactedSecretsCount?: number;
}

export interface ClientCheckpointTransferReceipt {
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

export interface ClientCheckpointTransferBundle {
  manifest: ClientCheckpointTransferManifest;
  blobs: Record<string, string>;
  receipt: ClientCheckpointTransferReceipt;
}

export interface CheckpointTransportClientOptions {
  serverUrl: string;
  workerId: string;
  authToken?: string;
  transportSecret?: string;
  fetchFn?: typeof fetch;
  maxRetries?: number;
  retryBackoffMs?: number;
  maxCheckpointBytes?: number;
  maxFileBytes?: number;
  secretPolicy?: 'redact' | 'reject';
  defaultTtlMs?: number;
  now?: () => number;
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

function computeBlobHash(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

function computeSnapshotDigest(filesSnapshot: Record<string, string>, workspaceRevision: number): string {
  const hash = createHash('sha256');
  const sortedEntries = Object.entries(filesSnapshot ?? {}).sort(([a], [b]) => a.localeCompare(b));
  for (const [filePath, content] of sortedEntries) {
    hash.update(JSON.stringify([filePath, content]));
  }
  hash.update(`rev:${workspaceRevision}\n`);
  return hash.digest('hex');
}

function validateSafePath(relative: string): void {
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

function canonicalManifestPayload(manifest: ClientCheckpointTransferManifest): string {
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

function signManifest(manifest: ClientCheckpointTransferManifest, secret: string): string {
  return createHmac('sha256', secret).update(canonicalManifestPayload(manifest)).digest('hex');
}

function verifyManifestSignature(manifest: ClientCheckpointTransferManifest, secret: string): boolean {
  if (!manifest.authSignature || typeof manifest.authSignature !== 'string') {
    return false;
  }
  const expected = signManifest(manifest, secret);
  const left = createHash('sha256').update(expected).digest();
  const right = createHash('sha256').update(manifest.authSignature).digest();
  return timingSafeEqual(left, right);
}

function scrubSecrets(
  checkpoint: ExecutionCheckpoint,
  policy: 'redact' | 'reject',
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
        current = current.replace(pattern.regex, (_match, ...args) => {
          redactedCount++;
          if (pattern.name === 'env_secret_assignment') {
            const [key, sep, quote] = args;
            return `${key}${sep}${quote}[REDACTED]${quote}`;
          }
          return pattern.replacement;
        });
      }
    }
    return current;
  };

  const scrubValue = (val: unknown, fieldPath: string): unknown => {
    if (typeof val === 'string') return scrubString(val, fieldPath);
    if (Array.isArray(val)) return val.map((item, idx) => scrubValue(item, `${fieldPath}[${idx}]`));
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

  if (findings.length > 0 && policy === 'reject') {
    throw new Error(
      `CHECKPOINT_SECRET_DETECTED: Refusing to transfer checkpoint '${checkpoint.id}' due to embedded secret(s) at ${findings.join(', ')}`,
    );
  }

  return { checkpoint: cloned, redactedCount, findings };
}

export class CheckpointTransportClient {
  private readonly serverUrl: string;
  private readonly workerId: string;
  private readonly authToken?: string;
  private readonly transportSecret?: string;
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly maxCheckpointBytes: number;
  private readonly maxFileBytes: number;
  private readonly secretPolicy: 'redact' | 'reject';
  private readonly defaultTtlMs: number;
  private readonly now: () => number;

  constructor(options: CheckpointTransportClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    this.workerId = options.workerId;
    this.authToken = options.authToken ?? options.transportSecret;
    this.transportSecret = options.transportSecret;
    this.fetchFn = options.fetchFn ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBackoffMs = options.retryBackoffMs ?? 20;
    this.maxCheckpointBytes = options.maxCheckpointBytes ?? 50 * 1024 * 1024;
    this.maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
    this.secretPolicy = options.secretPolicy ?? 'redact';
    this.defaultTtlMs = options.defaultTtlMs ?? 24 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const out: Record<string, string> = {
      'x-wazir-worker-id': this.workerId,
      ...extra,
    };
    if (this.authToken) {
      out.Authorization = this.authToken.startsWith('Bearer ')
        ? this.authToken
        : `Bearer ${this.authToken}`;
    }
    return out;
  }

  private async requestWithRetry<T>(
    url: string,
    init: RequestInit,
  ): Promise<{ data: T; retries: number }> {
    let retries = 0;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.fetchFn(url, init);
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          const errorMessage =
            typeof body.error === 'string'
              ? body.error
              : `HTTP ${response.status} from ${url}`;
          // Do not retry deterministic client/auth/validation errors (4xx except 408/429)
          if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
            throw Object.assign(new Error(errorMessage), { nonRetryable: true, status: response.status });
          }
          throw new Error(errorMessage);
        }
        return { data: body as T, retries };
      } catch (error) {
        if ((error as { nonRetryable?: boolean }).nonRetryable || attempt === this.maxRetries) {
          throw error;
        }
        retries++;
        if (this.retryBackoffMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.retryBackoffMs * attempt));
        }
      }
    }
    throw new Error(`Request to ${url} exhausted retries`);
  }

  /**
   * Packages and pushes a checkpoint from this worker to the control plane,
   * uploading only missing content-addressed blobs and supporting automatic
   * resumable retry on network interruptions.
   */
  public async pushCheckpoint(
    checkpoint: ExecutionCheckpoint,
    options: {
      targetWorkerId?: string;
      ttlMs?: number;
      secretPolicy?: 'redact' | 'reject';
    } = {},
  ): Promise<{
    manifest: ClientCheckpointTransferManifest;
    receipt: ClientCheckpointTransferReceipt;
    uploadedBlobs: string[];
    deduplicatedBlobs: string[];
    retryAttempts: number;
    redactedSecretsCount: number;
  }> {
    const { checkpoint: scrubbed, redactedCount } = scrubSecrets(
      checkpoint,
      options.secretPolicy ?? this.secretPolicy,
    );

    const filesSnapshot = scrubbed.worktreeState?.filesSnapshot ?? {};
    const blobHashes: Record<string, string> = {};
    const blobs: Record<string, string> = {};
    let totalBytes = 0;

    for (const [relativePath, content] of Object.entries(filesSnapshot)) {
      validateSafePath(relativePath);
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

    const snapshotDigest = computeSnapshotDigest(filesSnapshot, scrubbed.workspaceRevision);
    const nowMs = this.now();
    const createdAt =
      scrubbed.createdAt instanceof Date
        ? scrubbed.createdAt.toISOString()
        : new Date(scrubbed.createdAt ?? nowMs).toISOString();
    const expiresAt = new Date(nowMs + (options.ttlMs ?? this.defaultTtlMs)).toISOString();
    const { filesSnapshot: _omitted, ...worktreeMeta } = scrubbed.worktreeState;

    const manifest: ClientCheckpointTransferManifest = {
      checkpointId: scrubbed.id,
      executionId: scrubbed.executionId,
      workspaceRevision: scrubbed.workspaceRevision,
      sourceWorkerId: this.workerId,
      targetWorkerId: options.targetWorkerId,
      snapshotDigest,
      blobHashes,
      totalBytes,
      createdAt,
      expiresAt,
      checkpointEnvelope: {
        id: scrubbed.id,
        executionId: scrubbed.executionId,
        parentCheckpointId: scrubbed.parentCheckpointId,
        createdAt,
        workspaceRevision: scrubbed.workspaceRevision,
        workspaceRoot: scrubbed.workspaceRoot,
        worktreeState: worktreeMeta,
        contextSnapshot: scrubbed.contextSnapshot,
        planState: scrubbed.planState,
        verificationState: scrubbed.verificationState,
        provenanceCursor: scrubbed.provenanceCursor,
        evidenceReferences: scrubbed.evidenceReferences,
        description: scrubbed.description,
        metadata: scrubbed.metadata,
      },
      redactedSecretsCount: redactedCount,
    };

    if (this.transportSecret) {
      manifest.authSignature = signManifest(manifest, this.transportSecret);
    }

    let retryAttempts = 0;

    // 1. Upload manifest and discover missing vs. deduplicated blobs
    const manifestResp = await this.requestWithRetry<{
      checkpointId: string;
      missingBlobHashes: string[];
      deduplicatedBlobHashes: string[];
      alreadyCommitted: boolean;
    }>(`${this.serverUrl}/api/v1/checkpoints/manifests`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ manifest }),
    });
    retryAttempts += manifestResp.retries;

    const uploadedBlobs: string[] = [];
    const deduplicatedBlobs = [...(manifestResp.data.deduplicatedBlobHashes ?? [])];

    // 2. Upload only the missing blobs (resumable / deduplicated)
    if (!manifestResp.data.alreadyCommitted) {
      for (const blobHash of manifestResp.data.missingBlobHashes) {
        const content = blobs[blobHash];
        if (typeof content !== 'string') {
          throw new Error(`CHECKPOINT_BLOB_MISSING: Local blob '${blobHash}' not found`);
        }
        const blobResp = await this.requestWithRetry<{
          blobHash: string;
          sizeBytes: number;
          deduplicated: boolean;
        }>(`${this.serverUrl}/api/v1/checkpoints/blobs/${encodeURIComponent(blobHash)}`, {
          method: 'PUT',
          headers: this.headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ content }),
        });
        retryAttempts += blobResp.retries;
        uploadedBlobs.push(blobHash);
      }
    }

    // 3. Commit checkpoint and verify full snapshot digest on control plane
    const commitResp = await this.requestWithRetry<{
      receipt: ClientCheckpointTransferReceipt;
    }>(`${this.serverUrl}/api/v1/checkpoints/${encodeURIComponent(manifest.checkpointId)}/commit`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ sourceWorkerId: this.workerId }),
    });
    retryAttempts += commitResp.retries;

    return {
      manifest,
      receipt: commitResp.data.receipt,
      uploadedBlobs,
      deduplicatedBlobs,
      retryAttempts,
      redactedSecretsCount: redactedCount,
    };
  }

  /**
   * Pulls and cryptographically verifies a committed checkpoint bundle from the control plane.
   */
  public async pullBundle(
    checkpointId: string,
    options: { targetWorkerId?: string } = {},
  ): Promise<{
    bundle: ClientCheckpointTransferBundle;
    checkpoint: ExecutionCheckpoint;
    retryAttempts: number;
  }> {
    const workerId = options.targetWorkerId ?? this.workerId;
    const url = `${this.serverUrl}/api/v1/checkpoints/${encodeURIComponent(checkpointId)}/bundle?workerId=${encodeURIComponent(workerId)}`;
    const bundleResp = await this.requestWithRetry<ClientCheckpointTransferBundle>(url, {
      method: 'GET',
      headers: this.headers(),
    });

    const { manifest, blobs, receipt } = bundleResp.data;
    if (this.transportSecret && manifest.authSignature) {
      if (!verifyManifestSignature(manifest, this.transportSecret)) {
        throw new Error('UNAUTHORIZED_CHECKPOINT_TRANSFER: Invalid manifest HMAC signature on downloaded bundle');
      }
    }

    if (manifest.targetWorkerId && manifest.targetWorkerId !== workerId) {
      throw new Error(
        `CHECKPOINT_TARGET_WORKER_MISMATCH: Bundle targetWorkerId '${manifest.targetWorkerId}' does not match worker '${workerId}'`,
      );
    }

    const filesSnapshot: Record<string, string> = {};
    for (const [relativePath, expectedHash] of Object.entries(manifest.blobHashes ?? {})) {
      validateSafePath(relativePath);
      const normalized = expectedHash.toLowerCase();
      const content = blobs[normalized] ?? blobs[expectedHash];
      if (typeof content !== 'string') {
        throw new Error(
          `CHECKPOINT_BLOB_MISSING: Downloaded bundle missing blob '${expectedHash}' for '${relativePath}'`,
        );
      }
      const computed = computeBlobHash(content);
      if (computed !== normalized) {
        throw new Error(
          `CHECKPOINT_BLOB_HASH_MISMATCH: Downloaded blob tampered for '${relativePath}'. Expected '${normalized}', got '${computed}'`,
        );
      }
      filesSnapshot[relativePath] = content;
    }

    const computedDigest = computeSnapshotDigest(filesSnapshot, manifest.workspaceRevision);
    if (computedDigest !== manifest.snapshotDigest) {
      throw new Error(
        `CHECKPOINT_DIGEST_MISMATCH: Downloaded bundle digest '${computedDigest}' does not match manifest '${manifest.snapshotDigest}'`,
      );
    }

    const env = manifest.checkpointEnvelope;
    const checkpoint: ExecutionCheckpoint = {
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

    return {
      bundle: { manifest, blobs, receipt },
      checkpoint,
      retryAttempts: bundleResp.retries,
    };
  }

  /**
   * Pulls a checkpoint from the control plane, validates digest and stale revision rules,
   * and materializes it onto the target worker's workspace via CheckpointService.materializeOnTarget.
   */
  public async pullAndMaterialize(params: {
    checkpointId: string;
    targetDir: string;
    checkpointService: CheckpointService;
    targetWorkerId?: string;
    targetExecutionRevision?: number;
    allowRollback?: boolean;
  }): Promise<{
    checkpoint: ExecutionCheckpoint;
    receipt: ClientCheckpointTransferReceipt;
    digest: string;
    filesRestored: string[];
    retryAttempts: number;
  }> {
    const targetWorkerId = params.targetWorkerId ?? this.workerId;
    const { bundle, checkpoint, retryAttempts } = await this.pullBundle(params.checkpointId, {
      targetWorkerId,
    });

    if (
      params.targetExecutionRevision !== undefined &&
      params.targetExecutionRevision > checkpoint.workspaceRevision &&
      params.allowRollback !== true
    ) {
      throw new Error(
        `STALE_CHECKPOINT_RESTORATION: Target execution '${checkpoint.executionId}' is at confirmed workspaceRevision ${params.targetExecutionRevision}, which is newer than checkpoint '${checkpoint.id}' revision ${checkpoint.workspaceRevision}`,
      );
    }

    const materialized = await params.checkpointService.materializeOnTarget(
      params.targetDir,
      checkpoint,
      bundle.manifest.snapshotDigest,
    );

    return {
      checkpoint,
      receipt: bundle.receipt,
      digest: materialized.digest,
      filesRestored: materialized.filesRestored,
      retryAttempts,
    };
  }
}
