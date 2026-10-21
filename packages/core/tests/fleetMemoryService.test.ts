import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@wazir/shared';
import { createFleetMemoryService } from '../src/services/fleetMemoryService.js';

describe('FleetMemoryService', () => {
  it('a fact written by one service instance is visible to a second instance backed by the same store', async () => {
    // Simulates two agents on two different machines sharing one control-plane
    // KeyValueStore (PostgresStore in production) — the whole point of fleet
    // memory is that it isn't scoped to one process's lifetime.
    const store = new MemoryStore();
    const writer = createFleetMemoryService(store);
    const reader = createFleetMemoryService(store);

    await writer.remember({
      projectRoot: '/repos/widget',
      title: 'flaky integration test',
      body: 'tests/db.test.ts needs --retries=3, the CI runner is slow to release the port',
      tags: ['testing', 'ci'],
    });

    const facts = await reader.recall('/repos/widget');
    expect(facts).toHaveLength(1);
    expect(facts[0].title).toBe('flaky integration test');
    expect(facts[0].body).toContain('--retries=3');
  });

  it('facts are scoped per project root — a different repo never sees another repo\'s facts', async () => {
    const store = new MemoryStore();
    const service = createFleetMemoryService(store);

    await service.remember({ projectRoot: '/repos/widget', title: 'widget fact', body: 'only relevant to widget' });
    await service.remember({ projectRoot: '/repos/gadget', title: 'gadget fact', body: 'only relevant to gadget' });

    const widgetFacts = await service.recall('/repos/widget');
    const gadgetFacts = await service.recall('/repos/gadget');

    expect(widgetFacts.map((f) => f.title)).toEqual(['widget fact']);
    expect(gadgetFacts.map((f) => f.title)).toEqual(['gadget fact']);
  });

  it('recall with a query ranks facts sharing query terms above unrelated facts', async () => {
    const store = new MemoryStore();
    const service = createFleetMemoryService(store);

    await service.remember({ projectRoot: '/repos/widget', title: 'unrelated note', body: 'the build takes 4 minutes' });
    await service.remember({ projectRoot: '/repos/widget', title: 'flaky test', body: 'tests/db.test.ts is flaky under load, add retries' });

    const facts = await service.recall('/repos/widget', { query: 'flaky retries' });
    expect(facts[0].title).toBe('flaky test');
  });

  it('recall respects limit and defaults to most-recent-first without a query', async () => {
    const store = new MemoryStore();
    const service = createFleetMemoryService(store);

    for (let i = 0; i < 5; i++) {
      await service.remember({ projectRoot: '/repos/widget', title: `fact ${i}`, body: `body ${i}` });
    }

    const facts = await service.recall('/repos/widget', { limit: 2 });
    expect(facts).toHaveLength(2);
    expect(facts[0].title).toBe('fact 4');
    expect(facts[1].title).toBe('fact 3');
  });

  it('forget removes a fact so it no longer appears in recall', async () => {
    const store = new MemoryStore();
    const service = createFleetMemoryService(store);

    const fact = await service.remember({ projectRoot: '/repos/widget', title: 'temp', body: 'temporary note' });
    expect(await service.recall('/repos/widget')).toHaveLength(1);

    await service.forget('/repos/widget', fact.id);
    expect(await service.recall('/repos/widget')).toHaveLength(0);
  });

  it('rejects an empty title or body instead of silently storing a useless fact', async () => {
    const store = new MemoryStore();
    const service = createFleetMemoryService(store);

    await expect(service.remember({ projectRoot: '/repos/widget', title: '  ', body: 'body' })).rejects.toThrow(
      'non-empty title',
    );
    await expect(service.remember({ projectRoot: '/repos/widget', title: 'title', body: '  ' })).rejects.toThrow(
      'non-empty body',
    );
  });
});
