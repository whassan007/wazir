import * as crypto from 'node:crypto';
import type { FileMutationResult, Tool, ToolResult } from '@wazir/core';
import { computeSmartEdit } from './editMatcher.js';
import { errorMessage, readProjectFile, writeProjectFile } from './paths.js';

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export interface MultiEditEntry {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export const multiEditTool: Tool = {
  descriptor: {
    name: 'multi_edit',
    description:
      'Apply multiple ordered string replacements to a single file atomically in one call. ' +
      'Each edit sees the result of previous edits in the array; if any edit fails, the file is left untouched.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to project root or absolute inside it)' },
        edits: {
          type: 'array',
          minItems: 1,
          description: 'Ordered list of replacements to apply sequentially',
          items: {
            type: 'object',
            properties: {
              oldString: { type: 'string', description: 'Text to replace (include 2-3 context lines for uniqueness)' },
              newString: { type: 'string', description: 'Replacement text' },
              replaceAll: { type: 'boolean', description: 'Replace all occurrences for this edit' },
            },
            required: ['oldString', 'newString'],
          },
        },
      },
      required: ['path', 'edits'],
    },
    permissions: ['filesystem_write'],
    riskLevel: 'medium',
    environment: 'local',
    sideEffectClass: 'NON_IDEMPOTENT_WRITE',
    concurrencySafety: 'exclusive',
  },
  async execute(input, ctx): Promise<ToolResult> {
    const started = Date.now();
    const filePath = String(input.path ?? '');
    const edits = Array.isArray(input.edits) ? (input.edits as MultiEditEntry[]) : [];

    const mutation: FileMutationResult = {
      path: filePath,
      attempted: true,
      succeeded: false,
      existedBefore: false,
      existsAfter: false,
      changed: false,
    };

    if (edits.length === 0) {
      return {
        ok: false,
        output: '',
        error: 'edits must be a non-empty array',
        durationMs: Date.now() - started,
        fileMutations: [mutation],
      };
    }

    try {
      let current: string;
      let resolved: string;
      try {
        const readRes = await readProjectFile(ctx.projectRoot, filePath);
        current = readRes.content;
        resolved = readRes.resolved;
        mutation.existedBefore = true;
        mutation.existsAfter = true;
        mutation.beforeHash = hashContent(current);
      } catch (error) {
        return {
          ok: false,
          output: '',
          error: errorMessage(error),
          durationMs: Date.now() - started,
          fileMutations: [mutation],
        };
      }

      const diffs: string[] = [];
      const strategies: string[] = [];
      let totalReplacements = 0;

      for (let i = 0; i < edits.length; i++) {
        const item = edits[i];
        const oldStr = typeof item?.oldString === 'string' ? item.oldString : '';
        const newStr = typeof item?.newString === 'string' ? item.newString : '';
        const res = computeSmartEdit(current, oldStr, newStr, item?.replaceAll === true);
        if (!res.ok) {
          return {
            ok: false,
            output: '',
            error: `multi_edit failed at edits[${i}] (file left unmodified): ${res.error}`,
            durationMs: Date.now() - started,
            fileMutations: [mutation],
          };
        }
        current = res.nextContent;
        totalReplacements += res.count;
        strategies.push(res.strategyUsed);
        diffs.push(res.diffSnippet);
      }

      await writeProjectFile(ctx.projectRoot, filePath, current);
      mutation.succeeded = true;
      mutation.existsAfter = true;
      mutation.afterHash = hashContent(current);
      mutation.changed = mutation.beforeHash !== mutation.afterHash;

      return {
        ok: true,
        output: `edited ${resolved} (${edits.length} edit block(s), ${totalReplacements} replacement(s))\n${diffs.join('\n')}`,
        durationMs: Date.now() - started,
        fileMutations: [mutation],
        metadata: { strategies },
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
