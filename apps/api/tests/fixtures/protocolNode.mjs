// An independent API process for cross-process protocol tests. Several of these
// share one durable JsonFileStore; the test talks to each over real HTTP.
//
// env:
//   NODE_STORE        path of the shared JsonFileStore file
//   NODE_PG_URL       use a shared PostgresStore at this URL instead
//   NODE_ROOT         project root tool calls are confined to
//   NODE_AUDIT        audit log path
//   NODE_CRASH        optional fault: SIGKILL this process when a store write matches
//                       'after-dispatch'  first write recording a step with a tool outcome
//                       'after-intent'    first write recording a dispatching step (before the tool runs)
//                       'before-verify-record' first write carrying verification evidence
//   NODE_FAIL_WRITE   optional fault: throw from store writes matching the same names
import http from 'node:http';
import { JsonFileStore } from '@wazir/shared';
import { createApiState, createApp } from '../../dist/server.js';

const crash = process.env.NODE_CRASH;
const failWrite = process.env.NODE_FAIL_WRITE;

function steps(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value.steps)) return value.steps;
  if (value.step_id) return [value];
  return [];
}

function matches(fault, key, value) {
  if (!fault) return false;
  if (fault === 'before-verify-record') return key.includes('verification') || steps(value).some((s) => s.additional_output?.verification);
  return steps(value).some((s) => {
    const out = s.additional_output ?? {};
    if (fault === 'after-dispatch') return out.tool !== undefined;
    if (fault === 'after-intent') return out.phase === 'dispatching';
    return false;
  });
}

function check(key, value) {
  if (matches(crash, key, value)) {
    process.stdout.write(`CRASH ${crash} ${key}\n`);
    process.kill(process.pid, 'SIGKILL');
  }
  if (matches(failWrite, key, value)) throw new Error(`injected store write failure (${failWrite}) for ${key}`);
}

/** Wraps any KeyValueStore with the configured fault; mutations are previewed before the real write. */
class FaultyStore {
  constructor(inner) { this.inner = inner; }
  async put(key, value) { check(key, value); return this.inner.put(key, value); }
  async update(key, mutate) {
    // Preview the write against the current value so a crash happens before any lock is taken.
    const preview = mutate(structuredClone(await this.inner.get(key)));
    check(key, preview);
    return this.inner.update(key, mutate);
  }
  get(key) { return this.inner.get(key); }
  list(prefix) { return this.inner.list(prefix); }
  delete(key) { return this.inner.delete(key); }
  clear() { return this.inner.clear(); }
}

async function backingStore() {
  if (!process.env.NODE_PG_URL) return new JsonFileStore(process.env.NODE_STORE);
  const { createPool, runKvMigration, PostgresStore } = await import('@wazir/database');
  const pool = createPool({ connectionString: process.env.NODE_PG_URL });
  await runKvMigration(pool);
  return new PostgresStore(pool);
}

const state = await createApiState({
  auth: { operatorToken: 'operator-token-0123456789', viewerToken: 'viewer-token-0123456789' },
  store: new FaultyStore(await backingStore()),
  projectRoot: process.env.NODE_ROOT,
  auditPath: process.env.NODE_AUDIT,
  approveTool: async () => true,
});
state.lifecycle.stopReconciliation?.();
const server = http.createServer(createApp(state));
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`LISTENING ${server.address().port}\n`);
});
