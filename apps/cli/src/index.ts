#!/usr/bin/env node

import { Command } from 'commander';

/** Injected by scripts/bundle.mjs from package.json (the canonical version); the literal is for unbundled dev runs. */
declare const __WAZIR_VERSION__: string | undefined;
import chalk from 'chalk';
import { registerMCPCommands, wasMCPRuntimeUsed } from './mcp.js';
import { registerWebCommands } from './web.js';
import { registerMobileCommands } from './mobile.js';
import { registerGoalCommands } from './commands/goalCommands.js';
import { installGlobalCrashHandlers } from './crashHandler.js';
import { createHandoffCommand } from './handoff.js';
import { globalStartupProfiler } from './startupProfiler.js';

globalStartupProfiler.mark('cli.entry');

// Installed before anything else runs: previously `uncaughtException` had no
// handler anywhere (Node's default silently crashes with no terminal
// restoration and no record of what happened), and `unhandledRejection` was
// only ever handled inside the TUI, and only while it was running.
installGlobalCrashHandlers();

const CLI_VERSION = typeof __WAZIR_VERSION__ === 'string' ? __WAZIR_VERSION__ : '0.2.15';

const rawArgs = process.argv.slice(2);
if (rawArgs.length === 1 && (rawArgs[0] === '--version' || rawArgs[0] === '-V')) {
  process.stdout.write(`${CLI_VERSION}\n`);
  globalStartupProfiler.mark('cli.fast_version');
  globalStartupProfiler.emitIfEnabled();
  process.exit(0);
}

const program = new Command();

program
  .name('wa')
  .description('Wazir CLI — meta-harness for local and distributed AI execution')
  .version(CLI_VERSION)
  .option('--no-banner', 'Disable the Wazir terminal startup banner')
  .option('--no-color', 'Disable ANSI colors in terminal output')
  .option('--ascii', 'Use plain ASCII fallback for terminal branding');

registerMCPCommands(program);
registerWebCommands(program);
registerMobileCommands(program);
registerGoalCommands(program);

program
  .command('banner')
  .description('Display the official Wazir terminal logo and interactive startup status')
  .option('--logo-only', 'Render only the Wazir terminal logo without runtime status')
  .option('--variant <variant>', 'Force logo variant: unicode-wide, unicode-medium, ascii, or compact')
  .option('--cols <columns>', 'Simulate a specific terminal width in columns', (v) => parseInt(v, 10))
  .option('-j, --json', 'Output startup status in JSON format (suppresses banner artwork)')
  .action(async (options) => {
    const globalOpts = program.opts<{ banner?: boolean; color?: boolean; ascii?: boolean }>();
    const {
      detectTerminalCapabilities,
      renderStartupBanner,
      renderUnicodeWideLogo,
      renderUnicodeMediumLogo,
      renderPlainAsciiLogo,
      renderCompactLogo,
    } = await import('./brand.js');
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ readOnlyLifecycle: true, quiet: true });
    const runtimes = engine.runtimes.list();
    const onlineRuntimes = runtimes.filter(
      (rt) => (rt as { status?: string }).status === 'online' || engine.discovered.some((d) => d.id === rt.id && d.health !== 'unavailable'),
    );
    const models = engine.models.list();

    const status = {
      version: CLI_VERSION,
      workspace: process.cwd(),
      runtimeConnected: onlineRuntimes.length > 0,
      runtimeLabel: onlineRuntimes.length > 0 ? onlineRuntimes.map((r) => r.type).join(', ') : undefined,
      modelsAvailable: models.length,
      mode: 'Autonomous',
    };

    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    if (globalOpts.banner === false) {
      return;
    }

    const envInput = {
      isTTY: options.variant || options.cols ? true : Boolean(process.stdout.isTTY),
      columns: options.cols ?? process.stdout.columns ?? 80,
      noColorFlag: globalOpts.color === false,
      noBannerFlag: false,
      asciiFlag: Boolean(globalOpts.ascii) || options.variant === 'ascii',
      jsonFlag: Boolean(options.json),
    };
    const caps = detectTerminalCapabilities(envInput);

    if (options.logoOnly || options.variant) {
      const v = options.variant ?? caps.variant;
      if (v === 'unicode-wide') {
        console.log(renderUnicodeWideLogo(caps.colorMode));
      } else if (v === 'unicode-medium') {
        console.log(renderUnicodeMediumLogo(caps.colorMode));
      } else if (v === 'ascii') {
        console.log(renderPlainAsciiLogo(caps.colorMode));
      } else {
        console.log(
          renderCompactLogo({
            unicode: caps.unicode && v !== 'ascii',
            colorMode: caps.colorMode,
            maxWidth: caps.columns,
          })
        );
      }
      return;
    }

    const output = renderStartupBanner(status, envInput);
    if (output) {
      console.log(output);
    }
  });

program
  .command('version')
  .description('Display detailed Wazir build and runtime version information')
  .option('-j, --json', 'Output version information in JSON format')
  .action(async (options) => {
    const { getBuildInfo, formatBuildInfo } = await import('./version.js');
    const info = getBuildInfo();
    if (options.json) {
      console.log(JSON.stringify(info, null, 2));
    } else {
      console.log(formatBuildInfo(info));
    }
  });

const updateCmd = new Command().name('update').description('Manage verified Wazir updates and the persistent updater');
updateCmd.command('status').description('Show installed components and updater status').option('--json', 'Output JSON').action(async (options) => {
  const { getUpdateStatus, getUpdateConfig } = await import('./updater/service.js');
  const status = await getUpdateStatus();
  if (options.json) console.log(JSON.stringify(status, null, 2));
  else {
    const last = status.lastCheck ? new Date(status.lastCheck).toLocaleString() : 'Never';
    console.log([
      'WAZIR AUTO UPDATE', '',
      `Installed:       ${status.installedVersion}`,
      `Available:       ${status.availableVersion ?? 'Not checked'}`,
      `Channel:         ${status.channel}`,
      `Auto-update:     ${status.enabled ? 'ENABLED' : 'DISABLED'}`,
      `Check interval:  ${Math.round(status.intervalSeconds / 60)} minutes`,
      `Scheduler:       ${status.schedulerInstalled ? 'installed' : 'not installed'}`,
      `Last checked:    ${last}`,
      `Next check:      ${status.nextCheck ? new Date(status.nextCheck).toLocaleString() : status.enabled ? 'On scheduler startup' : 'Disabled'}`,
      '', 'Components:',
      ...status.components.map((component) => `  ${component.name.padEnd(14)} ${component.state}`),
      '', `Status: ${status.error ?? status.phase ?? 'Ready'}`,
    ].join('\n'));
  }
});
updateCmd.command('check').description('Check the official release source and stage a verified update').option('--json', 'Output JSON').option('--scheduled', 'Internal persistent scheduler invocation').option('--jitter', 'Spread fleet release requests over a short randomized delay').action(async (options) => {
  if (options.jitter) await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 45_001)));
  const { checkForUpdates } = await import('./updater/service.js');
  const result = await checkForUpdates({ force: !options.scheduled, scheduled: options.scheduled });
  console.log(options.json ? JSON.stringify(result, null, 2) : `${result.phase}: ${result.message ?? (result.availableVersion ? `Wazir ${result.availableVersion} is available.` : 'No newer release is available.')}`);
  if (result.phase === 'FAILED') process.exitCode = 1;
});
updateCmd.command('now').description('Check, verify, and activate an eligible update immediately').option('--json', 'Output JSON').action(async (options) => {
  const { checkForUpdates } = await import('./updater/service.js');
  const result = await checkForUpdates({ install: true, force: true });
  console.log(options.json ? JSON.stringify(result, null, 2) : `${result.phase}: ${result.message ?? result.availableVersion ?? 'No update available.'}`);
  if (result.phase === 'FAILED') process.exitCode = 1;
});
updateCmd.command('enable').description('Enable five-minute automatic update checks and installs').option('--json', 'Output JSON').action(async (options) => {
  const { enableAutoUpdates } = await import('./updater/service.js');
  const result = await enableAutoUpdates();
  console.log(options.json ? JSON.stringify(result, null, 2) : `Automatic updates enabled (${result.scheduler.backend}, every ${Math.round(result.config.intervalSeconds / 60)} minutes).`);
});
updateCmd.command('disable').description('Disable automatic updates and remove the persistent scheduler').option('--json', 'Output JSON').action(async (options) => {
  const { disableAutoUpdates } = await import('./updater/service.js');
  const result = disableAutoUpdates();
  console.log(options.json ? JSON.stringify(result, null, 2) : 'Automatic updates disabled. Update history has been preserved.');
});
updateCmd.command('history').description('Show recent update attempts').option('--limit <count>', 'Maximum records', (n) => Math.max(1, Number(n)), 30).option('--json', 'Output JSON').action(async (options) => {
  const { listUpdateHistory } = await import('./updater/service.js');
  const result = listUpdateHistory(options.limit);
  console.log(options.json ? JSON.stringify(result, null, 2) : (result.length ? result.map((entry) => `${entry.at}  ${entry.phase.padEnd(26)} ${entry.installedVersion}${entry.availableVersion ? ` → ${entry.availableVersion}` : ''}${entry.message ? ` · ${entry.message}` : ''}`).join('\n') : 'No update history yet.'));
});
updateCmd.command('rollback').description('Restore the last verified package-manager backup').option('--json', 'Output JSON').action(async (options) => {
  const { rollbackUpdate } = await import('./updater/service.js');
  const result = await rollbackUpdate();
  console.log(options.json ? JSON.stringify(result, null, 2) : `${result.phase}: ${result.message ?? result.installedVersion}`);
  if (result.phase === 'FAILED') process.exitCode = 1;
});
updateCmd.command('config').description('Show or change persistent update configuration').option('--json', 'Output JSON').option('--channel <channel>', 'stable, prerelease, or development').option('--automatic-download <boolean>', 'Automatically download new versions').option('--automatic-install <boolean>', 'Automatically install verified versions').option('--defer-while-jobs-running <boolean>', 'Defer activation while local Wazir processes run').action(async (options) => {
  const { configureUpdates, getUpdateConfig } = await import('./updater/service.js');
  const patch: Record<string, unknown> = {};
  if (options.channel) patch.channel = options.channel;
  for (const [input, target] of [['automaticDownload', 'automaticDownload'], ['automaticInstall', 'automaticInstall'], ['deferWhileJobsRunning', 'deferWhileJobsRunning']] as const) {
    const value = options[input];
    if (value !== undefined) {
      if (!['true', 'false'].includes(value)) throw new Error(`--${input.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be true or false`);
      patch[target] = value === 'true';
    }
  }
  const config = Object.keys(patch).length ? configureUpdates(patch as any) : getUpdateConfig();
  console.log(options.json ? JSON.stringify(config, null, 2) : JSON.stringify(config, null, 2));
});
program.addCommand(updateCmd);

program.hook('postAction', async () => {
  if (wasMCPRuntimeUsed()) {
    const { closeMCPRegistries } = await import('@wazir/core');
    await closeMCPRegistries();
  }
  globalStartupProfiler.mark('cli.post_action');
  globalStartupProfiler.emitIfEnabled();
});

// computers command
const computersCmd = new Command()
  .name('computers')
  .description('Manage target computers');

computersCmd
  .command('list')
  .description('List all registered computers')
  .action(async () => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { listComputers } = await import('./commands.js');
    console.log(listComputers(engine));
  });

computersCmd
  .command('inspect')
  .argument('<id>', 'Computer ID')
  .description('Inspect a specific computer')
  .action((id) => {
    console.log(chalk.green(`Computer: ${id}`));
  });

program.addCommand(computersCmd);

// workers command
const workersCmd = new Command()
  .name('workers')
  .description('Manage workers');

workersCmd
  .command('list')
  .description('List all workers')
  .action(async () => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { listWorkers } = await import('./commands.js');
    console.log(listWorkers(engine));
  });

program.addCommand(workersCmd);

// runtimes command
const runtimesCmd = new Command()
  .name('runtimes')
  .description('Manage AI runtimes');

runtimesCmd
  .command('list')
  .description('List available runtimes')
  .action(async () => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { listRuntimes } = await import('./commands.js');
    console.log(listRuntimes(engine));
  });

runtimesCmd
  .command('inspect <id>')
  .description('Inspect a specific runtime')
  .action(async (id) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { inspectRuntime } = await import('./commands.js');
    await inspectRuntime(engine, id);
  });

program.addCommand(runtimesCmd);

// providers command
const providersCmd = new Command()
  .name('providers')
  .description('Manage local and hosted AI execution providers (Ollama, LM Studio, NVIDIA, Anthropic, OpenAI, Google)');

providersCmd
  .command('list', { isDefault: true })
  .description('List all registered execution providers and their status')
  .option('--json', 'Output in JSON format')
  .action(async (options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ readOnlyLifecycle: true, quiet: true });
    const { listProvidersCommand } = await import('./commands.js');
    const result = await listProvidersCommand(engine, options);
    console.log(result.output);
    process.exit(result.code);
  });

providersCmd
  .command('inspect <provider>')
  .description('Inspect a provider, its configuration, capabilities, and registered models')
  .option('--json', 'Output in JSON format')
  .action(async (provider, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ readOnlyLifecycle: true, quiet: true });
    const { inspectProviderCommand } = await import('./commands.js');
    const result = await inspectProviderCommand(engine, provider, options);
    console.log(result.output);
    process.exit(result.code);
  });

providersCmd
  .command('test <provider>')
  .description('Test connectivity, authentication, and model discovery for a provider')
  .option('--json', 'Output in JSON format')
  .action(async (provider, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ readOnlyLifecycle: true, quiet: true });
    const { testProviderCommand } = await import('./commands.js');
    const result = await testProviderCommand(engine, provider, options);
    console.log(result.output);
    process.exit(result.code);
  });

program.addCommand(providersCmd);

// models command
const modelsCmd = new Command()
  .name('models')
  .description('Manage AI models');

modelsCmd
  .command('list', { isDefault: true })
  .description('List available models')
  .option('--computer <id>', 'Target computer')
  .option('--runtime <id>', 'Target runtime')
  .option('--json', 'Output in JSON format')
  .action(async (options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { listModels } = await import('./commands.js');
    console.log(listModels(engine, options));
  });

modelsCmd
  .command('loaded')
  .description('List resident/loaded models in memory')
  .option('--computer <id>', 'Target computer')
  .option('--runtime <id>', 'Target runtime')
  .option('--json', 'Output in JSON format')
  .action(async (options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { listLoadedModels } = await import('./commands.js');
    console.log(listLoadedModels(engine, options));
  });

modelsCmd
  .command('discover')
  .description('Discover and reconcile runtimes and installed models')
  .option('--computer <id>', 'Target computer')
  .option('--runtime <id>', 'Target runtime')
  .option('--json', 'Output in JSON format')
  .action(async (options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { discoverModelsCommand } = await import('./commands.js');
    console.log(await discoverModelsCommand(engine, options));
  });

modelsCmd
  .command('load <modelId>')
  .description('Load an installed model into memory')
  .option('--context <tokens>', 'Context tokens, 128k, auto, or max-safe')
  .option('--fit', 'Allow explicit context downshift')
  .option('--evict', 'Allow safe idle model eviction')
  .option('--dry-run', 'Plan without runtime mutation')
  .option('--wait', 'Wait for readiness verification')
  .option('--computer <id>', 'Target computer')
  .option('--runtime <id>', 'Target runtime')
  .option('--json', 'Output in JSON format')
  .action(async (modelId, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ readOnlyLifecycle: !!options.dryRun });
    const { loadModelCommand } = await import('./commands.js');
    const result = await loadModelCommand(engine, modelId, options);
    console.log(result.message);
    if (!result.ok) process.exit(1);
  });

modelsCmd
  .command('unload <modelId>')
  .description('Unload a resident model from memory')
  .option('--drain', 'Block new assignments and wait for existing executions')
  .option('--computer <id>', 'Target computer')
  .option('--runtime <id>', 'Target runtime')
  .option('--json', 'Output in JSON format')
  .action(async (modelId, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { unloadModelCommand } = await import('./commands.js');
    const result = await unloadModelCommand(engine, modelId, options);
    console.log(result.message);
    if (!result.ok) process.exit(1);
  });

modelsCmd
  .command('startup')
  .description('Launch interactive Model Startup Selector')
  .action(async () => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { FleetTui } = await import('./tui/index.js');
    const tui = new FleetTui({ engine });
    tui.openModelStartupSelector();
    await tui.start();
    await tui.waitForExit();
  });

for (const operation of ['inspect', 'estimate', 'pin', 'unpin'] as const) {
  modelsCmd.command(`${operation} <modelId>`)
    .option('--computer <id>', 'Target computer').option('--runtime <id>', 'Target runtime')
    .option('--context <tokens>', 'Context tokens, auto, or max-safe').option('--fit', 'Allow fitting')
    .option('--json', 'JSON output')
    .action(async (modelId, options) => {
      const { createEngine } = await import('./engine.js');
      const { lifecycleOptions, formatModelLoadPlan } = await import('./commands.js');
      const engine = await createEngine({ readOnlyLifecycle: true });
      if (operation === 'inspect') console.log(JSON.stringify(engine.lifecycle.inspect(modelId), null, 2));
      else if (operation === 'estimate') {
        const plan = await engine.lifecycle.estimate(modelId, lifecycleOptions(options));
        console.log(options.json ? JSON.stringify(plan, null, 2) : formatModelLoadPlan(plan));
      } else {
        await engine.lifecycle[operation](modelId, lifecycleOptions(options));
        console.log(options.json ? JSON.stringify({ ok: true, modelId, pinned: operation === 'pin' }) : `${modelId}: ${operation}`);
      }
    });
}
modelsCmd.command('reconcile').option('--json', 'JSON output').action(async () => {
  const { createEngine } = await import('./engine.js');
  const engine = await createEngine({ readOnlyLifecycle: true });
  console.log(JSON.stringify(await engine.lifecycle.reconcile(), null, 2));
});

modelsCmd
  .command('health')
  .description('Runtime and model health diagnostics (runtime, model, load, resource, telemetry, worker)')
  .option('--detail', 'Show the evidence behind each classification')
  .option('--json', 'Output in JSON format')
  .action(async (options) => {
    const { healthCommand } = await import('./health.js');
    const result = await healthCommand(options);
    console.log(result.output);
    process.exit(result.code);
  });

program.addCommand(modelsCmd);

// init command
program
  .command('init')
  .description('Initialize Wazir control plane')
  .option('--force', 'Force re-initialization')
  .action(async (options) => {
    const { initCommand } = await import('./init.js');
    const result = await initCommand(options);
    console.log(result.output);
    process.exit(result.code);
  });

// doctor command
program
  .command('doctor')
  .description('Check system health')
  .option('--json', 'Output in JSON format (includes runtime & model health)')
  .action(async (options) => {
    const { doctorCommand } = await import('./doctor.js');
    const result = await doctorCommand(options);
    console.log(result.output);
    process.exit(result.code);
  });

// test command — action/model protocol diagnostics
const testCmd = new Command()
  .name('test')
  .description('Protocol diagnostics: does the model/parser boundary actually work?');

testCmd
  .command('action-protocol')
  .description('Run the tool-argument validation matrix (no model invoked)')
  .action(async () => {
    const { actionProtocolTestCommand } = await import('./commands.js');
    const result = actionProtocolTestCommand();
    console.log(result.output);
    process.exit(result.code);
  });

testCmd
  .command('model-protocol')
  .description('Run one deterministic file-write task through a real model and verify the result')
  .requiredOption('--model <id>', 'Model id to test, e.g. nvidia/nemotron-3-nano-omni')
  .action(async (options) => {
    const { modelProtocolTestCommand } = await import('./commands.js');
    const result = await modelProtocolTestCommand(options.model);
    console.log(result.output);
    process.exit(result.code);
  });

program.addCommand(testCmd);

// status command
program
  .command('status')
  .description('Show system status')
  .action(async () => {
    const { statusCommand } = await import('./status.js');
    const result = await statusCommand();
    console.log(result.output);
    process.exit(result.code);
  });

// task command
const taskCmd = new Command()
  .name('task')
  .description('Manage tasks');

taskCmd
  .command('run')
  .argument('<prompt>', 'Task prompt or description')
  .option('--computer <id>', 'Target specific computer')
  .option('--model <name>', 'Use specific model')
  .option('--runtime <name>', 'Use specific runtime')
  .option('--agent <name>', 'Use specific agent')
  .option('--force', 'Run even if the agent failed its last preflight check')
  .option('--max-turns <number>', 'Maximum turns per task')
  .option('--type <type>', 'Task type: chat, coding, research, etc.')
  .option('--preset <name>', 'Runtime preset (e.g. standard, minimal)')
  .option('--expected-files <files>', 'Expected changed files (comma-separated)')
  .option('--allow-hosted', 'Allow routing to an authenticated hosted provider (NVIDIA, Anthropic, OpenAI, Google)')
  .option('--routing-mode <mode>', 'Routing policy mode: AUTO, NVIDIA, LOCAL_ONLY, HYBRID')
  .option('--json', 'Output in JSON format')
  .option('--full-verify', 'Build/test/lint/typecheck the whole repo instead of scoping to the workspace(s) the task touched')
  .description('Run a new task')
  .action(async (prompt, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ fastStartup: true, quiet: Boolean(options.json) });
    const { runTaskCommand } = await import('./commands.js');
    const result = await runTaskCommand(
      engine,
      prompt,
      {
        type: options.type as any,
        model: options.model,
        agent: options.agent,
        force: options.force,
        maxTurns: options.maxTurns ? Number(options.maxTurns) : undefined,
        preset: options.preset,
        expectedFiles: options.expectedFiles
          ? options.expectedFiles.split(',').map((s) => s.trim())
          : undefined,
        allowHosted: options.allowHosted,
        routingMode: options.routingMode ? (String(options.routingMode).toUpperCase() as any) : undefined,
        json: options.json,
        fullVerification: options.fullVerify,
      },
    );
    console.log(result.output);
    process.exit(result.code);
  });

taskCmd
  .command('plan')
  .argument('<prompt>', 'Task prompt or description')
  .option('--model <name>', 'Use specific model')
  .option('--agent <name>', 'Use specific agent')
  .option('--type <type>', 'Task type: chat, coding, research, etc.')
  .option('--allow-hosted', 'Allow routing to an authenticated hosted provider (NVIDIA, Anthropic, OpenAI, Google)')
  .option('--routing-mode <mode>', 'Routing policy mode: AUTO, NVIDIA, LOCAL_ONLY, HYBRID')
  .option('--json', 'Output in JSON format')
  .description('Show scheduling decision without executing')
  .action(async (prompt, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ fastStartup: true, quiet: Boolean(options.json) });
    const { planTaskCommand } = await import('./commands.js');
    const result = await planTaskCommand(engine, prompt, {
      type: options.type as any,
      model: options.model,
      agent: options.agent,
      allowHosted: options.allowHosted,
      routingMode: options.routingMode ? (String(options.routingMode).toUpperCase() as any) : undefined,
      json: options.json,
    });
    console.log(result.output);
    process.exit(result.code);
  });

taskCmd
  .command('status')
  .argument('<id>', 'Task or Execution ID')
  .option('-j, --json', 'Output as JSON')
  .description('Show authoritative task/execution status from persisted execution store')
  .action(async (id: string, opts: { json?: boolean }) => {
    const { createEngine } = await import('./engine.js');
    const { taskStatusCommand } = await import('./commands.js');
    const engine = await createEngine({ fastStartup: true, readOnlyLifecycle: true, quiet: Boolean(opts.json) });
    const res = await taskStatusCommand(engine, id, { json: Boolean(opts.json) });
    console.log(res.output);
    process.exitCode = res.code;
  });

program.addCommand(taskCmd);

// top-level run command alias (wa run <prompt>)
program
  .command('run')
  .argument('<prompt>', 'Task prompt or description')
  .option('--computer <id>', 'Target specific computer')
  .option('--model <name>', 'Use specific model')
  .option('--runtime <name>', 'Use specific runtime')
  .option('--agent <name>', 'Use specific agent')
  .option('--force', 'Run even if the agent failed its last preflight check')
  .option('--max-turns <number>', 'Maximum turns per task')
  .option('--type <type>', 'Task type: chat, coding, research, etc.')
  .option('--preset <name>', 'Runtime preset (e.g. standard, minimal)')
  .option('--expected-files <files>', 'Expected changed files (comma-separated)')
  .option('--allow-hosted', 'Allow routing to an authenticated hosted provider (NVIDIA, Anthropic, OpenAI, Google)')
  .option('--routing-mode <mode>', 'Routing policy mode: AUTO, NVIDIA, LOCAL_ONLY, HYBRID')
  .option('--json', 'Output in JSON format')
  .option('--full-verify', 'Build/test/lint/typecheck the whole repo instead of scoping to the workspace(s) the task touched')
  .description('Run a new task (alias for wa task run)')
  .action(async (prompt, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ fastStartup: true, quiet: Boolean(options.json) });
    const { runTaskCommand } = await import('./commands.js');
    const result = await runTaskCommand(
      engine,
      prompt,
      {
        type: options.type as any,
        model: options.model,
        agent: options.agent,
        force: options.force,
        maxTurns: options.maxTurns ? Number(options.maxTurns) : undefined,
        preset: options.preset,
        expectedFiles: options.expectedFiles
          ? options.expectedFiles.split(',').map((s) => s.trim())
          : undefined,
        allowHosted: options.allowHosted,
        routingMode: options.routingMode ? (String(options.routingMode).toUpperCase() as any) : undefined,
        json: options.json,
        fullVerification: options.fullVerify,
      },
    );
    if (!options.json || result.output) {
      console.log(result.output);
    }
    process.exit(result.code);
  });

// executions command
const execCmd = new Command()
  .name('executions')
  .description('Manage executions');

execCmd
  .command('list')
  .description('List recent executions')
  .option('--json', 'Output in JSON format')
  .action(async (options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { listExecutions } = await import('./commands.js');
    console.log(await listExecutions(engine, options.json ?? false));
  });

execCmd
  .command('inspect')
  .argument('<id>', 'Execution ID')
  .description('Inspect execution details')
  .option('--json', 'Output in JSON format')
  .action(async (id, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { inspectExecution } = await import('./commands.js');
    console.log(await inspectExecution(engine, id, options.json ?? false));
  });

execCmd
  .command('events')
  .argument('<id>', 'Execution ID')
  .description('Show the execution\'s durable event log in sequence order')
  .option('--type <prefix>', 'Only events whose type starts with this prefix (e.g. tool., model.route)')
  .option('--json', 'Output in JSON format')
  .action(async (id, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ readOnlyLifecycle: true });
    const { listExecutionEvents } = await import('./commands.js');
    const result = await listExecutionEvents(engine, id, options);
    console.log(result.output);
    process.exit(result.code);
  });

execCmd
  .command('replay')
  .argument('<id>', 'Execution ID')
  .description('Replay an execution from recorded events')
  .action(async (id) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { replayExecution } = await import('./commands.js');
    console.log(await replayExecution(engine, id));
  });

program.addCommand(execCmd);

// history command
const historyCmd = new Command()
  .name('history')
  .description('View command history (blocks)');

historyCmd
  .command('list')
  .description('List recent blocks')
  .option('--status <status>', 'Filter by status: running, success, failed, cancelled')
  .option('--command <substring>', 'Filter by command substring')
  .option('--json', 'Output in JSON format')
  .action(async (options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { listHistory } = await import('./commands.js');
    console.log(await listHistory(engine, options));
  });

historyCmd
  .command('inspect')
  .argument('<id>', 'Block ID')
  .description('Inspect block details')
  .option('--json', 'Output in JSON format')
  .action(async (id, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { inspectHistory } = await import('./commands.js');
    console.log(await inspectHistory(engine, id, options.json ?? false));
  });

program.addCommand(historyCmd);

// context command
const contextCmd = new Command()
  .name('context')
  .description('Manage active context blocks');

contextCmd
  .command('add')
  .argument('<blockId>', 'Block ID to add to context')
  .description('Add a block to the active context')
  .action(async (blockId) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { addContext } = await import('./commands.js');
    const result = await addContext(engine, blockId);
    console.log(result.output);
    process.exit(result.code);
  });

contextCmd
  .command('remove')
  .argument('<blockId>', 'Block ID to remove from context')
  .description('Remove a block from the active context')
  .action(async (blockId) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { removeContext } = await import('./commands.js');
    const result = await removeContext(engine, blockId);
    console.log(result.output);
    process.exit(result.code);
  });

contextCmd
  .command('list')
  .description('List active context blocks with token estimate')
  .action(async () => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { listContext } = await import('./commands.js');
    const result = await listContext(engine);
    console.log(result.output);
    process.exit(result.code);
  });

contextCmd
  .command('clear')
  .description('Clear all active context blocks')
  .action(async () => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { clearContextCommand } = await import('./commands.js');
    const result = await clearContextCommand(engine);
    console.log(result.output);
    process.exit(result.code);
  });

contextCmd
  .command('explain')
  .argument('<executionId>', 'Execution ID to explain context for')
  .option('--json', 'Output in JSON format')
  .description('Explain why context items were included, omitted, or compressed')
  .action(async (executionId, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ readOnlyLifecycle: true });
    const { explainContextCommand } = await import('./commands.js');
    const result = await explainContextCommand(engine, executionId, options);
    console.log(result.output);
    process.exit(result.code);
  });

contextCmd
  .command('inspect')
  .argument('<executionId>', 'Execution ID to inspect context snapshot for')
  .option('--json', 'Output in JSON format')
  .description('Inspect detailed compiled context snapshot and revision metadata')
  .action(async (executionId, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ readOnlyLifecycle: true });
    const { inspectContextCommand } = await import('./commands.js');
    const result = await inspectContextCommand(engine, executionId, options);
    console.log(result.output);
    process.exit(result.code);
  });

program.addCommand(contextCmd);

// evaluation command
const evalCmd = new Command()
  .name('evaluation')
  .description('Quantitative evaluation metrics and multi-dimensional comparisons');

evalCmd
  .command('show')
  .argument('<executionId>', 'Execution ID to show evaluation record for')
  .option('--json', 'Output in JSON format')
  .description('Show quantitative EvaluationRecord for an execution')
  .action(async (executionId, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ readOnlyLifecycle: true });
    const { showEvaluationCommand } = await import('./commands.js');
    const result = await showEvaluationCommand(engine, executionId, options);
    console.log(result.output);
    process.exit(result.code);
  });

evalCmd
  .command('compare')
  .argument('<baselineId>', 'Baseline execution ID')
  .argument('<candidateId>', 'Candidate execution ID')
  .option('--json', 'Output in JSON format')
  .description('Compare baseline vs candidate execution across all evaluation dimensions')
  .action(async (baselineId, candidateId, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ readOnlyLifecycle: true });
    const { compareEvaluationCommand } = await import('./commands.js');
    const result = await compareEvaluationCommand(engine, baselineId, candidateId, options);
    console.log(result.output);
    process.exit(result.code);
  });

program.addCommand(evalCmd);

// benchmark command
const benchCmd = new Command()
  .name('benchmark')
  .description('Run model benchmarks');

benchCmd
  .command('run')
  .argument('[model]', 'Model to benchmark (all if not specified)')
  .option('--prompt <text>', 'Custom prompt for benchmark')
  .description('Run benchmarks on available models')
  .action(async (model, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { runBenchmark } = await import('./commands.js');
    console.log(await runBenchmark(engine, model, options.prompt));
  });

program.addCommand(benchCmd);

// discover command
const discoverCmd = new Command()
  .name('discover')
  .description('Discover runtimes and models');

discoverCmd
  .command('all')
  .description('Run full discovery')
  .action(async () => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { discover } = await import('./commands.js');
    console.log(await discover(engine));
  });

program.addCommand(discoverCmd);

// agents command
const agentsCmd = new Command()
  .name('agents')
  .description('Manage agents');

agentsCmd
  .command('list')
  .description('List registered agents')
  .option('--json', 'Output JSON including discovery and connection states')
  .action(async (options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { listAgents } = await import('./commands.js');
    const { AgentConnectionManager } = await import('./agentConnectionManager.js');
    const discovered = new AgentConnectionManager(engine).discover();
    console.log(options.json ? JSON.stringify({ registered: engine.agents.list(), agents: discovered }, null, 2) : `${listAgents(engine)}\n${discovered.map(a => `${a.agent}: ${a.state}`).join('\n')}`);
  });

for (const verb of ['discover', 'refresh', 'inspect', 'explain']) {
  agentsCmd.command(verb).argument('[name]', 'Agent name')
    .option('--json', 'Output JSON')
    .option('--trust-project', 'Authorize reading project settings for inspection; does not execute them')
    .description('Inspect native configuration declarations and provenance without launching agents')
    .action(async (name, options) => {
      const { AgentConfigurationDiscovery } = await import('@wazir/agents');
      const { loadPreflightCache, invalidateAgentPreflight } = await import('./agentPreflight.js');
      const { isPreflightFresh, effectivePreflightStatus } = await import('@wazir/agents');
      if (verb === 'refresh') invalidateAgentPreflight(name);
      const cache = loadPreflightCache();
      const agents = new AgentConfigurationDiscovery().discover({ trustedProject: options.trustProject }).filter(a => !name || a.agent === name).map(a => {
        const connection = cache[a.agent];
        const fresh = connection?.fingerprint === a.fingerprint && isPreflightFresh(connection);
        return { ...a, state: fresh ? effectivePreflightStatus(connection) : a.state, connection: fresh ? connection : undefined,
          authentication: fresh && connection.status === 'READY' ? 'VERIFIED' : 'UNKNOWN',
          verificationScope: 'Connection probes use an empty temporary workspace, not project instructions or project model overrides.' };
      });
      console.log(options.json ? JSON.stringify({ agents }, null, 2) : agents.map(a => `${a.agent}: ${a.state}\nExecutable: ${a.executable ?? 'not found'}\nModel: ${a.model.value ?? 'unknown'} (${a.model.status})\n${a.sources.map(s => `  ${s.path} [${s.scope}, ${s.trusted ? 'trusted' : 'untrusted'}]`).join('\n')}\n${a.diagnostics.join('\n')}`).join('\n\n'));
      if (!agents.length) process.exitCode = 1;
    });
}

agentsCmd.command('connect').argument('<name>', 'Agent or configured account instance')
  .option('--json', 'Output JSON').option('--timeout <seconds>', 'Bounded preflight timeout', '90')
  .description('Verify the existing vendor login through a real bounded agent task')
  .action(async (name, options) => {
    const { createEngine } = await import('./engine.js');
    const { AgentConnectionManager } = await import('./agentConnectionManager.js');
    const engine = await createEngine({ readOnlyLifecycle: true, quiet: true });
    const results = await new AgentConnectionManager(engine).connect([name], { fresh: true, timeoutMs: Number(options.timeout) * 1000 });
    const { renderPreflight } = await import('./agentPreflight.js');
    console.log(options.json ? JSON.stringify({ agents: results }, null, 2) : renderPreflight(results));
    process.exit(results.every(r => r.status === 'READY') ? 0 : 1);
  });

agentsCmd.command('capabilities').description('List registered agent capabilities and their providers')
  .option('--json', 'Output JSON')
  .action(async (options: { json?: boolean }) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ readOnlyLifecycle: true });
    const catalog = engine.agents.catalog();
    console.log(options.json ? JSON.stringify({ capabilities: catalog }) : catalog.map(entry => `${entry.capability}: ${entry.agents.join(', ')}`).join('\n'));
  });

agentsCmd
  .command('check')
  .argument('[names...]', 'Agents to check (default: all external agents)')
  .option('--fresh', 'Ignore cached results and probe again')
  .option('--timeout <seconds>', 'Per-agent probe timeout', '90')
  .option('--json', 'Output in JSON format')
  .description('Check that external agents (Claude Code, Codex, Qwen Code, Gemini, Antigravity) can actually run a task')
  .action(async (names: string[], options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { checkAgents, renderPreflight } = await import('./agentPreflight.js');
    const results = await checkAgents(engine, names, { fresh: options.fresh, timeoutMs: Number(options.timeout) * 1000 });
    console.log(options.json ? JSON.stringify({ agents: results }, null, 2) : renderPreflight(results));
    process.exit(results.length > 0 && results.every((r) => r.status === 'READY') ? 0 : 1);
  });

program.addCommand(agentsCmd);

// resources command: accounts, budgets, ledger, DGX Spark capacity, routing economics
const resourcesCmd = new Command()
  .name('resources')
  .description('Accounts, token budgets, quotas, local GPU capacity and routing economics')
  .option('--json', 'Output the snapshot as JSON')
  .option('--watch [seconds]', 'Refresh continuously (reads the ledger and local probes; never polls providers)')
  .action(async (options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ quiet: true });
    const { resourceSnapshot, renderResourceSnapshot } = await import('./resourceDashboard.js');
    const show = async () => {
      const snap = await resourceSnapshot(engine);
      return options.json ? JSON.stringify(snap, null, 2) : renderResourceSnapshot(snap);
    };
    if (!options.watch) {
      console.log(await show());
      process.exit(0);
    }
    const every = Math.max(1, Number(options.watch === true ? 5 : options.watch)) * 1000;
    for (;;) {
      const out = await show();
      process.stdout.write('\x1b[2J\x1b[H' + out + '\n');
      await new Promise((r) => setTimeout(r, every));
    }
  });

resourcesCmd.command('stop').argument('[reason...]', 'Why').description('Emergency stop: block new cloud dispatches (local inference continues)')
  .action(async (reason: string[]) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ quiet: true });
    engine.resources.budget.emergencyStop(reason.join(' ') || 'operator emergency stop');
    console.log('Emergency stop active: no new cloud or subscription dispatches. Local inference continues. Undo with `wa resources resume`.');
    process.exit(0);
  });

resourcesCmd.command('resume').description('Lift the emergency stop')
  .action(async () => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ quiet: true });
    if (engine.resources.configError) {
      console.error(`Not resuming: ${engine.resources.configError}`);
      process.exit(1);
    }
    engine.resources.budget.resume();
    console.log('Emergency stop lifted.');
    process.exit(0);
  });

resourcesCmd.command('reset').argument('<account>', 'Account id').description('Clear an account\'s auth/quota/cooldown block after fixing it')
  .action(async (account: string) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ quiet: true });
    if (!engine.resources.accounts.get(account)) { console.error(`unknown account '${account}'`); process.exit(1); }
    engine.resources.budget.resetHealth(account);
    console.log(`Account '${account}' health reset.`);
    process.exit(0);
  });

resourcesCmd.command('validate')
  .description('Check resources.json, account mappings, limits and what admission would do now')
  .option('--profile <profile>', "'default' reports problems; 'production' also requires enforcement and known, configured limits", 'default')
  .option('--json', 'Output the report as JSON')
  .action(async (options: { profile: string; json?: boolean }, cmd: Command) => {
    // The parent `resources` command also has --json, and commander gives it the flag.
    options.json = options.json ?? cmd.parent?.opts().json;
    if (options.profile !== 'default' && options.profile !== 'production') { console.error("--profile must be 'default' or 'production'"); process.exit(2); }
    const { createEngine } = await import('./engine.js');
    const { validateResourceSetup } = await import('@wazir/core');
    const engine = await createEngine({ quiet: true });
    const r = engine.resources;
    const report = validateResourceSetup({
      budget: r.budget, configError: r.configError, configuredIds: r.configuredIds, profile: options.profile,
      agents: engine.agents.list().filter((a) => a.source === 'external').map((a) => a.descriptor.name),
      runtimes: [...new Set([...engine.adapters.keys(), ...engine.discovered.map((d) => d.id)])],
    });
    if (options.json) {
      console.log(JSON.stringify({ configPath: r.configPath, ...report }, null, 2));
      process.exit(report.ok ? 0 : 1);
    }
    const mark = { error: chalk.red('ERROR'), warn: chalk.yellow('WARN '), ok: chalk.green('ok   ') } as const;
    console.log(`${r.configPath} (profile: ${report.profile})`);
    for (const f of report.findings) console.log(`  ${mark[f.level]} ${f.subject}: ${f.message}`);
    console.log('\n  Admission preview (1-token request, nothing reserved):');
    for (const p of report.probes) console.log(`    ${p.accountId} ${p.workload}: ${p.outcome}${p.reasons.length ? ` — ${p.reasons.join('; ')}` : ''}`);
    const errors = report.findings.filter((f) => f.level === 'error').length;
    console.log(`\n${report.ok ? chalk.green('VALID') : chalk.red(`INVALID: ${errors} error(s)`)}${report.ok && errors === 0 && report.findings.some((f) => f.level === 'warn') ? ' with warnings' : ''}`);
    process.exit(report.ok ? 0 : 1);
  });

resourcesCmd.command('init').option('--force', 'Overwrite an existing resources.json').description('Write an example resources.json from detected runtimes and agents')
  .action(async (options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ quiet: true });
    const { existsSync, writeFileSync } = await import('node:fs');
    const path = engine.resources.configPath;
    if (existsSync(path) && !options.force) { console.error(`${path} exists; use --force to overwrite`); process.exit(1); }
    const { exampleResourceConfig } = await import('./resourceConfigExample.js');
    writeFileSync(path, JSON.stringify(exampleResourceConfig(engine), null, 2) + '\n', { mode: 0o600 });
    console.log(`Wrote ${path}. Limits are recorded but not enforced until you set "enforce": true in policy. Review the limits (subscription quotas are unknown until you set them), then run \`wa resources validate\`.`);
    process.exit(0);
  });

resourcesCmd.command('explain').argument('<task>', 'Task id or execution id').option('--json', 'JSON output').description('Show routing decisions, admissions and usage for a task')
  .action(async (taskId: string, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ quiet: true });
    const { ledger } = engine.resources;
    const events = ledger.events({ taskId, limit: 500 }).reverse();
    const usage = ledger.usageRows({ taskId });
    if (options.json) { console.log(JSON.stringify({ events, usage }, null, 2)); process.exit(0); }
    if (!events.length && !usage.length) { console.log(`No resource records for '${taskId}'.`); process.exit(0); }
    for (const e of events) console.log(`${new Date(e.at).toISOString()}  ${e.kind.padEnd(12)} ${e.accountId ?? ''}  ${JSON.stringify(e.data).slice(0, 600)}`);
    for (const u of usage) console.log(`usage ${u.requestId}: ${u.accountId} ${u.modelId} ${u.inputTokens} in / ${u.outputTokens} out (${u.source}) ${u.costKnown === false ? 'cost unknown (no pricing configured)' : `$${u.costUsd.toFixed(4)}`}`);
    process.exit(0);
  });

resourcesCmd.command('events').option('--kind <kind>', 'Filter by event kind').option('--limit <n>', 'Max rows', '50').description('Tail the append-only resource audit trail')
  .action(async (options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ quiet: true });
    for (const e of engine.resources.ledger.events({ kind: options.kind, limit: Number(options.limit) }).reverse()) {
      console.log(`${new Date(e.at).toISOString()}  ${e.kind.padEnd(14)} ${(e.accountId ?? '').padEnd(18)} ${e.taskId ?? ''} ${JSON.stringify(e.data).slice(0, 300)}`);
    }
    process.exit(0);
  });

program.addCommand(resourcesCmd);

// tools command
const toolsCmd = new Command()
  .name('tools')
  .description('Manage tools');

toolsCmd
  .command('list')
  .description('List available tools')
  .action(async () => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { listTools } = await import('./commands.js');
    console.log(listTools(engine));
  });

program.addCommand(toolsCmd);

// policy command
const policyCmd = new Command()
  .name('policy')
  .description('Manage and inspect policies');

policyCmd
  .command('inspect')
  .description('Inspect current policy rules')
  .action(async () => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { inspectPolicy } = await import('./commands.js');
    console.log(inspectPolicy(engine));
  });

policyCmd
  .command('explain <command>')
  .description('Explain policy classification and decision for a shell command')
  .option('--json', 'Output decision as JSON')
  .action(async (command: string, opts: { json?: boolean }) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { explainPolicyCommand } = await import('./commands.js');
    console.log(explainPolicyCommand(engine, command, opts));
  });

program.addCommand(policyCmd);

// auth command — hosted provider authentication (Anthropic, OpenAI, Google, NVIDIA)
const authCmd = new Command()
  .name('auth')
  .description('Authenticate hosted AI providers (Anthropic, OpenAI, Google, NVIDIA)');

authCmd
  .command('login [provider]')
  .description('Authenticate with a hosted provider (prompts to choose one if omitted)')
  .option('--api-key <key>', 'Provide the API key non-interactively (also honors the provider env var)')
  .option('--oauth', 'Use OAuth instead of an API key (Google only, requires oauthClientId configured)')
  .option('--json', 'Output the resulting status as JSON')
  .action(async (provider: string | undefined, opts: { apiKey?: string; oauth?: boolean; json?: boolean }) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { authLoginCommand } = await import('./auth.js');
    const result = await authLoginCommand(engine, provider, opts);
    if (result.output) console.log(result.output);
    process.exit(result.code);
  });

authCmd
  .command('status')
  .description('Show which hosted providers are connected')
  .option('--json', 'Output as JSON')
  .action(async (opts: { json?: boolean }) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { authStatusCommand } = await import('./auth.js');
    const result = await authStatusCommand(engine, opts);
    if (result.output) console.log(result.output);
    process.exit(result.code);
  });

authCmd
  .command('logout <provider>')
  .description('Remove a hosted provider credential')
  .option('--json', 'Output as JSON')
  .action(async (provider: string, opts: { json?: boolean }) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { authLogoutCommand } = await import('./auth.js');
    const result = await authLogoutCommand(engine, provider, opts);
    if (result.output) console.log(result.output);
    process.exit(result.code);
  });

authCmd
  .command('providers')
  .description('List supported hosted providers and their authentication methods')
  .option('--json', 'Output as JSON')
  .action(async (opts: { json?: boolean }) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { authProvidersCommand } = await import('./auth.js');
    const result = await authProvidersCommand(engine, opts);
    if (result.output) console.log(result.output);
    process.exit(result.code);
  });

program.addCommand(authCmd);

// audit command
program
  .command('audit')
  .description('Inspect the append-only security and policy audit log')
  .option('-n, --limit <number>', 'Maximum number of events to show', (val) => parseInt(val, 10), 50)
  .option('--tool <name>', 'Filter by tool name')
  .option('--decision <allow|ask|deny>', 'Filter by policy decision')
  .option('--json', 'Output audit events as JSON')
  .action(async (opts: { limit?: number; tool?: string; decision?: 'allow' | 'ask' | 'deny'; json?: boolean }) => {
    const { auditCommand } = await import('./commands.js');
    console.log(await auditCommand(opts));
  });

// config command
const configCmd = new Command()
  .name('config')
  .description('Show configuration');

configCmd
  .command('show')
  .description('Display current configuration')
  .action(async () => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    console.log(JSON.stringify(engine.config, null, 2));
  });

program.addCommand(configCmd);

// ask command - simplified interface
program
  .command('ask')
  .argument('<prompt>', 'Question or task description')
  .description('Ask a question (automatic selection)')
  .option('--computer <id>', 'Target specific computer')
  .option('--model <name>', 'Use specific model')
  .option('--local-only', 'Only run on local computers')
  .option('--allow-hosted', 'Allow this command to route to an authenticated hosted provider (NVIDIA, Anthropic, OpenAI, Google)')
  .option('--routing-mode <mode>', 'Routing policy mode: AUTO, NVIDIA, LOCAL_ONLY, HYBRID')
  .action(async (prompt, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ fastStartup: true });
    const { askCommand } = await import('./commands.js');
    const result = await askCommand(engine, prompt, {
      ...options,
      routingMode: options.routingMode ? (String(options.routingMode).toUpperCase() as any) : undefined,
    });
    if (result.output) {
      console.log(result.output);
    }
    process.exit(result.code);
  });

// Shared interactive runner keeps conversation and dashboard on one execution source.
async function launchInteractiveTui(options: any, presentationMode: 'conversation' | 'dashboard'): Promise<void> {
  const { createEngine } = await import('./engine.js');
  const engine = await createEngine();
  const { FleetTui } = await import('./tui/index.js');
  const timeout = options.timeout !== undefined ? Number(options.timeout) : undefined;
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
    console.error(`--timeout must be a positive number of seconds, got '${options.timeout}'`);
    process.exit(2);
  }
  const tui = new FleetTui({
    engine,
    presentationMode,
    concurrencyLimit: options.concurrency ? Number(options.concurrency) : 4,
    useWorktrees: options.worktrees !== false,
    autoMerge: options.autoMerge === true,
    timeoutSeconds: timeout,
    enablePlanner: options.planner === true,
    ...(options.model ? { modelId: String(options.model) } : {}),
  } as any);
  const { shutdownController } = await import('./shutdownController.js');
  shutdownController().register('chat-tui', () => tui.stop());
  await tui.start();
  await tui.waitForExit();
}

// `wa chat` is the inline conversation; the full-screen fleet UI remains explicit.
program
  .command('chat')
  .description('Open the conversation-first coding assistant')
  .option('--model <name>', 'Pin a specific model for the session')
  .option('--routing-mode <mode>', 'Routing policy mode: AUTO, NVIDIA, LOCAL_ONLY, HYBRID')
  .option('--dashboard', 'Open the full-screen fleet dashboard')
  .option('--legacy', 'Use the legacy full-screen fleet dashboard')
  .option('--concurrency <number>', 'Concurrent agent limit across the fleet (default: 4)')
  .option('--no-worktrees', 'Disable git worktree isolation')
  .option('--auto-merge', 'Automatically merge completed agent branches into main')
  .option('--timeout <seconds>', 'Stop a job automatically after this many seconds (default: no limit)')
  .option('--planner', 'Enable 3-layer Planner-Supervisor-Executor architecture (pre-execution DAG planning)')
  .action(async (options) => launchInteractiveTui(options, options.dashboard || options.legacy ? 'dashboard' : 'conversation'));

program
  .command('fleet')
  .description('Open the full-screen fleet dashboard (alias: wa chat --dashboard)')
  .option('--model <name>', 'Pin a specific model for the session')
  .option('--routing-mode <mode>', 'Routing policy mode: AUTO, NVIDIA, LOCAL_ONLY, HYBRID')
  .option('--concurrency <number>', 'Concurrent agent limit across the fleet (default: 4)')
  .option('--no-worktrees', 'Disable git worktree isolation')
  .option('--auto-merge', 'Automatically merge completed agent branches into main')
  .option('--timeout <seconds>', 'Stop a job automatically after this many seconds (default: no limit)')
  .option('--planner', 'Enable 3-layer Planner-Supervisor-Executor architecture')
  .action(async (options) => launchInteractiveTui(options, 'dashboard'));

// dashboard command — launch web dashboard & control plane
program
  .command('dashboard')
  // Not also aliased 'web': that name is the top-level `wa web` command (web grounding
  // diagnostics, registered first), and a duplicate makes commander throw at startup —
  // which crashed every `wa` invocation. `wa ui` still opens the dashboard.
  .alias('ui')
  .description('Launch the Wazir web control plane & dashboard')
  .option('-p, --port <port>', 'Port to listen on', '4801')
  .option('-H, --host <host>', 'Host to bind to', '127.0.0.1')
  .option('--no-open', 'Do not automatically open the dashboard in browser')
  .action(async (options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { startDashboardServer, openBrowser } = await import('./dashboardServer.js');
    const { color } = await import('./colors.js');
    const port = Number(options.port ?? 4801);
    const host = options.host ?? '127.0.0.1';
    let server: Awaited<ReturnType<typeof startDashboardServer>>;
    try {
      server = await startDashboardServer(engine, { port, host });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EADDRINUSE') {
        console.error(`wa dashboard: port ${port} is already in use on ${host} — stop whatever is using it, or pass --port <other>`);
      } else if (code === 'EACCES') {
        console.error(`wa dashboard: permission denied binding ${host}:${port} (ports below 1024 usually need elevated privileges)`);
      } else {
        console.error(`wa dashboard: failed to start: ${error instanceof Error ? error.message : String(error)}`);
      }
      process.exit(1);
    }
    const url = `http://${host}:${port}`;

    console.log();
    console.log(`  ✦ ${color.bold(color.cyan('Wazir Control Plane & Web Dashboard'))}`);
    console.log(`  Dashboard: ${color.bold(color.green(url))}`);
    console.log(`  API:       ${color.gray(`${url}/api/v1/overview`)}`);
    console.log(`  Health:    ${color.gray(`${url}/health`)}`);
    console.log();
    console.log(`  Press ${color.bold('Ctrl+C')} to stop.`);
    console.log();

    if (options.open !== false) {
      openBrowser(url);
    }

    // Previously `server.close(() => process.exit(0))` had no timeout: a
    // stuck keep-alive connection means close()'s callback never fires and
    // Ctrl-C hangs forever. Routed through ShutdownController for a bounded
    // grace period and a force-exit on a second interrupt.
    const { shutdownController } = await import('./shutdownController.js');
    shutdownController().register('dashboard-server', () => {
      console.log('\n  Shutting down Wazir dashboard...');
      return new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });

// jobs command — manage distributed fleet jobs
const jobsCmd = new Command()
  .name('jobs')
  .alias('job')
  .description('Manage fleet jobs and DAGs');

jobsCmd
  .command('list')
  .description('List all jobs')
  .action(async () => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { listJobs } = await import('./commands.js');
    console.log(listJobs(engine));
  });

jobsCmd
  .command('inspect')
  .argument('<id>', 'Job ID')
  .description('Inspect a job and its usage rollup')
  .action(async (id) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { inspectJob } = await import('./commands.js');
    console.log(await inspectJob(engine, id));
  });

jobsCmd
  .command('merge')
  .argument('<id>', 'Job ID')
  .option('--target <branch>', 'Target branch to merge into')
  .description('Merge all task branches for a job into the target branch')
  .action(async (id, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { mergeJob } = await import('./commands.js');
    console.log(await mergeJob(engine, id, options.target));
  });

jobsCmd.command('resume <id>').description('Resume a persisted job after its owner lease expires')
  .action(async (id: string) => {
    const { createEngine } = await import('./engine.js');
    const { createFleetTaskExecutor } = await import('./fleetRunner.js');
    const engine = await createEngine();
    const job = await engine.orchestrator.runJob(id, { taskExecutor: createFleetTaskExecutor(engine) });
    console.log(JSON.stringify({ jobId: job.id, status: job.status }));
    if (job.status !== 'completed') process.exitCode = 1;
  });

jobsCmd.command('recover').description('Recover persisted pending or interrupted graphs; leave live owners and paused jobs alone')
  .action(async () => {
    const { createEngine } = await import('./engine.js');
    const { createFleetTaskExecutor } = await import('./fleetRunner.js');
    const engine = await createEngine();
    console.log(JSON.stringify(await engine.orchestrator.recoverJobs({ taskExecutor: createFleetTaskExecutor(engine) })));
  });

jobsCmd
  .command('checkpoint <executionId>')
  .description('Create an execution and workspace checkpoint')
  .option('--desc <text>', 'Checkpoint description')
  .option('--json', 'Output raw JSON')
  .action(async (executionId, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { checkpointCommand } = await import('./commands.js');
    console.log(await checkpointCommand(engine, executionId, options));
  });

jobsCmd
  .command('fork <checkpointId>')
  .description('Fork an execution into an isolated worktree branch')
  .option('--fork-id <id>', 'Optional custom fork ID')
  .option('--json', 'Output raw JSON')
  .action(async (checkpointId, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { forkCommand } = await import('./commands.js');
    console.log(await forkCommand(engine, checkpointId, options));
  });

jobsCmd
  .command('rollback <executionId> <checkpointId>')
  .description('Rollback an execution to a checkpoint')
  .option('--json', 'Output raw JSON')
  .action(async (executionId, checkpointId, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { rollbackCommand } = await import('./commands.js');
    console.log(await rollbackCommand(engine, executionId, checkpointId, options));
  });

program.addCommand(jobsCmd);

// artifacts command
const artifactsCmd = new Command()
  .name('artifacts')
  .description('Inspect artifact provenance');

artifactsCmd
  .command('list')
  .description('List registered artifacts')
  .option('--execution <id>', 'Filter by execution id')
  .option('--job <id>', 'Filter by job id')
  .option('--type <type>', 'Filter by artifact type')
  .option('--json', 'Output in JSON format')
  .action(async (options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { listArtifacts } = await import('./commands.js');
    console.log(await listArtifacts(engine, options));
  });

for (const [name, fn, description] of [
  ['inspect', 'inspectArtifact', 'Inspect an artifact and its provenance record'],
  ['lineage', 'showArtifactLineage', 'Show the lineage graph from root inputs to the artifact'],
  ['why', 'showArtifactWhy', 'Explain the execution, policy and check context behind an artifact'],
  ['inputs', 'showArtifactInputs', 'List the input artifacts an artifact was derived from'],
] as const) {
  artifactsCmd
    .command(name)
    .argument('<id>', 'Artifact ID')
    .description(description)
    .option('--json', 'Output in JSON format')
    .action(async (id, options) => {
      const { createEngine } = await import('./engine.js');
      const engine = await createEngine();
      const commands = await import('./commands.js');
      console.log(await commands[fn](engine, id, options.json ?? false));
    });
}

program.addCommand(artifactsCmd);

// explain command — accepts a bare execution id, a block ref (@123), or a
// job ref (@job:x), and renders the scheduling decision already recorded
// at execution time.
program
  .command('explain')
  .argument('<ref>', 'Execution id, @<blockId>, or @job:<id>')
  .option('--json', 'Output in JSON format')
  .description('Explain the scheduling decision behind an execution, block, or job')
  .action(async (ref, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { explainCommand } = await import('./commands.js');
    const result = await explainCommand(engine, ref, options.json);
    console.log(result.output);
    process.exit(result.code);
  });

// evidence command — read-only verification evidence inspector for one execution.
program
  .command('evidence')
  .argument('<ref>', 'Execution id or @<blockId>')
  .option('--json', 'Output in JSON format')
  .description('Show exactly which controller evidence verifies (or fails to verify) an execution revision')
  .action(async (ref, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ readOnlyLifecycle: true });
    const { evidenceCommand } = await import('./commands.js');
    const result = await evidenceCommand(engine, ref, { json: options.json });
    console.log(result.output);
    process.exit(result.code);
  });

// search command — systematically explore multiple independent solution trajectories
const searchCmd = new Command()
  .name('search')
  .description('Systematically explore multiple independent solution trajectories (Best-of-N)');

searchCmd
  .command('run <task>')
  .description('Run parallel candidate trajectories for an objective')
  .option('--candidates <n>', 'Number of candidates to explore (default 3)', (val) => parseInt(val, 10), 3)
  .option('--strategy <strategy>', 'Search strategy: same_model_diverse, multi_model, multi_agent, mixed', 'same_model_diverse')
  .option('--max-parallel <n>', 'Maximum parallel candidate worktrees', (val) => parseInt(val, 10), 2)
  .option('--timeout <ms>', 'Per-candidate timeout in milliseconds', (val) => parseInt(val, 10), 180_000)
  .option('--auto-promote', 'Automatically promote winning candidate to parent workspace')
  .option('--model <id>', 'Target model for execution')
  .option('--agent <name>', 'Target agent for execution')
  .option('--json', 'Output in JSON format')
  .action(async (task, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { searchRunCommand } = await import('./searchCommands.js');
    console.log(await searchRunCommand(engine, task, options));
  });

searchCmd
  .command('status <searchId>')
  .description('Check status of a solution search')
  .option('--json', 'Output in JSON format')
  .action(async (searchId, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { searchStatusCommand } = await import('./searchCommands.js');
    console.log(searchStatusCommand(engine, searchId, options));
  });

searchCmd
  .command('candidates <searchId>')
  .description('List all candidates for a solution search')
  .option('--json', 'Output in JSON format')
  .action(async (searchId, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { searchCandidatesCommand } = await import('./searchCommands.js');
    console.log(searchCandidatesCommand(engine, searchId, options));
  });

searchCmd
  .command('inspect <searchId> <candidateId>')
  .description('Inspect detailed evaluation, checks, and evidence for a candidate')
  .option('--json', 'Output in JSON format')
  .action(async (searchId, candidateId, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { searchInspectCommand } = await import('./searchCommands.js');
    console.log(searchInspectCommand(engine, searchId, candidateId, options));
  });

searchCmd
  .command('promote <searchId> <candidateId>')
  .description('Promote a verified candidate to parent workspace with conflict check & reverification')
  .option('--json', 'Output in JSON format')
  .action(async (searchId, candidateId, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { searchPromoteCommand } = await import('./searchCommands.js');
    console.log(await searchPromoteCommand(engine, searchId, candidateId, options));
  });

searchCmd
  .command('cancel <searchId>')
  .description('Cancel an active solution search')
  .option('--json', 'Output in JSON format')
  .action(async (searchId, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { searchCancelCommand } = await import('./searchCommands.js');
    console.log(searchCancelCommand(engine, searchId, options));
  });

program.addCommand(searchCmd);

// ======================================================================
// IMPROVE COMMAND (Empirical self-improvement system)
// ======================================================================
const exitImproveOk = (): void => {
  if (process.stdout.writableNeedDrain) {
    process.stdout.once('drain', () => process.exit(0));
    return;
  }
  process.stdout.write('', () => process.exit(0));
};

const improveCmd = new Command()
  .name('improve')
  .description('Empirical self-improvement system (observe, hypothesize, experiment, guard, promote)');

improveCmd
  .command('status')
  .description('Show self-improvement status, maturity levels, and budgets')
  .option('--json', 'Output in JSON format')
  .option('--live', 'Watch durable supervisor state')
  .action(async (options) => {
    if (options.live) {
      const { improvementSupervisorCommand } = await import('./improvementSupervisor.js');
      await improvementSupervisorCommand('status', options);
      exitImproveOk();
      return;
    }
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { improveStatusCommand } = await import('./commands.js');
    console.log(await improveStatusCommand(engine, options));
    exitImproveOk();
  });

improveCmd
  .command('opportunities')
  .description('List detected measurable improvement opportunities')
  .option('--json', 'Output in JSON format')
  .action(async (options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { improveOpportunitiesCommand } = await import('./commands.js');
    console.log(await improveOpportunitiesCommand(engine, options));
    exitImproveOk();
  });

improveCmd
  .command('experiments')
  .description('List recorded self-improvement experiments')
  .option('--json', 'Output in JSON format')
  .action(async (options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { improveExperimentsCommand } = await import('./commands.js');
    console.log(await improveExperimentsCommand(engine, options));
    exitImproveOk();
  });

improveCmd
  .command('inspect <experiment>')
  .description('Inspect detailed metrics, mutations, and decisions for an experiment')
  .option('--json', 'Output in JSON format')
  .action(async (experiment, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { improveInspectCommand } = await import('./commands.js');
    console.log(await improveInspectCommand(engine, experiment, options));
    exitImproveOk();
  });

improveCmd
  .command('run')
  .description('Execute an optimization cycle under explicit budgets')
  .option('--level <level>', 'Target self-improvement maturity level')
  .option('--distributed', 'Distribute benchmark candidate evaluation across the worker fleet')
  .option('--json', 'Output in JSON format')
  .option('--mode <modes>', 'harden, optimize, or evolve', 'harden')
  .option('--scope <file>', 'Authorized reproducible repair scope with independent checks')
  .option('--commit-mode <mode>', 'Commit policy mode: manual (default), auto, or no-commit')
  .option('--auto-commit', 'Explicitly authorize automatic local commits for verified improvements in this scope')
  .option('--no-commit', 'Preserve verified changes in the candidate worktree without committing')
  .option('--offline-policy <policy>', 'Remote fetch offline policy: allow (default) or block', 'allow')
  .action(async (options) => {
    if (!options.level && !options.distributed) {
      const { improvementSupervisorCommand } = await import('./improvementSupervisor.js');
      await improvementSupervisorCommand('run', { ...options, foreground: true });
      exitImproveOk();
      return;
    }
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { improveRunCommand } = await import('./commands.js');
    console.log(await improveRunCommand(engine, options));
    exitImproveOk();
  });

improveCmd
  .command('compare <experiment>')
  .description('Compare baseline vs candidate metrics for an experiment')
  .option('--json', 'Output in JSON format')
  .action(async (experiment, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { improveCompareCommand } = await import('./commands.js');
    console.log(await improveCompareCommand(engine, experiment, options));
    exitImproveOk();
  });

improveCmd
  .command('promote <candidate>')
  .description('Promote a verified candidate to active baseline with operator authorization')
  .option('--force', 'Bypass level guards')
  .option('--json', 'Output in JSON format')
  .action(async (candidate, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { improvePromoteCommand } = await import('./commands.js');
    console.log(await improvePromoteCommand(engine, candidate, options));
    exitImproveOk();
  });

improveCmd
  .command('rollback [promotion]')
  .description('Rollback active baseline to a previous verified state')
  .option('--json', 'Output in JSON format')
  .action(async (promotion, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { improveRollbackCommand } = await import('./commands.js');
    console.log(await improveRollbackCommand(engine, promotion, options));
    exitImproveOk();
  });

improveCmd
  .command('explain <experiment>')
  .description('Explain why an experiment was initiated, what changed, what improved/regressed, and why it was promoted/rejected')
  .option('--json', 'Output in JSON format')
  .action(async (experiment, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { improveExplainCommand } = await import('./commands.js');
    console.log(await improveExplainCommand(engine, experiment, options));
    exitImproveOk();
  });

for (const command of ['doctor', 'failures', 'recommendations', 'history', 'pause', 'resume', 'stop', 'preflight', 'approvals']) {
  improveCmd
    .command(command)
    .option('--json', 'Output JSON')
    .option('--scope <file>', 'Authorized repair scope')
    .option('--offline-policy <policy>', 'Remote fetch offline policy: allow or block', 'allow')
    .option('--print-systemd-unit', 'Print optional systemd --user unit template without installing')
    .action(async (options) => {
      const { improvementSupervisorCommand } = await import('./improvementSupervisor.js');
      await improvementSupervisorCommand(command, options);
      exitImproveOk();
    });
}

improveCmd
  .command('approve <attemptId>')
  .description('Approve, revise, keep uncommitted, discard, or cancel a candidate awaiting manual commit approval')
  .option('--action <action>', 'Decision: COMMIT, REVISE, KEEP_UNCOMMITTED, DISCARD, or CANCEL', 'COMMIT')
  .option('--revision <hash>', 'Bind approval to exact candidate revision hash')
  .option('--confirm-discard', 'Explicit confirmation required when --action DISCARD is selected')
  .option('--json', 'Output JSON')
  .action(async (attemptId, options) => {
    const { improvementSupervisorCommand } = await import('./improvementSupervisor.js');
    await improvementSupervisorCommand('approve', { ...options, attemptId });
    exitImproveOk();
  });

improveCmd
  .command('start')
  .description('Start the native persistent supervisor under the current user')
  .option('--continuous', 'Observe and execute bounded cycles continuously')
  .option('--foreground', 'Run in the foreground (for systemd or debugging)')
  .option('--mode <modes>', 'Comma-separated harden,optimize,evolve', 'harden')
  .option('--interval <seconds>', 'Sweep interval, minimum 1 second', '60')
  .option('--max-cycles <count>', 'Session cycle budget', '1000')
  .option('--scope <file>', 'Authorized repair scope')
  .option('--commit-mode <mode>', 'Commit policy mode: manual (default), auto, or no-commit')
  .option('--auto-commit', 'Explicitly authorize automatic local commits for verified improvements in this session')
  .option('--no-commit', 'Preserve verified changes in the candidate worktree without committing')
  .option('--offline-policy <policy>', 'Remote fetch offline policy: allow (default) or block', 'allow')
  .option('--print-systemd-unit', 'Print optional systemd --user unit template without installing')
  .action(async (options) => {
    const { improvementSupervisorCommand } = await import('./improvementSupervisor.js');
    await improvementSupervisorCommand('start', options);
    exitImproveOk();
  });
improveCmd
  .command('logs')
  .option('--follow', 'Follow structured supervisor logs')
  .action(async (options) => {
    const { improvementSupervisorCommand } = await import('./improvementSupervisor.js');
    await improvementSupervisorCommand('logs', options);
    exitImproveOk();
  });
program.addCommand(improveCmd);

// ======================================================================
// wa canary commands (Level 3 Autonomous Continuous Canary Control)
// ======================================================================
const canaryCmd = new Command()
  .name('canary')
  .description('Level 3 Autonomous Continuous Canary deployment control and status');

canaryCmd
  .command('status')
  .description('Show status of the currently active canary deployment')
  .option('--json', 'Output in JSON format')
  .action(async (options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { canaryStatusCommand } = await import('./commands.js');
    console.log(await canaryStatusCommand(engine, options));
  });

canaryCmd
  .command('inspect <id>')
  .description('Inspect detailed canary deployment metrics, stages, and evidence')
  .option('--json', 'Output in JSON format')
  .action(async (id, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { canaryInspectCommand } = await import('./commands.js');
    console.log(await canaryInspectCommand(engine, id, options));
  });

canaryCmd
  .command('history')
  .description('List historical canary deployments and outcomes')
  .option('--json', 'Output in JSON format')
  .action(async (options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { canaryHistoryCommand } = await import('./commands.js');
    console.log(await canaryHistoryCommand(engine, options));
  });

canaryCmd
  .command('compare <id>')
  .description('Compare baseline vs candidate metrics for a canary deployment')
  .option('--json', 'Output in JSON format')
  .action(async (id, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { canaryCompareCommand } = await import('./commands.js');
    console.log(await canaryCompareCommand(engine, id, options));
  });

canaryCmd
  .command('shadow <id>')
  .description('Inspect shadow mode evaluation results for a canary candidate')
  .option('--json', 'Output in JSON format')
  .action(async (id, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { canaryShadowCommand } = await import('./commands.js');
    console.log(await canaryShadowCommand(engine, id, options));
  });

canaryCmd
  .command('rollback <id>')
  .description('Trigger immediate manual operator rollback for a canary deployment')
  .option('--reason <text>', 'Reason for manual rollback')
  .option('--json', 'Output in JSON format')
  .action(async (id, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { canaryRollbackCommand } = await import('./commands.js');
    console.log(await canaryRollbackCommand(engine, id, options));
  });

for (const action of ['pause', 'resume', 'advance'] as const) {
  canaryCmd
    .command(`${action} <id>`)
    .description(`${action} an existing canary deployment`)
    .option('--json', 'Output in JSON format')
    .action(async (id, options) => {
      const { createEngine } = await import('./engine.js');
      const engine = await createEngine();
      const { canaryControlCommand } = await import('./commands.js');
      console.log(await canaryControlCommand(engine, action, id, options));
    });
}

canaryCmd
  .command('throttle <id> <percentage>')
  .description('Reduce canary traffic to the requested percentage')
  .option('--json', 'Output in JSON format')
  .action(async (id, percentage, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { canaryControlCommand } = await import('./commands.js');
    console.log(await canaryControlCommand(engine, 'throttle', id, { ...options, percentage }));
  });

program.addCommand(canaryCmd);

// service command
const serviceCmd = new Command()
  .name('service')
  .description('Manage Wazir background daemon services (systemd / launchd / Windows)');

serviceCmd
  .command('install')
  .description('Install Wazir as a system background service')
  .option('--type <type>', 'Service type: worker or api', 'worker')
  .option('--user <user>', 'System user to run the service under (if running as root)')
  .option('--port <port>', 'Port number (for api service)')
  .option('--api-url <url>', 'Control plane API URL (for worker service)')
  .option('--name <name>', 'Custom service name', 'wazir')
  .action(async (options) => {
    const { ServiceManager } = await import('./serviceManager.js');
    const sm = new ServiceManager();
    const result = await sm.install(options);
    console.log(result.message);
  });

serviceCmd
  .command('start [name]')
  .description('Start the Wazir system service')
  .action(async (name) => {
    const { ServiceManager } = await import('./serviceManager.js');
    const sm = new ServiceManager();
    const result = await sm.start(name);
    console.log(result.message);
  });

serviceCmd
  .command('stop [name]')
  .description('Stop the Wazir system service')
  .action(async (name) => {
    const { ServiceManager } = await import('./serviceManager.js');
    const sm = new ServiceManager();
    const result = await sm.stop(name);
    console.log(result.message);
  });

serviceCmd
  .command('restart [name]')
  .description('Restart the Wazir system service')
  .action(async (name) => {
    const { ServiceManager } = await import('./serviceManager.js');
    const sm = new ServiceManager();
    const result = await sm.restart(name);
    console.log(result.message);
  });

serviceCmd
  .command('status [name]')
  .description('Display status of the Wazir system service')
  .option('--json', 'Output status in JSON format')
  .action(async (name, options) => {
    const { ServiceManager } = await import('./serviceManager.js');
    const sm = new ServiceManager();
    const status = await sm.status(name);
    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(`Backend:   ${status.backend} (${status.platform})`);
      console.log(`Service:   ${status.serviceName}`);
      console.log(`Installed: ${status.installed ? chalk.green('yes') : chalk.red('no')}`);
      console.log(`Status:    ${status.active ? chalk.green('active (running)') : chalk.yellow(status.details || 'inactive')}`);
      if (status.unitFile) {
        console.log(`Unit File: ${status.unitFile}`);
      }
    }
  });

serviceCmd
  .command('uninstall [name]')
  .description('Uninstall and remove the Wazir system service')
  .action(async (name) => {
    const { ServiceManager } = await import('./serviceManager.js');
    const sm = new ServiceManager();
    const result = await sm.uninstall(name);
    console.log(result.message);
  });

program.addCommand(serviceCmd);
program.addCommand(createHandoffCommand());

globalStartupProfiler.mark('cli.commands_registered');

program.action(async () => {
  const globalOpts = program.opts<{ banner?: boolean; color?: boolean; ascii?: boolean }>();
  if (process.stdout.isTTY && globalOpts.banner !== false) {
    const { renderStartupBanner } = await import('./brand.js');
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ readOnlyLifecycle: true, quiet: true });
    const runtimes = engine.runtimes.list();
    const onlineRuntimes = runtimes.filter(
      (rt) => (rt as { status?: string }).status === 'online' || engine.discovered.some((d) => d.id === rt.id && d.health !== 'unavailable'),
    );
    const models = engine.models.list();
    const bannerText = renderStartupBanner(
      {
        version: CLI_VERSION,
        workspace: process.cwd(),
        runtimeConnected: onlineRuntimes.length > 0,
        runtimeLabel: onlineRuntimes.length > 0 ? onlineRuntimes.map((r) => r.type).join(', ') : undefined,
        modelsAvailable: models.length,
        mode: 'Autonomous',
      },
      {
        isTTY: true,
        columns: process.stdout.columns ?? 80,
        noColorFlag: globalOpts.color === false,
        noBannerFlag: false,
        asciiFlag: Boolean(globalOpts.ascii),
      }
    );
    if (bannerText) {
      console.log(bannerText);
      console.log();
    }
  }
  program.outputHelp();
});

globalStartupProfiler.mark('cli.parse');
program.parse();
globalStartupProfiler.emitIfEnabled();


