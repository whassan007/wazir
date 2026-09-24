import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import type { InstructionResolver, ResolvedInstruction } from '../types/context.js';
import { estimateTokens } from './contextCompiler.js';

export interface ContextFileDescriptor {
  filename: string;
  scope: 'root' | 'package' | 'nested';
  priority: number;
  description: string;
}

/** Configurable registry of recognized instruction files. */
export const DEFAULT_CONTEXT_FILE_PATTERNS: ContextFileDescriptor[] = [
  { filename: 'AGENTS.md', scope: 'package', priority: 80, description: 'Package/project agent instructions' },
  { filename: 'WAZIR.md', scope: 'root', priority: 85, description: 'Wazir project guidance' },
  { filename: '.wazir/INSTRUCTIONS.md', scope: 'root', priority: 90, description: 'Wazir core instructions' },
  { filename: 'CLAUDE.md', scope: 'root', priority: 70, description: 'Compatibility agent guidance' },
  { filename: '.cursorrules', scope: 'root', priority: 65, description: 'Cursor rules guidance' },
];

export interface FileInstructionEntry {
  relativePath: string;
  absolutePath: string;
  scope: string; // e.g. "" (root) or "packages/scheduler"
  priority: number;
  content: string;
  tokenCount: number;
  contentHash: string;
  lastModified: number;
}

export class ScopedInstructionResolver implements InstructionResolver {
  private readonly filePatterns: ContextFileDescriptor[];

  constructor(filePatterns: ContextFileDescriptor[] = DEFAULT_CONTEXT_FILE_PATTERNS) {
    this.filePatterns = filePatterns;
  }

  /**
   * Resolves the nearest and most relevant instructions for a given task,
   * active files, and working directory.
   */
  async resolve(request: {
    projectRoot: string;
    workingDirectory?: string;
    activeFiles?: string[];
    task: string;
    agentRole?: string;
    phase?: string;
  }): Promise<ResolvedInstruction[]> {
    const root = path.resolve(request.projectRoot);
    const discovered = await this.discoverInstructions(root);
    const resolved: ResolvedInstruction[] = [];

    // Normalize active files relative to root
    const normalizedActiveFiles = (request.activeFiles ?? []).map((f) => {
      const abs = path.isAbsolute(f) ? f : path.resolve(root, f);
      return path.relative(root, abs).split(path.sep).join('/');
    });

    const activeScopes = new Set<string>();
    for (const f of normalizedActiveFiles) {
      const parts = f.split('/');
      // If file is in packages/foo/src/bar.ts, scope is packages/foo
      if (parts.length >= 2 && (parts[0] === 'packages' || parts[0] === 'apps')) {
        activeScopes.add(`${parts[0]}/${parts[1]}`);
      } else if (parts.length > 1) {
        activeScopes.add(parts[0]);
      }
    }

    if (request.workingDirectory) {
      const absWd = path.isAbsolute(request.workingDirectory)
        ? request.workingDirectory
        : path.resolve(root, request.workingDirectory);
      const relWd = path.relative(root, absWd).split(path.sep).join('/');
      if (relWd && relWd !== '.' && !relWd.startsWith('..')) {
        const parts = relWd.split('/');
        if (parts.length >= 2 && (parts[0] === 'packages' || parts[0] === 'apps')) {
          activeScopes.add(`${parts[0]}/${parts[1]}`);
        } else if (parts.length >= 1) {
          activeScopes.add(parts[0]);
        }
      }
    }

    for (const entry of discovered) {
      // 1. Root scope always applies
      if (entry.scope === '' || entry.scope === '.') {
        resolved.push({
          path: entry.relativePath,
          scope: 'root',
          priority: entry.priority,
          content: entry.content,
          tokenCount: entry.tokenCount,
          reasonIncluded: 'Root project instructions apply globally',
        });
        continue;
      }

      // 2. Package / directory scope matching
      const matchingActiveFile = normalizedActiveFiles.find(
        (f) => f.startsWith(`${entry.scope}/`) || f === entry.scope,
      );

      if (matchingActiveFile) {
        resolved.push({
          path: entry.relativePath,
          scope: entry.scope,
          priority: entry.priority,
          content: entry.content,
          tokenCount: entry.tokenCount,
          reasonIncluded: `Active file '${matchingActiveFile}' modifies scope '${entry.scope}'`,
        });
        continue;
      }

      if (activeScopes.has(entry.scope)) {
        resolved.push({
          path: entry.relativePath,
          scope: entry.scope,
          priority: entry.priority,
          content: entry.content,
          tokenCount: entry.tokenCount,
          reasonIncluded: `Active execution scope matches '${entry.scope}'`,
        });
        continue;
      }

      // If no active files are specified yet, but task mentions scope keywords
      if (normalizedActiveFiles.length === 0 && request.task.toLowerCase().includes(path.basename(entry.scope).toLowerCase())) {
        resolved.push({
          path: entry.relativePath,
          scope: entry.scope,
          priority: entry.priority - 10,
          content: entry.content,
          tokenCount: entry.tokenCount,
          reasonIncluded: `Task description references scope '${entry.scope}'`,
        });
      }
    }

    // Sort by priority descending
    resolved.sort((a, b) => b.priority - a.priority);
    return resolved;
  }

  /**
   * Discovers recognized context/instruction files in the repository.
   */
  async discoverInstructions(root: string): Promise<FileInstructionEntry[]> {
    const results: FileInstructionEntry[] = [];
    const visitedDirs = new Set<string>();

    const scanDirectory = async (dir: string, depth: number) => {
      if (depth > 4) return;
      if (visitedDirs.has(dir)) return;
      visitedDirs.add(dir);

      let entries: import('node:fs').Dirent[] = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const pattern of this.filePatterns) {
        if (pattern.filename.includes('/')) {
          // Relative path like .wazir/INSTRUCTIONS.md
          const fullPath = path.join(dir, pattern.filename);
          try {
            const stat = await fs.stat(fullPath);
            if (stat.isFile()) {
              const content = await fs.readFile(fullPath, 'utf8');
              const rel = path.relative(root, fullPath).split(path.sep).join('/');
              const scope = path.dirname(rel) === '.' ? '' : path.dirname(rel);
              results.push({
                relativePath: rel,
                absolutePath: fullPath,
                scope,
                priority: pattern.priority,
                content,
                tokenCount: estimateTokens(content),
                contentHash: createHash('sha256').update(content).digest('hex'),
                lastModified: stat.mtimeMs,
              });
            }
          } catch {
            // Ignore missing
          }
          continue;
        }

        const match = entries.find((e) => e.isFile() && e.name === pattern.filename);
        if (match) {
          const fullPath = path.join(dir, match.name);
          try {
            const stat = await fs.stat(fullPath);
            const content = await fs.readFile(fullPath, 'utf8');
            const rel = path.relative(root, fullPath).split(path.sep).join('/');
            const scope = path.dirname(rel) === '.' ? '' : path.dirname(rel);
            results.push({
              relativePath: rel,
              absolutePath: fullPath,
              scope,
              priority: pattern.priority,
              content,
              tokenCount: estimateTokens(content),
              contentHash: createHash('sha256').update(content).digest('hex'),
              lastModified: stat.mtimeMs,
            });
          } catch {
            // Ignore read errors
          }
        }
      }

      // Traverse subdirectories (skip node_modules, .git, dist)
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          entry.name !== 'node_modules' &&
          entry.name !== 'dist' &&
          entry.name !== 'build' &&
          entry.name !== 'coverage'
        ) {
          await scanDirectory(path.join(dir, entry.name), depth + 1);
        }
      }
    };

    await scanDirectory(root, 0);
    return results;
  }
}
