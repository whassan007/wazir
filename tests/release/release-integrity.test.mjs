import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertUniqueArtifacts, validateVersion, verifyChecksums } from '../../scripts/release-integrity.mjs';
import { validateCachedEvidence } from '../../scripts/release-gate.mjs';

const { describe, it } = process.env.VITEST ? await import('vitest') : await import('node:test');

describe('release integrity checks', () => {
  for (const v of ['1.2.3', '0.1.66', '2.0.0-rc.1']) {
    it(`accepts semver ${v}`, () => {
      assert.doesNotThrow(() => validateVersion(v));
    });
  }
  for (const v of ['1.2', 'v1.2.3', '01.2.3', '1.2.3.4']) {
    it(`rejects malformed version ${v}`, () => {
      assert.throws(() => validateVersion(v));
    });
  }
  it('rejects prereleases when stable is required', () => {
    assert.throws(() => validateVersion('1.2.3-rc.1', { requireStable: true }));
  });
  it('detects missing and corrupt artifacts', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wazir-release-test-'));
    writeFileSync(path.join(dir, 'artifact.tgz'), 'correct');
    const hash = createHash('sha256').update('correct').digest('hex');
    writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${hash}  artifact.tgz\n`);
    assert.equal(verifyChecksums(dir), true);
    writeFileSync(path.join(dir, 'artifact.tgz'), 'corrupt');
    assert.throws(() => verifyChecksums(dir), /checksum mismatch/);
  });
  it('rejects duplicate artifact basenames', () => {
    assert.throws(() => assertUniqueArtifacts(['/a/x.tgz', '/b/x.tgz']), /duplicate/);
  });
  it('validates cached release-gate evidence against source version, commit, and bundle hash', () => {
    const expected = { version: '0.4.1', commit: 'abc123', bundleSha256: 'deadbeef' };
    assert.equal(validateCachedEvidence({ version: '0.4.1', commit: 'abc123', hostId: 'linux-x64', bundleSha256: 'deadbeef' }, expected, 'linux-x64'), true);
    assert.equal(validateCachedEvidence({ version: '0.4.0', commit: 'abc123', hostId: 'linux-x64' }, expected, 'linux-x64'), false);
    assert.equal(validateCachedEvidence({ version: '0.4.1', commit: 'oldsha', hostId: 'linux-x64' }, expected, 'linux-x64'), false);
    assert.equal(validateCachedEvidence({ version: '0.4.1', commit: 'abc123', hostId: 'darwin-arm64' }, expected, 'linux-x64'), false);
    assert.equal(validateCachedEvidence({ version: '0.4.1', commit: 'abc123', hostId: 'linux-x64', bundleSha256: 'stale' }, expected, 'linux-x64'), false);
  });
});
