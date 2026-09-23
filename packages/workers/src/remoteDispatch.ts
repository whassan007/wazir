import type { WorkerExecutionEvent, WorkerEventType, WorkerExecutionRequest } from '@wazir/core';

export interface RemoteExecutionOutcome {
  ok: boolean;
  output: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
}

export interface DispatchOptions {
  /** Give up waiting for the worker after this long (default 120s). */
  timeoutMs?: number;
  /** How often to poll the control plane for new events/outcome (default 300ms). */
  pollIntervalMs?: number;
  /** Operator token (`WAZIR_API_TOKEN`) when the control plane requires one. */
  token?: string;
}

/**
 * Event types that are internal to the control-plane lease/recovery mechanism.
 * These events are preserved in the server-side event store for observability
 * and lease-state reconstruction but are **not** part of the public execution
 * event stream exposed to `dispatchRemote` callers.
 *
 * Only event types explicitly classified here are suppressed — unknown or
 * future event types always pass through to the caller unchanged.
 */
const CONTROL_PLANE_EVENT_TYPES = new Set<WorkerEventType>([
  'lease_acquired',
  'lease_renewed',
]);

/**
 * Dispatches an authorized execution request to a specific computer through
 * the control plane's task-pull loop (`apps/api`'s `TaskDispatcher`), then
 * polls for streamed events until the worker reports a final outcome.
 *
 * This is the scheduling-side counterpart to `Worker.execute()`: a caller
 * that already decided *which* computer should run a task (e.g. the
 * `Scheduler`) uses this to actually hand the work to that computer's worker,
 * wherever it is, instead of only being able to run work in-process.
 *
 * Control-plane events (`lease_acquired`, `lease_renewed`) are accepted from
 * the server but filtered at this consumer boundary — they are not yielded to
 * callers. All other event types, including any unknown future types, pass
 * through unmodified.
 */
export async function* dispatchRemote(
  apiUrl: string,
  computerId: string,
  request: WorkerExecutionRequest,
  options: DispatchOptions = {},
): AsyncGenerator<WorkerExecutionEvent, RemoteExecutionOutcome> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 300;
  const base = apiUrl.replace(/\/+$/, '');
  const authHeaders: Record<string, string> = options.token ? { Authorization: `Bearer ${options.token}` } : {};

  const dispatchRes = await fetch(`${base}/api/v1/tasks/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ computerId, request }),
  });
  if (!dispatchRes.ok) {
    const body = (await dispatchRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(`dispatch to '${computerId}' failed: ${body.error ?? dispatchRes.statusText}`);
  }

  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for computer '${computerId}' to report a result for '${request.requestId}'`);
    }

    const statusRes = await fetch(`${base}/api/v1/tasks/${encodeURIComponent(request.requestId)}/status`, { headers: authHeaders });
    if (statusRes.ok) {
      const status = (await statusRes.json()) as { events: WorkerExecutionEvent[]; outcome?: RemoteExecutionOutcome };
      for (; seen < status.events.length; seen++) {
        const ev = status.events[seen];
        // Suppress internal control-plane events at the consumer boundary.
        // They remain in the server-side store for lease/recovery observability.
        if (!CONTROL_PLANE_EVENT_TYPES.has(ev.type)) {
          yield ev;
        }
      }
      if (status.outcome) {
        return status.outcome;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
