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

function expandIncludePatterns(include?: string | string[]): string[] {
  if (!include) return [];
  if (Array.isArray(include)) return include.flatMap((item) => expandIncludePatterns(String(item)));
  const trimmed = include.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((x) => String(x).trim()).filter(Boolean);
      }
    } catch {
      // fall through
    }
  }
  const braceMatch = trimmed.match(/^(.*?)\{([^{}]+)\}(.*)$/);
  if (braceMatch) {
    const [, prefix, inner, suffix] = braceMatch;
    return inner.split(',').map((part) => `${prefix}${part.trim()}${suffix}`).filter(Boolean);
  }
  return [trimmed];
}

function matchesInclude(file: string, include?: string | string[]): boolean {
  const patterns = expandIncludePatterns(include);
  if (patterns.length === 0) return true;
  return patterns.some((p) => globToRegExp(p).test(file) || globToRegExp(p).test(path.basename(file)));
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
      const rootStat = await fs.stat(searchRoot).catch(() => null);
      if (!rootStat || !rootStat.isDirectory()) {
        if (searchRoot === path.resolve(ctx.projectRoot)) {
          return {
            ok: false,
            output: '',
            error: `workspace directory '${ctx.projectRoot}' does not exist`,
            durationMs: Date.now() - started,
          };
        }
        // A missing directory is not "no matches": saying so stops a model from
        // re-globbing a path it wrongly believes exists.
        return { ok: false, output: '', error: `directory '${String(input.path)}' does not exist in the project`, durationMs: Date.now() - started };
      }
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
        glob: { type: 'string', description: 'File glob filter when pattern or regex is supplied (e.g. "src/**/*.ts"). When used alone, legacy content-glob matching is preserved.' },
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
        if (input.regex) {
          regex = new RegExp(String(input.regex));
        } else if (input.pattern) {
          regex = new RegExp(String(input.pattern));
        } else if (input.glob) {
          // Preserve glob-only content matching for existing callers. A supplied
          // content regex must never be replaced by its file filter.
          regex = globToRegExp(String(input.glob));
        } else {
          return { ok: false, output: '', error: 'Must provide regex or glob', durationMs: Date.now() - started };
        }
      } catch (error) {
        return { ok: false, output: '', error: `invalid regex: ${errorMessage(error)}`, durationMs: Date.now() - started };
      }

      // `path` is advertised in the schema; it used to be ignored, so a search scoped to a
      // nonexistent directory silently returned whole-project matches.
      const searchRoot = await assertInsideProject(ctx.projectRoot, String(input.path ?? '.'));
      const rootStat = await fs.stat(searchRoot).catch(() => null);
      if (!rootStat || !rootStat.isDirectory()) {
        return { ok: false, output: '', error: `directory '${String(input.path ?? '.')}' does not exist in the project`, durationMs: Date.now() - started };
      }

      const results: string[] = [];
      const fileGlob = (input.regex || input.pattern) && (typeof input.glob === 'string' || Array.isArray(input.glob)) ? (Array.isArray(input.glob) ? JSON.stringify(input.glob) : input.glob) : undefined;
      let filesScanned = 0;

      for await (const file of walkFiles(searchRoot, path.relative(ctx.projectRoot, searchRoot).split(path.sep).join('/'))) {
        const relative = path.relative(ctx.projectRoot, file).split(path.sep).join('/');
        if (!matchesInclude(relative, typeof input.include === 'string' ? input.include : undefined)) continue;
        if (fileGlob && !matchesInclude(relative, fileGlob)) continue;
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
        output: results.length > 0 ? results.join('\n') : filesScanned === 0 && fileGlob
          ? `(no files matched glob '${fileGlob}'; use path to select a directory or a glob such as **/*.ts)`
          : '(no matches)',
        durationMs: Date.now() - started,
        metadata: { filesScanned, matches: results.length },
      };
    } catch (error) {
      return { ok: false, output: '', error: errorMessage(error), durationMs: Date.now() - started };
    }
  },
};
