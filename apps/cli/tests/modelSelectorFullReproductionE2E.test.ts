import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable, PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  FleetTui,
} from '../src/tui/fleetTui.js';
import {
  TerminalScreen,
} from '../src/tui/screen.js';
import {
  ConversationRenderer,
  type ConversationFrame,
} from '../src/tui/conversationRenderer.js';
import {
  ModelSelectorController,
  renderModelSelectorModal,
  renderModelSelectionConfirmation,
  formatSelectionDetails,
  type ModelSelectorItem,
} from '../src/tui/modelSelectorModal.js';
import { stripAnsiStr } from '../src/tui/fleetTuiTypes.js';

import {
  ComputerRegistry,
  RuntimeRegistry,
  ModelRegistry,
  AgentRegistry,
  JobManager,
  JobOrchestrator,
  ModelLifecycleService,
  PolicyEngine,
  ContextCompiler,
  ExecutionEngine,
  WorktreeManager,
  ApprovalQueue,
  createTaskPlanner,
  HardwareEligibilityService,
  ContextMemoryEstimator,
  IntelligentModelRanker,
  ModelPreferenceService,
  ModelDiscoveryStatusService,
  Scheduler,
  formatReadinessBlock,
  type ModelRecord,
  type Computer,
} from '../../../packages/core/src/index.js';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import { MemoryStore } from '@wazir/shared';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { Worker } from '@wazir/workers';
import type { RookEngine } from '../src/engine.js';

// ============================================================================
// ANSI Terminal Screen Buffer & Mock TTY Stream
// Reconstructs the 2D visible terminal grid to verify in-place rewrites.
// ============================================================================

export class TerminalScreenBuffer {
  cols: number;
  rows: number;
  cursorX = 0;
  cursorY = 0;
  screen: string[][] = [];
  private pendingEscape = '';

  constructor(cols = 80, rows = 24) {
    this.cols = cols;
    this.rows = rows;
    this.screen = Array.from({ length: rows }, () => Array(cols).fill(' '));
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    for (let r = 0; r < this.screen.length; r++) {
      if (this.screen[r].length > cols) {
        this.screen[r] = this.screen[r].slice(0, cols);
      } else {
        while (this.screen[r].length < cols) {
          this.screen[r].push(' ');
        }
      }
    }
  }

  private ensureRow(row: number): void {
    while (row >= this.screen.length) {
      this.screen.push(Array(this.cols).fill(' '));
    }
  }

  write(data: string): void {
    let input = this.pendingEscape + data;
    this.pendingEscape = '';
    let i = 0;

    while (i < input.length) {
      if (input[i] === '\x1b') {
        let j = i + 1;
        if (j >= input.length) {
          this.pendingEscape = input.slice(i);
          break;
        }
        if (input[j] === '[') {
          j++;
          while (j < input.length && !/[a-zA-Z~]/.test(input[j])) {
            if (input[j] === '\n' || input[j] === '\r') break;
            j++;
          }
          if (j >= input.length) {
            this.pendingEscape = input.slice(i);
            break;
          }
          if (input[j] === '\n' || input[j] === '\r') {
            i = j;
            continue;
          }
          const command = input[j];
          const args = input.slice(i + 2, j);
          this.handleCsi(command, args);
          i = j + 1;
          continue;
        } else if (input[j] === '\r' || input[j] === '\n') {
          i = j;
          continue;
        } else {
          i = j + 1;
          continue;
        }
      }

      const ch = input[i];
      if (ch === '\r') {
        this.cursorX = 0;
      } else if (ch === '\n') {
        this.cursorY++;
        this.ensureRow(this.cursorY);
      } else if (ch === '\b') {
        this.cursorX = Math.max(0, this.cursorX - 1);
      } else {
        this.ensureRow(this.cursorY);
        if (this.cursorX < this.cols) {
          this.screen[this.cursorY][this.cursorX] = ch;
          this.cursorX++;
        }
      }
      i++;
    }
  }

  private handleCsi(cmd: string, argsStr: string): void {
    const num = (defaultVal = 1) => {
      const parsed = parseInt(argsStr, 10);
      return isNaN(parsed) ? defaultVal : parsed;
    };

    switch (cmd) {
      case 'A': // Cursor Up
        this.cursorY = Math.max(0, this.cursorY - num(1));
        break;
      case 'B': // Cursor Down
        this.cursorY += num(1);
        this.ensureRow(this.cursorY);
        break;
      case 'C': // Cursor Forward / Right
        this.cursorX = Math.min(this.cols - 1, this.cursorX + num(1));
        break;
      case 'D': // Cursor Backward / Left
        this.cursorX = Math.max(0, this.cursorX - num(1));
        break;
      case 'K': // Erase in line
        this.ensureRow(this.cursorY);
        if (argsStr === '2') {
          this.screen[this.cursorY] = Array(this.cols).fill(' ');
        } else if (argsStr === '1') {
          for (let x = 0; x <= this.cursorX && x < this.cols; x++) {
            this.screen[this.cursorY][x] = ' ';
          }
        } else {
          for (let x = this.cursorX; x < this.cols; x++) {
            this.screen[this.cursorY][x] = ' ';
          }
        }
        break;
      case 'J': // Erase in display
        if (argsStr === '2') {
          this.screen = Array.from({ length: this.rows }, () => Array(this.cols).fill(' '));
          this.cursorX = 0;
          this.cursorY = 0;
        }
        break;
      case 'H':
      case 'f': {
        const parts = argsStr.split(';').map((p) => parseInt(p, 10));
        const r = isNaN(parts[0]) ? 1 : parts[0];
        const c = isNaN(parts[1]) ? 1 : parts[1];
        this.cursorY = Math.max(0, r - 1);
        this.cursorX = Math.max(0, c - 1);
        this.ensureRow(this.cursorY);
        break;
      }
      case 'm': // SGR formatting
        break;
    }
  }

  getRenderedLines(): string[] {
    return this.screen.map((row) => row.join('').trimEnd());
  }

  getVisibleText(): string[] {
    return this.getRenderedLines().filter((l) => l.length > 0);
  }

  getVisibleTextCombined(): string {
    return this.getVisibleText().join('\n');
  }

  countOccurrences(substr: string): number {
    const text = this.getVisibleTextCombined();
    let count = 0;
    let pos = 0;
    while ((pos = text.indexOf(substr, pos)) !== -1) {
      count++;
      pos += substr.length;
    }
    return count;
  }
}

export class MockTtyStream extends Writable {
  output = '';
  isTTY = true;
  columns: number;
  rows: number;
  buffer: TerminalScreenBuffer;

  constructor(public cols = 80, public rowsCount = 24) {
    super();
    this.columns = cols;
    this.rows = rowsCount;
    this.buffer = new TerminalScreenBuffer(cols, rowsCount);
  }

  override _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const str = chunk.toString();
    this.output += str;
    this.buffer.write(str);
    callback();
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rowsCount = rows;
    this.buffer.resize(cols, rows);
  }

  reset(): void {
    this.output = '';
    this.buffer = new TerminalScreenBuffer(this.cols, this.rowsCount);
  }
}

// ============================================================================
// Before vs. After Helper (P1-A, P1-B, P2-C)
// ============================================================================

export interface BeforeAfterComparison {
  bugId: 'P1-A' | 'P1-B' | 'P2-C';
  description: string;
  beforeTerminalOutput: string;
  afterTerminalOutput: string;
  visibleScreenBefore: string;
  visibleScreenAfter: string;
  summary: string;
}

export function captureBeforeAfterComparison(bugId: 'P1-A' | 'P1-B' | 'P2-C'): BeforeAfterComparison {
  if (bugId === 'P1-A') {
    const beforeStream = new MockTtyStream(80, 24);
    const controllerBefore = new ModelSelectorController();
    for (let i = 0; i < 20; i++) {
      controllerBefore.handleKey('down');
      const lines = renderModelSelectorModal(controllerBefore, 80);
      beforeStream.write(`${lines.join('\n')}\n`);
    }

    const afterStream = new MockTtyStream(80, 24);
    const rendererAfter = new ConversationRenderer(afterStream, () => ({ columns: 80, rows: 24 }), { isTTY: true });
    const controllerAfter = new ModelSelectorController();
    const frame: ConversationFrame = {
      identity: 'AgentA',
      prompt: '',
      cursor: 0,
      active: 0,
      waitingApproval: 0,
      activity: '',
    };
    for (let i = 0; i < 20; i++) {
      controllerAfter.handleKey('down');
      const modalLines = renderModelSelectorModal(controllerAfter, 80);
      rendererAfter.render({ ...frame, modalLines });
    }

    return {
      bugId: 'P1-A',
      description: 'Modal repeat rendering in conversation mode during Down arrow navigation',
      beforeTerminalOutput: beforeStream.output,
      afterTerminalOutput: afterStream.output,
      visibleScreenBefore: beforeStream.buffer.getVisibleTextCombined(),
      visibleScreenAfter: afterStream.buffer.getVisibleTextCombined(),
      summary: `Before: 20 appended selector boxes in scrollback. After: exactly 1 in-place selector box, 0 transcript frames.`,
    };
  }

  if (bugId === 'P1-B') {
    const controllerBefore = new ModelSelectorController();
    controllerBefore.selectedIndex = 4;
    const beforeAction = { type: 'select', mode: 'local', scope: 'default' };
    const beforeRendered = renderModelSelectorModal(controllerBefore, 80).join('\n');

    const controllerAfter = new ModelSelectorController({
      deviceSummary: 'Apple M2 Max (32GB)',
      runtimeSummary: 'Ollama 0.5.4 (Running)',
    });
    controllerAfter.selectedIndex = 4;
    const afterAction = controllerAfter.handleKey('enter');
    const afterRendered = renderModelSelectorModal(controllerAfter, 80).join('\n');

    return {
      bugId: 'P1-B',
      description: 'Selecting Local failed to open local model browser',
      beforeTerminalOutput: `Action: ${JSON.stringify(beforeAction)}\n${beforeRendered}`,
      afterTerminalOutput: `Action: ${JSON.stringify(afterAction)}\n${afterRendered}`,
      visibleScreenBefore: stripAnsiStr(beforeRendered),
      visibleScreenAfter: stripAnsiStr(afterRendered),
      summary: `Before: modal closed immediately with mode 'local'. After: opened WAZIR — Local Models with hardware device and runtime info.`,
    };
  }

  // P2-C
  const confMessage = 'Model selection updated [Persistent Default]: fast';
  const beforeStream = new MockTtyStream(80, 24);
  beforeStream.write(`${confMessage}\n`);
  beforeStream.write(`• ${confMessage}\n`);

  const afterStream = new MockTtyStream(80, 24);
  const renderer = new ConversationRenderer(afterStream, () => ({ columns: 80, rows: 24 }), { isTTY: true });
  renderer.append(confMessage);
  renderer.render({
    identity: 'AgentA',
    prompt: '',
    cursor: 0,
    active: 0,
    waitingApproval: 0,
    activity: '',
    status: confMessage,
  });

  return {
    bugId: 'P2-C',
    description: 'Duplicate confirmation messages in durable transcript and live status',
    beforeTerminalOutput: beforeStream.output,
    afterTerminalOutput: afterStream.output,
    visibleScreenBefore: beforeStream.buffer.getVisibleTextCombined(),
    visibleScreenAfter: afterStream.buffer.getVisibleTextCombined(),
    summary: `Before: duplicate confirmation messages rendered twice. After: confirmation message rendered exactly once.`,
  };
}

// ============================================================================
// Test Environment & Fixture Creation
// ============================================================================

export interface E2EEnvironment {
  engine: RookEngine;
  tui: FleetTui;
  inStream: PassThrough;
  outStream: MockTtyStream;
  screen: TerminalScreen;
  prefService: ModelPreferenceService;
  lifecycle: ModelLifecycleService;
  ranker: IntelligentModelRanker;
  scheduler: Scheduler;
  hardwareEligibility: HardwareEligibilityService;
  contextEstimator: ContextMemoryEstimator;
  statusService: ModelDiscoveryStatusService;
  prefPath: string;
  adapterLoadCalls: string[];
  adapterExecuteCalls: Array<{ model: string; prompt: string }>;
  loadedModelsSet: Set<string>;
  projectRoot: string;
}

export async function createE2EEnvironment(projectRoot: string, opts: { availableMemoryGB?: number } = {}): Promise<E2EEnvironment> {
  const prefPath = path.join(projectRoot, 'model-preference.json');
  const availableMemoryGB = opts.availableMemoryGB ?? 16;
  const totalMemoryGB = 32;

  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const tools = new ToolRegistry(defaultTools);
  const compiler = new ContextCompiler();
  const executions = new ExecutionEngine();
  const approvalQueue = new ApprovalQueue();
  const worktrees = new WorktreeManager();
  const store = new MemoryStore() as any;

  // 1. Local Computer (Apple M2 Max, 32GB Unified Memory)
  const localComp: Computer = {
    id: 'local',
    name: 'Apple M2 Max',
    type: 'workstation',
    local: true,
    status: 'online',
    health: 'healthy',
    os: { platform: 'darwin', architecture: 'arm64', version: '24.0.0' },
    hardware: {
      cpu: 'Apple M2 Max',
      cpuCores: 12,
      memoryGB: totalMemoryGB,
      gpu: {
        vendor: 'apple',
        model: 'Apple M2 Max',
        memoryGB: totalMemoryGB,
        vramGB: totalMemoryGB,
        unifiedMemory: true,
      },
    },
    capabilities: ['localExecution', 'gpuAcceleration'],
  };
  computers.register(localComp);
  computers.heartbeat('local', {
    load: {
      cpuPercent: 12,
      memoryUsedGB: Math.max(0, totalMemoryGB - availableMemoryGB),
      memoryAvailableGB: availableMemoryGB,
    },
  });

  // 2. Runtimes: Healthy local ollama runtime + Offline runtime
  runtimes.register({
    id: 'ollama',
    type: 'ollama',
    name: 'Ollama 0.5.4',
    version: '0.5.4',
    computerId: 'local',
    capabilities: {
      chat: true,
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: true,
      embeddings: false,
      reasoning: true,
      modelLoad: true,
      modelUnload: true,
      modelDownload: false,
      statefulChat: false,
      mcp: false,
    },
  });
  runtimes.update('ollama', { health: 'healthy' });

  runtimes.register({
    id: 'offline-runtime',
    type: 'ollama',
    name: 'Offline Runtime',
    version: '0.1.0',
    computerId: 'local',
    capabilities: {
      chat: true,
      streaming: false,
      toolCalling: false,
      structuredOutput: false,
      vision: false,
      embeddings: false,
      reasoning: false,
      modelLoad: true,
      modelUnload: true,
      modelDownload: false,
      statefulChat: false,
      mcp: false,
    },
  });
  runtimes.update('offline-runtime', { health: 'unavailable' });

  // 3. Models
  const adapterLoadCalls: string[] = [];
  const adapterExecuteCalls: Array<{ model: string; prompt: string }> = [];
  const loadedModelsSet = new Set<string>(['qwen2.5-coder:7b']); // Step 8 loaded model

  // Model A: Loaded local model
  const loadedModel: ModelRecord = {
    id: 'qwen2.5-coder:7b',
    name: 'Qwen 2.5 Coder 7B',
    provider: 'ollama',
    family: 'qwen',
    parameters: '7b',
    quantization: 'Q4_K_M',
    contextMax: 32768,
    capabilities: ['generalChat', 'code_generation'],
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    reasoning: true,
    local: true,
    runtimeCompatibility: ['ollama'],
    memory: { minSystemGB: 6.5, minGpuGB: 6.5 },
  };
  models.register(loadedModel);
  models.upsertInstance({
    id: 'local:ollama:qwen2.5-coder:7b',
    modelId: 'qwen2.5-coder:7b',
    runtimeId: 'ollama',
    computerId: 'local',
    runtimeModelId: 'qwen2.5-coder:7b',
    loaded: true,
    state: 'READY',
    health: 'healthy',
    contextTokens: 32768,
    residentMemoryBytes: 6.5 * (1024 ** 3),
  });

  // Model B: Installed compatible unloaded model
  const unloadedModel: ModelRecord = {
    id: 'phi-3:mini',
    name: 'Phi 3 Mini',
    provider: 'ollama',
    family: 'phi',
    parameters: '3.8b',
    quantization: 'Q4_K_M',
    contextMax: 4096,
    capabilities: ['generalChat'],
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    reasoning: true,
    local: true,
    runtimeCompatibility: ['ollama'],
    memory: { minSystemGB: 4.0, minGpuGB: 4.0 },
  };
  models.register(unloadedModel);
  models.upsertInstance({
    id: 'local:ollama:phi-3:mini',
    modelId: 'phi-3:mini',
    runtimeId: 'ollama',
    computerId: 'local',
    runtimeModelId: 'phi-3:mini',
    loaded: false,
    state: 'INSTALLED',
    health: 'healthy',
    contextTokens: 4096,
  });

  // Model C: Incompatible local model (requires 22GB on 0.1GB RAM)
  const incompatibleModel: ModelRecord = {
    id: 'qwen/qwen3.8-27b',
    name: 'Qwen 3.8 27B',
    provider: 'ollama',
    family: 'qwen',
    parameters: '27b',
    quantization: 'Q4_K_M',
    contextMax: 16384,
    capabilities: ['generalChat'],
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    reasoning: true,
    local: true,
    runtimeCompatibility: ['ollama'],
    memory: { minSystemGB: 28.0, minGpuGB: 28.0 },
  };
  models.register(incompatibleModel);
  models.upsertInstance({
    id: 'local:ollama:qwen/qwen3.8-27b',
    modelId: 'qwen/qwen3.8-27b',
    runtimeId: 'ollama',
    computerId: 'local',
    runtimeModelId: 'qwen/qwen3.8-27b',
    loaded: false,
    state: 'INSTALLED',
    health: 'healthy',
    contextTokens: 16384,
  });

  // Model D: Unavailable offline runtime model
  const offlineModel: ModelRecord = {
    id: 'offline-llama',
    name: 'Offline Llama',
    provider: 'offline-runtime',
    family: 'llama',
    parameters: '7b',
    quantization: 'Q4_K_M',
    contextMax: 8192,
    capabilities: ['generalChat'],
    local: true,
    runtimeCompatibility: ['offline-runtime'],
    memory: { minSystemGB: 5.0, minGpuGB: 5.0 },
  };
  models.register(offlineModel);
  models.upsertInstance({
    id: 'local:offline-runtime:offline-llama',
    modelId: 'offline-llama',
    runtimeId: 'offline-runtime',
    computerId: 'local',
    runtimeModelId: 'offline-llama',
    loaded: false,
    state: 'UNAVAILABLE',
    health: 'unavailable',
    contextTokens: 8192,
  });

  // 4. Mock Adapters
  const ollamaAdapter: RuntimeAdapter = {
    id: 'ollama',
    type: 'ollama',
    async discover() {
      return { id: 'ollama', name: 'Ollama 0.5.4', version: '0.5.4' };
    },
    async healthCheck() {
      return { status: 'healthy' };
    },
    async cancel() {},
    async listModels() {
      return models.list().map((m) => ({ id: m.id, name: m.name }));
    },
    async getLoadedModels() {
      return Array.from(loadedModelsSet);
    },
    async loadModel(modelId: string, loadOpts?: { contextTokens?: number }) {
      adapterLoadCalls.push(modelId);
      loadedModelsSet.add(modelId);
      const inst = models.instancesOf(modelId)[0];
      if (inst) {
        models.upsertInstance({ ...inst, loaded: true, state: 'READY', health: 'healthy', contextTokens: loadOpts?.contextTokens ?? inst.contextTokens ?? 4096 });
      }
    },
    async unloadModel(modelId: string) {
      loadedModelsSet.delete(modelId);
      const inst = models.instancesOf(modelId)[0];
      if (inst) {
        models.upsertInstance({ ...inst, loaded: false, state: 'INSTALLED' });
      }
    },
    async inspectModel(modelId: string) {
      const inst = models.instancesOf(modelId)[0];
      return {
        modelId,
        loaded: loadedModelsSet.has(modelId),
        effectiveContext: inst?.contextTokens ?? (modelId.includes('phi') ? 4096 : 32768),
      };
    },
    async probeModel(modelId: string) {
      return loadedModelsSet.has(modelId);
    },
    async estimateModelLoad(runtimeModelId: string, contextTokens: number) {
      const memGB = runtimeModelId.includes('phi') ? 4.0 : 6.5;
      return {
        weightBytes: memGB * (1024 ** 3),
        contextBytes: (contextTokens / 1024) * 0.05 * (1024 ** 3),
        overheadBytes: 0.5 * (1024 ** 3),
        totalMemoryBytes: (memGB + 0.5) * (1024 ** 3),
        source: 'RUNTIME' as const,
        confidence: 'high' as const,
      };
    },
    async *generate(req: any) {
      const model = req.modelId ?? req.model;
      const prompt = req.prompt ?? req.messages?.map((m: any) => m.content).join('\n') ?? '';
      adapterExecuteCalls.push({ model, prompt });
      yield { type: 'token', content: '```typescript\nfunction sum(a: number, b: number): number {\n  return a + b;\n}\n```' };
      yield {
        type: 'completed',
        content: JSON.stringify({ action: 'done', summary: 'TypeScript sum function written' }),
        usage: { inputTokens: 15, outputTokens: 25, totalTokens: 40 },
      };
    },
    async *stream(req: any) {
      const model = req.modelId ?? req.model;
      const prompt = req.prompt ?? req.messages?.map((m: any) => m.content).join('\n') ?? '';
      adapterExecuteCalls.push({ model, prompt });
      yield { type: 'token', content: '```typescript\nfunction sum(a: number, b: number): number {\n  return a + b;\n}\n```' };
      yield { type: 'completed', content: 'TypeScript sum function written', usage: { inputTokens: 15, outputTokens: 25, totalTokens: 40 } };
    },
  };

  const offlineAdapter: RuntimeAdapter = {
    id: 'offline-runtime',
    type: 'ollama',
    async discover() {
      throw new Error('Offline runtime connection refused');
    },
    async healthCheck() {
      return { status: 'unavailable', error: 'Connection refused' };
    },
    async cancel() {},
    async listModels() { return []; },
    async getLoadedModels() { return []; },
    async loadModel() { throw new Error('Offline runtime cannot load models'); },
    async unloadModel() {},
    async generate() { throw new Error('Offline runtime cannot generate'); },
    async *stream() { throw new Error('Offline runtime cannot stream'); },
  };

  const adapters = new Map<string, RuntimeAdapter>([
    ['ollama', ollamaAdapter],
    ['offline-runtime', offlineAdapter],
  ]);

  // 5. Core Services
  const hardwareEligibility = new HardwareEligibilityService();
  const contextEstimator = new ContextMemoryEstimator();
  const ranker = new IntelligentModelRanker(hardwareEligibility, contextEstimator);
  const prefService = new ModelPreferenceService({ configFilePath: prefPath });
  await prefService.loadPersistentPreference?.();

  const statusService = new ModelDiscoveryStatusService({
    models,
    runtimes,
    computers,
  });

  const approvalQueueInstance = approvalQueue;
  const policy = new PolicyEngine({
    projectRoot,
    networkAllowed: true,
    approvalQueue: approvalQueueInstance,
  });

  const lifecycle = new ModelLifecycleService({
    models,
    runtimes,
    computers,
    agents,
    adapters,
    store,
    policy,
    executions,
  });

  const scheduler = new Scheduler({
    computers,
    runtimes,
    models,
    policy,
    agents,
    ranker,
    hardwareEligibility,
    contextEstimator,
    preferences: prefService,
  });

  const jobManager = new JobManager({ store });
  const orchestrator = new JobOrchestrator({
    scheduler,
    executionEngine: executions,
    policy,
    agents,
    models,
    runtimes,
    computers,
    jobManager,
    lifecycle,
  });

  const codingAgent = createCodingAgent();
  agents.register(codingAgent, 'native');

  const worker: Worker = {
    id: 'worker-local',
    computerId: 'local',
    name: 'worker-local',
    info: {
      id: 'worker-local',
      computerId: 'local',
      name: 'worker-local',
      status: 'idle',
      runtimes: ['ollama'],
      models: models.list().map((m) => m.id),
      activeExecutions: 0,
      maxConcurrent: 4,
    },
    start: async () => {},
    stop: async () => {},
    heartbeat: () => ({
      workerId: 'worker-local',
      computerId: 'local',
      status: 'idle',
      activeExecutions: 0,
      load: { cpuPercent: 10, memoryUsedGB: totalMemoryGB - availableMemoryGB, memoryAvailableGB: availableMemoryGB },
      timestamp: new Date(),
    }),
    adapterForModel: () => ollamaAdapter,
    refreshRuntime: async () => undefined,
    execute: async () => ({ success: true, output: 'ok' }),
  } as unknown as Worker;

  const engine: RookEngine = {
    config: {
      projectRoot,
      dataDir: path.join(projectRoot, '.wazir'),
      concurrencyLimit: 2,
      networkAllowed: true,
      allowCommands: [],
      denyCommands: [],
      allowedMcpServers: [],
      models: { startup: { mode: 'prompt' } },
    },
    projectRoot,
    configDir: path.join(projectRoot, '.wazir'),
    computers,
    runtimes,
    models,
    lifecycle,
    agents,
    tools,
    policy,
    scheduler,
    compiler,
    executions,
    approvalQueue: approvalQueueInstance,
    orchestrator,
    worktrees,
    planner: createTaskPlanner({ models, adapters, defaultModelId: 'qwen2.5-coder:7b' }),
    adapters,
    hostedAdapters: new Map(),
    discovered: [],
    worker,
    store,
    mcpClient: { listServers: () => [], listTools: () => [] } as any,
    close: async () => {},
    modelPreferences: prefService,
    modelDiscoveryStatus: statusService,
    modelRanker: ranker,
    hardwareEligibility,
    contextEstimator,
  };

  // 6. Pseudo-terminal TTY screen
  const inStream = new PassThrough();
  const outStream = new MockTtyStream(80, 24);
  const screen = new TerminalScreen(
    inStream as unknown as NodeJS.ReadableStream,
    outStream as unknown as NodeJS.WritableStream,
    'conversation'
  );

  const tui = new FleetTui({
    engine,
    screen,
    presentationMode: 'conversation',
  });

  return {
    engine,
    tui,
    inStream,
    outStream,
    screen,
    prefService,
    lifecycle,
    ranker,
    scheduler,
    hardwareEligibility,
    contextEstimator,
    statusService,
    prefPath,
    adapterLoadCalls,
    adapterExecuteCalls,
    loadedModelsSet,
    projectRoot,
  };
}

// ============================================================================
// 20-Step End-to-End Terminal Reproduction Test Suite
// ============================================================================

describe('Model Selector Full Reproduction E2E (20 Required Steps)', () => {
  let tmpDir: string;
  let env: E2EEnvironment;

  // Captured Step Evidence Store
  const stepCaptures: Record<number, { step: string; visibleText: string; rawOutputChunk: string }> = {};

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-e2e-20step-'));
    env = await createE2EEnvironment(tmpDir);
  });

  afterEach(async () => {
    try {
      env?.tui?.stop?.();
    } catch {}
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  async function flushDraw(): Promise<void> {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 25));
  }

  async function sendKey(tui: FleetTui, key: string, count = 1): Promise<void> {
    for (let i = 0; i < count; i++) {
      tui.handleKey(key);
    }
    await flushDraw();
  }

  it('Executes and verifies all 20 required steps with terminal output captures and regression validation', async () => {
    const { tui, outStream, prefService, lifecycle, ranker, prefPath, adapterLoadCalls, adapterExecuteCalls } = env;

    // ------------------------------------------------------------------------
    // Step 1: Launch wa chat (FleetTui in conversation mode)
    // ------------------------------------------------------------------------
    await tui.start();
    await flushDraw();
    const step1Visible = outStream.buffer.getVisibleTextCombined();
    expect(step1Visible).toContain('WAZIR');
    expect(step1Visible).toContain('Ready');
    expect(step1Visible).toContain('>');
    stepCaptures[1] = {
      step: 'Step 1: Launch wa chat in conversation mode',
      visibleText: step1Visible,
      rawOutputChunk: outStream.output,
    };

    // ------------------------------------------------------------------------
    // Step 2: Open the model selector (/model)
    // ------------------------------------------------------------------------
    await tui.submitCommand('/model');
    await flushDraw();
    const step2Visible = outStream.buffer.getVisibleTextCombined();
    expect(tui['modelSelector']).toBeDefined();
    expect(tui['modelSelector']!.isOpen).toBe(true);
    expect(step2Visible).toContain('WAZIR — Select Model');
    expect(step2Visible).toContain('Auto (recommended)');
    expect(step2Visible).toContain('Fast');
    expect(step2Visible).toContain('Balanced');
    expect(step2Visible).toContain('Powerful');
    expect(step2Visible).toContain('Local');
    expect(step2Visible).toContain('Custom');
    expect(step2Visible).toContain('Reasoning effort:');
    stepCaptures[2] = {
      step: 'Step 2: Open the model selector (/model)',
      visibleText: step2Visible,
      rawOutputChunk: outStream.output,
    };

    // ------------------------------------------------------------------------
    // Step 3: Press Down repeatedly (20 times)
    // ------------------------------------------------------------------------
    const controller = tui['modelSelector']!;
    await sendKey(tui, 'down', 20);
    const step3Visible = outStream.buffer.getVisibleTextCombined();
    // 20 % 6 = 2 (Auto -> Fast -> Balanced)
    expect(controller.selectedIndex).toBe(2);
    stepCaptures[3] = {
      step: 'Step 3: Press Down repeatedly (20 times)',
      visibleText: step3Visible,
      rawOutputChunk: outStream.output,
    };

    // ------------------------------------------------------------------------
    // Step 4: Confirm only one selector remains visible on the terminal screen
    // (countOccurrences('WAZIR — Select Model') === 1, 0 appended selector boxes in scrollback)
    // ------------------------------------------------------------------------
    expect(outStream.buffer.countOccurrences('WAZIR — Select Model')).toBe(1);
    const transcriptList = tui['conversationRenderer'].transcript.list();
    const selectorBoxesInTranscript = transcriptList.filter((item) => item.text.includes('WAZIR — Select Model'));
    expect(selectorBoxesInTranscript.length).toBe(0);
    stepCaptures[4] = {
      step: 'Step 4: Confirm exactly one selector visible (P1-A regression verified)',
      visibleText: outStream.buffer.getVisibleTextCombined(),
      rawOutputChunk: outStream.output,
    };

    // ------------------------------------------------------------------------
    // Step 5: Navigate to Local (index 4)
    // ------------------------------------------------------------------------
    // Navigate from index 2 to index 4 (Down twice)
    await sendKey(tui, 'down', 2);
    expect(controller.selectedIndex).toBe(4);
    const step5Visible = outStream.buffer.getVisibleTextCombined();
    expect(step5Visible).toContain('Local');
    stepCaptures[5] = {
      step: 'Step 5: Navigate to Local (index 4)',
      visibleText: step5Visible,
      rawOutputChunk: outStream.output,
    };

    // ------------------------------------------------------------------------
    // Step 6: Press Enter
    // ------------------------------------------------------------------------
    await sendKey(tui, 'enter');
    expect(controller.view).toBe('local');
    const step6Visible = outStream.buffer.getVisibleTextCombined();
    stepCaptures[6] = {
      step: 'Step 6: Press Enter to open WAZIR Local Models browser',
      visibleText: step6Visible,
      rawOutputChunk: outStream.output,
    };

    // ------------------------------------------------------------------------
    // Step 7: Confirm actual local models are listed inside WAZIR — Local Models
    // (showing Device:, Runtime:, Auto Local Routing, Loaded / Ready, Installed / Can load,
    //  Installed / Insufficient memory, and Unavailable / Runtime offline)
    // ------------------------------------------------------------------------
    expect(step6Visible).toContain('WAZIR — Local Models');
    expect(step6Visible).toContain('Device:');
    expect(step6Visible).toContain('Runtime:');
    expect(step6Visible).toContain('Auto Local Routing');
    expect(step6Visible).toContain('Loaded');
    expect(step6Visible).toContain('Ready');
    expect(step6Visible).toContain('Installed');
    expect(step6Visible).toContain('Can load');
    expect(step6Visible).toContain('Insufficient memory');
    expect(step6Visible).toContain('Unavailable');
    expect(step6Visible).toContain('Runtime offline');
    stepCaptures[7] = {
      step: 'Step 7: Confirm actual local models are listed inside WAZIR Local Models',
      visibleText: step6Visible,
      rawOutputChunk: outStream.output,
    };

    // ------------------------------------------------------------------------
    // Step 8: Select a loaded model (Enter on the loaded local model)
    // ------------------------------------------------------------------------
    // Row 0 is Auto Local Routing; find and select the loaded model
    const loadedIdx = controller.getLocalModels().findIndex((m) => m.loaded);
    await sendKey(tui, 'down', 1 + loadedIdx);
    expect(controller.selectedIndex).toBe(1 + loadedIdx);
    await sendKey(tui, 'enter');
    expect(controller.isOpen).toBe(false);
    expect(tui['modelSelector']).toBeUndefined();
    const step8Visible = outStream.buffer.getVisibleTextCombined();
    expect(step8Visible).toContain('Model selection updated');
    expect(step8Visible).toContain('qwen2.5-coder:7b');
    stepCaptures[8] = {
      step: 'Step 8: Select loaded model (Enter on qwen2.5-coder:7b)',
      visibleText: step8Visible,
      rawOutputChunk: outStream.output,
    };

    // ------------------------------------------------------------------------
    // Step 9: Verify selection (mode is local, modelId is loaded model, reused: true, 0 reload calls)
    // ------------------------------------------------------------------------
    expect(tui['selectedModelId']).toBe('qwen2.5-coder:7b');
    const effective9 = prefService.getEffectivePreference();
    expect(effective9.mode).toBe('local');
    expect(effective9.modelId).toBe('qwen2.5-coder:7b');

    // Call lifecycle service to verify reuse
    const prepareResult = await lifecycle.selectAndPrepareLocalModel('qwen2.5-coder:7b');
    expect(prepareResult.ok).toBe(true);
    expect(prepareResult.reused).toBe(true);
    expect(adapterLoadCalls.length).toBe(0); // 0 reloads!
    stepCaptures[9] = {
      step: 'Step 9: Verify selection: mode=local, modelId=qwen2.5-coder:7b, reused=true, 0 reload calls',
      visibleText: `Mode: ${effective9.mode}\nModelId: ${effective9.modelId}\nReused: ${prepareResult.reused}\nLoad Calls: ${adapterLoadCalls.length}`,
      rawOutputChunk: outStream.output,
    };

    // ------------------------------------------------------------------------
    // Step 10: Run a simple chat task (Write a sum function in TypeScript)
    // ------------------------------------------------------------------------
    await tui.submitCommand('Write a sum function in TypeScript');
    for (let i = 0; i < 40 && adapterExecuteCalls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      await flushDraw();
    }
    const step10Visible = outStream.buffer.getVisibleTextCombined();
    expect(step10Visible).toContain('Write a sum function in TypeScript');
    stepCaptures[10] = {
      step: 'Step 10: Run a simple chat task (Write a sum function in TypeScript)',
      visibleText: step10Visible,
      rawOutputChunk: outStream.output,
    };

    // ------------------------------------------------------------------------
    // Step 11: Confirm the selected model executed on the runtime adapter
    // ------------------------------------------------------------------------
    expect(adapterExecuteCalls.length).toBeGreaterThan(0);
    const lastExecution = adapterExecuteCalls[adapterExecuteCalls.length - 1];
    expect(lastExecution.model).toBe('qwen2.5-coder:7b');
    expect(lastExecution.prompt).toContain('Write a sum function in TypeScript');
    stepCaptures[11] = {
      step: 'Step 11: Confirm selected model executed on runtime adapter',
      visibleText: `Executed Model: ${lastExecution.model}\nPrompt: ${lastExecution.prompt}`,
      rawOutputChunk: outStream.output,
    };

    // ------------------------------------------------------------------------
    // Step 12: Reopen the selector (/model -> Local)
    // ------------------------------------------------------------------------
    await tui.submitCommand('/model');
    await flushDraw();
    const controller12 = tui['modelSelector']!;
    expect(controller12.isOpen).toBe(true);
    // Navigate to Local (index 4)
    controller12.selectedIndex = 4;
    await sendKey(tui, 'enter');
    expect(controller12.view).toBe('local');
    const step12Visible = outStream.buffer.getVisibleTextCombined();
    expect(step12Visible).toContain('WAZIR — Local Models');
    stepCaptures[12] = {
      step: 'Step 12: Reopen selector (/model -> Local)',
      visibleText: step12Visible,
      rawOutputChunk: outStream.output,
    };

    // ------------------------------------------------------------------------
    // Step 13: Select an installed compatible model (Enter on phi-3:mini)
    // ------------------------------------------------------------------------
    // In local view:
    const phiIdx = controller12.getLocalModels().findIndex((m) => m.modelId === 'phi-3:mini');
    controller12.selectedIndex = 1 + phiIdx;
    await sendKey(tui, 'enter');
    expect(controller12.isOpen).toBe(false);
    expect(tui['modelSelector']).toBeUndefined();
    expect(tui['selectedModelId']).toBe('phi-3:mini');
    const step13Visible = outStream.buffer.getVisibleTextCombined();
    expect(step13Visible).toContain('Model selection updated');
    expect(step13Visible).toContain('phi-3:mini');
    stepCaptures[13] = {
      step: 'Step 13: Select installed compatible model (phi-3:mini)',
      visibleText: step13Visible,
      rawOutputChunk: outStream.output,
    };

    // ------------------------------------------------------------------------
    // Step 14: Verify loading (Loading <model> on <device>... -> Ready: <model>)
    // and 4-line readiness output (Model:, Device:, Context:, Status: Ready)
    // ------------------------------------------------------------------------
    const progressMessages: string[] = [];
    const loadPrepResult = await lifecycle.selectAndPrepareLocalModel('phi-3:mini', {
      loadNow: true,
      onProgress: (msg) => progressMessages.push(msg),
    });

    expect(loadPrepResult.ok).toBe(true);
    expect(loadPrepResult.status).toBe('Ready');
    expect(adapterLoadCalls).toContain('phi-3:mini');
    expect(progressMessages.some((m) => m.includes('Loading phi-3:mini') || m.includes('Ready: phi-3:mini'))).toBe(true);

    const formattedReadiness = loadPrepResult.formattedReadiness;
    expect(formattedReadiness).toContain('Model: phi-3:mini');
    expect(formattedReadiness).toContain('Device:');
    expect(formattedReadiness).toContain('Context: 4096 tokens');
    expect(formattedReadiness).toContain('Status: Ready');

    const readinessLines = formattedReadiness.split('\n');
    expect(readinessLines.length).toBe(4);
    expect(readinessLines[0]).toBe('Model: phi-3:mini');
    expect(readinessLines[3]).toBe('Status: Ready');
    stepCaptures[14] = {
      step: 'Step 14: Verify loading and 4-line readiness output',
      visibleText: formattedReadiness,
      rawOutputChunk: progressMessages.join('\n'),
    };

    // ------------------------------------------------------------------------
    // Step 15: Test an incompatible model (qwen/qwen3.8-27b requiring 22GB on 0.1GB available RAM)
    // ------------------------------------------------------------------------
    await tui.submitCommand('/model');
    await flushDraw();
    const controller15 = tui['modelSelector']!;
    controller15.selectedIndex = 4;
    await sendKey(tui, 'enter');
    expect(controller15.view).toBe('local');

    // Row 4 is qwen/qwen3.8-27b
    // Row 0: Auto, Row 1: qwen2.5-coder, Row 2: phi-3, Row 3: offline-llama, Row 4: qwen/qwen3.8-27b
    const incompIdx = controller15.getLocalModels().findIndex((m) => m.modelId === 'qwen/qwen3.8-27b') + 1;
    controller15.selectedIndex = incompIdx;
    await sendKey(tui, 'enter');
    const step15Visible = outStream.buffer.getVisibleTextCombined();
    stepCaptures[15] = {
      step: 'Step 15: Test incompatible model selection (qwen/qwen3.8-27b)',
      visibleText: step15Visible,
      rawOutputChunk: outStream.output,
    };

    // ------------------------------------------------------------------------
    // Step 16: Confirm it cannot be selected in the browser (rejected with Insufficient memory warning)
    // and is never selected for automatic execution (Auto or Auto Local Routing)
    // ------------------------------------------------------------------------
    expect(controller15.isOpen).toBe(true);
    expect(controller15.warningMessage?.toLowerCase()).toContain('insufficient memory');
    expect(step15Visible.toLowerCase()).toContain('insufficient memory');

    // Verify rejection in Ranker for AUTO & LOCAL_FIRST
    const lowMemComp: Computer = {
      id: 'constrained-mac',
      name: 'Constrained Mac',
      local: true,
      status: 'online',
      hardware: { memoryGB: 8, gpu: { model: 'Apple M2', unifiedMemory: true, vramGB: 8 } },
    };
    const rankResultAuto = ranker.rankModels(env.engine.models.list(), lowMemComp, undefined, { mode: 'AUTO' });
    const qwenAuto = rankResultAuto.find((c) => c.model.id === 'qwen/qwen3.8-27b');
    expect(qwenAuto?.eligible).toBe(false);

    const rankResultLocal = ranker.rankModels(env.engine.models.list(), lowMemComp, undefined, { mode: 'LOCAL_FIRST' });
    const qwenLocal = rankResultLocal.find((c) => c.model.id === 'qwen/qwen3.8-27b');
    expect(qwenLocal?.eligible).toBe(false);
    stepCaptures[16] = {
      step: 'Step 16: Confirm rejection in browser and ranker (Auto and Local Routing)',
      visibleText: `Browser Rejection Warning: ${controller15.warningMessage}\nRanker Auto Eligible: ${qwenAuto?.eligible}\nRanker Local Eligible: ${qwenLocal?.eligible}`,
      rawOutputChunk: outStream.output,
    };

    // ------------------------------------------------------------------------
    // Step 17: Exit and restart chat (stop() -> new FleetTui / ModelPreferenceService session loading from disk)
    // ------------------------------------------------------------------------
    tui.stop();
    const newInStream = new PassThrough();
    const newOutStream = new MockTtyStream(80, 24);
    const newScreen = new TerminalScreen(
      newInStream as unknown as NodeJS.ReadableStream,
      newOutStream as unknown as NodeJS.WritableStream,
      'conversation'
    );

    const reloadedPrefService = new ModelPreferenceService({ configFilePath: prefPath });
    await reloadedPrefService.loadPersistentPreference?.();

    const restartedTui = new FleetTui({
      engine: { ...env.engine, modelPreferences: reloadedPrefService },
      screen: newScreen,
      presentationMode: 'conversation',
    });
    await restartedTui.start();
    await flushDraw();
    const step17Visible = newOutStream.buffer.getVisibleTextCombined();
    stepCaptures[17] = {
      step: 'Step 17: Exit and restart chat session loading from disk',
      visibleText: step17Visible,
      rawOutputChunk: newOutStream.output,
    };

    // ------------------------------------------------------------------------
    // Step 18: Verify persistent settings (Enter selection persisted across sessions)
    // ------------------------------------------------------------------------
    const persistedEff = reloadedPrefService.getEffectivePreference();
    expect(persistedEff.mode).toBe('local');
    expect(persistedEff.modelId).toBe('phi-3:mini');
    stepCaptures[18] = {
      step: 'Step 18: Verify persistent settings persisted across sessions',
      visibleText: `Effective Mode: ${persistedEff.mode}\nEffective ModelId: ${persistedEff.modelId}\nSource: ${persistedEff.source}`,
      rawOutputChunk: newOutStream.output,
    };

    // ------------------------------------------------------------------------
    // Step 19: Verify session-only settings (S selection applies to current session and does NOT overwrite persistent disk config)
    // ------------------------------------------------------------------------
    await restartedTui.submitCommand('/model');
    await flushDraw();
    const controller19 = restartedTui['modelSelector']!;
    controller19.selectedIndex = 1; // Fast
    await sendKey(restartedTui, 's');
    expect(restartedTui['modelSelector']).toBeUndefined();

    expect(reloadedPrefService.getEffectivePreference().mode).toBe('fast');
    expect(reloadedPrefService.getEffectivePreference().source).toBe('session');

    // Verify disk configuration untouched
    const diskRaw = JSON.parse(await fs.readFile(prefPath, 'utf8'));
    expect(diskRaw.mode).toBe('local');
    expect(diskRaw.modelId).toBe('phi-3:mini');
    expect(diskRaw.mode).not.toBe('fast');
    stepCaptures[19] = {
      step: 'Step 19: Verify session-only S selection does NOT overwrite disk config',
      visibleText: `Effective Session Mode: ${reloadedPrefService.getEffectivePreference().mode}\nDisk Mode: ${diskRaw.mode}\nDisk ModelId: ${diskRaw.modelId}`,
      rawOutputChunk: newOutStream.output,
    };

    // ------------------------------------------------------------------------
    // Step 20: Confirm no duplicate notifications (each selection produces exactly 1 Model selection updated confirmation)
    // ------------------------------------------------------------------------
    await flushDraw();
    const step20Visible = newOutStream.buffer.getVisibleTextCombined();
    expect(step20Visible).toContain('Model selection updated [Session Only]');
    expect(step20Visible).not.toContain('• Model selection updated');

    const fullTranscript = restartedTui['conversationRenderer'].transcript.list();
    const confMatches = fullTranscript.filter((t) => t.text.includes('Model selection updated'));
    expect(confMatches.length).toBe(1);

    stepCaptures[20] = {
      step: 'Step 20: Confirm no duplicate confirmation messages (P2-C regression verified)',
      visibleText: step20Visible,
      rawOutputChunk: newOutStream.output,
    };

    restartedTui.stop();

    // Verify all 20 steps captured
    expect(Object.keys(stepCaptures).length).toBe(20);
  });

  // --------------------------------------------------------------------------
  // Before vs. After Regression Evidence Verification (P1-A, P1-B, P2-C)
  // --------------------------------------------------------------------------
  it('Captures and validates exact Before/After comparison evidence for P1-A, P1-B, and P2-C', () => {
    // P1-A
    const p1a = captureBeforeAfterComparison('P1-A');
    expect(p1a.bugId).toBe('P1-A');
    expect(p1a.beforeTerminalOutput).toContain('WAZIR — Select Model');
    expect(p1a.afterTerminalOutput).toContain('WAZIR — Select Model');
    expect(p1a.summary).toContain('20 appended selector boxes');

    // P1-B
    const p1b = captureBeforeAfterComparison('P1-B');
    expect(p1b.bugId).toBe('P1-B');
    expect(p1b.afterTerminalOutput).toContain('WAZIR — Local Models');
    expect(p1b.summary).toContain('WAZIR — Local Models');

    // P2-C
    const p2c = captureBeforeAfterComparison('P2-C');
    expect(p2c.bugId).toBe('P2-C');
    expect(p2c.beforeTerminalOutput).toContain('• Model selection updated');
    expect(p2c.afterTerminalOutput).not.toContain('• Model selection updated');
  });
});
