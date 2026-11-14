import { promises as fs } from 'node:fs';
import type { Tool, ToolResult } from '@wazir/core';
import { errorMessage, readProjectFile, resolveInsideProject } from './paths.js';

const MAX_SINGLE_FILE_BYTES = 512 * 1024;
const MAX_COMBINED_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_LINES_PER_FILE = 400;

export const readManyFilesTool: Tool = {
  descriptor: {
    name: 'read_many_files',
    description:
      'Read multiple project text files in a single turn. Prefer this over sequential read calls when inspecting several related files.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          minItems: 1,
          maxItems: 25,
          items: { type: 'string' },
          description: 'Project-relative (or project-internal) file paths to read',
        },
        maxLinesPerFile: {
          type: 'number',
          description: 'Maximum lines returned per file (default: 400)',
        },
      },
      required: ['paths'],
    },
    permissions: ['filesystem_read'],
    riskLevel: 'low',
    environment: 'local',
    sideEffectClass: 'READ_ONLY',
    concurrencySafety: 'parallel',
  },
  async execute(input, ctx): Promise<ToolResult> {
    const started = Date.now();
    const paths = Array.isArray(input.paths) ? input.paths.map((p) => String(p)) : [];
    if (paths.length === 0) {
      return { ok: false, output: '', error: 'paths must be a non-empty array', durationMs: Date.now() - started };
    }

    const maxLines =
      typeof input.maxLinesPerFile === 'number' && input.maxLinesPerFile > 0
        ? Math.min(2000, Math.floor(input.maxLinesPerFile))
        : DEFAULT_LINES_PER_FILE;

    const sections: string[] = [];
    let usedBytes = 0;
    let filesReturned = 0;

    for (const filePath of paths) {
      try {
        const { real } = await resolveInsideProject(ctx.projectRoot, filePath);
        const stat = await fs.stat(real);
        if (stat.size > MAX_SINGLE_FILE_BYTES) {
          sections.push(`=== ${filePath} [skipped: file too large (${stat.size} bytes); use read with offset/limit] ===`);
          continue;
        }
        const { content } = await readProjectFile(ctx.projectRoot, filePath);
        const lines = content.split('\n');
        const slice = lines.slice(0, maxLines);
        const body = slice.map((line, idx) => `${idx + 1}: ${line}`).join('\n');
        const truncatedSuffix =
          lines.length > slice.length
            ? `\n[Showing lines 1-${slice.length} of ${lines.length}. Use read with offset=${slice.length + 1} for more.]`
            : '';
        const section = `=== ${filePath} (${lines.length} lines) ===\n${body}${truncatedSuffix}`;
        const sectionBytes = Buffer.byteLength(section, 'utf8');

        if (usedBytes + sectionBytes > MAX_COMBINED_OUTPUT_BYTES && sections.length > 0) {
          sections.push(
            `=== [Output budget (${MAX_COMBINED_OUTPUT_BYTES} bytes) reached after ${filesReturned} file(s); read remaining files individually] ===`,
          );
          break;
        }

        sections.push(section);
        usedBytes += sectionBytes;
        filesReturned += 1;
      } catch (error) {
        sections.push(`=== ${filePath} [error: ${errorMessage(error)}] ===`);
      }
    }

    return {
      ok: true,
      output: sections.join('\n\n'),
      durationMs: Date.now() - started,
      metadata: { requestedFiles: paths.length, returnedFiles: filesReturned },
    };
  },
};
