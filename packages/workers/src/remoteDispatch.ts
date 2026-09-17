import type { WorkerExecutionRequest, WorkerExecutionEvent } from '@wazir/core';

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
}

/**
 * Dispatches an authorized execution request to a specific computer through
 * the control plane's task-pull loop (`apps/api`'s `TaskDispatcher`), then
 * polls for streamed events until the worker reports a final outcome.
 *
 * This is the scheduling-side counterpart to `Worker.execute()`: a caller
 * that already decided *which* computer should run a task (e.g. the
 * `Scheduler`) uses this to actually hand the work to that computer's worker,
 * wherever it is, instead of only being able to run work in-process.
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

  const dispatchRes = await fetch(`${base}/api/v1/tasks/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

    const statusRes = await fetch(`${base}/api/v1/tasks/${encodeURIComponent(request.requestId)}/status`);
    if (statusRes.ok) {
      const status = (await statusRes.json()) as { events: WorkerExecutionEvent[]; outcome?: RemoteExecutionOutcome };
      for (; seen < status.events.length; seen++) {
        yield status.events[seen];
      }
      if (status.outcome) {
        return status.outcome;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
