import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  maxBuffer?: number;
}

export function runShell(command: string, options: RunOptions): Promise<CommandResult> {
  const shell = process.platform === 'win32' ? 'cmd' : 'sh';
  const args = process.platform === 'win32' ? ['/c', command] : ['-c', command];
  return runProcess(shell, args, options);
}

export function runFile(
  file: string,
  args: string[],
  options: RunOptions,
): Promise<CommandResult> {
  return runProcess(file, args, options);
}

function runProcess(
  file: string,
  args: string[],
  options: RunOptions,
): Promise<CommandResult> {
  const started = Date.now();
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 120_000);

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, durationMs: Date.now() - started, timedOut });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > maxBuffer) {
        stdout = stdout.slice(0, maxBuffer);
        child.kill('SIGKILL');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > maxBuffer) {
        stderr = stderr.slice(0, maxBuffer);
      }
    });

    child.on('error', (error) => {
      stderr += `\n${error.message}`;
      finish(127);
    });

    child.on('close', (code) => finish(code ?? 1));
  });
}
