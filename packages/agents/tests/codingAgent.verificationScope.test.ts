import { describe, expect, it, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodingAgent } from '../src/codingAgent.js';
import type { AgentRunRequest, AgentRuntime, AgentTurn, ToolResult } from '@wazir/core';

/**
 * Regression coverage for P0-A (test/agy-execution-repair): VERIFY must scope
 * build/test/lint/typecheck to the workspace(s) the task actually touched instead of the
 * whole monorepo, unless scoping can't be justified (a changed file outside every known
 * workspace) or the caller explicitly asked for a full build (`fullVerification: true`).
 */

async function drain(turns: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const collected: AgentTurn[] = [];
  for await (const turn of turns) collected.push(turn);
  return collected;
}

describe('CodingAgent.run — VERIFY scopes checks to the workspace(s) actually touched', () => {
  let root: string;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  async function makeFakeMonorepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-vscope-agent-'));
    const pkg = async (rel: string, name: string) => {
      await fs.mkdir(path.join(dir, rel), { recursive: true });
      await fs.writeFile(path.join(dir, rel, 'package.json'), JSON.stringify({ name }));
    };
    await pkg('packages/agents', '@wazir/agents');
    await pkg('apps/desktop', '@wazir/desktop');
    return dir;
  }

  function runtimeThatWrites(file: string, calls: Array<{ tool: string; input: Record<string, unknown> }>): AgentRuntime {
    let call = 0;
    return {
      tools: [{ name: 'write', description: 'write a file', inputSchema: {} }],
      async *generate() {
        call += 1;
        const reply =
          call === 1
            ? '{"action":"plan","content":"write a file"}'
            : call === 2
              ? `{"action":"tool","tool":"write","input":{"path":"${file}","content":"x"}}`
              : '{"action":"done","summary":"done"}';
        yield { type: 'token' as const, content: reply };
        yield { type: 'completed' as const, content: reply };
      },
      async executeTool(name, input): Promise<ToolResult> {
        calls.push({ tool: name, input });
        return { ok: true, output: `ok:${name}`, durationMs: 1 };
      },
    };
  }

  it('scopes checks to the one workspace a changed file belongs to, never touching an unrelated package', async () => {
    root = await makeFakeMonorepo();
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const agent = createCodingAgent();
    const request: AgentRunRequest = {
      modelId: 'fake-model',
      taskDescription: 'write a function in the agents package',
      taskType: 'coding',
      projectRoot: root,
      maxTurns: 5,
    };
    await drain(agent.run(request, runtimeThatWrites('packages/agents/src/thing.ts', calls)));

    const checkCalls = calls.filter((c) => ['build', 'test', 'lint', 'typecheck'].includes(c.tool));
    expect(checkCalls.length).toBeGreaterThan(0);
    for (const c of checkCalls) {
      expect(c.input.workspaces).toEqual(['@wazir/agents']);
    }
  });

  it('falls back to a full, unscoped run when a changed file is outside every known workspace', async () => {
    root = await makeFakeMonorepo();
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const agent = createCodingAgent();
    const request: AgentRunRequest = {
      modelId: 'fake-model',
      taskDescription: 'edit a root config file',
      taskType: 'coding',
      projectRoot: root,
      maxTurns: 5,
    };
    await drain(agent.run(request, runtimeThatWrites('package.json', calls)));

    const checkCalls = calls.filter((c) => ['build', 'test', 'lint', 'typecheck'].includes(c.tool));
    expect(checkCalls.length).toBeGreaterThan(0);
    for (const c of checkCalls) {
      expect(c.input.workspaces).toBeUndefined();
    }
  });

  it('runs a full, unscoped verification when the caller explicitly requests it, even for a single-workspace change', async () => {
    root = await makeFakeMonorepo();
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const agent = createCodingAgent();
    const request: AgentRunRequest = {
      modelId: 'fake-model',
      taskDescription: 'write a function, but verify everything',
      taskType: 'coding',
      projectRoot: root,
      maxTurns: 5,
      fullVerification: true,
    };
    await drain(agent.run(request, runtimeThatWrites('packages/agents/src/thing.ts', calls)));

    const checkCalls = calls.filter((c) => ['build', 'test', 'lint', 'typecheck'].includes(c.tool));
    expect(checkCalls.length).toBeGreaterThan(0);
    for (const c of checkCalls) {
      expect(c.input.workspaces).toBeUndefined();
    }
  });
});
