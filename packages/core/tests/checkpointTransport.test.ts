import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import express from 'express';
import {
  ExecutionEngine,
  WorktreeManager,
  CheckpointService,
} from '../src/index.js';
import {
  CheckpointTransportService,
  computeBlobHash,
  computeSnapshotDigest,
  scrubCheckpointSecrets,
  signCheckpointManifest,
} from '../src/services/checkpointTransportService.js';
import { CheckpointTransportClient } from '../../workers/src/checkpointTransportClient.js';
import { registerCheckpointTransportRoutes } from '../../../apps/api/src/checkpointTransportRoutes.js';

describe('Group C4: Remote Checkpoint Transport (Service, HTTP Routes, Worker Client)', () => {
  let tempRoot: string;
  let workerADir: string;
  let workerBDir: string;
  let engineA: ExecutionEngine;
  let engineB: ExecutionEngine;
  let worktreeManagerA: WorktreeManager;
  let worktreeManagerB: WorktreeManager;
  let checkpointServiceA: CheckpointService;
  let checkpointServiceB: CheckpointService;
  let server: http.Server | undefined;
  let serverUrl: string;
  let transportService: CheckpointTransportService;

  const clusterSecret = 'cluster-transport-secret-key-2026';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-c4-transport-'));
    workerADir = path.join(tempRoot, 'worker-a');
    workerBDir = path.join(tempRoot, 'worker-b');
    await fs.mkdir(workerADir, { recursive: true });
    await fs.mkdir(workerBDir, { recursive: true });

    engineA = new ExecutionEngine({ workspace: workerADir });
    engineB = new ExecutionEngine({ workspace: workerBDir });
    worktreeManagerA = new WorktreeManager({
      worktreeRootDir: path.join(workerADir, '.wazir', 'worktrees'),
    });
    worktreeManagerB = new WorktreeManager({
      worktreeRootDir: path.join(workerBDir, '.wazir', 'worktrees'),
    });
    checkpointServiceA = new CheckpointService({
      executionEngine: engineA,
      worktreeManager: worktreeManagerA,
      defaultWorkspaceRoot: workerADir,
    });
    checkpointServiceB = new CheckpointService({
      executionEngine: engineB,
      worktreeManager: worktreeManagerB,
      defaultWorkspaceRoot: workerBDir,
    });

    transportService = new CheckpointTransportService({
      executionEngine: engineB,
      transportSecret: clusterSecret,
    });

    const app = express();
    registerCheckpointTransportRoutes(app, transportService);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    serverUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  });

  async function createSampleCheckpointOnWorkerA(
    files: Record<string, string>,
    revision = 1,
    options: { description?: string; metadata?: Record<string, unknown> } = {},
  ) {
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = path.join(workerADir, relPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf8');
    }

    const record = await engineA.create({
      task: {
        id: `task-${Date.now()}`,
        type: 'coding',
        input: 'transport test',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      computerId: 'worker-a',
      runtimeId: 'rt-local',
      modelId: 'model-1',
      workspaceRoot: workerADir,
    });

    for (let i = 0; i < revision; i++) {
      await engineA.recordFilesChanged(record.execution.id, Object.keys(files));
    }

    return checkpointServiceA.checkpoint(record.execution.id, {
      description: options.description ?? 'worker-a-checkpoint',
      metadata: options.metadata,
    });
  }

  it('1. performs end-to-end checkpoint creation on Worker A -> authenticated HTTP transfer -> digest validation -> materialization on Worker B', async () => {
    const checkpoint = await createSampleCheckpointOnWorkerA(
      {
        'src/index.ts': 'export const answer = 42;\n',
        'src/utils/math.ts': 'export function double(n: number) { return n * 2; }\n',
        'README.md': '# Distributed Checkpoint Test\n',
      },
      2,
    );

    // Pre-populate stale file on Worker B to confirm clean materialization removes extra files
    await fs.writeFile(path.join(workerBDir, 'stale.txt'), 'remove me', 'utf8');

    const clientA = new CheckpointTransportClient({
      serverUrl,
      workerId: 'worker-a',
      transportSecret: clusterSecret,
    });
    const clientB = new CheckpointTransportClient({
      serverUrl,
      workerId: 'worker-b',
      transportSecret: clusterSecret,
    });

    const pushResult = await clientA.pushCheckpoint(checkpoint, {
      targetWorkerId: 'worker-b',
    });

    expect(pushResult.uploadedBlobs.length).toBe(3);
    expect(pushResult.deduplicatedBlobs.length).toBe(0);
    expect(pushResult.receipt.checkpointId).toBe(checkpoint.id);
    expect(pushResult.receipt.sourceWorkerId).toBe('worker-a');
    expect(pushResult.receipt.targetWorkerId).toBe('worker-b');
    expect(pushResult.receipt.snapshotDigest).toBe(checkpointServiceA.computeDigest(checkpoint));

    const restoreResult = await clientB.pullAndMaterialize({
      checkpointId: checkpoint.id,
      targetDir: workerBDir,
      checkpointService: checkpointServiceB,
      targetWorkerId: 'worker-b',
    });

    expect(restoreResult.digest).toBe(checkpointServiceA.computeDigest(checkpoint));
    expect(restoreResult.checkpoint.workspaceRevision).toBe(2);
    expect(restoreResult.filesRestored.sort()).toEqual([
      'README.md',
      'src/index.ts',
      'src/utils/math.ts',
    ]);

    const restoredIndex = await fs.readFile(path.join(workerBDir, 'src/index.ts'), 'utf8');
    const restoredMath = await fs.readFile(path.join(workerBDir, 'src/utils/math.ts'), 'utf8');
    expect(restoredIndex).toBe('export const answer = 42;\n');
    expect(restoredMath).toBe('export function double(n: number) { return n * 2; }\n');
    await expect(fs.stat(path.join(workerBDir, 'stale.txt'))).rejects.toThrow();
  });

  it('2. deduplicates content-addressed blobs within a checkpoint and across subsequent checkpoints', async () => {
    const sharedContent = 'export const SHARED_CONSTANT = "immutable-v1";\n';
    const cp1 = await createSampleCheckpointOnWorkerA({
      'packages/a/shared.ts': sharedContent,
      'packages/b/shared.ts': sharedContent,
      'packages/a/unique.ts': 'export const v = 1;\n',
    });

    const clientA = new CheckpointTransportClient({
      serverUrl,
      workerId: 'worker-a',
      transportSecret: clusterSecret,
    });

    const push1 = await clientA.pushCheckpoint(cp1);
    // 3 files, but 2 share identical content -> only 2 unique blobs uploaded
    expect(push1.uploadedBlobs.length).toBe(2);
    expect(push1.deduplicatedBlobs.length).toBe(0);
    expect(transportService.blobCount).toBe(2);

    // Create second checkpoint modifying only unique.ts while keeping both shared.ts files unchanged
    const cp2 = await createSampleCheckpointOnWorkerA({
      'packages/a/shared.ts': sharedContent,
      'packages/b/shared.ts': sharedContent,
      'packages/a/unique.ts': 'export const v = 2;\n',
    });

    const push2 = await clientA.pushCheckpoint(cp2);
    // Only the 1 changed blob is uploaded; the shared blob is already in the control-plane store
    expect(push2.uploadedBlobs.length).toBe(1);
    expect(push2.deduplicatedBlobs.length).toBe(1);
    expect(push2.receipt.deduplicatedBlobCount).toBe(1);
    expect(transportService.blobCount).toBe(3);
  });

  it('3. handles transfer interruption with bounded retry and resumable blob upload without re-sending verified blobs', async () => {
    const checkpoint = await createSampleCheckpointOnWorkerA({
      'file1.ts': 'content-1',
      'file2.ts': 'content-2',
      'file3.ts': 'content-3',
    });

    // Simulate a hard disconnect after the first blob is uploaded (maxRetries: 0 so first push fails mid-stream)
    let blobPutCalls = 0;
    const failingFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/v1/checkpoints/blobs/')) {
        blobPutCalls++;
        if (blobPutCalls === 2) {
          throw new Error('ECONNRESET: simulated network drop after blob 1');
        }
      }
      return fetch(input, init);
    };

    const nonRetryingClient = new CheckpointTransportClient({
      serverUrl,
      workerId: 'worker-a',
      transportSecret: clusterSecret,
      fetchFn: failingFetch,
      maxRetries: 0,
    });

    await expect(nonRetryingClient.pushCheckpoint(checkpoint)).rejects.toThrow(/ECONNRESET/);
    // Exactly 1 blob was stored before the network failure
    expect(transportService.blobCount).toBe(1);

    // Now resume with a client that also experiences 1 transient failure but retries automatically
    let transientFailureTriggered = false;
    const uploadedHashesOnResume: string[] = [];
    const resumingFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/v1/checkpoints/blobs/')) {
        if (!transientFailureTriggered) {
          transientFailureTriggered = true;
          return new Response(JSON.stringify({ error: '503 Service Temporarily Unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        uploadedHashesOnResume.push(url.split('/').pop()!);
      }
      return fetch(input, init);
    };

    const resumingClient = new CheckpointTransportClient({
      serverUrl,
      workerId: 'worker-a',
      transportSecret: clusterSecret,
      fetchFn: resumingFetch,
      maxRetries: 3,
      retryBackoffMs: 5,
    });

    const resumed = await resumingClient.pushCheckpoint(checkpoint);
    // Only the 2 remaining missing blobs were uploaded on resume; the 1st blob was deduplicated!
    expect(resumed.deduplicatedBlobs.length).toBe(1);
    expect(resumed.uploadedBlobs.length).toBe(2);
    expect(uploadedHashesOnResume.length).toBe(2);
    expect(resumed.retryAttempts).toBe(1);
    expect(transportService.blobCount).toBe(3);
  });

  it('4. rejects tampered blob content whose SHA-256 does not match its content-addressed hash', async () => {
    const expectedHash = computeBlobHash('legitimate file content');

    await expect(
      transportService.putBlob(expectedHash, 'tampered malicious content', {
        authToken: clusterSecret,
      }),
    ).rejects.toThrow(/CHECKPOINT_BLOB_HASH_MISMATCH/);

    // Also verify over the HTTP PUT route
    const response = await fetch(`${serverUrl}/api/v1/checkpoints/blobs/${expectedHash}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${clusterSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'tampered malicious content' }),
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as { code: string; error: string };
    expect(body.code).toBe('CHECKPOINT_BLOB_HASH_MISMATCH');
  });

  it('5. rejects commit and restoration when snapshotDigest is tampered', async () => {
    const checkpoint = await createSampleCheckpointOnWorkerA({
      'src/app.ts': 'console.log("safe");\n',
    });

    const packaged = transportService.packageCheckpoint(checkpoint, {
      sourceWorkerId: 'worker-a',
      transportSecret: clusterSecret,
    });

    // Tamper with snapshotDigest and re-sign manifest
    const tamperedManifest = {
      ...packaged.manifest,
      snapshotDigest: 'f'.repeat(64),
    };
    tamperedManifest.authSignature = signCheckpointManifest(tamperedManifest, clusterSecret);

    await transportService.registerManifest(tamperedManifest, { authToken: clusterSecret });
    for (const [hash, content] of Object.entries(packaged.blobs)) {
      await transportService.putBlob(hash, content, { authToken: clusterSecret });
    }

    await expect(
      transportService.commitCheckpoint(checkpoint.id, { authToken: clusterSecret }),
    ).rejects.toThrow(/CHECKPOINT_DIGEST_MISMATCH/);

    // Also verify reconstructCheckpoint rejects tampered bundle
    expect(() =>
      transportService.reconstructCheckpoint({
        manifest: tamperedManifest,
        blobs: packaged.blobs,
      }),
    ).toThrow(/CHECKPOINT_DIGEST_MISMATCH/);
  });

  it('6. rejects unauthenticated transfers and invalid HMAC signatures', async () => {
    const checkpoint = await createSampleCheckpointOnWorkerA({
      'src/index.ts': 'export default 1;\n',
    });

    // Client with no credentials
    const unauthClient = new CheckpointTransportClient({
      serverUrl,
      workerId: 'worker-a',
    });
    await expect(unauthClient.pushCheckpoint(checkpoint)).rejects.toThrow(
      /UNAUTHORIZED_CHECKPOINT_TRANSFER/,
    );

    // Client with wrong secret
    const wrongSecretClient = new CheckpointTransportClient({
      serverUrl,
      workerId: 'worker-a',
      transportSecret: 'wrong-secret-token',
    });
    await expect(wrongSecretClient.pushCheckpoint(checkpoint)).rejects.toThrow(
      /UNAUTHORIZED_CHECKPOINT_TRANSFER/,
    );

    // Valid bearer token but forged manifest HMAC signature
    const packaged = transportService.packageCheckpoint(checkpoint, {
      sourceWorkerId: 'worker-a',
      transportSecret: clusterSecret,
    });
    const forgedManifest = {
      ...packaged.manifest,
      authSignature: '0'.repeat(64),
    };
    await expect(
      transportService.registerManifest(forgedManifest, { authToken: clusterSecret }),
    ).rejects.toThrow(/UNAUTHORIZED_CHECKPOINT_TRANSFER/);

    // Stored manifest HMAC must NOT substitute for caller authentication on commit or getBundle (CLAUDE-01 H1)
    await transportService.registerManifest(packaged.manifest, { authToken: clusterSecret });
    for (const [hash, content] of Object.entries(packaged.blobs)) {
      await transportService.putBlob(hash, content, { authToken: clusterSecret });
    }
    await expect(transportService.commitCheckpoint(checkpoint.id)).rejects.toThrow(
      /UNAUTHORIZED_CHECKPOINT_TRANSFER/,
    );
    await transportService.commitCheckpoint(checkpoint.id, { authToken: clusterSecret });
    await expect(transportService.getBundle(checkpoint.id)).rejects.toThrow(
      /UNAUTHORIZED_CHECKPOINT_TRANSFER/,
    );
  });

  it('7. scrubs embedded secrets from descriptions, metadata, contextSnapshot, and planState in redact mode', async () => {
    const checkpoint = await createSampleCheckpointOnWorkerA(
      { 'src/clean.ts': 'export const ok = true;\n' },
      1,
      {
        description:
          'Checkpoint with Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret and OPENAI_API_KEY=sk-proj-1234567890abcdef',
        metadata: {
          safeField: 'keep-me',
          apiKey: 'sk-live-secret-value-999999',
          nestedEnv: {
            DATABASE_PASSWORD: 'super-secret-db-password',
            GITHUB_TOKEN: 'ghp_1234567890abcdefghijklmnopqrstuv',
            PRIVATE_KEY:
              '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----',
            PUBLIC_HOST: 'localhost:5432',
          },
        },
      },
    );
    checkpoint.contextSnapshot = {
      itemUris: ['src/clean.ts'],
      metadata: {
        client_secret: 'my-oauth-secret',
        inlineNote: 'Used token sk-abcdef1234567890abcdef during debug',
      },
    };

    const packaged = transportService.packageCheckpoint(checkpoint, {
      sourceWorkerId: 'worker-a',
      secretPolicy: 'redact',
    });

    expect(packaged.redactedSecretsCount).toBeGreaterThanOrEqual(6);
    expect(packaged.manifest.checkpointEnvelope.description).toContain('Bearer [REDACTED]');
    expect(packaged.manifest.checkpointEnvelope.description).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(packaged.manifest.checkpointEnvelope.description).not.toContain('sk-proj-1234567890abcdef');

    const meta = packaged.manifest.checkpointEnvelope.metadata as Record<string, any>;
    expect(meta.safeField).toBe('keep-me');
    expect(meta.apiKey).toBe('[REDACTED]');
    expect(meta.nestedEnv.DATABASE_PASSWORD).toBe('[REDACTED]');
    expect(meta.nestedEnv.GITHUB_TOKEN).toBe('[REDACTED]');
    expect(meta.nestedEnv.PRIVATE_KEY).toBe('[REDACTED]');
    expect(meta.nestedEnv.PUBLIC_HOST).toBe('localhost:5432');

    const ctxMeta = packaged.manifest.checkpointEnvelope.contextSnapshot?.metadata as Record<string, any>;
    expect(ctxMeta.client_secret).toBe('[REDACTED]');
    expect(ctxMeta.inlineNote).toContain('[REDACTED]');
    expect(ctxMeta.inlineNote).not.toContain('sk-abcdef1234567890abcdef');
  });

  it('8. rejects packaging checkpoints with embedded secrets when secretPolicy is set to reject', async () => {
    const checkpoint = await createSampleCheckpointOnWorkerA(
      { 'src/index.ts': 'export const x = 1;\n' },
      1,
      {
        metadata: {
          AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        },
      },
    );

    expect(() =>
      scrubCheckpointSecrets(checkpoint, 'reject'),
    ).toThrow(/CHECKPOINT_SECRET_DETECTED/);

    expect(() =>
      transportService.packageCheckpoint(checkpoint, {
        sourceWorkerId: 'worker-a',
        secretPolicy: 'reject',
      }),
    ).toThrow(/CHECKPOINT_SECRET_DETECTED/);
  });

  it('9. enforces maxFileBytes and maxCheckpointBytes limits', async () => {
    const strictTransport = new CheckpointTransportService({
      transportSecret: clusterSecret,
      maxFileBytes: 100,
      maxCheckpointBytes: 200,
    });

    const singleLargeFileCp = await createSampleCheckpointOnWorkerA({
      'large.txt': 'x'.repeat(150),
    });

    expect(() =>
      strictTransport.packageCheckpoint(singleLargeFileCp, {
        sourceWorkerId: 'worker-a',
      }),
    ).toThrow(/CHECKPOINT_FILE_TOO_LARGE/);

    await expect(
      strictTransport.putBlob(computeBlobHash('x'.repeat(150)), 'x'.repeat(150), {
        authToken: clusterSecret,
      }),
    ).rejects.toThrow(/CHECKPOINT_FILE_TOO_LARGE/);

    // Remove large.txt so it is not picked up by the next workspace snapshot
    await fs.rm(path.join(workerADir, 'large.txt'), { force: true });

    const multiFileCp = await createSampleCheckpointOnWorkerA({
      'part1.txt': 'a'.repeat(80),
      'part2.txt': 'b'.repeat(80),
      'part3.txt': 'c'.repeat(80),
    });

    expect(() =>
      strictTransport.packageCheckpoint(multiFileCp, {
        sourceWorkerId: 'worker-a',
      }),
    ).toThrow(/CHECKPOINT_SIZE_LIMIT_EXCEEDED/);
  });

  it('10. enforces maxStoredCheckpoints retention limit and garbage-collects unreferenced blobs', async () => {
    let clock = 1_700_000_000_000;
    const boundedTransport = new CheckpointTransportService({
      transportSecret: clusterSecret,
      maxStoredCheckpoints: 2,
      now: () => clock,
    });

    const pushToBounded = async (cp: Awaited<ReturnType<typeof createSampleCheckpointOnWorkerA>>) => {
      clock += 1000;
      const pkg = boundedTransport.packageCheckpoint(cp, { sourceWorkerId: 'worker-a' });
      await boundedTransport.registerManifest(pkg.manifest, { authToken: clusterSecret });
      for (const [hash, content] of Object.entries(pkg.blobs)) {
        await boundedTransport.putBlob(hash, content, { authToken: clusterSecret });
      }
      return boundedTransport.commitCheckpoint(cp.id, { authToken: clusterSecret });
    };

    const cp1 = await createSampleCheckpointOnWorkerA({ 'f.txt': 'only-in-cp1' });
    const cp2 = await createSampleCheckpointOnWorkerA({ 'f.txt': 'only-in-cp2' });
    const cp3 = await createSampleCheckpointOnWorkerA({ 'f.txt': 'only-in-cp3' });

    await pushToBounded(cp1);
    await pushToBounded(cp2);
    expect(boundedTransport.storedCheckpointCount).toBe(2);
    expect(boundedTransport.blobCount).toBe(2);

    await pushToBounded(cp3);
    // cp1 should be evicted and its unreferenced blob garbage-collected
    expect(boundedTransport.storedCheckpointCount).toBe(2);
    expect(boundedTransport.blobCount).toBe(2);
    expect(boundedTransport.hasBlob(computeBlobHash('only-in-cp1'))).toBe(false);
    expect(boundedTransport.hasBlob(computeBlobHash('only-in-cp2'))).toBe(true);
    expect(boundedTransport.hasBlob(computeBlobHash('only-in-cp3'))).toBe(true);
    await expect(
      boundedTransport.getBundle(cp1.id, { authToken: clusterSecret }),
    ).rejects.toThrow(/CHECKPOINT_NOT_FOUND/);
  });

  it('11. prunes expired checkpoints and blobs based on TTL', async () => {
    let clock = 1_700_000_000_000;
    const ttlTransport = new CheckpointTransportService({
      transportSecret: clusterSecret,
      defaultTtlMs: 5_000,
      now: () => clock,
    });

    const cp = await createSampleCheckpointOnWorkerA({ 'ephemeral.ts': 'const ttl = 5000;' });
    const pkg = ttlTransport.packageCheckpoint(cp, { sourceWorkerId: 'worker-a' });
    await ttlTransport.registerManifest(pkg.manifest, { authToken: clusterSecret });
    for (const [hash, content] of Object.entries(pkg.blobs)) {
      await ttlTransport.putBlob(hash, content, { authToken: clusterSecret });
    }
    await ttlTransport.commitCheckpoint(cp.id, { authToken: clusterSecret });
    expect(ttlTransport.storedCheckpointCount).toBe(1);

    // Advance clock past TTL
    clock += 6_000;
    const pruned = await ttlTransport.pruneExpired();
    expect(pruned.prunedCheckpoints).toEqual([cp.id]);
    expect(pruned.prunedBlobs).toBe(1);
    expect(ttlTransport.storedCheckpointCount).toBe(0);
    expect(ttlTransport.blobCount).toBe(0);
  });

  it('12. prevents restoring a stale checkpoint onto an execution with a newer workspaceRevision unless allowRollback is true', async () => {
    const checkpointR1 = await createSampleCheckpointOnWorkerA(
      { 'src/state.ts': 'export const rev = 1;\n' },
      1,
    );

    const clientA = new CheckpointTransportClient({
      serverUrl,
      workerId: 'worker-a',
      transportSecret: clusterSecret,
    });
    const clientB = new CheckpointTransportClient({
      serverUrl,
      workerId: 'worker-b',
      transportSecret: clusterSecret,
    });

    await clientA.pushCheckpoint(checkpointR1);

    // Target execution on Worker B is already at confirmed revision 3 (> checkpoint revision 1)
    await expect(
      clientB.pullAndMaterialize({
        checkpointId: checkpointR1.id,
        targetDir: workerBDir,
        checkpointService: checkpointServiceB,
        targetExecutionRevision: 3,
      }),
    ).rejects.toThrow(/STALE_CHECKPOINT_RESTORATION/);

    // Also verify service-level restoreOnTarget rejects stale checkpoint without allowRollback
    await expect(
      transportService.restoreOnTarget({
        checkpointId: checkpointR1.id,
        targetDir: workerBDir,
        checkpointService: checkpointServiceB,
        targetWorkerId: 'worker-b',
        targetExecutionRevision: 3,
        authToken: clusterSecret,
      }),
    ).rejects.toThrow(/STALE_CHECKPOINT_RESTORATION/);

    // Explicit operator allowRollback: true permits restoration
    const allowed = await clientB.pullAndMaterialize({
      checkpointId: checkpointR1.id,
      targetDir: workerBDir,
      checkpointService: checkpointServiceB,
      targetExecutionRevision: 3,
      allowRollback: true,
    });
    expect(allowed.checkpoint.workspaceRevision).toBe(1);
    expect(await fs.readFile(path.join(workerBDir, 'src/state.ts'), 'utf8')).toBe(
      'export const rev = 1;\n',
    );
  });

  it('13. preserves and validates sourceWorkerId and targetWorkerId identities across transfer receipts', async () => {
    const checkpoint = await createSampleCheckpointOnWorkerA({
      'src/identity.ts': 'export const node = "worker-a";\n',
    });

    const clientA = new CheckpointTransportClient({
      serverUrl,
      workerId: 'worker-a',
      transportSecret: clusterSecret,
    });
    await clientA.pushCheckpoint(checkpoint, {
      targetWorkerId: 'worker-b',
    });

    // Worker C attempting to pull a bundle restricted to worker-b is rejected with 403
    const clientC = new CheckpointTransportClient({
      serverUrl,
      workerId: 'worker-c',
      transportSecret: clusterSecret,
    });
    await expect(
      clientC.pullAndMaterialize({
        checkpointId: checkpoint.id,
        targetDir: workerBDir,
        checkpointService: checkpointServiceB,
      }),
    ).rejects.toThrow(/CHECKPOINT_TARGET_WORKER_MISMATCH/);

    // Worker B succeeds and receipt records sourceWorkerId, targetWorkerId, and downloadedByWorkerId
    const restored = await transportService.restoreOnTarget({
      checkpointId: checkpoint.id,
      targetDir: workerBDir,
      checkpointService: checkpointServiceB,
      targetWorkerId: 'worker-b',
      authToken: clusterSecret,
    });

    expect(restored.receipt?.sourceWorkerId).toBe('worker-a');
    expect(restored.receipt?.targetWorkerId).toBe('worker-b');
    expect(restored.receipt?.downloadedByWorkerId).toBe('worker-b');
    expect(restored.receipt?.restoredByWorkerId).toBe('worker-b');
    expect(restored.receipt?.restoredAt).toBeDefined();
  });

  it('14. rejects unsafe path traversal in checkpoint manifests and bundles', async () => {
    const checkpoint = await createSampleCheckpointOnWorkerA({
      'src/safe.ts': 'export const safe = true;\n',
    });

    const maliciousCheckpoint = structuredClone(checkpoint);
    maliciousCheckpoint.worktreeState.filesSnapshot['../escape.sh'] = '#!/bin/sh\necho pwned';

    expect(() =>
      transportService.packageCheckpoint(maliciousCheckpoint, {
        sourceWorkerId: 'worker-a',
      }),
    ).toThrow(/UNSAFE_CHECKPOINT_PATH/);

    // Also verify computeSnapshotDigest matches CheckpointService.computeDigest
    expect(
      computeSnapshotDigest(checkpoint.worktreeState.filesSnapshot, checkpoint.workspaceRevision),
    ).toBe(checkpointServiceA.computeDigest(checkpoint));
  });
});
