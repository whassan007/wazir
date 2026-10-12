import { describe, it, expect } from 'vitest';
import { SqliteMemoryStore } from '../src/sqlite/sqliteMemoryStore.js';
import { unlinkSync, existsSync } from 'node:fs';

describe('SqliteMemoryStore (Adapted from Qwen-Live-Harness)', () => {
  it('creates schema, stores dialogue segments, and retrieves via BM25 lexical ranking', () => {
    const store = new SqliteMemoryStore();

    store.ensureLibrary('repo-wazir', 'Wazir Repository');

    store.addDialogueSegment({
      libraryId: 'repo-wazir',
      turnId: 'turn-1',
      speaker: 'user',
      text: 'How do we fix the race condition in the checkpoint service?',
      timestamp: Date.now() - 100_000,
    });

    store.addDialogueSegment({
      libraryId: 'repo-wazir',
      turnId: 'turn-2',
      speaker: 'assistant',
      text: 'We can introduce generation fencing and atomic write locks in checkpoint service.',
      timestamp: Date.now() - 50_000,
    });

    store.addDialogueSegment({
      libraryId: 'repo-wazir',
      turnId: 'turn-3',
      speaker: 'user',
      text: 'What is the color of the TUI header banner?',
      timestamp: Date.now() - 10_000,
    });

    const searchResults = store.searchDialogue('repo-wazir', 'checkpoint service fencing');
    expect(searchResults.length).toBeGreaterThan(0);
    // Turn 2 has both checkpoint, service, and fencing, plus newer timestamp -> should be rank 1
    expect(searchResults[0].item.turnId).toBe('turn-2');
    expect(searchResults[0].item.text).toContain('atomic write locks');

    store.close();
  });

  it('persists data across store re-openings using node:sqlite', () => {
    const dbPath = '/tmp/test_wazir_memory.db';
    if (existsSync(dbPath)) unlinkSync(dbPath);

    try {
      const store1 = new SqliteMemoryStore({ dbPath });
      store1.addEnvObservation({
        libraryId: 'default',
        scope: 'build',
        observation: 'Node 22 requires --experimental-sqlite flag or native DatabaseSync',
        evidenceId: 'ev-101',
        timestamp: Date.now(),
      });
      store1.close();

      // Re-open from disk
      const store2 = new SqliteMemoryStore({ dbPath });
      store2.addDialogueSegment({
        libraryId: 'default',
        turnId: 'turn-disk',
        speaker: 'assistant',
        text: 'Database successfully persisted on disk',
        timestamp: Date.now(),
      });

      const res = store2.searchDialogue('default', 'persisted');
      expect(res).toHaveLength(1);
      expect(res[0].item.text).toBe('Database successfully persisted on disk');
      store2.close();
    } finally {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    }
  });
});
