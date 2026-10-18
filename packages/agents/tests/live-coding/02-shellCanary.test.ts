import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ExecutionEngine,
  PolicyEngine,
  type AgentRuntime,
  type ToolResult,
} from '@wazir/core';
import { ToolRegistry, defaultTools, executeTool as runRegisteredTool } from '@wazir/tools';
import { evaluateExecution } from '@wazir/evaluation';
import { createCodingAgent } from '../../src/codingAgent.js';

describe('LIVE-CODE-02: Real Model + Shell Canary (Release Gate G1)', () => {
  let projectRoot: string;

  afterEach(async () => {
    if (projectRoot) {
      await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('executes echo <canary> via shell tool with exitCode 0 and exact canary output verification', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-live02-canary-'));
    const canary = `WAZIR_CANARY_${Date.now()}_OK`;

    const tools = new ToolRegistry(defaultTools);
    const executions = new ExecutionEngine();
    const policy = new PolicyEngine({ projectRoot, networkAllowed: false });
    const agent = createCodingAgent();

    const record = await executions.create({
      task: {
        id: 'task-live-02',
        type: 'coding',
        input: `Run echo ${canary} using the shell tool and report the exact output.`,
        requirements: { minimumContext: 8192 },
        policy: { projectRoot, networkAccess: false },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      },
      agentId: agent.descriptor.name,
      computerId: 'local',
      runtimeId: 'fake',
      modelId: 'fake-model',
      workerId: 'worker-local',
      workspaceRoot: projectRoot,
    });
    const executionId = record.execution.id;

    const replies = [
      `{"action":"plan","content":"Execute echo ${canary} with shell tool and finish."}`,
      `{"action":"tool","tool":"shell","input":{"command":"echo ${canary}"}}`,
      `{"action":"done","summary":"${canary}"}`,
    ];
    let turnIdx = 0;

    const runtime: AgentRuntime = {
      tools: tools.forModel(undefined, agent.descriptor.capabilities),
      async *generate() {
        const content = replies[Math.min(turnIdx++, replies.length - 1)];
        yield { type: 'token' as const, content };
        yield { type: 'completed' as const, content, usage: { inputTokens: 8, outputTokens: 8 } };
      },
      async executeTool(name, input): Promise<ToolResult> {
        const decision = await policy.authorize({ tool: name, input, executionId, projectRoot });
        await executions.recordPolicy(executionId, decision);
        const result = await runRegisteredTool(tools, name, input, {
          verifyWorkspace: true,
          projectRoot,
          executionId,
          networkAllowed: false,
        });
        await executions.recordToolCall(executionId, {
          id: `call-${turnIdx}`,
          tool: name,
          input,
          output: result.output,
          ok: result.ok,
          error: result.error,
          policyEffect: decision.decision,
          policyRule: decision.rule,
          durationMs: result.durationMs,
          at: new Date(),
          exitCode: typeof result.metadata?.exitCode === 'number' ? result.metadata.exitCode : undefined,
        });
        return result;
      },
    };

    const turns = [];
    for await (const turn of agent.run(
      {
        modelId: 'fake-model',
        taskDescription: `Run echo ${canary} using the shell tool and report the exact output.`,
        taskType: 'coding',
        mutationRequired: false,
        projectRoot,
        maxTurns: 6,
      },
      runtime,
    )) {
      turns.push(turn);
    }

    const doneTurn = turns.find((t) => t.kind === 'done');
    expect(doneTurn).toBeDefined();
    expect(doneTurn?.content).toContain(canary);

    const finalRecord = executions.require(executionId);
    const shellCall = finalRecord.toolCalls.find((c) => c.tool === 'shell');
    expect(shellCall).toBeDefined();
    expect(shellCall?.ok).toBe(true);
    expect(shellCall?.exitCode).toBe(0);
    expect(shellCall?.output.trim()).toBe(canary);

    const evaluation = evaluateExecution(finalRecord);
    expect(evaluation.success).toBe(true);
  });

  it('fails evaluation when the shell canary command exits non-zero without recovery', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-live02-fail-'));
    const executions = new ExecutionEngine();
    const record = await executions.create({
      task: {
        id: 'task-live-02-fail',
        type: 'coding',
        input: 'Run failing canary command',
        requirements: { minimumContext: 8192 },
        policy: { projectRoot, networkAccess: false },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      },
      agentId: 'wazir-coding',
      computerId: 'local',
      runtimeId: 'fake',
      modelId: 'fake-model',
      workerId: 'worker-local',
      workspaceRoot: projectRoot,
    });
    const executionId = record.execution.id;

    await executions.recordToolCall(executionId, {
      id: 'call-fail-1',
      tool: 'shell',
      input: { command: 'node -e "process.exit(2)"' },
      output: '',
      error: 'Command exited with code 2',
      ok: false,
      exitCode: 2,
      durationMs: 10,
      at: new Date(),
    });

    const evaluation = evaluateExecution(executions.require(executionId));
    expect(evaluation.success).toBe(false);
    expect(evaluation.reasons.join(' ')).toContain('unresolved shell command failure');
  });
});
