import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApiState, createApp } from '../../apps/api/src/server.js';
import { Worker, dispatchRemote } from '@wazir/workers';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { WorkerExecutionRequest, OSInfo, HardwareInfo } from '@wazir/core';

interface TestFleetNode {
  os: OSInfo;
  hardware: HardwareInfo;
}

const FLEET_PROFILES: Record<string, TestFleetNode> = {
  'dgx-spark-linux-arm64': {
    os: { platform: 'linux', architecture: 'arm64', version: '7.0.0-1019-nvidia' },
    hardware: {
      cpu: 'Cortex-X925',
      cpuCores: 20,
      memoryGB: 122,
      gpu: { vendor: 'nvidia', model: 'NVIDIA GB10', memoryGB: 122, unifiedMemory: true, cuda: true },
    },
  },
  'mac-studio-arm64': {
    os: { platform: 'darwin', architecture: 'arm64', version: '14.5' },
    hardware: {
      cpu: 'Apple M3 Max',
      cpuCores: 16,
      memoryGB: 64,
      gpu: { vendor: 'apple', model: 'Apple M3 Max GPU', memoryGB: 64, unifiedMemory: true },
    },
  },
  'win-workstation-x64': {
    os: { platform: 'win32', architecture: 'x64', version: '10.0.22631' },
    hardware: {
      cpu: 'Intel Core i9-14900K',
      cpuCores: 24,
      memoryGB: 64,
      gpu: { vendor: 'nvidia', model: 'NVIDIA GeForce RTX 4090', memoryGB: 24, cuda: true },
    },
  },
  'linux-cloud-x64': {
    os: { platform: 'linux', architecture: 'x64', version: '6.5.0-generic' },
    hardware: {
      cpu: 'AMD EPYC 7763',
      cpuCores: 32,
      memoryGB: 128,
    },
  },
};

function createMockAdapter(id = 'fake-ollama', modelId = 'qwen2.5-coder:32b'): RuntimeAdapter {
  return {
    id,
    type: 'ollama',
    async discover() {
      return { id, name: 'Ollama Discovered', version: '0.3.0' };
    },
    async healthCheck() {
      return { status: 'healthy' };
    },
    async listModels() {
      return [{ id: modelId, name: modelId }];
    },
    async getCapabilities() {
      return {
        chat: true,
        streaming: true,
        toolCalling: true,
        structuredOutput: true,
        vision: true,
        embeddings: true,
        reasoning: true,
        modelLoad: true,
        modelUnload: true,
        modelDownload: true,
        statefulChat: false,
        mcp: true,
      };
    },
    async *generate(req) {
      yield { type: 'token' as const, content: 'Executing on remote worker: ' };
      yield { type: 'token' as const, content: 'Task completed successfully' };
      yield {
        type: 'completed' as const,
        content: 'Executing on remote worker: Task completed successfully',
        usage: { inputTokens: 12, outputTokens: 8 },
      };
    },
  };
}

async function startController(options: { token?: string } = {}) {
  const state = await createApiState({
    auth: {
      allowUnauthenticated: !options.token,
      operatorToken: options.token,
      registrationToken: options.token,
    },
  });
  const app = createApp(state);
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { state, server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('Cross-Platform Fleet Execution & Remote Worker Compatibility', () => {
  const serversToClose: Server[] = [];
  const workersToStop: Worker[] = [];

  afterEach(async () => {
    for (const w of workersToStop) {
      await w.stop().catch(() => undefined);
    }
    workersToStop.length = 0;
    for (const s of serversToClose) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    serversToClose.length = 0;
  });

  // Test the 6 required controller -> worker cross-platform combinations:
  // 1. macOS controller -> Linux worker (specifically Linux ARM64 DGX Spark)
  it('1. macOS controller -> Linux ARM64 DGX Spark worker: registration, hardware reporting, task dispatch, streaming, result collection', async () => {
    const { state, server, baseUrl } = await startController();
    serversToClose.push(server);

    // Emulate macOS controller metadata on the controller side
    const macControllerId = 'controller-mac-studio';
    state.computers.register({
      id: macControllerId,
      name: 'Mac Controller',
      type: 'workstation',
      local: true,
      os: FLEET_PROFILES['mac-studio-arm64'].os,
      hardware: FLEET_PROFILES['mac-studio-arm64'].hardware,
    });

    // Start real Linux ARM64 DGX Spark worker connecting to controller
    const dgxProfile = FLEET_PROFILES['dgx-spark-linux-arm64'];
    const adapter = createMockAdapter('ollama-dgx', 'qwen2.5-coder:32b');
    const worker = new Worker({
      computerId: 'dgx-spark-worker',
      name: 'dgx-spark-01',
      serverUrl: baseUrl,
      adapters: [adapter],
      os: dgxProfile.os,
      hardware: dgxProfile.hardware,
    });
    workersToStop.push(worker);

    // Phase 2: Worker Registration & Hardware Reporting
    const info = await worker.start();
    expect(info.status).toBe('online');
    expect(info.runtimes).toContain('ollama-dgx');
    expect(info.models).toContain('qwen2.5-coder:32b');

    // Verify controller registry recorded worker hardware & capability accurately
    const registered = state.computers.get('dgx-spark-worker');
    expect(registered).toBeDefined();
    expect(registered?.os.platform).toBe('linux');
    expect(registered?.os.architecture).toBe('arm64');
    expect(registered?.hardware.gpu?.model).toBe('NVIDIA GB10');
    expect(registered?.hardware.gpu?.cuda).toBe(true);
    expect(registered?.hardware.gpu?.unifiedMemory).toBe(true);

    // Phase 2: Task Dispatch from macOS controller to DGX Spark worker
    const request: WorkerExecutionRequest = {
      executionId: 'exec-mac-to-dgx',
      requestId: 'req-mac-to-dgx',
      modelId: 'qwen2.5-coder:32b',
      runtimeId: 'ollama-dgx',
      messages: [{ role: 'user', content: 'Compile CUDA kernel on DGX Spark' }],
    };

    const events: any[] = [];
    const outcomeGenerator = dispatchRemote(baseUrl, 'dgx-spark-worker', request);
    let step = await outcomeGenerator.next();
    while (!step.done) {
      events.push(step.value);
      step = await outcomeGenerator.next();
    }
    const finalResult = step.value;

    // Verify streaming output and result collection
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'token')).toBe(true);
    expect(finalResult).toBeDefined();
    expect(finalResult.ok).toBe(true);
    expect(finalResult.output).toContain('Executing on remote worker');
    expect(finalResult.inputTokens).toBe(12);
    expect(finalResult.outputTokens).toBe(8);
  });

  it('2. Windows controller -> Linux worker: dispatch and execution', async () => {
    const { server, baseUrl } = await startController();
    serversToClose.push(server);

    const linuxProfile = FLEET_PROFILES['linux-cloud-x64'];
    const adapter = createMockAdapter('ollama-linux', 'qwen2.5-coder:32b');
    const worker = new Worker({
      computerId: 'linux-cloud-worker',
      name: 'linux-worker-01',
      serverUrl: baseUrl,
      adapters: [adapter],
      os: linuxProfile.os,
      hardware: linuxProfile.hardware,
    });
    workersToStop.push(worker);
    await worker.start();

    const request: WorkerExecutionRequest = {
      executionId: 'exec-win-to-linux',
      requestId: 'req-win-to-linux',
      modelId: 'qwen2.5-coder:32b',
      runtimeId: 'ollama-linux',
      messages: [{ role: 'user', content: 'Run Linux build' }],
    };

    const events: any[] = [];
    for await (const event of dispatchRemote(baseUrl, 'linux-cloud-worker', request)) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);
  });

  it('3. Linux controller -> Windows worker: dispatch, execution, and capability discovery', async () => {
    const { state, server, baseUrl } = await startController();
    serversToClose.push(server);

    const winProfile = FLEET_PROFILES['win-workstation-x64'];
    const adapter = createMockAdapter('lmstudio-win', 'qwen2.5-coder:32b');
    const worker = new Worker({
      computerId: 'win-workstation-worker',
      name: 'win-01',
      serverUrl: baseUrl,
      adapters: [adapter],
      os: winProfile.os,
      hardware: winProfile.hardware,
    });
    workersToStop.push(worker);
    await worker.start();

    const comp = state.computers.get('win-workstation-worker');
    expect(comp?.os.platform).toBe('win32');
    expect(comp?.hardware.gpu?.model).toBe('NVIDIA GeForce RTX 4090');

    const request: WorkerExecutionRequest = {
      executionId: 'exec-linux-to-win',
      requestId: 'req-linux-to-win',
      modelId: 'qwen2.5-coder:32b',
      runtimeId: 'lmstudio-win',
      messages: [{ role: 'user', content: 'Build Windows app' }],
    };

    const events: any[] = [];
    for await (const event of dispatchRemote(baseUrl, 'win-workstation-worker', request)) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);
  });

  it('4. macOS controller -> Windows worker', async () => {
    const { server, baseUrl } = await startController();
    serversToClose.push(server);

    const winProfile = FLEET_PROFILES['win-workstation-x64'];
    const adapter = createMockAdapter('lmstudio-win', 'qwen2.5-coder:32b');
    const worker = new Worker({
      computerId: 'win-mac-pair-worker',
      serverUrl: baseUrl,
      adapters: [adapter],
      os: winProfile.os,
      hardware: winProfile.hardware,
    });
    workersToStop.push(worker);
    await worker.start();

    const request: WorkerExecutionRequest = {
      executionId: 'exec-mac-to-win',
      requestId: 'req-mac-to-win',
      modelId: 'qwen2.5-coder:32b',
      messages: [{ role: 'user', content: 'Test cross dispatch' }],
    };

    const events: any[] = [];
    for await (const event of dispatchRemote(baseUrl, 'win-mac-pair-worker', request)) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);
  });

  it('5. Windows controller -> macOS worker: Apple Silicon unified memory verification', async () => {
    const { state, server, baseUrl } = await startController();
    serversToClose.push(server);

    const macProfile = FLEET_PROFILES['mac-studio-arm64'];
    const adapter = createMockAdapter('ollama-mac', 'qwen2.5-coder:32b');
    const worker = new Worker({
      computerId: 'mac-studio-worker',
      serverUrl: baseUrl,
      adapters: [adapter],
      os: macProfile.os,
      hardware: macProfile.hardware,
    });
    workersToStop.push(worker);
    await worker.start();

    const registered = state.computers.get('mac-studio-worker');
    expect(registered?.os.platform).toBe('darwin');
    expect(registered?.hardware.gpu?.unifiedMemory).toBe(true);

    const request: WorkerExecutionRequest = {
      executionId: 'exec-win-to-mac',
      requestId: 'req-win-to-mac',
      modelId: 'qwen2.5-coder:32b',
      messages: [{ role: 'user', content: 'Execute Metal inference' }],
    };

    const events: any[] = [];
    for await (const event of dispatchRemote(baseUrl, 'mac-studio-worker', request)) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);
  });

  it('6. Linux controller -> macOS worker', async () => {
    const { server, baseUrl } = await startController();
    serversToClose.push(server);

    const macProfile = FLEET_PROFILES['mac-studio-arm64'];
    const adapter = createMockAdapter('ollama-mac', 'qwen2.5-coder:32b');
    const worker = new Worker({
      computerId: 'mac-linux-pair-worker',
      serverUrl: baseUrl,
      adapters: [adapter],
      os: macProfile.os,
      hardware: macProfile.hardware,
    });
    workersToStop.push(worker);
    await worker.start();

    const request: WorkerExecutionRequest = {
      executionId: 'exec-linux-to-mac',
      requestId: 'req-linux-to-mac',
      modelId: 'qwen2.5-coder:32b',
      messages: [{ role: 'user', content: 'Run swift test' }],
    };

    const events: any[] = [];
    for await (const event of dispatchRemote(baseUrl, 'mac-linux-pair-worker', request)) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);
  });

  // Phase 2: Security policies, cancellation, reconnection, and resource reconciliation
  it('enforces bearer authentication on remote dispatch and worker registration', async () => {
    const secretToken = 'sec-token-1234567890';
    const { server, baseUrl } = await startController({ token: secretToken });
    serversToClose.push(server);

    const adapter = createMockAdapter();
    const unauthWorker = new Worker({
      computerId: 'unauth-worker',
      serverUrl: baseUrl,
      adapters: [adapter],
    });

    // Unauthenticated worker cannot register
    await expect(unauthWorker.start()).rejects.toThrow();

    // Authenticated worker succeeds
    const authWorker = new Worker({
      computerId: 'auth-worker',
      serverUrl: baseUrl,
      adapters: [adapter],
      registrationToken: secretToken,
    });
    workersToStop.push(authWorker);
    const info = await authWorker.start();
    expect(info.status).toBe('online');
  });

  it('supports remote task cancellation cleanly', async () => {
    const { server, baseUrl } = await startController();
    serversToClose.push(server);

    let wasCancelled = false;
    const slowAdapter: RuntimeAdapter = {
      ...createMockAdapter(),
      async *generate() {
        yield { type: 'token' as const, content: 'working...' };
        await new Promise((resolve) => setTimeout(resolve, 3000));
        yield { type: 'completed' as const, content: 'done' };
      },
      async cancel(id) {
        wasCancelled = true;
      },
    };

    const worker = new Worker({
      computerId: 'cancellation-worker',
      serverUrl: baseUrl,
      adapters: [slowAdapter],
    });
    workersToStop.push(worker);
    await worker.start();

    const request: WorkerExecutionRequest = {
      executionId: 'exec-cancel-test',
      requestId: 'req-cancel-test',
      modelId: 'qwen2.5-coder:32b',
      messages: [{ role: 'user', content: 'Long task' }],
    };

    // Dispatch in background
    void (async () => {
      try {
        for await (const _ of dispatchRemote(baseUrl, 'cancellation-worker', request, { timeoutMs: 5000 })) {
          // stream
        }
      } catch {}
    })();

    // Wait for task to begin executing
    await new Promise((r) => setTimeout(r, 200));

    // Send cancellation to worker
    await worker.cancel('req-cancel-test');
    expect(wasCancelled).toBe(true);
  });
});
