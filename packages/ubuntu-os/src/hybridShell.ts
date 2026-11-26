import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClassifiedInput, ShellMode } from './contracts.js';
import { classifyHybridInput } from './shellClassifier.js';

export interface ShellExecutionResult {
  classification: ClassifiedInput;
  executedAs: 'shell' | 'ai' | 'ambiguous' | 'control';
  exitCode: number;
  stdout: string;
  stderr: string;
  cwd: string;
  dispatchOverheadMs: number;
  totalDurationMs: number;
}

export interface HybridShellOptions {
  cwd?: string;
  shellPath?: string;
  env?: NodeJS.ProcessEnv;
  historyFile?: string;
  aiHandler?: (prompt: string, cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Hybrid Linux shell (`wa shell`) session controller.
 * - Tier 0 deterministic commands execute directly through the user's real POSIX shell
 *   with zero LLM calls and sub-50ms dispatch overhead.
 * - Natural-language inputs route through the injected Wazir orchestrator handler.
 * - If Wazir's AI daemon is offline, native shell execution continues unaffected.
 */
export class HybridShellSession {
  private mode: ShellMode = 'auto';
  private cwd: string;
  private readonly shellPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly history: string[] = [];
  private readonly historyFile?: string;
  private readonly aiHandler?: HybridShellOptions['aiHandler'];

  constructor(options: HybridShellOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.shellPath = options.shellPath ?? process.env.SHELL ?? '/bin/bash';
    this.env = { ...process.env, ...(options.env ?? {}) };
    this.historyFile = options.historyFile;
    this.aiHandler = options.aiHandler;
  }

  getMode(): ShellMode {
    return this.mode;
  }

  getCwd(): string {
    return this.cwd;
  }

  getHistory(): readonly string[] {
    return this.history;
  }

  private recordHistory(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.history.push(trimmed);
    if (this.historyFile) {
      try {
        fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
        fs.appendFileSync(this.historyFile, trimmed + '\n', 'utf8');
      } catch {
        // non-fatal history persistence error
      }
    }
  }

  async executeLine(rawLine: string): Promise<ShellExecutionResult> {
    const t0 = performance.now();
    const classification = classifyHybridInput(rawLine, this.mode);
    this.recordHistory(rawLine);

    if (classification.kind === 'empty') {
      return {
        classification,
        executedAs: 'control',
        exitCode: 0,
        stdout: '',
        stderr: '',
        cwd: this.cwd,
        dispatchOverheadMs: Number((performance.now() - t0).toFixed(3)),
        totalDurationMs: Number((performance.now() - t0).toFixed(3)),
      };
    }

    if (classification.kind === 'mode-switch' && classification.modeChange) {
      this.mode = classification.modeChange;
      return {
        classification,
        executedAs: 'control',
        exitCode: 0,
        stdout: `Hybrid shell mode set to: ${this.mode}\n`,
        stderr: '',
        cwd: this.cwd,
        dispatchOverheadMs: Number((performance.now() - t0).toFixed(3)),
        totalDurationMs: Number((performance.now() - t0).toFixed(3)),
      };
    }

    if (classification.route === 'ambiguous') {
      return {
        classification,
        executedAs: 'ambiguous',
        exitCode: 2,
        stdout: '',
        stderr: `Ambiguous input: "${classification.normalized}". Prefix with ! to run as shell or ? to send to Wazir AI.\n`,
        cwd: this.cwd,
        dispatchOverheadMs: Number((performance.now() - t0).toFixed(3)),
        totalDurationMs: Number((performance.now() - t0).toFixed(3)),
      };
    }

    if (classification.route === 'shell') {
      return this.runNativeShell(classification, t0);
    }

    // AI orchestration route
    const dispatchOverheadMs = Number((performance.now() - t0).toFixed(3));
    if (!this.aiHandler) {
      return {
        classification,
        executedAs: 'ai',
        exitCode: 1,
        stdout: '',
        stderr: 'Wazir AI orchestrator is offline. Native shell commands (! or Linux builtins) remain fully operational.\n',
        cwd: this.cwd,
        dispatchOverheadMs,
        totalDurationMs: Number((performance.now() - t0).toFixed(3)),
      };
    }

    try {
      const outcome = await this.aiHandler(classification.normalized, this.cwd);
      return {
        classification,
        executedAs: 'ai',
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        cwd: this.cwd,
        dispatchOverheadMs,
        totalDurationMs: Number((performance.now() - t0).toFixed(3)),
      };
    } catch (err) {
      return {
        classification,
        executedAs: 'ai',
        exitCode: 1,
        stdout: '',
        stderr: `Wazir AI error (Ubuntu shell unaffected): ${err instanceof Error ? err.message : String(err)}\n`,
        cwd: this.cwd,
        dispatchOverheadMs,
        totalDurationMs: Number((performance.now() - t0).toFixed(3)),
      };
    }
  }

  private runNativeShell(classification: ClassifiedInput, t0: number): ShellExecutionResult {
    const cmd = classification.normalized;

    // Preserve working directory for bare `cd` commands in-session
    if (cmd === 'cd' || cmd.startsWith('cd ')) {
      const targetArg = cmd === 'cd' ? os.homedir() : cmd.slice(3).trim();
      const resolved = path.resolve(this.cwd, targetArg.replace(/^~(?=$|\/)/, os.homedir()));
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        this.cwd = resolved;
        const dt = Number((performance.now() - t0).toFixed(3));
        return {
          classification,
          executedAs: 'shell',
          exitCode: 0,
          stdout: '',
          stderr: '',
          cwd: this.cwd,
          dispatchOverheadMs: dt,
          totalDurationMs: dt,
        };
      }
      const dt = Number((performance.now() - t0).toFixed(3));
      return {
        classification,
        executedAs: 'shell',
        exitCode: 1,
        stdout: '',
        stderr: `cd: no such file or directory: ${targetArg}\n`,
        cwd: this.cwd,
        dispatchOverheadMs: dt,
        totalDurationMs: dt,
      };
    }

    const beforeSpawn = performance.now();
    const dispatchOverheadMs = Number((beforeSpawn - t0).toFixed(3));
    const proc = spawnSync(this.shellPath, ['-c', cmd], {
      cwd: this.cwd,
      env: this.env,
      encoding: 'utf8',
    });
    const totalDurationMs = Number((performance.now() - t0).toFixed(3));

    return {
      classification,
      executedAs: 'shell',
      exitCode: proc.status ?? (proc.error ? 1 : 0),
      stdout: proc.stdout ?? '',
      stderr: proc.stderr ?? (proc.error ? proc.error.message : ''),
      cwd: this.cwd,
      dispatchOverheadMs,
      totalDurationMs,
    };
  }
}
