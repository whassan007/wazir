/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 * Adapted for Wazir.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Load Node.js 22 built-in node:sqlite cleanly in both CommonJS and ESM
const nodeSqlite = (process as any).getBuiltinModule?.('node:sqlite') ?? (typeof require !== 'undefined' ? require('node:sqlite') : undefined);
const DatabaseSync = nodeSqlite?.DatabaseSync;

export interface DialogueSegment {
  id?: number;
  libraryId: string;
  turnId: string;
  speaker: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  timestamp: number;
}

export interface EnvObservation {
  id?: number;
  libraryId: string;
  scope: string;
  observation: string;
  evidenceId?: string;
  timestamp: number;
}

export interface MemorySearchResult<T = DialogueSegment | EnvObservation> {
  item: T;
  score: number;
  bm25Rank?: number;
  vectorRank?: number;
}

export interface MemoryStoreOptions {
  dbPath?: string;
}

export class SqliteMemoryStore {
  private readonly db: any;

  constructor(options: MemoryStoreOptions = {}) {
    const dbPath = options.dbPath ?? ':memory:';
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS libraries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dialogue_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        library_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        speaker TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_dialogue_lib_time ON dialogue_segments(library_id, timestamp);

      CREATE TABLE IF NOT EXISTS env_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        library_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        observation TEXT NOT NULL,
        evidence_id TEXT,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_env_lib_scope ON env_observations(library_id, scope);

      CREATE TABLE IF NOT EXISTS stored_vectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref_id INTEGER NOT NULL,
        ref_type TEXT NOT NULL,
        vector_blob BLOB NOT NULL
      );
    `);
  }

  ensureLibrary(id: string, name: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO libraries (id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
    `);
    stmt.run(id, name, now, now);
  }

  addDialogueSegment(segment: DialogueSegment): number {
    this.ensureLibrary(segment.libraryId, segment.libraryId);
    const stmt = this.db.prepare(`
      INSERT INTO dialogue_segments (library_id, turn_id, speaker, text, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      segment.libraryId,
      segment.turnId,
      segment.speaker,
      segment.text,
      segment.timestamp,
    );
    return Number(result.lastInsertRowid);
  }

  addEnvObservation(obs: EnvObservation): number {
    this.ensureLibrary(obs.libraryId, obs.libraryId);
    const stmt = this.db.prepare(`
      INSERT INTO env_observations (library_id, scope, observation, evidence_id, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      obs.libraryId,
      obs.scope,
      obs.observation,
      obs.evidenceId ?? null,
      obs.timestamp,
    );
    return Number(result.lastInsertRowid);
  }

  storeVector(refId: number, refType: 'dialogue' | 'env', vector: Float32Array): void {
    const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    const stmt = this.db.prepare(`
      INSERT INTO stored_vectors (ref_id, ref_type, vector_blob)
      VALUES (?, ?, ?)
    `);
    stmt.run(refId, refType, buffer);
  }

  /**
   * Hybrid BM25 lexical ranking combined with time-decay recency boosting
   */
  searchDialogue(libraryId: string, query: string, limit = 10): MemorySearchResult<DialogueSegment>[] {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    if (terms.length === 0) return [];

    // Match terms in SQL before limiting: limiting to the newest rows first made any
    // segment older than the most recent 100 unretrievable regardless of relevance.
    const escapeLike = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);
    const stmt = this.db.prepare(`
      SELECT id, library_id, turn_id, speaker, text, timestamp
      FROM dialogue_segments
      WHERE library_id = ? AND (${terms.map(() => "lower(text) LIKE ? ESCAPE '\\'").join(' OR ')})
      ORDER BY timestamp DESC
      LIMIT 500
    `);

    const rows = stmt.all(libraryId, ...terms.map((t) => `%${escapeLike(t)}%`)) as Array<{
      id: number;
      library_id: string;
      turn_id: string;
      speaker: 'user' | 'assistant' | 'system' | 'tool';
      text: string;
      timestamp: number;
    }>;

    const scored: MemorySearchResult<DialogueSegment>[] = [];
    const now = Date.now();

    for (const row of rows) {
      const lower = row.text.toLowerCase();
      let matchCount = 0;
      for (const term of terms) {
        if (lower.includes(term)) matchCount += 1;
      }

      if (matchCount > 0) {
        // BM25-style term frequency + time decay boost (newer turns scored higher)
        const daysOld = Math.max(0, (now - row.timestamp) / (1000 * 86400));
        const timeDecay = 1 / (1 + 0.1 * daysOld);
        const score = matchCount * timeDecay;

        scored.push({
          item: {
            id: row.id,
            libraryId: row.library_id,
            turnId: row.turn_id,
            speaker: row.speaker,
            text: row.text,
            timestamp: row.timestamp,
          },
          score,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  close(): void {
    this.db.close();
  }

  /** Full records, rather than lossy observation strings, support restart recovery. */
  putMemoryRecord(kind: 'episode' | 'procedure', record: { id: string }): void {
    this.db.prepare('INSERT INTO memory_records (id, kind, version, payload) VALUES (?, ?, 1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload')
      .run(record.id, kind, JSON.stringify(record));
  }

  listMemoryRecords(kind: 'episode' | 'procedure'): unknown[] {
    return this.db.prepare('SELECT version, payload FROM memory_records WHERE kind = ?').all(kind).map((row: any) => {
      if (row.version !== 1) throw new Error(`UNSUPPORTED_MEMORY_VERSION: ${row.version}`);
      return JSON.parse(row.payload);
    });
  }
}
