import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentRegistry, Scheduler, ComputerRegistry, RuntimeRegistry, ModelRegistry, type Task } from '@wazir/core';
import { ExternalAgentAdapter, type ExternalAgentSpec } from '../src/externalAgent.js';

const execFileAsync = promisify(execFile);

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wazir-ext-agent-'));
}

describe('Section 11: External Agent (OpenCode) Suite', () => {
  let scratchDir: string | undefined;

  afterEach(async () => {
    if (scratchDir) {
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
      scratchDir = undefined;
    }
  });

  describe('Detection: binary presence on PATH', () => {
    it('detects binary when present on PATH and returns false when absent', async () => {
      scratchDir = await tempDir();
      const fakeBinPath = path.join(scratchDir, 'opencode');

      // Create a mock executable binary
      await fs.writeFile(
        fakeBinPath,
        `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "opencode version 0.5.2"
  exit 0
fi
exit 1
`,
        { mode: 0o755 },
      );

      const checkDetection = async (pathEnv: string): Promise<boolean> => {
        try {
          await execFileAsync('opencode', ['--version'], {
            env: { ...process.env, PATH: pathEnv },
            timeout: 2000,
          });
          return true;
        } catch {
          return false;
        }
      };

      // When absent from isolated PATH
      const absent = await checkDetection('/invalid/empty/bin/path');
      expect(absent).toBe(false);

      // When present on PATH
      const present = await checkDetection(`${scratchDir}:${process.env.PATH ?? ''}`);
      expect(present).toBe(true);
    });
  });

  describe('Routing Isolation: taskTypes: [] keeps it out of automatic routing', () => {
    it('is NEVER automatically selected by AgentRegistry.resolveForTask for unpinned tasks', () => {
      const agents = new AgentRegistry();

      // Register standard coding agent
      agents.register(
        {
          descriptor: {
            name: 'wazir-native-coder',
            version: '1.0',
            description: 'Native agent',
            capabilities: ['coding'],
            requiredTools: [],
            modelRequirements: { capabilities: ['coding'] },
            permissions: [],
            taskTypes: ['coding'],
            strategy: 'test',
          },
          async *run() {
            yield { kind: 'done', content: 'native' };
          },
        },
        'native',
      );

      // Register OpenCode external agent with taskTypes: []
      const opencodeSpec: ExternalAgentSpec = {
        name: 'opencode',
        version: 'external',
        description: 'OpenCode external agent',
        command: 'opencode',
        args: ['run'],
        taskTypes: [], // CRITICAL: empty taskTypes prevents auto-routing!
        capabilities: ['coding'],
      };
      agents.register(new ExternalAgentAdapter(opencodeSpec), 'external');

      // 1. Submit unpinned coding task
      const codingTask: Task = {
        id: 't-unpinned-code',
        type: 'coding',
        title: 'Fix typo in README',
        input: 'Please fix typo',
        requirements: {
          capabilities: ['coding'],
          reasoning: 'low',
          vision: false,
          toolCalling: false,
          minimumContext: 1024,
          minimumMemoryGB: 4,
          minimumGPUMemoryGB: 0,
          localOnly: false,
        },
        execution: { executionMode: 'automatic' },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const resolution = agents.resolveForTask(codingTask);
      expect(resolution).toBeDefined();
      expect(resolution.agent.descriptor.name).toBe('wazir-native-coder');
      expect(resolution.agent.descriptor.name).not.toBe('opencode');

      // 2. Submit chat task
      const chatTask: Task = {
        ...codingTask,
        id: 't-unpinned-chat',
        type: 'chat',
      };
      const resolvedChat = agents.resolveForTask(chatTask);
      expect(resolvedChat.agent.descriptor.name).toBe('wazir-native-coder');
      expect(resolvedChat.agent.descriptor.name).not.toBe('opencode');

      // 3. Explicit resolution still works when explicitly requested by name
      const explicit = agents.get('opencode');
      expect(explicit).toBeDefined();
      expect(explicit?.descriptor.name).toBe('opencode');
    });

    it('Scheduler never routes unpinned tasks to opencode without explicit targetAgentId', async () => {
      const computers = new ComputerRegistry();
      computers.register({
        id: 'local',
        name: 'local',
        type: 'workstation',
        local: true,
        hardware: { cpu: 'test', cpuCores: 8, memoryGB: 16 },
      });

      const runtimes = new RuntimeRegistry();
      runtimes.register({
        id: 'fake-rt',
        type: 'other',
        name: 'fake',
        version: '1.0',
        computerId: 'local',
        capabilities: { chat: true, streaming: true, toolCalling: false, structuredOutput: false, vision: false, embeddings: false, reasoning: false, modelLoad: false, modelUnload: false, modelDownload: false, statefulChat: false, mcp: false },
      });

      const models = new ModelRegistry();
      models.register({
        id: 'fake-m',
        name: 'fake-m',
        provider: 'fake-rt',
        family: 'other',
        contextMax: 32768,
        capabilities: ['coding'],
        toolCalling: false,
        structuredOutput: false,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: false,
        runtimeCompatibility: 'any',
        local: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      models.upsertInstance({
        id: 'fake-m::local::fake-rt',
        modelId: 'fake-m',
        computerId: 'local',
        runtimeId: 'fake-rt',
        runtimeModelId: 'fake-m',
        loaded: true,
        health: 'healthy',
      });

      const agents = new AgentRegistry();
      agents.register(
        {
          descriptor: {
            name: 'default-coder',
            version: '1.0',
            description: 'default coder',
            capabilities: ['coding'],
            requiredTools: [],
            modelRequirements: { capabilities: ['coding'] },
            permissions: [],
            taskTypes: ['coding'],
            strategy: 'test',
          },
          async *run() {
            yield { kind: 'done', content: 'ok' };
          },
        },
        'native',
      );

      // Register OpenCode external agent
      agents.register(
        new ExternalAgentAdapter({
          name: 'opencode',
          version: 'external',
          description: 'OpenCode external',
          command: 'opencode',
          args: ['run'],
          taskTypes: [],
          capabilities: ['coding'],
        }),
        'external',
      );

      const scheduler = new Scheduler({ computers, runtimes, models, agents });

      const decision = scheduler.plan({
        task: {
          id: 'task-routing-test',
          type: 'coding',
          title: 'Auto routed task',
          input: 'Do task',
          requirements: { capabilities: ['coding'], reasoning: 'low', vision: false, toolCalling: false, minimumContext: 1024, minimumMemoryGB: 4, minimumGPUMemoryGB: 0, localOnly: false },
          execution: { executionMode: 'automatic' },
          priority: 'normal',
          status: 'pending',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      // Must select default-coder, NEVER opencode!
      expect(decision.agentId).toBe('default-coder');
      expect(decision.agentId).not.toBe('opencode');
    });
  });

  describe('Invocation Shape: flags, prompt delivery, working dir', () => {
    it('executes external command with exact args, task description, and projectRoot cwd', async () => {
      scratchDir = await tempDir();
      const fakeBinaryPath = path.join(scratchDir, 'fake-opencode.sh');
      const logFilePath = path.join(scratchDir, 'invocation-log.json');

      // Create fake opencode binary that logs argv and cwd to a JSON file
      await fs.writeFile(
        fakeBinaryPath,
        `#!/usr/bin/env bash
python3 -c "
import sys, json, os
data = {
    'args': sys.argv[1:],
    'cwd': os.getcwd()
}
with open('${logFilePath}', 'w') as f:
    json.dump(data, f)
" "$@"
echo "OpenCode session completed successfully"
exit 0
`,
        { mode: 0o755 },
      );

      const targetProjectDir = path.join(scratchDir, 'target-project');
      await fs.mkdir(targetProjectDir);

      const adapter = new ExternalAgentAdapter({
        name: 'opencode',
        version: 'external',
        description: 'Test adapter',
        command: fakeBinaryPath,
        args: ['run', '--format', 'json'],
        taskTypes: [],
        capabilities: ['coding'],
      });

      const turns: any[] = [];
      const dummyRuntime: any = {};

      for await (const turn of adapter.run(
        {
          taskDescription: 'Implement feature X in src/feature.ts',
          projectRoot: targetProjectDir,
        },
        dummyRuntime,
      )) {
        turns.push(turn);
      }

      expect(turns).toHaveLength(2);
      expect(turns[0].kind).toBe('message');
      expect(turns[0].content).toContain('OpenCode session completed successfully');
      expect(turns[1].kind).toBe('done');

      // Inspect recorded invocation log
      const logRaw = await fs.readFile(logFilePath, 'utf8');
      const log = JSON.parse(logRaw);

      // Verify exact arguments: configured args + taskDescription appended
      expect(log.args).toEqual(['run', '--format', 'json', 'Implement feature X in src/feature.ts']);

      // Verify working directory matches projectRoot exactly
      expect(path.resolve(log.cwd)).toBe(path.resolve(targetProjectDir));
    });

    it('propagates failure exit code cleanly', async () => {
      scratchDir = await tempDir();
      const failingBinary = path.join(scratchDir, 'failing-agent.sh');

      await fs.writeFile(
        failingBinary,
        `#!/usr/bin/env bash
echo "Fatal error: syntax error in config" >&2
exit 42
`,
        { mode: 0o755 },
      );

      const adapter = new ExternalAgentAdapter({
        name: 'failing-agent',
        version: '1.0',
        description: 'Failing agent',
        command: failingBinary,
        taskTypes: [],
        capabilities: [],
      });

      await expect(async () => {
        for await (const _ of adapter.run({ taskDescription: 'fail', projectRoot: scratchDir! }, {} as any)) {
          // iterate
        }
      }).rejects.toThrow(/exited with code 42/);
    });
  });
});
