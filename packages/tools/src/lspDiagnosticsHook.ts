import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { resolveNodeRuntimeBinary } from '@wazir/shared';
import type { ToolExecutionContext } from '@wazir/core';

const execFile = promisify(_execFile);

export interface DiagnosticEntry {
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
  source: string;
}

export type PostEditDiagnosticsProvider = (params: {
  projectRoot: string;
  filePath: string;
  resolvedPath: string;
  content: string;
}) => Promise<DiagnosticEntry[]> | DiagnosticEntry[];

let postEditDiagnosticsProvider: PostEditDiagnosticsProvider | undefined;

export function setPostEditDiagnosticsProvider(provider: PostEditDiagnosticsProvider | undefined): void {
  postEditDiagnosticsProvider = provider;
}

export function getPostEditDiagnosticsProvider(): PostEditDiagnosticsProvider | undefined {
  return postEditDiagnosticsProvider;
}

async function timeoutPromise<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export async function checkSyntaxDiagnostics(
  filePath: string,
  content: string,
  resolvedPath?: string,
  timeoutMs = 1200
): Promise<DiagnosticEntry[]> {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') {
      try {
        JSON.parse(content);
        return [];
      } catch (err: any) {
        const match = err.message.match(/position (\d+)/);
        if (!match) return [{ line: 1, column: 1, severity: 'error', message: err.message, source: 'json' }];
        const pos = parseInt(match[1], 10);
        const lines = content.slice(0, pos).split('\n');
        const line = lines.length;
        const column = lines[lines.length - 1].length + 1;
        return [{ line, column, severity: 'error', message: err.message, source: 'json' }];
      }
    } else if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) {
      const tsMod = await import('typescript');
      const ts = tsMod.default ?? tsMod;
      const result = ts.transpileModule(content, {
        fileName: filePath,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          ...(filePath.endsWith('.tsx') ? { jsx: ts.JsxEmit.ReactJSX } : {}),
        },
      });
      const diagnostics = result.diagnostics ?? [];
      return diagnostics
        .filter((diag) => diag.category === ts.DiagnosticCategory.Error)
        .map((diag) => {
          if (!diag.file) {
            return { line: 1, column: 1, severity: 'error', message: ts.flattenDiagnosticMessageText(diag.messageText, ' '), source: 'typescript' };
          }
          const pos = diag.start ?? 0;
          const { line, character } = diag.file.getLineAndCharacterOfPosition(pos);
          return {
            line: line + 1,
            column: character + 1,
            severity: 'error',
            message: ts.flattenDiagnosticMessageText(diag.messageText, ' '),
            source: 'typescript',
          };
        });
    } else if (['.js', '.mjs', '.cjs'].includes(ext)) {
      if (!resolvedPath) return [];
      try {
        await timeoutPromise(execFile(resolveNodeRuntimeBinary(), ['--check', resolvedPath], { timeout: timeoutMs }), timeoutMs);
        return [];
      } catch (err: any) {
        if (err.code !== 0 && err.stderr && err.stderr.includes('SyntaxError')) {
          const match = err.stderr.match(/:(\d+): (.+)/);
          if (match) {
            const line = parseInt(match[1], 10);
            const message = match[2].trim();
            return [{ line, column: 1, severity: 'error', message, source: 'node' }];
          }
        }
        return [];
      }
    }
    return [];
  } catch (err) {
    return [];
  }
}

export async function collectPostEditDiagnostics(params: {
  projectRoot: string;
  filePath: string;
  resolvedPath: string;
  content: string;
  ctx?: ToolExecutionContext;
  timeoutMs?: number;
}): Promise<{ entries: DiagnosticEntry[]; formatted?: string }> {
  const { projectRoot, filePath, resolvedPath, content, ctx, timeoutMs = 1200 } = params;

  if (
    ctx?.env?.WAZIR_POST_EDIT_DIAGNOSTICS === '0' ||
    process.env.WAZIR_POST_EDIT_DIAGNOSTICS === '0'
  ) {
    return { entries: [] };
  }

  const providerEntriesPromise: Promise<DiagnosticEntry[]> = postEditDiagnosticsProvider
    ? timeoutPromise(Promise.resolve(postEditDiagnosticsProvider({ projectRoot, filePath, resolvedPath, content })), timeoutMs)
    : Promise.resolve([]);

  const syntaxEntriesPromise = timeoutPromise(
    checkSyntaxDiagnostics(filePath, content, resolvedPath, timeoutMs),
    timeoutMs
  );

  const allEntries: DiagnosticEntry[] = await Promise.race([
    Promise.all([providerEntriesPromise, syntaxEntriesPromise]).then(([a, b]) => [...a, ...b]),
    new Promise<DiagnosticEntry[]>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), timeoutMs)
    ),
  ]).catch((): DiagnosticEntry[] => []);

  const deduped = new Map<string, DiagnosticEntry>();
  for (const entry of allEntries) {
    deduped.set(`${entry.line}:${entry.column}:${entry.message}`, entry);
  }
  const entries = Array.from(deduped.values());

  if (entries.length === 0) {
    return { entries: [] };
  }

  const formatted = `\n[diagnostics] ${entries.length} syntax/compile error(s) in ${filePath}:\n` +
    entries.slice(0, 5).map((d) => `  - line ${d.line}:${d.column} [${d.source}] ${d.message}`).join('\n') +
    (entries.length > 5 ? `\n  ... and ${entries.length - 5} more` : '');

  return { entries, formatted };
}
