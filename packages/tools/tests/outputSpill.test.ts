import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SpillingBuffer } from '../src/outputSpill.js';
import { runShell } from '../src/process.js';

describe('SpillingBuffer', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('stays in memory (no file created) when output never crosses the threshold', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-spill-'));
    const buf = new SpillingBuffer({ runDir: dir, fileName: 'stdout.log', spillThresholdBytes: 1000, previewBytes: 500 });
    buf.push('hello world');
    const result = await buf.finish();
    expect(result.spilled).toBe(false);
    expect(result.filePath).toBeUndefined();
    expect(result.preview).toContain('hello world');
    expect(result.totalBytes).toBe(Buffer.byteLength('hello world'));
    await expect(fs.access(path.join(dir, 'stdout.log'))).rejects.toThrow();
  });

  it('spills to disk once the threshold is crossed, with the full content recoverable from the file', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-spill-'));
    const buf = new SpillingBuffer({ runDir: dir, fileName: 'stdout.log', spillThresholdBytes: 100, previewBytes: 50 });
    const chunk = 'x'.repeat(40);
    for (let i = 0; i < 10; i++) buf.push(chunk + `-${i}\n`);
    const result = await buf.finish();

    expect(result.spilled).toBe(true);
    expect(result.filePath).toBe(path.join(dir, 'stdout.log'));
    expect(result.preview).toContain(result.filePath!);
    expect(result.preview.length).toBeLessThan(result.totalBytes);

    const fileContents = await fs.readFile(result.filePath!, 'utf8');
    expect(fileContents.length).toBe(result.totalBytes);
    // The full content is still on disk even though the preview is truncated.
    expect(fileContents).toContain('x'.repeat(40) + '-0');
    expect(fileContents).toContain('x'.repeat(40) + '-9');
  });

  it('preview includes both head and tail once spilled, not just one end', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-spill-'));
    const buf = new SpillingBuffer({ runDir: dir, fileName: 'stdout.log', spillThresholdBytes: 50, previewBytes: 20 });
    buf.push('START-MARKER-'.padEnd(60, 'a'));
    buf.push('MIDDLE-'.repeat(20));
    buf.push('END-MARKER'.padStart(60, 'z'));
    const result = await buf.finish();

    expect(result.spilled).toBe(true);
    expect(result.preview).toContain('START-MARKER');
    expect(result.preview).toContain('END-MARKER');
    expect(result.preview).not.toContain('MIDDLE-MIDDLE-MIDDLE'); // omitted from the middle
  });
});

describe('runProcess output spilling (real subprocess)', () => {
  let projectDir: string;

  afterEach(async () => {
    if (projectDir) await fs.rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('does not kill a process whose output exceeds maxBuffer — it completes normally and stdout is spilled', async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-spill-proc-'));
    const result = await runShell(
      // ~200KB of output, well past a small maxBuffer, printed then a clean exit.
      'for i in $(seq 1 4000); do echo "line-$i-0123456789012345678901234567890123456789"; done; exit 0',
      { cwd: projectDir, projectRoot: projectDir, unsandboxed: true, maxBuffer: 10_000, runId: 'test-run' },
    );

    expect(result.code).toBe(0); // not killed
    expect(result.timedOut).toBe(false);
    expect(result.outputSpilled).toBe(true);
    expect(result.spillPaths?.stdout).toBeTruthy();

    const spilled = await fs.readFile(result.spillPaths!.stdout!, 'utf8');
    expect(spilled).toContain('line-1-');
    expect(spilled).toContain('line-4000-');
    expect(spilled.split('\n').length).toBeGreaterThan(3900);
  }, 15_000);

  it('places the spill file under .wazir/runs/<runId>/outputs/', async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-spill-proc-'));
    const result = await runShell(
      'for i in $(seq 1 2000); do echo "0123456789012345678901234567890123456789"; done',
      { cwd: projectDir, projectRoot: projectDir, unsandboxed: true, maxBuffer: 5_000, runId: 'my-run-id' },
    );
    expect(result.spillPaths?.stdout).toBe(
      path.join(projectDir, '.wazir', 'runs', 'my-run-id', 'outputs', 'stdout.log'),
    );
  }, 15_000);
});
