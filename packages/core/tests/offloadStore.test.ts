import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { OffloadStore } from '../src/services/offloadStore.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'wazir-offload-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('OffloadStore', () => {
  it('stores content and returns artifact metadata', async () => {
    const store = new OffloadStore({ workspace: tmpDir });
    const content = 'a'.repeat(50000);
    const artifact = await store.offload({
      executionId: 'exec-001',
      toolCallId: 'call-001',
      toolName: 'shell',
      content,
    });
    expect(artifact).toBeDefined();
    expect(artifact!.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(artifact!.originalBytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(artifact!.offloadPath).toContain('.wazir');
    expect(artifact!.offloadPath).toContain('offload');
    expect(artifact!.contentType).toBe('tool_result');
    expect(artifact!.executionId).toBe('exec-001');
    expect(artifact!.toolName).toBe('shell');
  });

  it('retrieves content byte-for-byte', async () => {
    const store = new OffloadStore({ workspace: tmpDir });
    const content = 'Hello\nWorld\n' + 'x'.repeat(10000);
    const artifact = await store.offload({
      executionId: 'exec-002',
      toolCallId: 'call-002',
      toolName: 'read',
      content,
    });
    expect(artifact).toBeDefined();
    const retrieved = await store.retrieve(artifact!);
    expect(retrieved).toBe(content);
  });

  it('verifies content hash matches stored artifact', async () => {
    const store = new OffloadStore({ workspace: tmpDir });
    const content = 'test content for hash verification';
    const artifact = await store.offload({
      executionId: 'exec-003',
      toolCallId: 'call-003',
      toolName: 'shell',
      content,
    });
    expect(artifact).toBeDefined();
    expect(await store.verify(artifact!)).toBe(true);
  });

  it('returns false from verify when artifact is missing', async () => {
    const store = new OffloadStore({ workspace: tmpDir });
    const artifact = {
      artifactId: 'nonexistent',
      executionId: 'exec-004',
      toolCallId: 'call-004',
      toolName: 'shell',
      sha256: 'abc123',
      originalTokens: 1000,
      originalBytes: 4000,
      offloadPath: '.wazir/offload/exec-004/nonexistent.txt',
      createdAt: new Date(),
      contentType: 'tool_result' as const,
    };
    expect(await store.verify(artifact)).toBe(false);
  });

  it('prevents path traversal in executionId', async () => {
    const store = new OffloadStore({ workspace: tmpDir });
    const artifact = await store.offload({
      executionId: '../../../etc',
      toolCallId: 'call-001',
      toolName: 'shell',
      content: 'malicious',
    });
    // Either returns undefined (sanitization removes the segment) or the path is contained
    if (artifact) {
      const abs = path.resolve(tmpDir, artifact.offloadPath);
      expect(abs.startsWith(tmpDir)).toBe(true);
      expect(artifact.offloadPath).not.toContain('..');
    }
    // If undefined, sanitization correctly blocked it — both outcomes are valid
  });

  it('prevents path traversal in toolCallId', async () => {
    const store = new OffloadStore({ workspace: tmpDir });
    // The toolCallId is not used in the path, but sanity-check anyway
    const artifact = await store.offload({
      executionId: 'exec-001',
      toolCallId: '../../evil',
      toolName: 'shell',
      content: 'evil content',
    });
    if (artifact) {
      const abs = path.resolve(tmpDir, artifact.offloadPath);
      expect(abs.startsWith(tmpDir)).toBe(true);
    }
  });

  it('returns undefined when disabled', async () => {
    const store = new OffloadStore({ workspace: tmpDir, enabled: false });
    const artifact = await store.offload({
      executionId: 'exec-001',
      toolCallId: 'call-001',
      toolName: 'shell',
      content: 'any content',
    });
    expect(artifact).toBeUndefined();
  });

  it('returns undefined from retrieve for paths outside workspace', async () => {
    const store = new OffloadStore({ workspace: tmpDir });
    const outsideArtifact = {
      artifactId: 'evil',
      executionId: 'exec-001',
      toolCallId: 'call-001',
      toolName: 'shell',
      sha256: 'abc',
      originalTokens: 100,
      originalBytes: 400,
      offloadPath: '../../../etc/passwd',
      createdAt: new Date(),
      contentType: 'tool_result' as const,
    };
    const content = await store.retrieve(outsideArtifact);
    expect(content).toBeUndefined();
  });

  it('namespaces artifacts by executionId', async () => {
    const store = new OffloadStore({ workspace: tmpDir });
    const a1 = await store.offload({
      executionId: 'exec-A',
      toolCallId: 'call-1',
      toolName: 'shell',
      content: 'content A',
    });
    const a2 = await store.offload({
      executionId: 'exec-B',
      toolCallId: 'call-1',
      toolName: 'shell',
      content: 'content B',
    });
    expect(a1).toBeDefined();
    expect(a2).toBeDefined();
    expect(a1!.offloadPath).toContain('exec-A');
    expect(a2!.offloadPath).toContain('exec-B');
    expect(a1!.offloadPath).not.toBe(a2!.offloadPath);
  });

  it('records originalTokens using estimateTokens (chars/4)', async () => {
    const store = new OffloadStore({ workspace: tmpDir });
    const content = 'a'.repeat(4000);  // exactly 1000 tokens at chars/4
    const artifact = await store.offload({
      executionId: 'exec-001',
      toolCallId: 'call-001',
      toolName: 'shell',
      content,
    });
    expect(artifact).toBeDefined();
    expect(artifact!.originalTokens).toBe(1000);
  });
});
