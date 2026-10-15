// Disposable worker process for restart/kill tests. Imports the shipped build.
// argv: <serverUrl> <computerId> <generationMs> <markerFile>
import { appendFileSync } from 'node:fs';
import { Worker } from '../../packages/workers/dist/src/index.js';
import { scriptedAdapter } from './fixtures/controlPlane.mjs';

const [serverUrl, computerId, generationMs, marker] = process.argv.slice(2);
const adapter = scriptedAdapter(async function* (request, ctx) {
  appendFileSync(marker, `start ${request.requestId} pid=${process.pid}\n`);
  yield { type: 'token', content: 'partial ' };
  await ctx.sleep(Number(generationMs));
  if (ctx.cancelled) { yield { type: 'completed', finishReason: 'cancelled' }; return; }
  appendFileSync(marker, `done ${request.requestId} pid=${process.pid}\n`);
  yield { type: 'completed', content: `answer from ${process.pid}` };
});
const worker = new Worker({ computerId, serverUrl, adapters: [adapter], heartbeatIntervalMs: 60_000, resultRetryBaseMs: 20 });
await worker.start();
console.log('ready');
const shutdown = async () => { await worker.stop(); appendFileSync(marker, `stopped pid=${process.pid}\n`); process.exit(0); };
process.on('SIGTERM', () => { void shutdown(); });
