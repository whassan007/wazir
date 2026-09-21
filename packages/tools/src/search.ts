import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool, ToolExecutionContext, ToolResult } from '@wazir/core';
import { assertInsideProject, errorMessage, IGNORED_DIRECTORIES } from './paths.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RESULTS = 200;

async function* walkFiles(root: string, base: string): AsyncGenerator<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    const relative = base ? path.posix.join(base, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      yield* walkFiles(absolute, relative);
    } else if (entry.isFile()) {
      yield absolute;
    }
  }
}

function globToRegExp(pattern: string): RegExp {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        regex += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        regex += '[^/]*';
      }
    } else if (char === '?') {
      regex += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
  }
  return new RegExp(`^${regex}$`);
}

function matchesInclude(file: string, include?: string): boolean {
  if (!include) return true;
  return globToRegExp(include).test(file) || globToRegExp(include).test(path.basename(file));
}

export const globTool: Tool = {
  descriptor: {
    name: 'glob',
    description: 'Find files by glob pattern, e.g. "src/**/*.ts" or "**/*.test.ts".',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern' },
        path: { type: 'string', description: 'Directory to search in (default: project root)' },
      },
      required: ['pattern'],
    },
    permissions: ['filesystem_read'],
    riskLevel: 'low',
    environment: 'local',
  },
  async execute(input, ctx): Promise<ToolResult> {
    const started = Date.now();
    try {
      const searchRoot = await assertInsideProject(ctx.projectRoot, String(input.path ?? '.'));
      const regex = globToRegExp(String(input.pattern));
      const matches: string[] = [];
      for await (const file of walkFiles(searchRoot, '')) {
        const relative = path.relative(ctx.projectRoot, file).split(path.sep).join('/');
        if (regex.test(relative) || regex.test(path.basename(file))) {
          matches.push(relative);
          if (matches.length >= MAX_RESULTS) break;
        }
      }
      return {
        ok: true,
        output: matches.length > 0 ? matches.join('\n') : '(no matches)',
        durationMs: Date.now() - started,
        metadata: { count: matches.length },
      };
    } catch (error) {
      return { ok: false, output: '', error: errorMessage(error), durationMs: Date.now() - started };
    }
  },
};

export const searchTool: Tool = {
  descriptor: {
    name: 'search',
    description: 'Regex search across project file contents. Returns matching lines with file and line number.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression (legacy, use regex or glob instead)' },
        regex: { type: 'string', description: 'Regular expression pattern' },
        glob: { type: 'string', description: 'Glob pattern (e.g., "*.cpp")' },
        path: { type: 'string', description: 'Directory to search in (default: project root)' },
        include: { type: 'string', description: 'File glob filter, e.g. "*.ts"' },
      },
    },
    permissions: ['filesystem_read'],
    riskLevel: 'low',
    environment: 'local',
  },
  async execute(input, ctx): Promise<ToolResult> {
    const started = Date.now();
    try {
      let regex: RegExp;
      try {
        if (input.glob) {
          regex = globToRegExp(String(input.glob));
        } else if (input.regex) {
          regex = new RegExp(String(input.regex));
        } else if (input.pattern) {
          regex = new RegExp(String(input.pattern));
        } else {
          return { ok: false, output: '', error: 'Must provide regex or glob', durationMs: Date.now() - started };
        }
      } catch (error) {
        return { ok: false, output: '', error: `invalid regex: ${errorMessage(error)}`, durationMs: Date.now() - started };
      }

      const results: string[] = [];
      let filesScanned = 0;

      for await (const file of walkFiles(ctx.projectRoot, '')) {
        const relative = path.relative(ctx.projectRoot, file).split(path.sep).join('/');
        if (!matchesInclude(relative, typeof input.include === 'string' ? input.include : undefined)) continue;
        const stat = await fs.stat(file).catch(() => null);
        if (!stat || stat.size > MAX_FILE_BYTES) continue;
        filesScanned += 1;

        const raw = await fs.readFile(file, 'utf8').catch(() => null);
        if (raw === null || raw.includes('\u0000')) continue;

        const lines = raw.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push(`${relative}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
            if (results.length >= MAX_RESULTS) break;
          }
        }
        if (results.length >= MAX_RESULTS) break;
      }

      return {
        ok: true,
        output: results.length > 0 ? results.join('\n') : '(no matches)',
        durationMs: Date.now() - started,
        metadata: { filesScanned, matches: results.length },
      };
    } catch (error) {
      return { ok: false, output: '', error: errorMessage(error), durationMs: Date.now() - started };
    }
  },
};
