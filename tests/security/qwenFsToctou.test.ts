/**
 * A085 — Filesystem TOCTOU, Symlink Escape, Path Traversal & `multi_edit` Atomic Rollback Suite
 *
 * Tests across `edit` (`computeSmartEdit` + `editTool`), `multi_edit` (`multiEditTool`),
 * `read_many_files` (`readManyFilesTool`), `read` (`readTool`), and `write` (`writeTool`):
 *  1. Symlink file & directory escapes (`ln -s /tmp/outside-secret-<uuid> <workspace>/sneaky-link.ts`)
 *  2. `../` lexical path traversal (`../outside-secret-<uuid>`, `src/../../outside-secret-<uuid>`)
 *  3. Dangling out-of-workspace symlink write prevention (`ln -s /tmp/outside-new-<uuid> <workspace>/dangling.ts`)
 *  4. `multi_edit` partial-failure atomic rollback (when hunk N fails after hunks 0..N-1 match via
 *     exact/line_trimmed/block_anchor, zero bytes on disk change and zero temp files remain).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@wazir/core', () => import('../../packages/core/src/index.js'));

import { computeSmartEdit } from '../../packages/tools/src/editMatcher.js';
import { editTool, readTool, writeTool } from '../../packages/tools/src/filesystem.js';
import { multiEditTool } from '../../packages/tools/src/multiEdit.js';
import { PathEscapeError, readProjectFile, writeProjectFile } from '../../packages/tools/src/paths.js';
import { readManyFilesTool } from '../../packages/tools/src/readManyFiles.js';

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('A085 — Filesystem Symlink Escape, Path Traversal & Atomic Rollback Suite', () => {
  let workspaceDir: string;
  let outsideSecretFile: string;
  let outsideDir: string;
  let outsideNewTarget: string;
  let secretSentinel: string;
  let originalOutsideContent: string;
  let originalOutsideHash: string;

  beforeEach(() => {
    const id = randomUUID();
    workspaceDir = mkdtempSync(join(tmpdir(), `wazir-fs-ws-${id.slice(0, 8)}-`));
    outsideDir = mkdtempSync(join(tmpdir(), `wazir-fs-outside-dir-${id.slice(0, 8)}-`));
    outsideSecretFile = join(tmpdir(), `outside-secret-${id}.txt`);
    outsideNewTarget = join(tmpdir(), `outside-new-${id}.txt`);

    secretSentinel = `OUTSIDE_SECRET_SENTINEL_${id}`;
    originalOutsideContent = `export const apiKey = "${secretSentinel}";\n`;
    writeFileSync(outsideSecretFile, originalOutsideContent, 'utf8');
    originalOutsideHash = sha256(readFileSync(outsideSecretFile));

    writeFileSync(join(outsideDir, 'nested-secret.ts'), `// ${secretSentinel}\nexport const x = 1;\n`, 'utf8');

    mkdirSync(join(workspaceDir, 'src'), { recursive: true });
    writeFileSync(
      join(workspaceDir, 'src', 'legit.ts'),
      ['export function add(a: number, b: number): number {', '  return a + b;', '}', ''].join('\n'),
      'utf8',
    );

    // Plant file symlink, directory symlink, and dangling symlink escaping projectRoot
    symlinkSync(outsideSecretFile, join(workspaceDir, 'sneaky-link.ts'));
    symlinkSync(outsideDir, join(workspaceDir, 'sneaky-dir'));
    symlinkSync(outsideNewTarget, join(workspaceDir, 'dangling-outside.ts'));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
    rmSync(outsideSecretFile, { force: true });
    rmSync(outsideNewTarget, { force: true });
  });

  it('1. Blocks symlink escapes (`sneaky-link.ts`, `sneaky-dir/nested-secret.ts`, `dangling-outside.ts`) across read, read_many_files, edit, multi_edit, and write with zero outside bytes read or modified', async () => {
    const ctx = { projectRoot: workspaceDir };

    // readTool on symlink file & symlink dir child
    const readLink = await readTool.execute({ path: 'sneaky-link.ts' }, ctx);
    expect(readLink.ok).toBe(false);
    expect(readLink.error).toContain('escapes the project root');
    expect(readLink.output).not.toContain(secretSentinel);

    const readDirLink = await readTool.execute({ path: 'sneaky-dir/nested-secret.ts' }, ctx);
    expect(readDirLink.ok).toBe(false);
    expect(readDirLink.error).toContain('escapes the project root');
    expect(readDirLink.output).not.toContain(secretSentinel);

    // read_many_files mixed batch: legit file succeeds while sneaky-link.ts & sneaky-dir/nested-secret.ts fail safely
    const readMany = await readManyFilesTool.execute(
      { paths: ['src/legit.ts', 'sneaky-link.ts', 'sneaky-dir/nested-secret.ts'] },
      ctx,
    );
    expect(readMany.ok).toBe(true);
    expect(readMany.output).toContain('export function add');
    expect(readMany.output).toContain('escapes the project root');
    expect(readMany.output).not.toContain(secretSentinel);

    // editTool on sneaky-link.ts
    const editLink = await editTool.execute(
      {
        path: 'sneaky-link.ts',
        oldString: 'export const apiKey',
        newString: 'export const hacked',
      },
      ctx,
    );
    expect(editLink.ok).toBe(false);
    expect(editLink.error).toContain('escapes the project root');

    // multiEditTool on sneaky-link.ts
    const multiEditLink = await multiEditTool.execute(
      {
        path: 'sneaky-link.ts',
        edits: [{ oldString: 'export const apiKey', newString: 'export const pwned' }],
      },
      ctx,
    );
    expect(multiEditLink.ok).toBe(false);
    expect(multiEditLink.error).toContain('escapes the project root');

    // writeTool on sneaky-link.ts, sneaky-dir/new-outside.ts, and dangling-outside.ts
    const writeLink = await writeTool.execute({ path: 'sneaky-link.ts', content: 'OVERWRITTEN' }, ctx);
    expect(writeLink.ok).toBe(false);
    expect(writeLink.error).toContain('escapes the project root');

    const writeThroughSymlinkDir = await writeTool.execute(
      { path: 'sneaky-dir/new-outside.ts', content: 'CREATED_OUTSIDE_VIA_DIR_SYMLINK' },
      ctx,
    );
    expect(writeThroughSymlinkDir.ok).toBe(false);
    expect(writeThroughSymlinkDir.error).toContain('escapes the project root');
    expect(existsSync(join(outsideDir, 'new-outside.ts'))).toBe(false);

    // Atomic rename over a dangling symlink in projectRoot never follows the symlink target outside:
    // outsideNewTarget is NEVER created, and the symlink inside projectRoot is replaced in-place by a regular file.
    const writeDangling = await writeTool.execute({ path: 'dangling-outside.ts', content: 'CREATED_OUTSIDE' }, ctx);
    expect(existsSync(outsideNewTarget)).toBe(false);
    if (writeDangling.ok) {
      expect(lstatSync(join(workspaceDir, 'dangling-outside.ts')).isSymbolicLink()).toBe(false);
    }

    // Outside file remains 100% byte-identical
    expect(sha256(readFileSync(outsideSecretFile))).toBe(originalOutsideHash);
    expect(readFileSync(outsideSecretFile, 'utf8')).toBe(originalOutsideContent);
  });

  it('2. Blocks `../` path traversal across read, read_many_files, edit, multi_edit, and write', async () => {
    const ctx = { projectRoot: workspaceDir };
    const relEscape = `../${outsideSecretFile.split('/').pop()!}`;
    const nestedRelEscape = `src/../../${outsideSecretFile.split('/').pop()!}`;

    for (const traversalPath of [relEscape, nestedRelEscape, outsideSecretFile]) {
      const r1 = await readTool.execute({ path: traversalPath }, ctx);
      expect(r1.ok).toBe(false);
      expect(r1.output).not.toContain(secretSentinel);

      const r2 = await editTool.execute(
        { path: traversalPath, oldString: 'export', newString: 'const' },
        ctx,
      );
      expect(r2.ok).toBe(false);

      const r3 = await multiEditTool.execute(
        { path: traversalPath, edits: [{ oldString: 'export', newString: 'const' }] },
        ctx,
      );
      expect(r3.ok).toBe(false);

      const r4 = await writeTool.execute({ path: traversalPath, content: 'pwn' }, ctx);
      expect(r4.ok).toBe(false);
    }

    const batchRes = await readManyFilesTool.execute({ paths: [relEscape, nestedRelEscape] }, ctx);
    expect(batchRes.output).not.toContain(secretSentinel);
    expect(batchRes.output).toContain('escapes the project root');
    expect(sha256(readFileSync(outsideSecretFile))).toBe(originalOutsideHash);
  });

  it('3. Enforces O_NOFOLLOW + inode re-verification when a workspace file is swapped for an external symlink', async () => {
    const victimRel = 'src/swapped.ts';
    const victimAbs = join(workspaceDir, victimRel);
    writeFileSync(victimAbs, 'export const safe = 1;\n', 'utf8');

    const legit = await readProjectFile(workspaceDir, victimRel);
    expect(legit.content).toBe('export const safe = 1;\n');

    // Simulate attacker replacing src/swapped.ts with a symlink to outsideSecretFile
    unlinkSync(victimAbs);
    symlinkSync(outsideSecretFile, victimAbs);

    await expect(readProjectFile(workspaceDir, victimRel)).rejects.toThrow(PathEscapeError);
    await expect(writeProjectFile(workspaceDir, victimRel, 'TAMPERED')).rejects.toThrow(PathEscapeError);
    expect(sha256(readFileSync(outsideSecretFile))).toBe(originalOutsideHash);
  });

  it('4. Guarantees `multi_edit` partial-failure atomic rollback (zero partial writes, zero temp leftovers, exact pre-call bytes preserved)', async () => {
    const targetRel = 'src/service.ts';
    const targetAbs = join(workspaceDir, targetRel);
    const initialContent = [
      'export class OrderService {',
      '  private retries = 2;',
      '',
      '  computeTotal(items: number[], taxRate: number): number {',
      '    const subtotal = items.reduce((acc, n) => acc + n, 0);',
      '    return subtotal * (1 + taxRate);',
      '  }',
      '',
      '  formatStatus(code: number): string {',
      '    return code === 200 ? "OK" : "ERR";',
      '  }',
      '}',
      '',
    ].join('\n');
    writeFileSync(targetAbs, initialContent, 'utf8');
    const beforeBytes = readFileSync(targetAbs);
    const beforeHash = sha256(beforeBytes);
    const beforeMode = statSync(targetAbs).mode;

    // Case A: Hunk 0 (exact) + Hunk 1 (Stage 2 line_trimmed) succeed in memory, Hunk 2 fails (missing target)
    const failedMissing = await multiEditTool.execute(
      {
        path: targetRel,
        edits: [
          {
            oldString: '  private retries = 2;',
            newString: '  private retries = 5;',
          },
          {
            // Shifted indentation -> matches via Stage 2 line_trimmed in memory
            oldString: 'const subtotal = items.reduce((acc, n) => acc + n, 0);\nreturn subtotal * (1 + taxRate);',
            newString: 'const subtotal = items.reduce((acc, n) => acc + n, 0);\nreturn Math.round(subtotal * (1 + taxRate) * 100) / 100;',
          },
          {
            oldString: 'nonExistentMethodThatCausesRollback()',
            newString: 'replacement()',
          },
        ],
      },
      { projectRoot: workspaceDir },
    );

    expect(failedMissing.ok).toBe(false);
    expect(failedMissing.error).toContain('multi_edit failed at edits[2] (file left unmodified)');
    expect(failedMissing.fileMutations?.[0]?.changed).toBe(false);
    expect(sha256(readFileSync(targetAbs))).toBe(beforeHash);
    expect(readFileSync(targetAbs).equals(beforeBytes)).toBe(true);
    expect(statSync(targetAbs).mode).toBe(beforeMode);

    // Case B: Hunk 0 succeeds in memory, Hunk 1 fails due to ambiguous multi-match without replaceAll
    const failedAmbiguous = await multiEditTool.execute(
      {
        path: targetRel,
        edits: [
          {
            oldString: '  private retries = 2;',
            newString: '  private retries = 9;',
          },
          {
            oldString: 'number', // appears multiple times without replaceAll: true
            newString: 'bigint',
          },
        ],
      },
      { projectRoot: workspaceDir },
    );

    expect(failedAmbiguous.ok).toBe(false);
    expect(failedAmbiguous.error).toContain('multi_edit failed at edits[1]');
    expect(sha256(readFileSync(targetAbs))).toBe(beforeHash);

    // Ensure no `.wazir-*.tmp` files were leaked in `src/`
    const dirEntries = readdirSync(join(workspaceDir, 'src'));
    expect(dirEntries).toEqual(['legit.ts', 'service.ts']);

    // Sanity check computeSmartEdit Stage 3 block_anchor still works cleanly when all hunks are valid
    const smartRes = computeSmartEdit(
      initialContent,
      [
        'computeTotal(items: number[], taxRate: number): number {',
        '  const   subtotal = items.reduce((acc, n) => acc + n, 0);',
        '  return subtotal * (1 + taxRate);',
        '}',
      ].join('\n'),
      [
        'computeTotal(items: number[], taxRate: number): number {',
        '  const subtotal = items.reduce((acc, n) => acc + n, 0);',
        '  return subtotal + subtotal * taxRate;',
        '}',
      ].join('\n'),
    );
    expect(smartRes.ok).toBe(true);
    if (smartRes.ok) {
      expect(smartRes.strategyUsed).toBe('block_anchor');
    }
  });

  it('5. Supports root-level dotfile writes/edits (.env.example) without false PathEscapeError while Layer 1 PolicyEngine denies symlink escapes', async () => {
    const dotfileWrite = await writeTool.execute(
      { path: '.env.example', content: 'PORT=3000\nLOG_LEVEL=info\n' },
      { projectRoot: workspaceDir },
    );
    expect(dotfileWrite.ok).toBe(true);

    const dotfileEdit = await editTool.execute(
      { path: '.env.example', oldString: 'PORT=3000', newString: 'PORT=8080' },
      { projectRoot: workspaceDir },
    );
    expect(dotfileEdit.ok).toBe(true);
    expect(readFileSync(join(workspaceDir, '.env.example'), 'utf8')).toContain('PORT=8080');

    // Layer 1 PolicyEngine realpath containment denies symlink escape directly
    const sneakyLink = join(workspaceDir, 'layer1-sneaky.ts');
    symlinkSync(outsideSecretFile, sneakyLink);
    const { PolicyEngine } = await import('@wazir/core');
    const policy = new PolicyEngine({ projectRoot: workspaceDir });
    const l1Read = policy.classify({
      tool: 'read',
      input: { path: 'layer1-sneaky.ts' },
      projectRoot: workspaceDir,
    });
    expect(l1Read.decision).toBe('deny');
    expect(l1Read.rule).toBe('filesystem-outside-deny');
  });
});
