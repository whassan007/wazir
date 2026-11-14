import { promises as fs } from 'node:fs';
import * as crypto from 'node:crypto';
import type { Tool, ToolExecutionContext, ToolResult, FileMutationResult } from '@wazir/core';
import { computeSmartEdit } from './editMatcher.js';
import { errorMessage, readProjectFile, resolveInsideProject, writeProjectFile } from './paths.js';

const MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_READ_LINE_LIMIT = 2000;

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export const readTool: Tool = {
  descriptor: {
    name: 'read',
    description: 'Read a text file from the project. Supports offset/limit for large files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to project root or absolute inside it)' },
        offset: { type: 'number', description: '1-based line number to start from' },
        limit: { type: 'number', description: 'Maximum number of lines to return' },
      },
      required: ['path'],
    },
    permissions: ['filesystem_read'],
    riskLevel: 'low',
    environment: 'local',
  },
  async execute(input, ctx): Promise<ToolResult> {
    const started = Date.now();
    try {
      const { real } = await resolveInsideProject(ctx.projectRoot, String(input.path));
      const stat = await fs.stat(real);
      if (stat.size > MAX_READ_BYTES) {
        return { ok: false, output: '', error: `file too large (${stat.size} bytes)`, durationMs: Date.now() - started };
      }
      const { content: raw } = await readProjectFile(ctx.projectRoot, String(input.path));
      const lines = raw.split('\n');
      const offset = typeof input.offset === 'number' ? Math.max(1, input.offset) : 1;
      const explicitLimit = typeof input.limit === 'number' ? Math.max(1, input.limit) : undefined;
      const limit = explicitLimit ?? DEFAULT_READ_LINE_LIMIT;
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const body = slice.map((line, i) => `${offset + i}: ${line}`).join('\n');
      const hasMore = offset - 1 + slice.length < lines.length;
      const output =
        explicitLimit === undefined && hasMore
          ? `${body}\n[Showing lines ${offset}-${offset + slice.length - 1} of ${lines.length}. Call read with offset=${offset + slice.length} to read more.]`
          : body;
      return {
        ok: true,
        output,
        durationMs: Date.now() - started,
        metadata: { totalLines: lines.length, returnedLines: slice.length },
      };
    } catch (error) {
      return { ok: false, output: '', error: errorMessage(error), durationMs: Date.now() - started };
    }
  },
};

export const writeTool: Tool = {
  descriptor: {
    sideEffectClass: 'IDEMPOTENT_WRITE',
    name: 'write',
    description: 'Create or overwrite a file inside the project.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
    permissions: ['filesystem_write'],
    riskLevel: 'medium',
    environment: 'local',
  },
  async execute(input, ctx): Promise<ToolResult> {
    const started = Date.now();
    const filePath = String(input.path);
    const newContent = String(input.content ?? '');
    
    const mutation: FileMutationResult = {
      path: filePath,
      attempted: true,
      succeeded: false,
      existedBefore: false,
      existsAfter: false,
      changed: false,
    };

    try {
      try {
        const { content: oldContent } = await readProjectFile(ctx.projectRoot, filePath);
        mutation.existedBefore = true;
        mutation.beforeHash = hashContent(oldContent);
      } catch {
        mutation.existedBefore = false;
      }

      const resolved = await writeProjectFile(ctx.projectRoot, filePath, newContent);
      
      mutation.succeeded = true;
      mutation.existsAfter = true;
      mutation.afterHash = hashContent(newContent);
      mutation.changed = mutation.beforeHash !== mutation.afterHash;

      return { 
        ok: true, 
        output: `wrote ${resolved}`, 
        durationMs: Date.now() - started,
        fileMutations: [mutation]
      };
    } catch (error) {
      return { 
        ok: false, 
        output: '', 
        error: errorMessage(error), 
        durationMs: Date.now() - started,
        fileMutations: [mutation]
      };
    }
  },
};

export const editTool: Tool = {
  descriptor: {
    name: 'edit',
    description:
      'Replace text in a file (supports exact, whitespace-trimmed, and anchored block matching). ' +
      'Include 2-3 surrounding context lines so oldString matches uniquely, unless replaceAll is true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        oldString: { type: 'string', description: 'Text to replace' },
        newString: { type: 'string', description: 'Replacement text' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence' },
      },
      required: ['path', 'oldString', 'newString'],
    },
    permissions: ['filesystem_write'],
    riskLevel: 'medium',
    environment: 'local',
  },
  async execute(input, ctx): Promise<ToolResult> {
    const started = Date.now();
    const filePath = String(input.path);

    const mutation: FileMutationResult = {
      path: filePath,
      attempted: true,
      succeeded: false,
      existedBefore: false,
      existsAfter: false,
      changed: false,
    };

    try {
      let raw: string;
      let resolved: string;
      try {
        const result = await readProjectFile(ctx.projectRoot, filePath);
        raw = result.content;
        resolved = result.resolved;
        mutation.existedBefore = true;
        mutation.beforeHash = hashContent(raw);
      } catch (error) {
        return { ok: false, output: '', error: errorMessage(error), durationMs: Date.now() - started, fileMutations: [mutation] };
      }

      const oldString = String(input.oldString ?? '');
      const newString = String(input.newString ?? '');
      const matchResult = computeSmartEdit(raw, oldString, newString, input.replaceAll === true);
      if (!matchResult.ok) {
        return {
          ok: false,
          output: '',
          error: matchResult.error,
          durationMs: Date.now() - started,
          fileMutations: [mutation],
        };
      }

      const next = matchResult.nextContent;
      await writeProjectFile(ctx.projectRoot, filePath, next);

      mutation.succeeded = true;
      mutation.existsAfter = true;
      mutation.afterHash = hashContent(next);
      mutation.changed = mutation.beforeHash !== mutation.afterHash;

      return {
        ok: true,
        output: `edited ${resolved} (${matchResult.count} replacement(s), strategy=${matchResult.strategyUsed})\n${matchResult.diffSnippet}`,
        durationMs: Date.now() - started,
        fileMutations: [mutation],
        metadata: {
          strategyUsed: matchResult.strategyUsed,
          startLine: matchResult.startLine,
          endLine: matchResult.endLine,
        },
      };
    } catch (error) {
      return {
        ok: false,
        output: '',
        error: errorMessage(error),
        durationMs: Date.now() - started,
        fileMutations: [mutation],
      };
    }
  },
};
