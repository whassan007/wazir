import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonFileStore } from '@wazir/shared';
import { GOAL_STORE_KEYS, GoalStudioFailure } from '../../src/contracts.js';
import { canonicalJson, promptDigest, sha256Hex, verifyPromptIntegrity, isPromptAdmin } from '../../src/prompts/index.js';
import { makeStudio, SELECT_DRAFT, storeWithoutUpdate } from './helpers.js';

async function failure(promise: Promise<unknown>): Promise<GoalStudioFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GoalStudioFailure);
    return error as GoalStudioFailure;
  }
  throw new Error('expected a GoalStudioFailure');
}

describe('prompt store: versions', () => {
  it('creates version 1 with a content digest and provenance', async () => {
    const { studio, store } = makeStudio();
    const { prompt, created } = await studio.create(SELECT_DRAFT, 'user:alice');
    expect(created).toBe(true);
    expect(prompt).toMatchObject({ id: 'select_target', version: 1, executorKey: 'select_target', createdBy: 'user:alice', source: 'publish' });
    expect(prompt.requiredCapabilities).toEqual(['generalChat', 'reasoning']); // sorted, deduped
    expect(prompt.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(prompt.digest).toBe(promptDigest(prompt));
    expect(verifyPromptIntegrity(prompt)).toBe(true);
    // stored at the contract key
    expect(await store.get(GOAL_STORE_KEYS.prompt('select_target', 1))).toMatchObject({ version: 1 });
    expect(await store.get(GOAL_STORE_KEYS.promptHead('select_target'))).toMatchObject({ promptId: 'select_target', version: 1 });
    expect(isPromptAdmin(studio)).toBe(true);
  });

  it('digest is sha256 of canonical content and ignores key order and provenance', async () => {
    const { prompt } = await makeStudio().studio.publish(SELECT_DRAFT, 'a');
    const reordered = { requiredCapabilities: ['generalChat', 'reasoning'], outputSchema: SELECT_DRAFT.outputSchema, inputSchema: SELECT_DRAFT.inputSchema, template: SELECT_DRAFT.template, role: SELECT_DRAFT.role, executorKey: 'select_target' };
    expect(prompt.digest).toBe(sha256Hex(canonicalJson(reordered)));
    const { prompt: other } = await makeStudio().studio.publish({ ...SELECT_DRAFT, note: 'different note' }, 'b');
    expect(other.digest).toBe(prompt.digest);
  });

  it('publishes monotonic immutable versions and treats identical content as a no-op', async () => {
    const { studio } = makeStudio();
    await studio.publish(SELECT_DRAFT, 'a');
    const v2 = await studio.publish({ ...SELECT_DRAFT, template: `${SELECT_DRAFT.template}\nBe concise.` }, 'b');
    expect(v2).toMatchObject({ created: true, prompt: { version: 2, parentVersion: 1 } });
    const same = await studio.publish({ ...SELECT_DRAFT, template: `${SELECT_DRAFT.template}\nBe concise.` }, 'c');
    expect(same.created).toBe(false);
    expect(same.prompt.version).toBe(2);
    expect((await studio.history('select_target')).map((v) => v.version)).toEqual([1, 2]);
    expect((await studio.latest('select_target'))?.version).toBe(2);
    expect((await studio.get('select_target', 1))?.template).toBe(SELECT_DRAFT.template);
  });

  it('returned records are copies; mutating them never changes stored history', async () => {
    const { studio } = makeStudio();
    const { prompt } = await studio.publish(SELECT_DRAFT, 'a');
    prompt.template = 'tampered';
    (prompt.requiredCapabilities as string[]).push('x');
    const fetched = await studio.get('select_target', 1);
    expect(fetched?.template).toBe(SELECT_DRAFT.template);
    fetched!.role = 'tampered';
    expect((await studio.get('select_target', 1))?.role).toBe('portfolio_scheduler');
  });

  it('create rejects an existing prompt; executorKey is bound to one prompt id and cannot change', async () => {
    const { studio } = makeStudio();
    await studio.create(SELECT_DRAFT, 'a');
    expect((await failure(studio.create(SELECT_DRAFT, 'a'))).code).toBe('DUPLICATE');
    expect((await failure(studio.publish({ ...SELECT_DRAFT, id: 'other' }, 'a'))).code).toBe('DUPLICATE');
    expect((await failure(studio.publish({ ...SELECT_DRAFT, id: 'select_target', executorKey: 'plan_target' }, 'a'))).code).toBe('VALIDATION');
  });

  it('enforces expectedVersion for optimistic concurrency', async () => {
    const { studio } = makeStudio();
    await studio.publish({ ...SELECT_DRAFT, expectedVersion: 0 }, 'a');
    const conflict = await failure(studio.publish({ ...SELECT_DRAFT, template: 'x {{a}}', expectedVersion: 0 }, 'a'));
    expect(conflict.code).toBe('LEDGER_CONFLICT');
    expect((await studio.publish({ ...SELECT_DRAFT, template: 'x {{a}}', expectedVersion: 1 }, 'a')).prompt.version).toBe(2);
  });

  it('validates drafts', async () => {
    const { studio } = makeStudio();
    const bad = [
      { ...SELECT_DRAFT, executorKey: '../escape' },
      { ...SELECT_DRAFT, executorKey: 'a/b' },
      { ...SELECT_DRAFT, role: '' },
      { ...SELECT_DRAFT, template: '   ' },
      { ...SELECT_DRAFT, inputSchema: { type: 'not-a-type' } },
      { ...SELECT_DRAFT, outputSchema: [] as unknown as Record<string, unknown> },
      { ...SELECT_DRAFT, requiredCapabilities: [''] },
      { ...SELECT_DRAFT, template: 'x'.repeat(70 * 1024) },
    ];
    for (const draft of bad) expect((await failure(studio.publish(draft, 'a'))).code).toBe('VALIDATION');
    expect((await failure(studio.publish(SELECT_DRAFT, ''))).code).toBe('VALIDATION');
    expect(await studio.list()).toEqual([]);
  });

  it('reports lint warnings without blocking publish', async () => {
    const { studio } = makeStudio();
    const result = await studio.publish({ ...SELECT_DRAFT, template: 'Use {{target_ledger}} and {{undeclared}}' }, 'a');
    expect(result.created).toBe(true);
    expect(result.warnings.join('\n')).toMatch(/undeclared/);
    expect(result.warnings.join('\n')).toMatch(/resource_limits/);
  });

  it('lists prompts with summaries and returns undefined/NOT_FOUND for unknown ids', async () => {
    const { studio } = makeStudio();
    await studio.publish(SELECT_DRAFT, 'a');
    await studio.publish({ executorKey: 'plan_target', role: 'task_planner', template: 'Plan {{target}}' }, 'a');
    const list = await studio.list();
    expect(list.map((item) => item.promptId)).toEqual(['plan_target', 'select_target']);
    expect(list[1]).toMatchObject({ latestVersion: 1, hasInputSchema: true, hasOutputSchema: true, requiredCapabilities: ['generalChat', 'reasoning'] });
    expect(await studio.get('nope', 1)).toBeUndefined();
    expect(await studio.get('../x', 1)).toBeUndefined();
    expect(await studio.latest('nope')).toBeUndefined();
    expect((await failure(studio.resolve({ promptId: 'nope', version: 1 }))).code).toBe('NOT_FOUND');
    expect((await failure(studio.diff('select_target', 1, 9))).code).toBe('NOT_FOUND');
  });

  it('emits a prompt.version event per new version', async () => {
    const events: unknown[] = [];
    const { studio } = makeStudio({ onEvent: (event) => { events.push(event); } });
    await studio.publish(SELECT_DRAFT, 'a');
    await studio.publish(SELECT_DRAFT, 'a');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'prompt.version', data: { promptId: 'select_target', version: 1 } });
  });
});

describe('prompt store: concurrency', () => {
  async function concurrentPublish(studio: ReturnType<typeof makeStudio>['studio']) {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => studio.publish({ ...SELECT_DRAFT, template: `${SELECT_DRAFT.template}\nvariant ${i}` }, `w${i}`)));
    const versions = results.map((r) => r.prompt.version).sort((a, b) => a - b);
    expect(versions).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    const history = await studio.history('select_target');
    expect(history.map((v) => v.version)).toEqual(versions);
    expect(new Set(history.map((v) => v.digest)).size).toBe(12);
    expect((await studio.latest('select_target'))?.version).toBe(12);
  }

  it('concurrent publishers get distinct monotonic versions (MemoryStore with update)', async () => {
    await concurrentPublish(makeStudio().studio);
  });

  it('concurrent publishers get distinct monotonic versions (store without update)', async () => {
    await concurrentPublish(makeStudio({ store: storeWithoutUpdate() }).studio);
  });

  it('two independent store instances on one JsonFileStore file never share a version slot', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wazir-prompts-'));
    try {
      const file = path.join(dir, 'store.json');
      const a = makeStudio({ store: new JsonFileStore(file) }).studio;
      const b = makeStudio({ store: new JsonFileStore(file) }).studio;
      const results = await Promise.all([
        a.publish({ ...SELECT_DRAFT, template: 'A {{x}}' }, 'a'),
        b.publish({ ...SELECT_DRAFT, template: 'B {{x}}' }, 'b'),
        a.publish({ ...SELECT_DRAFT, template: 'C {{x}}' }, 'a'),
        b.publish({ ...SELECT_DRAFT, template: 'D {{x}}' }, 'b'),
      ]);
      expect(results.map((r) => r.prompt.version).sort()).toEqual([1, 2, 3, 4]);
      const reopened = makeStudio({ store: new JsonFileStore(file) }).studio;
      const history = await reopened.history('select_target');
      expect(history.map((v) => v.template).sort()).toEqual(['A {{x}}', 'B {{x}}', 'C {{x}}', 'D {{x}}']);
      expect(history.every(verifyPromptIntegrity)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
