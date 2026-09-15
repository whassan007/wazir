import { spawn } from 'node:child_process';
import type {
  AgentAdapter,
  AgentDescriptor,
  AgentRunRequest,
  AgentRuntime,
  AgentTurn,
  TaskType,
} from '@rook/core';

export interface ExternalAgentSpec {
  name: string;
  version: string;
  description: string;
  /** Executable to run for a task, e.g. 'opencode' or 'bionic'. */
  command: string;
  args?: string[];
  taskTypes: TaskType[];
  capabilities: string[];
  timeoutMs?: number;
}

/**
 * Adapter for external agent harnesses (OpenCode, Bionic, ...).
 * External agents are OPTIONAL execution providers — Rook remains the
 * control plane: it schedules the task, selects the model/computer, and
 * records the execution. The external process only provides the reasoning loop.
 */
export class ExternalAgentAdapter implements AgentAdapter {
  readonly descriptor: AgentDescriptor;
  private readonly spec: ExternalAgentSpec;

  constructor(spec: ExternalAgentSpec) {
    this.spec = spec;
    this.descriptor = {
      name: spec.name,
      version: spec.version,
      description: spec.description,
      capabilities: spec.capabilities,
      requiredTools: [],
      modelRequirements: { capabilities: [] },
      permissions: [],
      taskTypes: spec.taskTypes,
      strategy: 'external',
    };
  }

  async *run(request: AgentRunRequest, _runtime: AgentRuntime): AsyncIterable<AgentTurn> {
    const args = [...(this.spec.args ?? []), request.taskDescription];

    const output = await new Promise<string>((resolve, reject) => {
      let captured = '';
      const child = spawn(this.spec.command, args, {
        cwd: request.projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), this.spec.timeoutMs ?? 600_000);
      child.stdout.on('data', (chunk: Buffer) => {
        captured += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        captured += chunk.toString();
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(captured);
        else reject(new Error(`'${this.spec.command}' exited with code ${code}`));
      });
    });

    if (request.isCancelled?.()) {
      yield { kind: 'error', error: 'cancelled' };
      return;
    }

    yield { kind: 'message', content: output.slice(0, 20_000) };
    yield { kind: 'done', content: `external agent '${this.descriptor.name}' completed` };
  }
}
