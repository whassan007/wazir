// An independent API process for cross-process protocol tests. Several of these
// share one durable JsonFileStore; the test talks to each over real HTTP.
//
// env:
//   NODE_STORE        path of the shared JsonFileStore file
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

class FaultyStore extends JsonFileStore {
  async put(key, value) { check(key, value); return super.put(key, value); }
  async update(key, mutate) {
    // Preview the write against the current value so a crash happens before the lock is taken.
    const preview = mutate(structuredClone(await this.get(key)));
    check(key, preview);
    return super.update(key, mutate);
  }
}

const state = await createApiState({
  auth: { operatorToken: 'operator-token-0123456789', viewerToken: 'viewer-token-0123456789' },
  store: new FaultyStore(process.env.NODE_STORE),
  projectRoot: process.env.NODE_ROOT,
  auditPath: process.env.NODE_AUDIT,
  approveTool: async () => true,
});
state.lifecycle.stopReconciliation?.();
const server = http.createServer(createApp(state));
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`LISTENING ${server.address().port}\n`);
});
