import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JsonFileStore } from '@wazir/shared';
import type { RookEngine } from '../src/engine.js';
import { createBlock, listBlocks, getBlock } from '../src/blocks.js';
import { listHistory, inspectHistory } from '../src/commands.js';

const execFileAsync = promisify(execFile);
const dirname = path.dirname(fileURLToPath(import.meta.url));

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wazir-blocks-test-'));
}

/** blocks.ts only ever touches `engine.store` — no need to build a full RookEngine. */
function fakeEngine(store: JsonFileStore): RookEngine {
  return { store } as unknown as RookEngine;
}

describe('Block persistence (createBlock/getBlock)', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('round-trips through persistence: create -> finish -> reload via a fresh store instance', async () => {
    dir = await tempDir();
    const engine = fakeEngine(new JsonFileStore(path.join(dir, 'wazir.json')));

    const { block, finish } = await createBlock(engine, 'doctor', ['--json']);
    expect(block.status).toBe('running');
    expect(block.command).toBe('doctor');
    expect(block.argv).toEqual(['--json']);

    await finish('success', { stdout: 'all good', exitCode: 0, filesChanged: ['a.ts'] });

    // A completely separate JsonFileStore instance pointed at the same file —
    // proves this is really persisted to disk, not just held in the first
    // instance's in-memory map.
    const reopened = fakeEngine(new JsonFileStore(path.join(dir, 'wazir.json')));
    const reloaded = await getBlock(reopened, block.id);

    expect(reloaded).toBeDefined();
    expect(reloaded?.status).toBe('success');
    expect(reloaded?.stdout).toBe('all good');
    expect(reloaded?.exitCode).toBe(0);
    expect(reloaded?.filesChanged).toEqual(['a.ts']);
    expect(reloaded?.command).toBe('doctor');
    expect(typeof reloaded?.durationMs).toBe('number');
  });

  it('assigns sequential, increasing ids across multiple blocks', async () => {
    dir = await tempDir();
    const engine = fakeEngine(new JsonFileStore(path.join(dir, 'wazir.json')));

    const first = await createBlock(engine, 'doctor');
    await first.finish('success');
    const second = await createBlock(engine, 'status');
    await second.finish('success');

    expect(Number(second.block.id)).toBeGreaterThan(Number(first.block.id));
  });

  it('getBlock returns undefined for an unknown id', async () => {
    dir = await tempDir();
    const engine = fakeEngine(new JsonFileStore(path.join(dir, 'wazir.json')));
    expect(await getBlock(engine, 'does-not-exist')).toBeUndefined();
  });

  it('truncates stdout/stderr at 64KB rather than growing the store unbounded', async () => {
    dir = await tempDir();
    const engine = fakeEngine(new JsonFileStore(path.join(dir, 'wazir.json')));
    const huge = 'x'.repeat(200_000);

    const { block, finish } = await createBlock(engine, 'task run');
    await finish('success', { stdout: huge, stderr: huge });

    const reloaded = await getBlock(engine, block.id);
    expect(reloaded?.stdout.length).toBeLessThanOrEqual(64 * 1024);
    expect(reloaded?.stderr.length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe('listBlocks filtering', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('filters by status and by command substring, and sorts newest-first', async () => {
    dir = await tempDir();
    const engine = fakeEngine(new JsonFileStore(path.join(dir, 'wazir.json')));

    const a = await createBlock(engine, 'doctor');
    await a.finish('failed', { errors: ['runtime unavailable'] });
    const b = await createBlock(engine, 'task run');
    await b.finish('success');
    const c = await createBlock(engine, 'task plan');
    await c.finish('success');

    const failedOnly = await listBlocks(engine, { status: 'failed' });
    expect(failedOnly.map((x) => x.id)).toEqual([a.block.id]);
    expect(failedOnly[0].errors).toEqual(['runtime unavailable']);

    const taskCommands = await listBlocks(engine, { commandContains: 'task' });
    expect(taskCommands.map((x) => x.command).sort()).toEqual(['task plan', 'task run']);

    const all = await listBlocks(engine);
    expect(all.length).toBe(3);
    expect(all[0].id).toBe(c.block.id); // newest first
    expect(all[all.length - 1].id).toBe(a.block.id); // oldest last
  });

  it('returns an empty array when no blocks exist yet', async () => {
    dir = await tempDir();
    const engine = fakeEngine(new JsonFileStore(path.join(dir, 'wazir.json')));
    expect(await listBlocks(engine)).toEqual([]);
  });
});

describe('wa history rendering (listHistory/inspectHistory)', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('listHistory renders a table with the right columns and respects --status/--command', async () => {
    dir = await tempDir();
    const engine = fakeEngine(new JsonFileStore(path.join(dir, 'wazir.json')));

    const ok = await createBlock(engine, 'status');
    await ok.finish('success');
    const bad = await createBlock(engine, 'doctor');
    await bad.finish('failed');

    const full = await listHistory(engine);
    expect(full).toContain('status');
    expect(full).toContain('doctor');
    expect(full).toContain('success');
    expect(full).toContain('failed');

    const failedOnly = await listHistory(engine, { status: 'failed' });
    expect(failedOnly).toContain(bad.block.id);
    expect(failedOnly).not.toContain(ok.block.id);
    expect(failedOnly).not.toContain('success');

    const parsed = JSON.parse(await listHistory(engine, { json: true })) as Array<{ id: string }>;
    expect(parsed.length).toBe(2);
  });

  it('listHistory reports no history recorded yet on an empty store', async () => {
    dir = await tempDir();
    const engine = fakeEngine(new JsonFileStore(path.join(dir, 'wazir.json')));
    expect(await listHistory(engine)).toContain('no history recorded yet');
  });

  it('inspectHistory renders full Block detail, and a clear message for an unknown id', async () => {
    dir = await tempDir();
    const engine = fakeEngine(new JsonFileStore(path.join(dir, 'wazir.json')));

    const { block, finish } = await createBlock(engine, 'task run', ['fix the bug']);
    await finish('success', { stdout: 'done', exitCode: 0 });

    const detail = await inspectHistory(engine, block.id);
    expect(detail).toContain(`Block ${block.id}`);
    expect(detail).toContain('task run');
    expect(detail).toContain('success');
    expect(detail).toContain('exit code:   0');

    const asJson = JSON.parse(await inspectHistory(engine, block.id, true)) as { id: string; stdout: string };
    expect(asJson.id).toBe(block.id);
    expect(asJson.stdout).toBe('done');

    const missing = await inspectHistory(engine, 'no-such-id');
    expect(missing).toContain('not found');
  });
});

describe('doctorCommand — real end-to-end Block wiring', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('running the real, compiled `wa doctor` creates a retrievable Block with the actual output', async () => {
    dir = await tempDir();
    const cliEntry = path.resolve(dirname, '../dist/index.js');
    await fs.access(cliEntry).catch(() => {
      throw new Error(`${cliEntry} is missing — run \`npm run build\` before this test`);
    });

    // Point at unreachable runtime URLs so this test's outcome doesn't depend
    // on whatever happens to be running on the machine executing it.
    const env = {
      ...process.env,
      WAZIR_HOME: dir,
      WAZIR_COMPUTER_ID: `test-doctor-${Date.now()}`,
      WAZIR_OLLAMA_URL: 'http://127.0.0.1:1',
      WAZIR_LMSTUDIO_URL: 'http://127.0.0.1:1',
    };

    // `wa doctor` exits non-zero on WARN/FAIL checks (expected here, since
    // both runtimes are unreachable by design above) — only the Block being
    // written is under test, not doctor's own exit code.
    await execFileAsync(process.execPath, [cliEntry, 'doctor'], { env }).catch((err) => err);

    const store = new JsonFileStore(path.join(dir, 'wazir.json'));
    const engine = { store } as unknown as RookEngine;
    const blocks = await listBlocks(engine, { commandContains: 'doctor' });

    expect(blocks.length).toBe(1);
    expect(blocks[0].command).toBe('doctor');
    expect(['success', 'failed']).toContain(blocks[0].status);
    expect(blocks[0].stdout).toContain('Wazir Doctor');
    expect(typeof blocks[0].durationMs).toBe('number');
    expect(typeof blocks[0].exitCode).toBe('number');
  });
});
