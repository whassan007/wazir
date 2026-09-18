import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveReference } from '../src/references.js';
import type { RookEngine } from '../src/engine.js';

/** Security review F-22: `@file:` references are contained to the project. */
describe('@file: reference containment', () => {
  let sandbox: string;
  afterEach(async () => {
    if (sandbox) await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('never reports existence of, or resolves to, a path outside the project root', async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-refs-'));
    const project = path.join(sandbox, 'project');
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(sandbox, 'outside.txt'), 'x');
    await fs.writeFile(path.join(project, 'inside.txt'), 'y');
    await fs.symlink(path.join(sandbox, 'outside.txt'), path.join(project, 'link.txt'));
    const engine = { projectRoot: project } as unknown as RookEngine;

    const inside = await resolveReference(engine, '@file:inside.txt');
    expect(inside).toMatchObject({ kind: 'file', exists: true });

    for (const raw of ['@file:../outside.txt', '@file:/etc/passwd', '@file:link.txt', `@file:${path.join(sandbox, 'outside.txt')}`]) {
      const resolved = await resolveReference(engine, raw);
      expect(resolved.kind, raw).toBe('file');
      expect((resolved as { exists: boolean }).exists, raw).toBe(false);
    }
  });
});
