import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentAdapter, AgentTurn } from '@wazir/core';

/**
 * READY: the agent answered a probe prompt. FAILED: it could not (detail says why).
 * BLOCKED: it must not be launched in this environment (nothing was started).
 * UNKNOWN: never checked, or the cached result expired.
 */
export type AgentPreflightStatus = 'READY' | 'FAILED' | 'BLOCKED' | 'UNKNOWN';

/** How far the probe got: `start` = launch/handshake/session, `answer` = the probe prompt. */
export type AgentPreflightStage = 'environment' | 'start' | 'answer';

export interface AgentPreflightResult {
  version?: string;
  /** Discovery scope and configuration identity used to invalidate cached results. */
  fingerprint?: string;
  agent: string;
  status: AgentPreflightStatus;
  stage?: AgentPreflightStage;
  detail: string;
  hint?: string;
  durationMs: number;
  checkedAt: string;
}

const PROBE_PROMPT = 'Reply with the single word OK. Do not use any tools.';

/** Where each agent keeps its own model and account settings, for fix hints. */
const AGENT_CONFIG: Record<string, string> = {
  'qwen-code': '~/.qwen/settings.json',
  gemini: '~/.gemini/settings.json',
  codex: '~/.codex/config.toml',
  'claude-code': '~/.claude/settings.json',
};

/** Environments in which an agent refuses to start; checked before launching anything. */
const BLOCKERS: Array<{ agent: string; env: string; detail: string; hint: string }> = [
  {
    agent: 'claude-code',
    env: 'CLAUDECODE',
    detail: 'running inside a Claude Code session; Claude Code refuses nested sessions',
    hint: 'run wa from a normal terminal',
  },
];

/**
 * Maps an agent's failure text to a status and a fix hint. Patterns follow vendors' current
 * wording, so an unmatched message keeps its full detail and simply gets no hint.
 */
export function classifyAgentFailure(agent: string, text: string): { status: 'FAILED' | 'BLOCKED'; hint?: string } {
  const config = AGENT_CONFIG[agent];
  if (/cannot be launched inside another Claude Code session/i.test(text)) {
    return { status: 'BLOCKED', hint: 'run wa from a normal terminal' };
  }
  if (/requires a newer version of Codex|not supported when using Codex with a ChatGPT account/i.test(text)) {
    return {
      status: 'FAILED',
      hint: "the codex-acp bridge is older than the model your account requires; wait for a codex-acp release",
    };
  }
  if (/no longer supported for Gemini Code Assist for individuals/i.test(text)) {
    return { status: 'FAILED', hint: 'Google retired this tier; use --agent antigravity' };
  }
  if (/ENOENT|command not found|not installed/i.test(text)) {
    return { status: 'FAILED', hint: `install the ${agent} CLI and make sure it is on PATH` };
  }
  if (/connection error|ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH|socket hang up/i.test(text)) {
    return { status: 'FAILED', hint: `the agent's model endpoint is unreachable; check its own settings${config ? ` (${config})` : ''}` };
  }
  if (/\b(401|403)\b|unauthori[sz]ed|not (logged|signed) in|log ?in required|authenticat|credential|api key/i.test(text)) {
    return { status: 'FAILED', hint: `sign in: run the ${agent} CLI once interactively` };
  }
  if (/context length|n_ctx|context window|maximum context|too many tokens/i.test(text)) {
    return { status: 'FAILED', hint: "the agent's model context window is smaller than its prompt; load the model with a larger context (e.g. in LM Studio) or pick a larger-context model" };
  }
  if (/did not initialize within|exceeded its wall-clock bound|timed out/i.test(text)) {
    return { status: 'FAILED', hint: 'the agent did not respond in time; retry, or run its CLI once to finish any first-run setup' };
  }
  return { status: 'FAILED' };
}

/** A cached result is reused for this long before the agent is probed again. */
export const PREFLIGHT_TTL_MS = 10 * 60_000;

export function isPreflightFresh(result: Pick<AgentPreflightResult, 'checkedAt'> | undefined, now = Date.now(), ttlMs = PREFLIGHT_TTL_MS): boolean {
  if (!result) return false;
  const at = new Date(result.checkedAt).getTime();
  return Number.isFinite(at) && now - at >= 0 && now - at < ttlMs;
}

/**
 * Checks that an agent can actually do work, by driving its real run() path with a one-line
 * prompt in an empty temporary directory. Exercises everything a real task uses (launch,
 * protocol handshake, session, sign-in, model call, shutdown) at the cost of one tiny turn.
 */
export async function preflightAgent(
  adapter: AgentAdapter,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<AgentPreflightResult> {
  const agent = adapter.descriptor.name;
  const started = Date.now();
  const finish = (r: Omit<AgentPreflightResult, 'agent' | 'durationMs' | 'checkedAt'>): AgentPreflightResult =>
    ({ agent, ...r, durationMs: Date.now() - started, checkedAt: new Date().toISOString() });

  const env = options.env ?? process.env;
  const blocker = BLOCKERS.find((b) => b.agent === agent.split('@')[0] && env[b.env]);
  if (blocker) return finish({ status: 'BLOCKED', stage: 'environment', detail: blocker.detail, hint: blocker.hint });

  const timeoutMs = options.timeoutMs ?? 90_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Preflight timeout must be a positive finite number');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wazir-preflight-'));
  const deadline = started + timeoutMs;
  let sessionOpened = false;
  let last: AgentTurn | undefined;
  let answeredProbe = false;
  const requiresProbeAnswer = ['codex', 'claude-code', 'antigravity'].includes(agent.split('@')[0]);
  try {
    for await (const turn of adapter.run({
      modelId: 'external',
      taskType: 'chat',
      taskDescription: PROBE_PROMPT,
      projectRoot: dir,
      maxWallClockMs: timeoutMs,
      isCancelled: () => Date.now() >= deadline,
    } as Parameters<AgentAdapter['run']>[0], {} as Parameters<AgentAdapter['run']>[1])) {
      if (turn.kind === 'message' && /^delegated to /.test(turn.content ?? '')) sessionOpened = true;
      last = turn;
      if ((turn.kind === 'message' || turn.kind === 'done') && /(^|\n)\s*OK[.!]?\s*($|\n)/.test(turn.content ?? '')) answeredProbe = true;
    }
  } catch (error) {
    last = { kind: 'error', error: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  if (last?.kind === 'done' && (!requiresProbeAnswer || answeredProbe)) {
    return finish({ status: 'READY', stage: 'answer', detail: `answered in ${((Date.now() - started) / 1000).toFixed(1)}s` });
  }
  const detail = last?.kind === 'error'
    ? (last.terminationReason === 'CANCELLED' || last.terminationReason === 'MAX_WALL_CLOCK'
      ? `no answer within ${Math.round(timeoutMs / 1000)}s (timed out)`
      : String(last.error ?? 'unknown error'))
    : 'agent ended without an answer';
  const stage: AgentPreflightStage = sessionOpened ? 'answer' : /^could not start/.test(detail) ? 'start' : 'answer';
  const { status, hint } = classifyAgentFailure(agent, detail);
  // eslint-disable-next-line no-control-regex
  const plain = detail.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
  return finish({ status, stage, detail: plain.slice(0, 400), hint });
}
