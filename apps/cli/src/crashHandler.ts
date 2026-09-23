import { inspect } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Global, last-resort crash handling. Before this, `uncaughtException` had no
 * handler anywhere in the codebase — Node's default for that is an immediate,
 * silent-to-the-user crash (no terminal restoration if raw/alternate-screen
 * mode was active, no record of what happened beyond whatever scrolled past
 * in the terminal). `unhandledRejection` was only ever handled *inside*
 * FleetTui, and only while it's actually running.
 *
 * This installs both at the process level so every entry point (one-shot CLI
 * commands, the API server, a worker, not just the TUI) gets the same
 * guarantee: restore the terminal, write a full crash dump to disk, print a
 * one-line summary, exit non-zero.
 */

const CRASH_EXIT_CODE = 1;

function crashLogDir(): string {
  return path.join(os.homedir(), '.wazir', 'logs');
}

/** Writes a full `util.inspect` dump of `error` to a timestamped, owner-only-readable log file. Returns its path, or undefined if writing failed (never throws). */
export function writeCrashReport(error: unknown, context: Record<string, unknown> = {}): string | undefined {
  try {
    const dir = crashLogDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `crash-${timestamp}.log`);
    const body = [
      `Wazir crash report — ${new Date().toISOString()}`,
      `pid=${process.pid} node=${process.version} platform=${process.platform}`,
      Object.keys(context).length ? `context: ${inspect(context, { depth: 6 })}` : '',
      '',
      inspect(error, { depth: 10, showHidden: false }),
    ].filter(Boolean).join('\n');
    writeFileSync(file, body, { mode: 0o600 });
    return file;
  } catch {
    // A crash handler that itself throws defeats the purpose — best effort only.
    return undefined;
  }
}

/** Best-effort terminal restoration: leaves alternate-screen mode, shows the cursor, disables raw mode. Mirrors screen.ts's own leave() sequence so a crash mid-TUI-session doesn't strand the user's real terminal. */
function restoreTerminal(): void {
  try {
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b[0 q\x1b[?2004l\x1b[?25h\x1b[?1049l');
    }
    if (process.stdin.isTTY && typeof (process.stdin as unknown as { setRawMode?: (v: boolean) => void }).setRawMode === 'function') {
      (process.stdin as unknown as { setRawMode: (v: boolean) => void }).setRawMode(false);
    }
  } catch {
    // best effort
  }
}

function summarize(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

let installed = false;
let currentRejectionHandler: ((reason: unknown) => void) | undefined;

function fatalRejectionHandler(reason: unknown): void {
  handleFatal(reason, 'unhandledRejection');
}

function handleFatal(error: unknown, kind: 'uncaughtException' | 'unhandledRejection'): void {
  restoreTerminal();
  const logPath = writeCrashReport(error, { kind });
  process.stderr.write(
    `\nwa: fatal ${kind}: ${summarize(error)}${logPath ? `\nFull details: ${logPath}` : ''}\n`,
  );
  process.exit(CRASH_EXIT_CODE);
}

/**
 * Installs the process-wide fatal handlers. Idempotent — safe to call more
 * than once (a second call is a no-op).
 */
export function installGlobalCrashHandlers(): void {
  if (installed) return;
  installed = true;
  process.on('uncaughtException', (error) => handleFatal(error, 'uncaughtException'));
  currentRejectionHandler = fatalRejectionHandler;
  process.on('unhandledRejection', currentRejectionHandler);
}

/**
 * Temporarily replaces the fatal unhandledRejection handler with `handler`
 * — used by FleetTui, whose keypress-driven fire-and-forget actions
 * legitimately want to recover in the status bar rather than crash the whole
 * interactive session (see fleetTui.ts's own comment on this). Returns a
 * function that restores the fatal default handler.
 *
 * uncaughtException is deliberately NOT swappable: an actually-uncaught
 * exception means something threw outside of any promise chain Wazir
 * controls, which is a different, more serious class of bug than a keypress
 * handler's unhandled rejection — that one always stays fatal.
 */
export function withScopedRejectionHandler(handler: (reason: unknown) => void): () => void {
  if (currentRejectionHandler) process.off('unhandledRejection', currentRejectionHandler);
  currentRejectionHandler = handler;
  process.on('unhandledRejection', currentRejectionHandler);
  return () => {
    if (currentRejectionHandler === handler) {
      process.off('unhandledRejection', handler);
      currentRejectionHandler = fatalRejectionHandler;
      process.on('unhandledRejection', currentRejectionHandler);
    }
  };
}
