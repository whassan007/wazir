import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ObservationCompactor } from '../src/services/observationCompactor.js';
import { OffloadStore } from '../src/services/offloadStore.js';
import type { ToolResult } from '../src/types/tool.js';

describe('ObservationCompactor with Offload (Stage 3)', () => {
  let tmpWorkspace: string;
  let offloadStore: OffloadStore;
  let compactor: ObservationCompactor;

  beforeEach(async () => {
    tmpWorkspace = await mkdtemp(path.join(tmpdir(), 'wazir-compactor-test-'));
    offloadStore = new OffloadStore({ workspace: tmpWorkspace, enabled: true });
    compactor = new ObservationCompactor({
      toolResultMaxTokens: 100, // small limit to trigger offload easily in tests
      toolResultPreviewTokens: 30,
    });
  });

  afterEach(async () => {
    await rm(tmpWorkspace, { recursive: true, force: true });
  });

  it('passes tool result below threshold through verbatim without offloading', async () => {
    const smallOutput = 'Build completed successfully. 0 warnings, 0 errors.';
    const result: ToolResult = { ok: true, output: smallOutput };

    const observation = await compactor.compactWithOffload(
      'shell',
      { command: 'npm run build' },
      result,
      offloadStore,
      'exec-1',
      'call-1',
    );

    expect(observation.compacted).toBe(false);
    expect(observation.text).toBe(smallOutput);
    expect(observation.offloadArtifact).toBeUndefined();
    expect(observation.originalTokens).toBeLessThanOrEqual(100);
  });

  it('offloads oversized tool result and produces structured compact replacement', async () => {
    // Generate ~1500 chars (approx 375 tokens, well over 100 token limit)
    const longOutput = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: Compilation detail message with data`).join('\n');
    const result: ToolResult = { ok: true, output: longOutput };

    const observation = await compactor.compactWithOffload(
      'read',
      { path: 'src/heavy.ts' },
      result,
      offloadStore,
      'exec-1',
      'call-1',
    );

    expect(observation.compacted).toBe(true);
    expect(observation.offloadArtifact).toBeDefined();
    expect(observation.text).toContain('[Tool output compacted]');
    expect(observation.text).toContain('Tool: read');
    expect(observation.text).toContain('Reason: TOOL_RESULT_TOKEN_LIMIT');
    expect(observation.text).toContain(`Artifact: ${observation.offloadArtifact?.offloadPath}`);
    expect(observation.text).toContain(`SHA256: ${observation.offloadArtifact?.sha256}`);
    expect(observation.text).toContain('Use the read tool on the artifact path if additional details are required.');
  });

  it('retrieves full content byte-for-byte from the offload artifact', async () => {
    const hugeOutput = 'IMPORTANT_DATA_START\n' + 'A'.repeat(2000) + '\nIMPORTANT_DATA_END';
    const result: ToolResult = { ok: true, output: hugeOutput };

    const observation = await compactor.compactWithOffload(
      'shell',
      { command: 'cat data.txt' },
      result,
      offloadStore,
      'exec-2',
      'call-2',
    );

    expect(observation.offloadArtifact).toBeDefined();
    const retrieved = await offloadStore.retrieve(observation.offloadArtifact!);
    expect(retrieved).toBe(hugeOutput);

    const verified = await offloadStore.verify(observation.offloadArtifact!);
    expect(verified).toBe(true);
  });

  it('preserves compiler errors and exit codes in structured failure compaction', async () => {
    const compilerFailureOutput = [
      'src/index.ts(42,10): error TS2322: Type "number" is not assignable to type "string".',
      'src/utils.ts(15,5): error TS2304: Cannot find name "missingSymbol".',
      ...Array.from({ length: 50 }, (_, i) => `note: random build context line ${i}`),
      'Process exited with code 1',
    ].join('\n');

    const result: ToolResult = {
      ok: false,
      error: 'Command failed: tsc',
      output: compilerFailureOutput,
    };

    const observation = await compactor.compactWithOffload(
      'build',
      { command: 'tsc' },
      result,
      offloadStore,
      'exec-3',
      'call-3',
    );

    expect(observation.compacted).toBe(true);
    expect(observation.text).toContain('TS2322');
    expect(observation.text).toContain('src/index.ts');
    expect(observation.text).toContain('Artifact:');
  });

  it('preserves search query and match structure in search compaction', async () => {
    const searchOutput = Array.from({ length: 80 }, (_, i) => `src/file${i}.ts:${i + 1}: const token = "${i}";`).join('\n');
    const result: ToolResult = { ok: true, output: searchOutput };

    const observation = await compactor.compactWithOffload(
      'search',
      { query: 'token' },
      result,
      offloadStore,
      'exec-4',
      'call-4',
    );

    expect(observation.compacted).toBe(true);
    expect(observation.text).toContain('[Tool output compacted]');
    expect(observation.text).toContain('Tool: search');
    expect(observation.offloadArtifact).toBeDefined();
  });
});
