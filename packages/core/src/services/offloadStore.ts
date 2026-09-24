import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { OffloadedArtifact } from '../types/context.js';
import { estimateTokens } from './contextCompiler.js';

export interface OffloadStoreOptions {
  /**
   * Absolute path to the workspace root. Offloads are written to:
   *   <workspace>/.wazir/offload/<executionId>/<artifactId>.txt
   *
   * All paths are validated to stay inside the workspace boundary.
   */
  workspace: string;
  /**
   * Whether offloading to disk is enabled.
   * When disabled, offload() always returns undefined.
   * Default: true.
   */
  enabled?: boolean;
}

/**
 * Safe, namespaced store for tool-result artifacts that are too large for
 * model context.
 *
 * Security properties:
 * - All paths are validated to stay within the workspace root (no path traversal)
 * - Execution IDs and tool-call IDs are sanitized before use in paths
 * - Content hash (SHA-256) is recorded for integrity verification
 * - No network I/O — local filesystem only
 *
 * Invariant: offloading is a VIEW-LAYER concern.
 * The authoritative execution record (ExecutionEngine) is NEVER modified.
 * This store only materializes a retrievable copy for the model's use.
 */
export class OffloadStore {
  private readonly workspace: string;
  private readonly enabled: boolean;

  constructor(options: OffloadStoreOptions) {
    this.workspace = path.resolve(options.workspace);
    this.enabled = options.enabled ?? true;
  }

  /**
   * Offloads content to a namespaced directory inside .wazir/offload/.
   *
   * Returns the artifact metadata, or undefined on failure (never throws).
   * Failures are silent to never break the agent's tool execution path.
   */
  async offload(params: {
    executionId: string;
    toolCallId: string;
    toolName: string;
    content: string;
  }): Promise<OffloadedArtifact | undefined> {
    if (!this.enabled) return undefined;
    try {
      const safeExecId = this.sanitizePathSegment(params.executionId);
      const safeCallId = this.sanitizePathSegment(params.toolCallId);
      if (!safeExecId || !safeCallId) return undefined;

      const artifactId = `tool_result_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const relativeDir = path.join('.wazir', 'offload', safeExecId);
      const relativeFile = path.join(relativeDir, `${artifactId}.txt`);

      const absoluteDir = path.resolve(this.workspace, relativeDir);
      const absoluteFile = path.resolve(this.workspace, relativeFile);

      // Enforce workspace boundary
      if (!this.isInsideWorkspace(absoluteDir) || !this.isInsideWorkspace(absoluteFile)) {
        return undefined;
      }

      await mkdir(absoluteDir, { recursive: true });
      await writeFile(absoluteFile, params.content, 'utf8');

      const sha256 = createHash('sha256').update(params.content).digest('hex');
      const originalBytes = Buffer.byteLength(params.content, 'utf8');
      const originalTokens = estimateTokens(params.content);

      return {
        artifactId,
        executionId: params.executionId,
        toolCallId: params.toolCallId,
        toolName: params.toolName,
        sha256,
        originalTokens,
        originalBytes,
        offloadPath: relativeFile,
        createdAt: new Date(),
        contentType: 'tool_result',
      };
    } catch {
      // Never break the agent execution path on offload failure
      return undefined;
    }
  }

  /**
   * Retrieves the full content of an offloaded artifact.
   * Returns undefined if the file is missing or outside the workspace.
   */
  async retrieve(artifact: OffloadedArtifact): Promise<string | undefined> {
    try {
      const absolutePath = path.resolve(this.workspace, artifact.offloadPath);
      if (!this.isInsideWorkspace(absolutePath)) return undefined;
      return await readFile(absolutePath, 'utf8');
    } catch {
      return undefined;
    }
  }

  /**
   * Verifies that the stored content matches the recorded SHA-256 hash.
   * Used for integrity checks before presenting content to the model.
   */
  async verify(artifact: OffloadedArtifact): Promise<boolean> {
    const content = await this.retrieve(artifact);
    if (content === undefined) return false;
    const sha256 = createHash('sha256').update(content).digest('hex');
    return sha256 === artifact.sha256;
  }

  /**
   * Returns true if the given absolute path is strictly inside the workspace.
   * Prevents path traversal by checking the resolved path starts with workspace + sep.
   */
  private isInsideWorkspace(absolutePath: string): boolean {
    const resolved = path.resolve(absolutePath);
    return (
      resolved.startsWith(this.workspace + path.sep) ||
      resolved === this.workspace
    );
  }

  /**
   * Sanitizes a string for safe use as a path segment.
   * Only alphanumerics, hyphens, underscores, and dots are allowed.
   * Returns undefined if the result is empty or contains '..' (traversal attempt).
   */
  private sanitizePathSegment(segment: string): string | undefined {
    const clean = segment.replace(/[^a-zA-Z0-9\-_.]/g, '');
    if (!clean || clean.includes('..')) return undefined;
    return clean;
  }
}
