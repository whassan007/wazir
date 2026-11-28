import { randomUUID } from 'node:crypto';
import type { FleetModelCommand, FleetModelVerb, FleetRuntimeKind } from './fleetCommandParser.js';

export interface FleetHostConfig {
  id: string;
  name: string;
  aliases?: string[];
  os: 'linux' | 'macos' | 'windows';
  isLocal?: boolean;
  tailscaleIP?: string;
  lanIP?: string;
  sshTarget?: string;
  memoryGB?: number;
  runtimes: Array<{
    kind: FleetRuntimeKind;
    port: number;
    enabled?: boolean;
    baseURL?: string;
    modelsDir?: string;
  }>;
}

export interface FleetPlanStep {
  id: number;
  hostId: string;
  hostName: string;
  runtime: FleetRuntimeKind;
  model: string;
  verb: FleetModelVerb;
  title: string;
  detail: string;
  action:
    | { type: 'ollamaPull'; model: string; baseUrl: string }
    | { type: 'ollamaDelete'; model: string; baseUrl: string }
    | { type: 'ollamaUnload'; model: string; baseUrl: string }
    | { type: 'ollamaLoad'; model: string; baseUrl: string }
    | { type: 'ssh'; target: string; command: string; posix: boolean }
    | { type: 'local'; command: string };
}

export interface FleetExecutionPlan {
  id: string;
  input: string;
  command: FleetModelCommand;
  dryRun: boolean;
  steps: FleetPlanStep[];
  warnings: string[];
  blockers: string[];
  estimatedBytes?: number;
  summary: string;
}

export type OllamaRegistryLookup =
  | { status: 'found'; bytes: number }
  | { status: 'notFound' }
  | { status: 'unavailable'; reason: string };

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function chooseRuntime(
  verb: FleetModelVerb,
  model: string,
  host: FleetHostConfig,
  explicit?: FleetRuntimeKind,
): FleetRuntimeKind {
  const enabled = host.runtimes.filter((r) => r.enabled !== false);
  if (explicit) {
    const found = enabled.find((r) => r.kind === explicit);
    if (!found) {
      throw new Error(`${host.name} has no ${explicit} runtime configured.`);
    }
    return found.kind;
  }

  const lower = model.toLowerCase();
  const order: FleetRuntimeKind[] = lower.includes('gguf')
    ? ['llamacpp', 'lmstudio', 'ollama']
    : lower.includes('mlx')
      ? ['mlx', 'lmstudio']
      : ['ollama', 'lmstudio', 'vllm', 'llamacpp', 'mlx', 'openaiCompatible'];

  for (const kind of order) {
    if (enabled.some((r) => r.kind === kind)) return kind;
  }
  if (enabled.length > 0) return enabled[0]!.kind;
  throw new Error(`${host.name} has no runtimes configured.`);
}

export function planFleetOperation(params: {
  command: FleetModelCommand;
  input: string;
  hosts: FleetHostConfig[];
  dryRunByDefault?: boolean;
}): FleetExecutionPlan {
  const { command, input, hosts, dryRunByDefault = true } = params;
  const targetHosts =
    command.target.kind === 'all'
      ? hosts
      : command.target.hosts.map((name) => {
          const low = name.toLowerCase();
          const match = hosts.find(
            (h) =>
              h.id.toLowerCase() === low ||
              h.name.toLowerCase() === low ||
              (h.aliases ?? []).some((a) => a.toLowerCase() === low),
          );
          if (!match) {
            throw new Error(`Unknown machine '${name}'. Known: ${hosts.map((h) => h.id).join(', ')}`);
          }
          return match;
        });

  const steps: FleetPlanStep[] = [];
  const warnings: string[] = [];

  for (const host of targetHosts) {
    const addr = host.isLocal ? '127.0.0.1' : (host.tailscaleIP ?? host.lanIP ?? '127.0.0.1');
    for (const model of command.models) {
      const runtimeKind = chooseRuntime(command.verb, model, host, command.runtime);
      const rt = host.runtimes.find((r) => r.kind === runtimeKind)!;
      const baseUrl = rt.baseURL ?? `http://${addr}:${rt.port}`;

      if (runtimeKind === 'ollama') {
        if (command.verb === 'add' || command.verb === 'update') {
          steps.push({
            id: steps.length,
            hostId: host.id,
            hostName: host.name,
            runtime: runtimeKind,
            model,
            verb: command.verb,
            title: `${command.verb === 'add' ? 'Pull' : 'Update'} ${model} on ${host.name}`,
            detail: `POST ${baseUrl}/api/pull {"model":"${model}","stream":true}`,
            action: { type: 'ollamaPull', model, baseUrl },
          });
        } else if (command.verb === 'remove') {
          steps.push({
            id: steps.length,
            hostId: host.id,
            hostName: host.name,
            runtime: runtimeKind,
            model,
            verb: command.verb,
            title: `Delete ${model} from ${host.name}`,
            detail: `DELETE ${baseUrl}/api/delete {"model":"${model}"}`,
            action: { type: 'ollamaDelete', model, baseUrl },
          });
        } else if (command.verb === 'reload') {
          steps.push({
            id: steps.length,
            hostId: host.id,
            hostName: host.name,
            runtime: runtimeKind,
            model,
            verb: 'reload',
            title: `Unload ${model} on ${host.name}`,
            detail: `POST ${baseUrl}/api/generate {"model":"${model}","keep_alive":0}`,
            action: { type: 'ollamaUnload', model, baseUrl },
          });
          steps.push({
            id: steps.length,
            hostId: host.id,
            hostName: host.name,
            runtime: runtimeKind,
            model,
            verb: 'reload',
            title: `Load ${model} on ${host.name}`,
            detail: `POST ${baseUrl}/api/generate {"model":"${model}","stream":false}`,
            action: { type: 'ollamaLoad', model, baseUrl },
          });
        }
      } else {
        const quoted = shellQuote(model);
        const cmd =
          runtimeKind === 'lmstudio'
            ? command.verb === 'reload'
              ? `lms unload ${quoted} && lms load ${quoted}`
              : `lms get ${quoted}`
            : `hf download ${quoted}`;
        if (host.isLocal) {
          steps.push({
            id: steps.length,
            hostId: host.id,
            hostName: host.name,
            runtime: runtimeKind,
            model,
            verb: command.verb,
            title: `${command.verb} ${model} on ${host.name} (${runtimeKind})`,
            detail: cmd,
            action: { type: 'local', command: cmd },
          });
        } else if (host.sshTarget) {
          steps.push({
            id: steps.length,
            hostId: host.id,
            hostName: host.name,
            runtime: runtimeKind,
            model,
            verb: command.verb,
            title: `${command.verb} ${model} on ${host.name} (${runtimeKind})`,
            detail: `ssh -o BatchMode=yes ${host.sshTarget} ${shellQuote(cmd)}`,
            action: { type: 'ssh', target: host.sshTarget, command: cmd, posix: host.os !== 'windows' },
          });
        } else {
          warnings.push(`${host.name} has no SSH target for ${runtimeKind} ${command.verb}.`);
        }
      }
    }
  }

  const dryRun = command.mode ? command.mode === 'dryRun' : dryRunByDefault;
  const hostNames = Array.from(new Set(steps.map((s) => s.hostName))).sort().join(', ');
  const summary = `${command.verb} ${command.models.join(', ')} on ${hostNames || 'none'}`;

  return {
    id: randomUUID(),
    input,
    command,
    dryRun,
    steps,
    warnings,
    blockers: [],
    summary,
  };
}

export function enrichFleetPlan(
  plan: FleetExecutionPlan,
  lookups: Record<string, OllamaRegistryLookup>,
  hosts: FleetHostConfig[],
  largeDownloadWarningGB = 20,
): FleetExecutionPlan {
  const next: FleetExecutionPlan = {
    ...plan,
    warnings: [...plan.warnings],
    blockers: [...plan.blockers],
  };
  let totalBytes = 0;
  let known = false;

  for (const step of plan.steps) {
    if (step.action.type !== 'ollamaPull') continue;
    const lookup = lookups[step.model];
    if (!lookup) continue;
    if (lookup.status === 'found') {
      known = true;
      totalBytes += lookup.bytes;
      const host = hosts.find((h) => h.id === step.hostId);
      if (host?.memoryGB && lookup.bytes > host.memoryGB * 0.85 * 1_073_741_824) {
        next.warnings.push(`${step.model} may not fit in ${host.name}'s ${host.memoryGB} GB memory.`);
      }
    } else if (lookup.status === 'notFound') {
      next.blockers.push(`'${step.model}' was not found in the Ollama registry.`);
    } else {
      next.warnings.push(`Could not check '${step.model}' in the Ollama registry (${lookup.reason}).`);
    }
  }

  if (known) {
    next.estimatedBytes = totalBytes;
    if (totalBytes > largeDownloadWarningGB * 1_073_741_824) {
      next.warnings.push(`Large download: ${(totalBytes / 1_073_741_824).toFixed(1)} GB total.`);
    }
  }
  return next;
}
