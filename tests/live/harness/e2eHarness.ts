import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';

export type Verdict = 'REAL_LIVE_PASS' | 'DETERMINISTIC_INTEGRATION_PASS' | 'FAILED' | 'BLOCKED' | 'NOT_RUN';

export interface HarnessOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface ProcessRunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  combined: string;
  durationMs: number;
}

export interface PtyStep {
  op: 'wait' | 'send' | 'resize' | 'signal' | 'sleep' | 'exit';
  text?: string;
  waitFor?: string;
  send?: string;
  delayBeforeMs?: number;
  delayMs?: number;
  data?: string;
  timeout?: number;
  expectCode?: number;
  ms?: number;
  cols?: number;
  rows?: number;
  name?: string;
}

export interface PtyResult {
  exitCode: number | null;
  signalName: string | null;
  killed: boolean;
  steps: Array<{ op: string; ok: boolean; detail?: string }>;
  outputBytes: number;
  outputTail: string;
  rawOutput?: string;
  cleanOutput?: string;
  timedOut?: boolean;
  durationMs?: number;
}

export interface UserJourneyReport {
  name: string;
  category: string;
  verdict: Verdict;
  durationMs: number;
  evidence: Record<string, any>;
  transcript: string[];
  error?: string;
}

const ROOT = path.resolve(import.meta.dirname, '../../..');
const BIN_WA = path.join(ROOT, 'bin/wa.js');
const PTY_DRIVER = path.join(ROOT, 'apps/cli/tests/ptyDriver.py');

/**
 * Creates an isolated temporary workspace containing an initialized git repository
 * and a dedicated WAZIR_HOME directory to avoid polluting the host.
 */
export async function createIsolatedWorkspace(prefix = 'wazir-e2e-'): Promise<{
  workspaceDir: string;
  wazirHome: string;
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const workspaceDir = path.join(root, 'workspace');
  const wazirHome = path.join(root, 'home');
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(wazirHome, { recursive: true });

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    WAZIR_HOME: wazirHome,
    WAZIR_IN_MEMORY: '0',
    WAZIR_DISABLE_UPDATE_CHECK: '1',
    WAZIR_SECRETS_BACKEND: 'encrypted-file',
  };
  delete env.WAZIR_DATABASE_URL;
  delete env.DATABASE_URL;

  const cleanup = async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  };

  return { workspaceDir, wazirHome, env, cleanup };
}

/**
 * Spawns the real built `wa` CLI executable.
 */
export async function runWa(
  args: string[],
  options: HarnessOptions = {}
): Promise<ProcessRunResult> {
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(process.execPath, [BIN_WA, ...args], {
      cwd: options.cwd ?? ROOT,
      env: (options.env ?? process.env) as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        combined: stdout + stderr,
        durationMs,
      });
    });
  });
}

/**
 * Drives `wa` under a real pseudo-terminal using python's ptyDriver.py
 */
export async function runWaPty(
  args: string[],
  script: {
    steps: PtyStep[];
    stepTimeout?: number;
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
    cwd?: string;
  }
): Promise<PtyResult> {
  if (process.platform === 'win32') return runWaConPty(args, script);
  return new Promise((resolve, reject) => {
    const ptyArgs = [
      PTY_DRIVER,
      '--json',
      JSON.stringify(script),
      '--',
      process.execPath,
      BIN_WA,
      ...args,
    ];

    let out = '';
    let err = '';
    const child = spawn('python3', ptyArgs, {
      cwd: script.cwd ?? ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });

    child.on('close', (code) => {
      try {
        // Output from ptyDriver.py should be a JSON object
        const trimmed = out.trim();
        const jsonLine = trimmed.split('\n').filter((l) => l.startsWith('{')).at(-1) || trimmed;
        const result = JSON.parse(jsonLine) as PtyResult;
        resolve(result);
      } catch (e: any) {
        reject(new Error(`Failed to parse PTY output (exit ${code}): ${err || out}`));
      }
    });
  });
}


/** ConPTY equivalent of the Python driver's step protocol. */
export async function runWaConPty(
  args: string[],
  script: Parameters<typeof runWaPty>[1],
): Promise<PtyResult> {
  const start = Date.now();
  const nodePty = createRequire(import.meta.url)('node-pty') as typeof import('node-pty');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...script.env })) {
    if (value !== undefined) env[key] = value;
  }
  const child = nodePty.spawn(process.execPath, [BIN_WA, ...args], {
    name: 'xterm-256color', cols: script.cols ?? 120, rows: script.rows ?? 40,
    cwd: script.cwd ?? ROOT, env,
  });
  let rawOutput = '';
  let outputBytes = 0;
  let alive = true;
  let exitCode: number | null = null;
  let signalName: string | null = null;
  let timedOut = false;
  let killed = false;
  const results: PtyResult['steps'] = [];
  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const dataSubscription = child.onData((chunk) => {
    outputBytes += Buffer.byteLength(chunk);
    rawOutput = (rawOutput + chunk).slice(-1_000_000);
  });
  const exitSubscription = child.onExit((event) => {
    alive = false;
    exitCode = event.exitCode;
    signalName = event.signal ? String(event.signal) : null;
  });
  const waitUntil = async (predicate: () => boolean, timeout: number) => {
    const deadline = Date.now() + timeout * 1000;
    while (!predicate() && alive && Date.now() < deadline) await pause(25);
    const ok = predicate();
    if (!ok && alive) timedOut = true;
    return ok;
  };
  try {
    for (const step of script.steps) {
      const record = { op: step.op, ok: true, detail: '' };
      try {
        if (step.delayBeforeMs) await pause(step.delayBeforeMs);
        const needle = step.waitFor ?? (step.op === 'wait' ? step.text ?? '' : undefined);
        if (needle !== undefined) {
          record.ok = await waitUntil(() =>
            stripVTControlCharacters(rawOutput).replace(/\s+/g, '').includes(needle.replace(/\s+/g, '')),
          step.timeout ?? script.stepTimeout ?? 10);
          record.detail = `found=${record.ok} needle=${JSON.stringify(needle)}`;
        }
        if (record.ok) {
          if (step.op === 'send' || step.send !== undefined) {
            child.write(step.send ?? step.data ?? '');
            if (step.delayMs) await pause(step.delayMs);
          } else if (step.op === 'resize') {
            child.resize(step.cols ?? 80, step.rows ?? 24);
            await pause(200);
          } else if (step.op === 'signal') {
            child.kill(step.name ?? 'SIGINT');
            await pause(300);
          } else if (step.op === 'sleep') {
            await pause(step.ms ?? 0);
          } else if (step.op === 'exit') {
            record.ok = await waitUntil(() => !alive, step.timeout ?? script.stepTimeout ?? 10);
            if (step.expectCode !== undefined) record.ok &&= exitCode === step.expectCode;
            record.detail = `exitCode=${exitCode} signal=${signalName}`;
          }
        }
      } catch (error) {
        record.ok = false;
        record.detail = String(error);
      }
      results.push(record);
    }
  } finally {
    if (alive) {
      killed = true;
      try { child.kill(); } catch { /* already exited */ }
    }
    await pause(150);
    dataSubscription.dispose();
    exitSubscription.dispose();
  }
  return {
    exitCode, signalName, killed, steps: results, outputBytes,
    outputTail: rawOutput.slice(-32768), rawOutput,
    cleanOutput: stripVTControlCharacters(rawOutput), timedOut, durationMs: Date.now() - start,
  };
}
