import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentAdapter, Block, Computer, ExecutionRecord, Job, ModelRecord } from '@wazir/core';
import type { RookEngine } from './engine.js';
import { getBlock } from './blocks.js';

export interface ResolvedBlockRef {
  kind: 'block';
  id: string;
  block: Block | undefined;
}
export interface ResolvedJobRef {
  kind: 'job';
  id: string;
  job: Job | undefined;
}
export interface ResolvedAgentRef {
  kind: 'agent';
  id: string;
  agent: AgentAdapter | undefined;
}
export interface ResolvedModelRef {
  kind: 'model';
  id: string;
  model: ModelRecord | undefined;
}
export interface ResolvedComputerRef {
  kind: 'computer';
  id: string;
  computer: Computer | undefined;
}
export interface ResolvedFileRef {
  kind: 'file';
  path: string;
  absolutePath: string;
  exists: boolean;
}
export interface ResolvedExecutionRef {
  kind: 'execution';
  id: string;
  execution: ExecutionRecord | undefined;
}
export interface UnresolvedRef {
  kind: 'unresolved';
  raw: string;
}

export type ResolvedReference =
  | ResolvedBlockRef
  | ResolvedJobRef
  | ResolvedAgentRef
  | ResolvedModelRef
  | ResolvedComputerRef
  | ResolvedFileRef
  | ResolvedExecutionRef
  | UnresolvedRef;

/**
 * Deterministic reference resolution — no LLM, no fuzzy matching, no network
 * call. Every kind is a direct lookup against an existing registry/store.
 *
 * Grammar:
 *   @<digits>       -> block           @job:<id>      -> job
 *   @agent:<name>   -> agent           @model:<id>    -> model
 *   @computer:<id>  -> computer        @file:<path>   -> file
 *   <bare id>       -> execution (tried last, since it has no @ prefix)
 */
export async function resolveReference(engine: RookEngine, raw: string): Promise<ResolvedReference> {
  const trimmed = raw.trim();

  if (/^@\d+$/.test(trimmed)) {
    const id = trimmed.slice(1);
    return { kind: 'block', id, block: await getBlock(engine, id) };
  }

  const prefixed = trimmed.match(/^@(job|agent|model|computer|file):(.+)$/);
  if (prefixed) {
    const [, tag, value] = prefixed;
    switch (tag) {
      case 'job':
        return { kind: 'job', id: value, job: engine.orchestrator.getJob(value) };
      case 'agent':
        return { kind: 'agent', id: value, agent: engine.agents.get(value) };
      case 'model':
        return { kind: 'model', id: value, model: engine.models.get(value) };
      case 'computer':
        return { kind: 'computer', id: value, computer: engine.computers.get(value) };
      case 'file': {
        const absolutePath = path.resolve(engine.projectRoot, value);
        const exists = await fs
          .access(absolutePath)
          .then(() => true)
          .catch(() => false);
        return { kind: 'file', path: value, absolutePath, exists };
      }
    }
  }

  if (!trimmed.startsWith('@')) {
    const execution = await engine.executions.get(trimmed);
    if (execution) {
      return { kind: 'execution', id: trimmed, execution };
    }
  }

  return { kind: 'unresolved', raw: trimmed };
}
