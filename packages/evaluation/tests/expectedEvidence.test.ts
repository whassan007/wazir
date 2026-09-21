import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { evaluateExecution } from '../src/index.js';

describe('evaluateExecution with expectedEvidence', () => {
  it('verifies file_exists when file is in filesChanged', () => {
    const res = evaluateExecution(
      { filesChanged: ['src/main.cpp'], checks: [], errors: [] },
      { expectedEvidence: ['file_exists: src/main.cpp'] },
    );
    expect(res.success).toBe(true);
    expect(res.reasons.some((r) => r.includes("file 'src/main.cpp' exists"))).toBe(true);
  });

  it('verifies file_exists when file exists on disk in projectRoot', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-test-evidence-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'output.txt'), 'hello world');
      const res = evaluateExecution(
        { filesChanged: [], checks: [], errors: [] },
        { expectedEvidence: ['file_exists: output.txt'], projectRoot: tmpDir },
      );
      expect(res.success).toBe(true);
      expect(res.reasons.some((r) => r.includes("file 'output.txt' exists"))).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails file_exists when file neither changed nor exists on disk', () => {
    const res = evaluateExecution(
      { filesChanged: ['other.cpp'], checks: [], errors: [] },
      { expectedEvidence: ['file_exists: missing.cpp'] },
    );
    expect(res.success).toBe(false);
    expect(res.reasons.some((r) => r.includes("evidence missing: file 'missing.cpp' does not exist"))).toBe(true);
  });

  it('verifies check_passed when check passed', () => {
    const res = evaluateExecution(
      {
        filesChanged: ['src/app.ts'],
        checks: [{ name: 'test', command: 'npm test', ok: true, durationMs: 100 }],
        errors: [],
      },
      { expectedEvidence: ['check_passed: test'] },
    );
    expect(res.success).toBe(true);
    expect(res.reasons.some((r) => r.includes("check 'test' passed"))).toBe(true);
  });

  it('fails check_passed when check failed or missing', () => {
    const res = evaluateExecution(
      {
        filesChanged: ['src/app.ts'],
        checks: [{ name: 'test', command: 'npm test', ok: false, durationMs: 100 }],
        errors: [],
      },
      { expectedEvidence: ['check_passed: test'] },
    );
    expect(res.success).toBe(false);
  });

  it('verifies no_errors evidence', () => {
    const okRes = evaluateExecution(
      { filesChanged: ['src/app.ts'], checks: [], errors: [] },
      { expectedEvidence: ['no_errors'] },
    );
    expect(okRes.success).toBe(true);

    const failRes = evaluateExecution(
      { filesChanged: ['src/app.ts'], checks: [], errors: ['something crashed'] },
      { expectedEvidence: ['no_errors'] },
    );
    expect(failRes.success).toBe(false);
  });
});
