import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApiState, createApp } from '../../apps/api/src/server.js';
import { Worker, dispatchRemote } from '@wazir/workers';
import {
  ComputerRegistry,
  ExecutionEngine,
  ModelRegistry,
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
  Task,
  WorkerExecutionRequest,
} from '@wazir/core';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';

describe('Phase 5: End-to-End Heterogeneous Coding Task Verification', () => {
  let scratchDir: string | undefined;
  const serversToClose: Server[] = [];
  const workersToStop: Worker[] = [];

  afterEach(async () => {
    for (const w of workersToStop) await w.stop().catch(() => undefined);
    workersToStop.length = 0;
    for (const s of serversToClose) await new Promise<void>((r) => s.close(() => r()));
    serversToClose.length = 0;
    if (scratchDir) {
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
      scratchDir = undefined;
    }
  });

  it('runs complete 10-step lifecycle for a coding task dispatched to Linux ARM64 DGX Spark worker', async () => {
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-e2e-hetero-'));
    const sourceFilePath = path.join(scratchDir, 'matrix_mul.cu');
    const artifactPath = path.join(scratchDir, 'matrix_mul.ptx');

    // 1. Controller setup (Control Plane)
    const state = await createApiState({ auth: { allowUnauthenticated: true } });
    const app = createApp(state);
    const server: Server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', r));
    serversToClose.push(server);
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Register DGX Spark Worker with real CUDA capability
    const dgxAdapter: RuntimeAdapter = {
      id: 'ollama-dgx',
      type: 'ollama',
      async discover() { return { id: 'ollama-dgx', name: 'Ollama DGX', version: '0.3.0' }; },
      async healthCheck() { return { status: 'healthy' }; },
      async listModels() { return [{ id: 'qwen2.5-coder:32b', name: 'qwen2.5-coder:32b' }]; },
      async getCapabilities() {
        return {
          chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: true,
          embeddings: true, reasoning: true, modelLoad: true, modelUnload: true, modelDownload: true,
          statefulChat: false, mcp: true,
        };
      },
      async *generate() {
        // 5. Run agent: create files and compile
        await fs.writeFile(sourceFilePath, '__global__ void matmul() {}', 'utf8');
        await fs.writeFile(artifactPath, '// PTX generated for sm_100', 'utf8');
        yield { type: 'token' as const, content: 'Compiling CUDA kernel on DGX Spark GB10...' };
        yield {
          type: 'completed' as const,
          content: 'Kernel compiled successfully with NVCC.',
          usage: { inputTokens: 50, outputTokens: 25 },
        };
      },
    };

    const worker = new Worker({
      computerId: 'dgx-spark-worker',
      name: 'dgx-spark-01',
      serverUrl: baseUrl,
      adapters: [dgxAdapter],
      os: { platform: 'linux', architecture: 'arm64', version: '7.0.0-1019-nvidia' },
      hardware: {
        cpu: 'Cortex-X925',
        cpuCores: 20,
        memoryGB: 122,
        gpu: { vendor: 'nvidia', model: 'NVIDIA GB10', memoryGB: 122, unifiedMemory: true, cuda: true },
      },
    });
    workersToStop.push(worker);
    await worker.start();

    // 1. Submit task
    const task: Task = {
      id: 'task-e2e-cuda',
      type: 'coding',
      title: 'CUDA Matrix Multiplication',
      input: 'Implement and compile a matrix multiplication kernel for DGX Spark',
      requirements: {
        os: 'linux',
        architecture: 'arm64',
        requiresCuda: true,
        minimumMemoryGB: 32,
      },
      model: 'qwen2.5-coder:32b',
      execution: {
        targetComputerId: 'dgx-spark-worker',
      },
      priority: 'high',
      status: 'pending',
    };

    // 2. Select eligible worker using Scheduler
    const scheduler = new Scheduler({
      computers: state.computers,
      runtimes: state.runtimes,
      models: state.models,
      policy: new PolicyEngine(),
    });
    const decision = scheduler.plan({ task });
    expect(decision.computerId).toBe('dgx-spark-worker');
    expect(decision.reasons.some((r) => r.includes('NVIDIA CUDA acceleration active (NVIDIA GB10)'))).toBe(true);

    // 3. Reserve resources & 4. Dispatch execution
    const request: WorkerExecutionRequest = {
      executionId: 'exec-e2e-cuda',
      requestId: 'req-e2e-cuda',
      modelId: decision.modelId,
      runtimeId: decision.runtimeId,
      messages: [{ role: 'user', content: task.input }],
    };

    const events: any[] = [];
    const outcomeGen = dispatchRemote(baseUrl, 'dgx-spark-worker', request);
    let step = await outcomeGen.next();
    while (!step.done) {
      events.push(step.value);
      step = await outcomeGen.next();
    }
    const outcome = step.value;

    // 6. Collect artifacts & 7. Verify output
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toContain('Kernel compiled successfully with NVCC');
    const srcExists = await fs.access(sourceFilePath).then(() => true).catch(() => false);
    const ptxExists = await fs.access(artifactPath).then(() => true).catch(() => false);
    expect(srcExists).toBe(true);
    expect(ptxExists).toBe(true);

    // 8. Persist results
    const status = await state.dispatcher.status('req-e2e-cuda');
    expect(status?.outcome?.ok).toBe(true);

    // 9. Reconcile usage
    expect(outcome.inputTokens).toBe(50);
    expect(outcome.outputTokens).toBe(25);

    // 10. Report completion
    expect(events.length).toBeGreaterThan(0);
  });
});
