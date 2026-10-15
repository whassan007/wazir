import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

describe('one canonical version', () => {
  it('package.json is the version; the CLI dev fallback and workspace manifests agree with it', () => {
    const version = JSON.parse(read('package.json')).version;
    expect(read('apps/cli/src/index.ts')).toContain(`__WAZIR_VERSION__ : '${version}'`);
    for (const p of ['apps/cli/package.json', 'packages/core/package.json']) expect(JSON.parse(read(p)).version, p).toBe(version);
    expect(JSON.parse(read('package-lock.json')).version).toBe(version);
  });
});
