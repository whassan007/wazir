import type { Server } from 'node:http';

/**
 * Binds `server` to `port`/`host`, turning a bind failure (EADDRINUSE,
 * EACCES on a privileged port, ...) into a clear, actionable message instead
 * of an uncaught exception.
 *
 * `listen()`'s 'error' event fires asynchronously *after* listen() itself
 * returns — a caller's own top-level promise chain (e.g. `main().catch()`)
 * has already resolved by the time it fires, so it can never be caught
 * there. With no listener on the server's own 'error' event at all, Node's
 * default is to throw it as an uncaught exception with a raw stack trace.
 */
export function listenOrFail(server: Server, port: number, host: string, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`${label}: port ${port} is already in use on ${host} — stop whatever is using it, or choose a different port`);
      } else if (error.code === 'EACCES') {
        console.error(`${label}: permission denied binding ${host}:${port} (ports below 1024 usually need elevated privileges)`);
      } else {
        console.error(`${label}: failed to start listening on ${host}:${port}: ${error.message}`);
      }
      // Already reported above with a specific, actionable message — the
      // marker lets a caller's generic top-level catch avoid printing the
      // raw error a second time.
      reject(Object.assign(error, { alreadyReported: true }));
    });
    server.listen(port, host, () => resolve());
  });
}
