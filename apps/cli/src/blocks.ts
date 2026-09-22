import type { RookEngine } from './engine.js';
import type { Block, BlockStatus, SubmissionSource } from '@wazir/core';
import type { KeyValueStore } from '@wazir/shared';

const BLOCK_PREFIX = 'block/';
const MAX_STDOUT_SIZE = 64 * 1024; // 64KB

export interface BlockStartResult {
  block: Block;
  finish: (status: BlockStatus, patch?: Partial<Block>) => Promise<void>;
}

export interface CreateBlockOptions {
  submissionId?: string;
  source?: SubmissionSource;
  sessionId?: string;
  jobId?: string;
  executionId?: string;
}

/**
 * Get the next sequential block ID by finding the max existing ID.
 */
async function getNextBlockId(store: KeyValueStore): Promise<string> {
  const entries = await store.list(BLOCK_PREFIX);
  let maxId = 0;
  for (const entry of entries) {
    const idStr = entry.key.replace(BLOCK_PREFIX, '');
    const num = parseInt(idStr, 10);
    if (!isNaN(num) && num > maxId) {
      maxId = num;
    }
  }
  return String(maxId + 1);
}

/**
 * Create a new block and start tracking it.
 */
export async function createBlock(
  engine: RookEngine,
  command: string,
  argv: string[] = [],
  options?: CreateBlockOptions,
): Promise<BlockStartResult> {
  const store = engine.store;
  if (!store) {
    throw new Error('No persistence store available');
  }

  const sessionId = options?.sessionId ?? (process.env.WAZIR_SESSION_ID || 'default');
  const sequence = Date.now();
  const block: Block = {
    id: await getNextBlockId(store),
    sessionId,
    submissionId: options?.submissionId,
    source: options?.source ?? 'cli',
    sequence,
    timestamp: new Date(),
    command,
    argv,
    status: 'running',
    stdout: '',
    stderr: '',
    filesChanged: [],
    errors: [],
    jobId: options?.jobId,
    executionId: options?.executionId,
  };

  // Persist immediately so it shows up in history even if command fails early
  await store.put(`${BLOCK_PREFIX}${block.id}`, block);

  const finish = async (status: BlockStatus, patch?: Partial<Block>) => {
    const updated: Block = {
      ...block,
      status,
      durationMs: Date.now() - block.timestamp.getTime(),
      stdout: (patch?.stdout ?? '').slice(0, MAX_STDOUT_SIZE),
      stderr: (patch?.stderr ?? '').slice(0, MAX_STDOUT_SIZE),
      exitCode: patch?.exitCode ?? block.exitCode,
      filesChanged: patch?.filesChanged ?? block.filesChanged,
      errors: patch?.errors ?? block.errors,
      jobId: patch?.jobId ?? block.jobId,
      executionId: patch?.executionId ?? block.executionId,
      submissionId: patch?.submissionId ?? block.submissionId,
      source: patch?.source ?? block.source,
    };
    await store.put(`${BLOCK_PREFIX}${block.id}`, updated);
  };

  return { block, finish };
}

/**
 * List blocks with optional filtering.
 */
export async function listBlocks(
  engine: RookEngine,
  filter?: { status?: BlockStatus; commandContains?: string },
): Promise<Block[]> {
  const store = engine.store;
  if (!store) {
    return [];
  }

  const entries = await store.list(BLOCK_PREFIX);
  let blocks = entries.map((e) => e.value as Block);

  if (filter?.status) {
    blocks = blocks.filter((b) => b.status === filter.status);
  }
  if (filter?.commandContains) {
    const term = filter.commandContains.toLowerCase();
    blocks = blocks.filter((b) => b.command.toLowerCase().includes(term));
  }

  // Sort by ID descending (newest first)
  blocks.sort((a, b) => parseInt(b.id, 10) - parseInt(a.id, 10));

  return blocks;
}

/**
 * Get a specific block by ID.
 */
export async function getBlock(engine: RookEngine, id: string): Promise<Block | undefined> {
  const store = engine.store;
  if (!store) {
    return undefined;
  }

  return await store.get(`${BLOCK_PREFIX}${id}`);
}

const CONTEXT_ACTIVE_KEY = 'context/active';

/** Get the list of active context block IDs. */
export async function getActiveContext(engine: RookEngine): Promise<string[]> {
  const store = engine.store;
  if (!store) {
    return [];
  }
  const value = await store.get(CONTEXT_ACTIVE_KEY);
  return Array.isArray(value) ? value : [];
}

/** Set the list of active context block IDs. */
export async function setActiveContext(engine: RookEngine, ids: string[]): Promise<void> {
  const store = engine.store;
  if (!store) {
    throw new Error('No persistence store available');
  }
  await store.put(CONTEXT_ACTIVE_KEY, ids);
}

/** Add a block ID to the active context (deduped). */
export async function addContextBlock(engine: RookEngine, id: string): Promise<void> {
  const current = await getActiveContext(engine);
  if (!current.includes(id)) {
    await setActiveContext(engine, [...current, id]);
  }
}

/** Remove a block ID from the active context. */
export async function removeContextBlock(engine: RookEngine, id: string): Promise<void> {
  const current = await getActiveContext(engine);
  await setActiveContext(engine, current.filter((bid) => bid !== id));
}

/** Clear all active context blocks. */
export async function clearContext(engine: RookEngine): Promise<void> {
  await setActiveContext(engine, []);
}
