/**
 * A single, centralized exit/disposal path for long-running CLI commands
 * (`wa chat`, `wa dashboard`, a worker, the API server). Before this, each of
 * those registered its own ad hoc SIGINT/SIGTERM/SIGHUP handler directly —
 * `dashboard`'s `server.close(() => process.exit(0))` had no timeout at all
 * (a stuck connection means `close`'s callback never fires and the process
 * hangs on Ctrl-C forever), `chat` only handled SIGHUP and nothing else, and
 * neither handled a second Ctrl-C during an already-hung shutdown.
 *
 * One-shot leaf commands (`wa jobs list`, `wa models load`, ...) are
 * deliberately NOT routed through this — they hold no open resources or
 * signal handlers; their `process.exit(result.code)` is just reporting a
 * result, not a lifecycle to manage.
 */

export interface ShutdownControllerOptions {
  /** How long registered disposers get to finish before a forced exit. Default 5000ms. */
  gracefulTimeoutMs?: number;
}

type Disposer = () => void | Promise<void>;

// Deliberately matching the directive's stated codes rather than the stricter
// POSIX 128+signum convention (SIGTERM would normally be 143): 0 for any
// clean/graceful termination including a handled SIGTERM, 130 for SIGINT.
const EXIT_CODE_CLEAN = 0;
const EXIT_CODE_SIGINT = 130;
const EXIT_CODE_FORCED = 1;

export class ShutdownController {
  private readonly disposers = new Map<string, Disposer>();
  private readonly gracefulTimeoutMs: number;
  private shuttingDown = false;
  private installed = false;

  constructor(options: ShutdownControllerOptions = {}) {
    this.gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5000;
  }

  /** Registers a cleanup step, keyed so a caller can safely register-then-replace (e.g. across a reconnect) without leaking duplicate disposers. */
  register(name: string, disposer: Disposer): void {
    this.disposers.set(name, disposer);
  }

  unregister(name: string): void {
    this.disposers.delete(name);
  }

  /** Installs the process-level signal handlers. Idempotent. */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    process.on('SIGINT', () => void this.shutdown('SIGINT'));
    process.on('SIGTERM', () => void this.shutdown('SIGTERM'));
    process.on('SIGHUP', () => void this.shutdown('SIGHUP'));
  }

  /** Runs every registered disposer, bounded by gracefulTimeoutMs, then exits with the code matching `signal`. A second call while already shutting down force-exits immediately instead of waiting again. */
  async shutdown(signal: NodeJS.Signals): Promise<never> {
    if (this.shuttingDown) {
      process.stderr.write('\nwa: second interrupt — forcing exit\n');
      process.exit(signal === 'SIGINT' ? EXIT_CODE_SIGINT : EXIT_CODE_FORCED);
      // process.exit() never returns in real Node, but nothing here should
      // rely on that: a wrapped/mocked exit (as in this module's own tests)
      // must not fall through into re-running the full disposer sequence a
      // second time, including a wait for whatever hung the first attempt.
      return undefined as never;
    }
    this.shuttingDown = true;

    const disposals = [...this.disposers.entries()].map(async ([name, dispose]) => {
      try {
        await dispose();
      } catch (error) {
        process.stderr.write(`wa: shutdown step '${name}' failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    });

    const timeout = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, this.gracefulTimeoutMs);
      t.unref?.();
    });

    await Promise.race([Promise.all(disposals), timeout]);
    process.exit(signal === 'SIGINT' ? EXIT_CODE_SIGINT : EXIT_CODE_CLEAN);
  }
}

let instance: ShutdownController | undefined;

/** The process-wide controller. Created and installed on first use. */
export function shutdownController(): ShutdownController {
  if (!instance) {
    instance = new ShutdownController();
    instance.install();
  }
  return instance;
}

/** Test-only: replaces the singleton so tests don't leak signal handlers or state across each other. */
export function resetShutdownControllerForTests(): void {
  instance = undefined;
}
