import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@wazir/shared';
import type { TargetAttempt } from '../../src/contracts.js';
import { renderPrompt, verifyPromptIntegrity } from '../../src/prompts/index.js';
import { makeStudio, SELECT_DRAFT } from './helpers.js';

/**
 * Historical binding: an attempt records `promptRef = {promptId, version}` at execution
 * time. Later publishes and rollbacks must never change what that reference resolves to.
 */
describe('historical binding of prompt versions', () => {
  it('old attempts keep resolving to the exact prompt they ran with after publish and rollback', async () => {
    const store = new MemoryStore();
    const { studio } = makeStudio({ store });
    const v1 = (await studio.publish(SELECT_DRAFT, 'user:alice')).prompt;

    const executed = await studio.latest('select_target');
    const attempt1: TargetAttempt = {
      id: 'att-1', runId: 'run-1', targetId: 'Y1.1', attempt: 1, phase: 'EXECUTE',
      promptRef: { promptId: executed!.id, version: executed!.version }, startedAt: '2026-10-22T10:00:00.000Z',
    };
    const renderedThen = renderPrompt(executed!, { target_ledger: {}, resource_limits: {} }).text;
    const snapshot = JSON.stringify(await studio.resolve(attempt1.promptRef!));

    // Edit → v2, then a second attempt binds to v2.
    const v2 = (await studio.publish({ ...SELECT_DRAFT, template: 'Completely new {{target_ledger}} {{resource_limits}}' }, 'user:bob')).prompt;
    const attempt2: TargetAttempt = { ...attempt1, id: 'att-2', attempt: 2, promptRef: { promptId: v2.id, version: v2.version } };

    // Roll back to v1 → v3 (a new version with v1's content; v2 untouched).
    const rolled = await studio.rollback('select_target', 1, 'user:carol');
    expect(rolled).toMatchObject({ created: true, prompt: { version: 3, rollbackOf: 1, parentVersion: 2, source: 'rollback', digest: v1.digest } });
    expect(rolled.prompt.template).toBe(v1.template);

    // Head moved to v3, but every historical ref is unchanged.
    expect((await studio.latest('select_target'))?.version).toBe(3);
    const resolved1 = await studio.resolve(attempt1.promptRef!);
    expect(JSON.stringify(resolved1)).toBe(snapshot);
    expect(renderPrompt(resolved1, { target_ledger: {}, resource_limits: {} }).text).toBe(renderedThen);
    expect((await studio.resolve(attempt2.promptRef!)).template).toBe('Completely new {{target_ledger}} {{resource_limits}}');

    // History is append-only and every record still verifies.
    const history = await studio.history('select_target');
    expect(history.map((v) => [v.version, v.createdBy])).toEqual([[1, 'user:alice'], [2, 'user:bob'], [3, 'user:carol']]);
    expect(history.every(verifyPromptIntegrity)).toBe(true);
  });

  it('rolling back to the current content is a no-op; rolling back to an unknown version is NOT_FOUND', async () => {
    const { studio } = makeStudio();
    await studio.publish(SELECT_DRAFT, 'a');
    const again = await studio.rollback('select_target', 1, 'a');
    expect(again.created).toBe(false);
    expect(again.prompt.version).toBe(1);
    await expect(studio.rollback('select_target', 7, 'a')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a tampered stored record is detectable by digest verification', async () => {
    const store = new MemoryStore();
    const { studio } = makeStudio({ store });
    await studio.publish(SELECT_DRAFT, 'a');
    const key = 'goals/prompts/select_target/v/000001';
    const raw = (await store.get<Record<string, unknown>>(key))!;
    await store.put(key, { ...raw, template: 'injected' });
    expect(verifyPromptIntegrity((await studio.get('select_target', 1))!)).toBe(false);
  });

  it('publishing never overwrites an existing version slot', async () => {
    const store = new MemoryStore();
    const { studio } = makeStudio({ store });
    await studio.publish(SELECT_DRAFT, 'a');
    const before = JSON.stringify(await store.get('goals/prompts/select_target/v/000001'));
    for (let i = 0; i < 5; i++) await studio.publish({ ...SELECT_DRAFT, template: `t${i} {{a}}` }, 'b');
    await studio.rollback('select_target', 1, 'c');
    expect(JSON.stringify(await store.get('goals/prompts/select_target/v/000001'))).toBe(before);
    expect((await studio.history('select_target')).length).toBe(7);
  });
});
