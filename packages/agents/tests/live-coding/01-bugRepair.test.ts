import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execSync } from 'node:child_process';
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

describe('LIVE-CODE-01: Autonomous Bug Repair (Release Gate G2)', () => {
  let projectRoot: string;

  afterEach(async () => {
    if (projectRoot) {
      await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runRepairScenario(scriptedReplies: string[], protectedFiles: string[] = ['add.test.js']) {
    const tools = new ToolRegistry(defaultTools);
    const executions = new ExecutionEngine();
    const policy = new PolicyEngine({ projectRoot, networkAllowed: false });
    const agent = createCodingAgent();

    const record = await executions.create({
      task: {
        id: 'task-live-01',
        type: 'coding',
        input: 'Fix add.js so node add.test.js passes. Do not modify add.test.js.',
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

    let callIndex = 0;
    const runtime: AgentRuntime = {
      tools: tools.forModel(undefined, agent.descriptor.capabilities),
      async *generate() {
        const reply = scriptedReplies[Math.min(callIndex, scriptedReplies.length - 1)];
        callIndex += 1;
        yield { type: 'token' as const, content: reply };
        yield { type: 'completed' as const, content: reply, usage: { inputTokens: 10, outputTokens: 10 } };
      },
      async executeTool(name, input): Promise<ToolResult> {
        const decision = await policy.authorize({ tool: name, input, executionId, projectRoot });
        await executions.recordPolicy(executionId, decision);
        if (decision.decision !== 'allow') {
          return { ok: false, output: '', error: `policy denied: ${decision.rule}`, durationMs: 0 };
        }
        const result = await runRegisteredTool(tools, name, input, {
          verifyWorkspace: true,
          allowVerificationChanges: false,
          projectRoot,
          executionId,
          networkAllowed: false,
        });
        await executions.recordToolCall(executionId, {
          id: `call-${Date.now()}-${Math.random()}`,
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
        if (result.fileMutations && result.fileMutations.length > 0) {
          const changed = result.fileMutations
            .filter((m) => m.changed)
            .map((m) => ({
              ...m,
              path: path.relative(projectRoot, path.resolve(projectRoot, m.path)).split(path.sep).join('/'),
            }));
          if (changed.length > 0) {
            await executions.recordFileMutations(executionId, changed);
          }
        }
        if (name === 'shell' && typeof input.command === 'string' && /\.test\.js/.test(input.command)) {
          await executions.recordCheck(executionId, {
            workspaceRevision: executions.getWorkspaceRevision(executionId),
            name: 'test',
            command: input.command,
            ok: result.ok,
            output: result.output,
            durationMs: result.durationMs,
          });
        }
        return result;
      },
    };

    const turns = [];
    for await (const turn of agent.run(
      {
        modelId: 'fake-model',
        taskDescription: 'Fix add.js so node add.test.js passes. Do not modify add.test.js.',
        taskType: 'coding',
        projectRoot,
        maxTurns: 10,
      },
      runtime,
    )) {
      turns.push(turn);
    }

    const finalRecord = executions.require(executionId);
    const evaluation = evaluateExecution(finalRecord, {
      expectedFiles: ['add.js'],
      protectedFiles,
      expectedEvidence: ['checks_pass'],
    });
    return { turns, finalRecord, evaluation };
  }

  it('modifies add.js while preserving add.test.js byte-identically and passes external verification', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-agent-live01-'));
    const testFixture =
      'const add = require("./add.js");\nif (add(2,3) !== 5 || add(-1,1) !== 0) { process.exit(1); } else { console.log("PASS"); process.exit(0); }\n';
    await fs.writeFile(path.join(projectRoot, 'add.js'), 'function add(a, b) { return a - b; }\nmodule.exports = add;\n');
    await fs.writeFile(path.join(projectRoot, 'add.test.js'), testFixture);

    const { finalRecord, evaluation } = await runRepairScenario([
      '{"action":"plan","content":"Run test, inspect add.js, patch subtraction to addition, and re-run test."}',
      '{"action":"tool","tool":"shell","input":{"command":"node add.test.js"}}',
      '{"action":"tool","tool":"read","input":{"path":"add.js"}}',
      '{"action":"tool","tool":"edit","input":{"path":"add.js","oldString":"return a - b;","newString":"return a + b;"}}',
      '{"action":"tool","tool":"shell","input":{"command":"node add.test.js"}}',
      '{"action":"done","summary":"Patched add.js and verified node add.test.js passes."}',
    ]);

    expect(evaluation.success).toBe(true);
    expect(finalRecord.filesChanged).toEqual(['add.js']);
    expect(await fs.readFile(path.join(projectRoot, 'add.test.js'), 'utf8')).toBe(testFixture);
    expect(execSync('node add.test.js', { cwd: projectRoot }).toString()).toContain('PASS');
  });

  it('rejects execution when protected test fixture add.test.js is tampered with', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-agent-live01-neg-'));
    await fs.writeFile(path.join(projectRoot, 'add.js'), 'function add(a, b) { return a - b; }\nmodule.exports = add;\n');
    await fs.writeFile(
      path.join(projectRoot, 'add.test.js'),
      'const add = require("./add.js");\nif (add(2,3) !== 5) { process.exit(1); }\n',
    );

    const { evaluation } = await runRepairScenario([
      '{"action":"plan","content":"Overwrite add.test.js to always exit 0."}',
      '{"action":"tool","tool":"write","input":{"path":"add.test.js","content":"console.log(\\"PASS\\"); process.exit(0);"}}',
      '{"action":"tool","tool":"shell","input":{"command":"node add.test.js"}}',
      '{"action":"done","summary":"Test passes now."}',
    ]);

    expect(evaluation.success).toBe(false);
  });
});
