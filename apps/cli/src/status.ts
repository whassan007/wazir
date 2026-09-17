import type { RookEngine } from './engine.js';
import { color } from './colors.js';

export interface StatusSummary {
  version: string;
  configDir: string;
  projectRoot: string;
  computers: {
    total: number;
    online: number;
    runtimes: string[];
    models: number;
  };
  runtimes: {
    total: number;
    healthy: number;
    unhealthy: number;
  };
  workers: {
    running: boolean;
    id: string;
    computerId: string;
    modelsDiscovered: number;
  };
  executions: {
    active: number;
    queued: number;
  };
}

export function getStatus(engine: RookEngine): StatusSummary {
  const computers = engine.computers.list();
  const onlineComputers = engine.computers.listOnline();
  
  const runtimes = engine.runtimes.list();
  const healthyRuntimes = runtimes.filter((r) => r.health === 'healthy' || r.health === undefined);
  
  const discoveredModels = new Set<string>();
  for (const runtime of engine.discovered) {
    for (const model of runtime.models) {
      discoveredModels.add(model.id);
    }
  }
  
  return {
    version: '0.1.0',
    configDir: engine.configDir,
    projectRoot: engine.projectRoot,
    computers: {
      total: computers.length,
      online: onlineComputers.length,
      runtimes: Array.from(new Set(computers.flatMap((c) => c.runtimes))),
      models: computers.reduce((sum, c) => sum + (c.models?.length ?? 0), 0),
    },
    runtimes: {
      total: runtimes.length,
      healthy: healthyRuntimes.length,
      unhealthy: runtimes.length - healthyRuntimes.length,
    },
    workers: {
      running: engine.worker.isRunning,
      id: engine.worker.id,
      computerId: engine.worker.computerId,
      modelsDiscovered: engine.worker.info.models.length,
    },
    executions: {
      active: 0,
      queued: 0,
    },
  };
}

export function statusCommand(): Promise<{ code: number; output: string }> {
  return new Promise(async (resolve) => {
    try {
      const { createEngine } = require('./engine.js');
      const engine = await createEngine();
      
      const status = getStatus(engine);
      
      const lines: string[] = [];
      
      lines.push(color.bold('Wazir Status'));
      lines.push('');
      
      lines.push(color.bold('Control Plane'));
      lines.push(`  version:   ${status.version}`);
      lines.push(`  configDir: ${status.configDir}`);
      lines.push(`  project:   ${status.projectRoot}`);
      
      lines.push('');
      lines.push(color.bold('Computers'));
      lines.push(`  total:     ${status.computers.total}`);
      lines.push(`  online:    ${status.computers.online}`);
      if (status.computers.runtimes.length > 0) {
        lines.push(`  runtimes:  ${status.computers.runtimes.join(', ')}`);
      }
      lines.push(`  models:    ${status.computers.models}`);
      
      lines.push('');
      lines.push(color.bold('Runtimes'));
      lines.push(`  total:     ${status.runtimes.total}`);
      lines.push(`  healthy:   ${status.runtimes.healthy}`);
      if (status.runtimes.unhealthy > 0) {
        lines.push(color.yellow(`  unhealthy: ${status.runtimes.unhealthy}`));
      }
      
      lines.push('');
      lines.push(color.bold('Worker'));
      const workerStatus = status.workers.running ? color.green('running') : color.red('stopped');
      lines.push(`  id:        ${status.workers.id}`);
      lines.push(`  computer:  ${status.workers.computerId}`);
      lines.push(`  status:    ${workerStatus}`);
      lines.push(`  models:    ${status.workers.modelsDiscovered} discovered`);
      
      lines.push('');
      lines.push(color.bold('Executions'));
      lines.push(`  active:    ${status.executions.active}`);
      lines.push(`  queued:    ${status.executions.queued}`);
      
      lines.push('');
      if (status.computers.online > 0 && status.runtimes.healthy > 0) {
        lines.push(color.green('System is operational'));
      } else {
        lines.push(color.yellow('System has issues - run wa doctor for details'));
      }
      
      resolve({ code: 0, output: lines.join('\n') });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({ code: 1, output: color.red(`status failed: ${message}`) });
    }
  });
}
