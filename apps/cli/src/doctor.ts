import type { RookEngine } from './engine.js';
import { color } from './colors.js';
import { createBlock } from './blocks.js';

export type DoctorStatus = 'PASS' | 'WARN' | 'FAIL' | 'NOT INSTALLED' | 'UNAVAILABLE';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  message?: string;
  details?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  summary: { pass: number; warn: number; fail: number; notInstalled: number; unavailable: number };
}

function checkConfig(engine: RookEngine): DoctorCheck {
  try {
    const config = engine.config;
    
    if (!config.ollamaUrl && !config.lmstudioUrl) {
      return { name: 'configuration', status: 'WARN', message: 'no runtimes configured' };
    }
    
    return { name: 'configuration', status: 'PASS', message: 'configuration file valid' };
  } catch (error) {
    return {
      name: 'configuration',
      status: 'FAIL',
      message: 'configuration error',
      details: (error as Error).message,
    };
  }
}

function checkPersistence(engine: RookEngine): DoctorCheck {
  try {
    const storePath = (engine as any).executions?.store?.path;
    
    if (!storePath) {
      return { name: 'persistence', status: 'PASS', message: 'in-memory store active' };
    }
    
    return { name: 'persistence', status: 'PASS', message: `persistent storage at ${storePath}` };
  } catch (error) {
    return {
      name: 'persistence',
      status: 'FAIL',
      message: 'persistence error',
      details: (error as Error).message,
    };
  }
}

function checkControlPlane(engine: RookEngine): DoctorCheck {
  try {
    const computers = engine.computers.list();
    
    if (computers.length === 0) {
      return { name: 'control plane', status: 'WARN', message: 'no computers registered' };
    }
    
    const onlineComputers = engine.computers.listOnline();
    
    return {
      name: 'control plane',
      status: onlineComputers.length > 0 ? 'PASS' : 'UNAVAILABLE',
      message: `${onlineComputers.length}/${computers.length} computer(s) online`,
    };
  } catch (error) {
    return {
      name: 'control plane',
      status: 'FAIL',
      message: 'control plane error',
      details: (error as Error).message,
    };
  }
}

function checkWorker(engine: RookEngine): DoctorCheck {
  try {
    const worker = engine.worker;
    
    if (!worker.isRunning) {
      return { name: 'worker', status: 'WARN', message: 'worker not running' };
    }
    
    const status = worker.info.status === 'online' ? 'PASS' : 'UNAVAILABLE';
    
    return {
      name: 'worker',
      status,
      message: `${worker.id} on ${worker.computerId}`,
      details: `runtimes: ${worker.info.runtimes.join(', ')}, models: ${worker.info.models.length}`,
    };
  } catch (error) {
    return {
      name: 'worker',
      status: 'FAIL',
      message: 'worker error',
      details: (error as Error).message,
    };
  }
}

function checkComputerRegistration(engine: RookEngine): DoctorCheck {
  try {
    const computerId = process.env.WAZIR_COMPUTER_ID ?? 'local';
    const computer = engine.computers.get(computerId);
    
    if (!computer) {
      return { name: 'computer registration', status: 'NOT INSTALLED', message: `computer ${computerId} not registered` };
    }
    
    const status = computer.status === 'online' ? 'PASS' : 'UNAVAILABLE';
    
    return {
      name: 'computer registration',
      status,
      message: `${computer.id}: ${computer.name}`,
      details: `${computer.runtimes.length} runtimes, ${computer.models.length} models`,
    };
  } catch (error) {
    return {
      name: 'computer registration',
      status: 'FAIL',
      message: 'registration error',
      details: (error as Error).message,
    };
  }
}

function checkRuntimeConnectivity(engine: RookEngine): DoctorCheck {
  try {
    const discovered = engine.discovered;
    
    if (discovered.length === 0) {
      return { name: 'runtime connectivity', status: 'NOT INSTALLED', message: 'no runtimes discovered' };
    }
    
    const healthyCount = discovered.filter((r) => r.health === 'healthy').length;
    const totalCount = discovered.length;
    
    if (healthyCount === 0) {
      return { name: 'runtime connectivity', status: 'UNAVAILABLE', message: 'all runtimes unavailable' };
    }
    
    return {
      name: 'runtime connectivity',
      status: healthyCount === totalCount ? 'PASS' : 'WARN',
      message: `${healthyCount}/${totalCount} runtime(s) healthy`,
      details: discovered.map((r) => `  ${r.id}: ${r.health}`).join('\n'),
    };
  } catch (error) {
    return {
      name: 'runtime connectivity',
      status: 'FAIL',
      message: 'connectivity check error',
      details: (error as Error).message,
    };
  }
}

function checkModelAvailability(engine: RookEngine): DoctorCheck {
  try {
    const models = engine.models.list();
    
    if (models.length === 0) {
      return { name: 'model availability', status: 'NOT INSTALLED', message: 'no models registered' };
    }
    
    const instances = engine.models.listInstances();
    const loadedCount = instances.filter((i) => i.loaded).length;
    
    return {
      name: 'model availability',
      status: 'PASS',
      message: `${models.length} model(s), ${loadedCount} loaded`,
      details: `total instances: ${instances.length}`,
    };
  } catch (error) {
    return {
      name: 'model availability',
      status: 'FAIL',
      message: 'availability check error',
      details: (error as Error).message,
    };
  }
}

function checkRequiredPermissions(engine: RookEngine): DoctorCheck {
  try {
    const policy = engine.policy;
    
    if (!policy || !policy.rules) {
      return { name: 'required permissions', status: 'WARN', message: 'no policy rules defined' };
    }
    
    return {
      name: 'required permissions',
      status: 'PASS',
      message: `${policy.rules.length} rule(s) configured`,
    };
  } catch (error) {
    return {
      name: 'required permissions',
      status: 'FAIL',
      message: 'permission check error',
      details: (error as Error).message,
    };
  }
}

function checkSchedulerReadiness(engine: RookEngine): DoctorCheck {
  try {
    const scheduler = engine.scheduler;
    
    if (!scheduler) {
      return { name: 'scheduler readiness', status: 'FAIL', message: 'scheduler not available' };
    }
    
    return {
      name: 'scheduler readiness',
      status: 'PASS',
      message: 'scheduler ready for planning',
    };
  } catch (error) {
    return {
      name: 'scheduler readiness',
      status: 'FAIL',
      message: 'scheduler error',
      details: (error as Error).message,
    };
  }
}

function checkSecurity(engine: RookEngine): DoctorCheck {
  try {
    const allowUnauthenticated = process.env.WAZIR_ALLOW_UNAUTHENTICATED === '1';
    const hasApiToken = Boolean(process.env.WAZIR_API_TOKEN ?? engine.config.apiToken);
    const hasRegToken = Boolean(process.env.WAZIR_REGISTRATION_TOKEN ?? engine.config.registrationToken);
    const childEnv = process.env.WAZIR_CHILD_ENV;

    const details: string[] = [];
    if (childEnv) {
      details.push(`WAZIR_CHILD_ENV: configured (${childEnv.split(',').filter(Boolean).length} additional variable(s) passed to tool processes)`);
    } else {
      details.push('WAZIR_CHILD_ENV: not set (tool processes inherit minimal default environment: PATH, HOME, TMPDIR, USER)');
    }

    if (allowUnauthenticated) {
      return {
        name: 'api security & tokens',
        status: 'WARN',
        message: 'unauthenticated access enabled (WAZIR_ALLOW_UNAUTHENTICATED=1)',
        details: [
          ...details,
          'Warning: cluster accepts unauthenticated requests from loopback/local clients.',
          'For production deployments, unset WAZIR_ALLOW_UNAUTHENTICATED and configure WAZIR_API_TOKEN and WAZIR_REGISTRATION_TOKEN.',
        ].join('\n'),
      };
    }

    if (!hasApiToken && !hasRegToken) {
      return {
        name: 'api security & tokens',
        status: 'WARN',
        message: 'no cluster tokens configured',
        details: [
          ...details,
          'Neither WAZIR_API_TOKEN nor WAZIR_REGISTRATION_TOKEN is set.',
          'API endpoints and worker registrations will reject unauthenticated calls.',
          'Set WAZIR_API_TOKEN (operator), WAZIR_API_VIEWER_TOKEN (viewer), and WAZIR_REGISTRATION_TOKEN in your environment.',
        ].join('\n'),
      };
    }

    return {
      name: 'api security & tokens',
      status: 'PASS',
      message: 'cluster tokens configured',
      details: [
        ...details,
        `API operator token: ${hasApiToken ? 'configured' : 'not set'}`,
        `Registration token: ${hasRegToken ? 'configured' : 'not set'}`,
      ].join('\n'),
    };
  } catch (error) {
    return {
      name: 'api security & tokens',
      status: 'FAIL',
      message: 'security check error',
      details: (error as Error).message,
    };
  }
}

export function doctor(engine: RookEngine): DoctorReport {
  const checks: DoctorCheck[] = [
    checkConfig(engine),
    checkPersistence(engine),
    checkControlPlane(engine),
    checkWorker(engine),
    checkComputerRegistration(engine),
    checkRuntimeConnectivity(engine),
    checkModelAvailability(engine),
    checkRequiredPermissions(engine),
    checkSchedulerReadiness(engine),
    checkSecurity(engine),
  ];
  
  const summary = {
    pass: checks.filter((c) => c.status === 'PASS').length,
    warn: checks.filter((c) => c.status === 'WARN').length,
    fail: checks.filter((c) => c.status === 'FAIL').length,
    notInstalled: checks.filter((c) => c.status === 'NOT INSTALLED').length,
    unavailable: checks.filter((c) => c.status === 'UNAVAILABLE').length,
  };
  
  return { checks, summary };
}

export function doctorCommand(): Promise<{ code: number; output: string }> {
  return new Promise(async (resolve) => {
    let finish: Awaited<ReturnType<typeof createBlock>>['finish'] | undefined;
    try {
      const { createEngine } = require('./engine.js');
      const engine = await createEngine();

      ({ finish } = await createBlock(engine, 'doctor', []));

      const report = doctor(engine);
    
    const lines: string[] = [];
    lines.push(color.bold('Wazir Doctor'));
    lines.push('');
    
    for (const check of report.checks) {
      const statusSymbol =
        check.status === 'PASS' ? color.green('✓') :
        check.status === 'WARN' ? color.yellow('⚠') :
        check.status === 'FAIL' ? color.red('✗') :
        check.status === 'NOT INSTALLED' ? color.blue('○') :
        color.gray('•');
      
      lines.push(`${statusSymbol} ${check.name}`);
      
      if (check.message) {
        const msgColor =
          check.status === 'PASS' ? color.green :
          check.status === 'WARN' ? color.yellow :
          check.status === 'FAIL' ? color.red :
          check.status === 'NOT INSTALLED' ? color.blue :
          color.gray;
        
        lines.push(`  ${msgColor(check.message)}`);
      }
      
      if (check.details && typeof check.details === 'string') {
        for (const detail of check.details.split('\n')) {
          lines.push(color.gray(`    ${detail}`));
        }
      }
    }
    
    lines.push('');
    lines.push(color.bold('Summary:'));
    lines.push(`  ${color.green(`✓ ${report.summary.pass} passed`)}`);
    
    if (report.summary.warn > 0) {
      lines.push(`  ${color.yellow(`⚠ ${report.summary.warn} warnings`)}`);
    }
    
    if (report.summary.fail > 0) {
      lines.push(`  ${color.red(`✗ ${report.summary.fail} failures`)}`);
    }
    
    if (report.summary.notInstalled > 0) {
      lines.push(`  ${color.blue(`○ ${report.summary.notInstalled} not installed`)}`);
    }
    
    if (report.summary.unavailable > 0) {
      lines.push(`  ${color.gray(`• ${report.summary.unavailable} unavailable`)}`);
    }
    
    const hasIssues = report.summary.fail > 0 || report.summary.warn > 0;
    
    await finish?.(hasIssues ? 'failed' : 'success', { stdout: lines.join('\n'), exitCode: hasIssues ? 1 : 0 });
    resolve({ code: hasIssues ? 1 : 0, output: lines.join('\n') });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finish?.('failed', { stdout: color.red(`doctor failed: ${message}`), exitCode: 2 });
    resolve({ code: 2, output: color.red(`doctor failed: ${message}`) });
  }
});
}
