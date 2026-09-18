import os from 'node:os';
import { writeFileSync, readFileSync } from 'node:fs';
import type { RookEngine } from './engine.js';
import { color } from './colors.js';
import { configFile, loadConfig, type WazirConfig } from './config.js';
import { estimateModelMemory, type ComputerRegistration } from '@wazir/core';

export interface InitOptions {
  force?: boolean;
}

interface InitResult {
  success: boolean;
  messages: string[];
  computerId: string | null;
  runtimeCount: number;
  modelCount: number;
}

function discoverCpu(): string {
  try {
    if (process.platform === 'darwin') {
      return os.cpus()[0]?.model ?? 'Apple Silicon';
    }
    if (process.platform === 'linux') {
      const cpuInfo = readFileSync('/proc/cpuinfo', 'utf8');
      const match = cpuInfo.match(/model name\s*:\s*(.+)/);
      if (match) return match[1].trim();
    }
    if (process.platform === 'win32') {
      const { execSync } = require('node:child_process');
      const out = execSync('wmic cpu get name /value', { timeout: 5000 }).toString();
      const match = out.match(/Name=(.+)/);
      if (match) return match[1].trim();
    }
  } catch {
    // fall through
  }
  return os.cpus()[0]?.model ?? 'Unknown CPU';
}

function createDefaultConfig(): WazirConfig {
  return {
    ollamaUrl: 'http://localhost:11434',
    lmstudioUrl: 'http://localhost:1234/v1',
    modelContext: {},
    modelCapabilities: {},
    networkAllowed: false,
    allowCommands: [],
    denyCommands: [],
    allowedMcpServers: [],
  };
}

function writeDefaultConfig(config: WazirConfig): void {
  const file = configFile();
  try {
    writeFileSync(file, JSON.stringify(config, null, 2));
  } catch (error) {
    throw new Error(`failed to write config file ${file}: ${(error as Error).message}`);
  }
}

export async function init(engine: RookEngine, options: InitOptions = {}): Promise<InitResult> {
  const messages: string[] = [];
  
  if (options.force) {
    messages.push(color.yellow('forcing re-initialization'));
  }
  
  const defaultConfig = createDefaultConfig();
  
  try {
    loadConfig();
    messages.push(color.green('configuration file exists, using existing configuration'));
  } catch {
    writeDefaultConfig(defaultConfig);
    messages.push(color.green(`created default configuration at ${configFile()}`));
  }
  
  const computerId = process.env.WAZIR_COMPUTER_ID ?? 'local';
  const existingComputer = engine.computers.get(computerId);
  
  if (existingComputer && !options.force) {
    messages.push(color.green(`computer already registered: ${computerId} (${existingComputer.name})`));
  } else {
    const hardware = engine.worker.hardwareReport;
    
    let computerHardware: typeof localComputer.hardware;
    let computerOS: typeof localComputer.os;
    
    if (hardware?.hardware && hardware?.os) {
      computerHardware = hardware.hardware;
      computerOS = hardware.os;
    } else {
      computerOS = {
        platform: os.platform(),
        architecture: os.arch(),
        version: os.version(),
      };
      
      const cpu = discoverCpu();
      computerHardware = {
        cpu,
        cpuCores: os.cpus().length,
        memoryGB: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
        gpu: undefined,
      };
    }
    
    const localComputer: ComputerRegistration = {
      id: computerId,
      name: process.env.WAZIR_COMPUTER_NAME ?? os.hostname() ?? 'local',
      type: 'workstation' as const,
      local: true,
      os: computerOS,
      hardware: computerHardware,
      capabilities: ['localExecution'],
    };
    
    engine.computers.register(localComputer);
    messages.push(color.green(`registered computer: ${computerId} (${localComputer.name})`));
  }
  
  if (engine.worker.discovered.length === 0) {
    await engine.worker.start();
  }
  
  const discoveredRuntimes = engine.worker.discovered;
  let runtimeCount = 0;
  let modelCount = 0;
  
  for (const discovered of discoveredRuntimes) {
    const existingRuntime = engine.runtimes.get(discovered.id);
    
    if (!existingRuntime || options.force) {
      const runtimeType: 'ollama' | 'lmstudio' | 'other' =
        discovered.id === 'ollama'
          ? 'ollama'
          : discovered.id === 'lmstudio'
            ? 'lmstudio'
            : 'other';
      
      engine.runtimes.register({
        id: discovered.id,
        type: runtimeType,
        name: discovered.info.name,
        version: discovered.info.version,
        url: discovered.info.url ?? '',
        computerId,
        capabilities: {
          chat: discovered.capabilities.chat ?? false,
          streaming: discovered.capabilities.streaming ?? false,
          toolCalling: discovered.capabilities.toolCalling ?? false,
          structuredOutput: discovered.capabilities.structuredOutput ?? false,
          vision: discovered.capabilities.vision ?? false,
          embeddings: discovered.capabilities.embeddings ?? false,
          reasoning: discovered.capabilities.reasoning ?? false,
          modelLoad: discovered.capabilities.modelLoad ?? false,
          modelUnload: discovered.capabilities.modelUnload ?? false,
          modelDownload: discovered.capabilities.modelDownload ?? false,
          statefulChat: discovered.capabilities.statefulChat ?? false,
          mcp: discovered.capabilities.mcp ?? false,
        },
      });
      
      runtimeCount++;
      messages.push(color.green(`registered runtime: ${discovered.id} (${discovered.info.name})`));
    }
    
    if (discovered.health !== 'unavailable') {
      const computer = engine.computers.get(computerId);
      if (computer) {
        engine.computers.heartbeat(computerId, {
          runtimeHealth: { [discovered.id]: { status: discovered.health } },
        });
      }
      
      for (const model of discovered.models) {
        const existingInstance = engine.models.instanceOn(computerId, discovered.id).find(
          (i) => i.runtimeModelId === model.id,
        );
        
        if (!existingInstance || options.force) {
          const capabilities: string[] = [];
          if (model.toolCalling) capabilities.push('toolCalling');
          if (model.reasoning) capabilities.push('reasoning');
          if (model.vision) capabilities.push('vision');
          if (model.embedding) capabilities.push('embedding');
          if (model.structuredOutput) capabilities.push('structuredOutput');
          
          const configuredContext = engine.config.modelContext[model.id] ?? model.contextWindow ?? 32768;
          
          engine.models.register({
            id: model.id,
            name: model.name ?? model.id,
            provider: discovered.id,
            family: model.architecture?.toLowerCase().includes('qwen') ? 'qwen' :
                    model.architecture?.toLowerCase().includes('gpt') ? 'gpt' :
                    model.architecture?.toLowerCase().includes('llama') ? 'llama' : 'other',
            architecture: model.architecture,
            parameters: model.parameters,
            contextMax: configuredContext,
            configuredContext: engine.config.modelContext[model.id],
            capabilities: capabilities as any[],
            toolCalling: model.toolCalling ?? false,
            structuredOutput: model.structuredOutput ?? false,
            vision: model.vision ?? false,
            audio: model.audio ?? false,
            embedding: model.embedding ?? false,
            reasoning: model.reasoning ?? false,
            quantization: model.quantization,
            memory: estimateModelMemory(model.parameters, model.id, model.quantization),
            runtimeCompatibility: discovered.id === 'ollama' ? ['ollama'] : discovered.id === 'lmstudio' ? ['lmstudio'] : 'any',
            local: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          
          engine.models.upsertInstance({
            id: `${model.id}::${computerId}::${discovered.id}`,
            modelId: model.id,
            computerId,
            runtimeId: discovered.id,
            runtimeModelId: model.id,
            loaded: false,
            health: discovered.health === 'healthy' ? 'healthy' : 'degraded',
            contextTokens: configuredContext,
          });
          
          modelCount++;
        }
      }
    }
  }
  
  if (runtimeCount > 0) {
    messages.push(color.green(`registered ${runtimeCount} runtime(s)`));
  } else {
    messages.push(color.yellow('no runtimes discovered'));
  }
  
  if (modelCount > 0) {
    messages.push(color.green(`registered ${modelCount} model(s)`));
  } else {
    messages.push(color.yellow('no models discovered'));
  }
  
  return { success: true, messages, computerId, runtimeCount, modelCount };
}

export async function initCommand(options: InitOptions = {}): Promise<{ code: number; output: string }> {
  try {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    
    const result = await init(engine, options);
    
    const lines: string[] = [];
    lines.push(color.bold('Wazir initialization'));
    lines.push('');
    
    for (const msg of result.messages) {
      lines.push(`  ${msg}`);
    }
    
    lines.push('');
    lines.push(color.green('initialization complete'));
    
    return { code: 0, output: lines.join('\n') };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: 1, output: color.red(`init failed: ${message}`) };
  }
}
