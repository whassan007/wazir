import type { AgentAdapter, AgentInfo } from '../types/agent.js';
import type { Task } from '../types/task.js';

export interface AgentResolution {
  agent: AgentAdapter;
  reasons: string[];
}

export class AgentRegistry {
  private agents: AgentInfo[] = [];
  private adapters = new Map<string, AgentAdapter>();

  register(agent: AgentAdapter, source: 'native' | 'external' = 'native'): AgentInfo {
    const info: AgentInfo = {
      descriptor: agent.descriptor,
      source,
      registeredAt: new Date(),
    };
    this.agents = this.agents.filter((a) => a.descriptor.name !== agent.descriptor.name);
    this.agents.push(info);
    this.adapters.set(agent.descriptor.name, agent);
    return info;
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name);
  }

  list(): AgentInfo[] {
    return [...this.agents].sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name));
  }

  /**
   * Deterministic agent selection:
   * 1. explicit preference (task.execution.targetAgentId) — hard requirement, no fallback
   * 2. first agent whose taskTypes include the task type
   * 3. first agent whose requiredCapabilities overlap the task capabilities
   * 4. otherwise an explicit error (no silent default agent)
   */
  resolveForTask(task: Task): AgentResolution {
    const sorted = this.list();
    if (sorted.length === 0) {
      throw new Error('No agents are registered');
    }

    const preferred = task.execution?.targetAgentId;
    if (preferred) {
      const agent = this.adapters.get(preferred);
      if (!agent) {
        throw new Error(`Requested agent '${preferred}' is not registered`);
      }
      return { agent, reasons: [`explicitly requested agent '${preferred}'`] };
    }

    const byTaskType = sorted.find((a) => a.descriptor.taskTypes.includes(task.type));
    if (byTaskType) {
      return {
        agent: this.adapters.get(byTaskType.descriptor.name)!,
        reasons: [`agent '${byTaskType.descriptor.name}' supports task type '${task.type}'`],
      };
    }

    const required = task.requirements.capabilities ?? [];
    if (required.length > 0) {
      const byCapability = sorted.find((a) =>
        required.some((c) => a.descriptor.capabilities.includes(c)),
      );
      if (byCapability) {
        return {
          agent: this.adapters.get(byCapability.descriptor.name)!,
          reasons: [`agent '${byCapability.descriptor.name}' matches required capabilities`],
        };
      }
    }

    throw new Error(
      `No agent supports task type '${task.type}'` +
        (required.length > 0 ? ` with capabilities ${required.join(', ')}` : ''),
    );
  }
}
