// Minimal real-HTTP control plane for worker fault-injection tests. Routes and status
// codes mirror apps/api/src/server.ts for the worker-facing endpoints, backed by the
// shipped TaskDispatcher, so lease/claim/commit semantics are the real ones; only the
// transport faults (dropped results, refused renewals) are injected here.
import { createServer } from 'node:http';
import { TaskDispatcher } from '../../../apps/api/dist/server.js';
import { MemoryStore } from '../../../packages/shared/dist/src/index.js';

export async function startControlPlane(options = {}) {
  const store = options.store ?? new MemoryStore();
  const dispatcher = new TaskDispatcher(store, options.now ?? Date.now, options.leaseMs ?? 30_000);
  await dispatcher.ready;
  const faults = { dropResults: 0, refuseRenew: false, ...options.faults };
  const stats = { claims: 0, claimRejections: 0, renewals: 0, results: [], committed: 0, duplicates: 0, staleResults: 0, droppedResults: 0 };
  const keepAlives = new Set();

  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    const body = req.method === 'POST' ? await readBody(req) : {};
    if (url.pathname === '/computers/register') return json(res, 200, { token: 'worker-token' });
    if (parts[0] !== 'computers') return json(res, 404, {});
    const computerId = decodeURIComponent(parts[1]);
    if (parts[2] === 'heartbeat') return json(res, 200, { ok: true });
    if (parts[2] === 'tasks' && parts[3] === 'stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.flushHeaders?.();
      const timer = setInterval(() => { res.write(': ping\n\n'); void dispatcher.redeliver().catch(() => undefined); }, options.redeliverMs ?? 5_000);
      keepAlives.add(timer);
      req.on('close', () => { clearInterval(timer); keepAlives.delete(timer); dispatcher.unsubscribe(computerId, res); });
      await dispatcher.subscribe(computerId, res);
      return;
    }
    if (parts[2] !== 'executions') return json(res, 404, {});
    const requestId = decodeURIComponent(parts[3]);
    const op = parts[4];
    const owner = await dispatcher.owner(requestId);
    if (owner === undefined) return json(res, 404, { error: 'unknown' });
    if (owner !== computerId) return json(res, 403, { error: 'not yours' });
    try {
      if (op === 'claim') {
        stats.claims++;
        try { return json(res, 200, await dispatcher.claim(requestId, computerId)); }
        catch (error) { stats.claimRejections++; throw error; }
      }
      if (op === 'renew') {
        if (faults.refuseRenew) return json(res, 409, { error: 'LEASE_LOST' });
        stats.renewals++;
        await dispatcher.renew(requestId, String(body.leaseToken ?? ''));
        return json(res, 200, { ok: true });
      }
      if (op === 'events') {
        await dispatcher.recordEvent(requestId, { executionId: String(body.executionId ?? ''), type: body.type ?? 'started', data: body.data, at: new Date() }, String(body.leaseToken ?? ''));
        return json(res, 200, { ok: true });
      }
      if (op === 'result') {
        stats.results.push({ ok: body.ok, output: body.output, error: body.error });
        if (faults.dropResults > 0) {
          faults.dropResults--;
          stats.droppedResults++;
          // Half the injected failures are a reset connection, half a 503.
          if (stats.droppedResults % 2) { req.socket.destroy(); return; }
          return json(res, 503, { error: 'unavailable' });
        }
        try {
          const committed = await dispatcher.commit(requestId, { ok: body.ok, output: body.output, error: body.error,
            inputTokens: body.inputTokens ?? 0, outputTokens: body.outputTokens ?? 0, durationMs: body.durationMs ?? 0 }, String(body.leaseToken ?? ''));
          if (committed === 'duplicate') { stats.duplicates++; return json(res, 200, { ok: true, duplicate: true }); }
          stats.committed++;
          return json(res, 200, { ok: true });
        } catch (error) { stats.staleResults++; throw error; }
      }
      return json(res, 404, {});
    } catch (error) {
      return json(res, 409, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    dispatcher,
    faults,
    stats,
    async close() {
      for (const t of keepAlives) clearInterval(t);
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Scriptable runtime adapter. `script(request, ctx)` is an async generator body; `ctx`
 * exposes `cancelled` (set by cancel()) and `sleep(ms)` that resolves early on cancel.
 */
export function scriptedAdapter(script, modelId = 'm') {
  const state = { generateCalls: [], cancelled: [] };
  const cancelWaiters = new Map();
  const adapter = {
    id: 'scripted', type: 'other', state,
    async discover() { return { id: 'scripted', name: 'scripted', version: '1' }; },
    async healthCheck() { return { status: 'healthy' }; },
    async listModels() { return [{ id: modelId, name: modelId }]; },
    async getCapabilities() {
      return { chat: true, streaming: true, toolCalling: false, structuredOutput: false, vision: false, embeddings: false,
        reasoning: false, modelLoad: false, modelUnload: false, modelDownload: false, statefulChat: false, mcp: false };
    },
    async *generate(request) {
      state.generateCalls.push(request.requestId);
      const ctx = {
        get cancelled() { return state.cancelled.includes(request.requestId); },
        sleep: (ms) => new Promise((resolve) => {
          const t = setTimeout(resolve, ms);
          cancelWaiters.set(request.requestId, () => { clearTimeout(t); resolve(); });
        }),
      };
      yield* script(request, ctx);
    },
    async cancel(requestId) {
      state.cancelled.push(requestId);
      cancelWaiters.get(requestId)?.();
    },
  };
  return adapter;
}

export const waitFor = async (predicate, timeoutMs = 10_000, stepMs = 20) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor: condition not met in time');
};
