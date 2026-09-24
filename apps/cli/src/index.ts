#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { registerMCPCommands } from './mcp.js';
import { registerWebCommands } from './web.js';
import { closeMCPRegistries } from '@wazir/core';
import { installGlobalCrashHandlers } from './crashHandler.js';

// Installed before anything else runs: previously `uncaughtException` had no
// handler anywhere (Node's default silently crashes with no terminal
// restoration and no record of what happened), and `unhandledRejection` was
// only ever handled inside the TUI, and only while it was running.
installGlobalCrashHandlers();

const program = new Command();

program
  .name('wa')
  .description('Wazir CLI — meta-harness for local and distributed AI execution')
  .version('0.1.41');

registerMCPCommands(program);
registerWebCommands(program);
program.hook('postAction', async () => { await closeMCPRegistries(); });

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
  .action(async () => {
    const { doctorCommand } = await import('./doctor.js');
    const result = await doctorCommand();
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
  .option('--max-turns <number>', 'Maximum turns per task')
  .option('--type <type>', 'Task type: chat, coding, research, etc.')
  .option('--preset <name>', 'Runtime preset (e.g. standard, minimal)')
  .option('--expected-files <files>', 'Expected changed files (comma-separated)')
  .option('--json', 'Output in JSON format')
  .description('Run a new task')
  .action(async (prompt, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { runTaskCommand } = await import('./commands.js');
    const result = await runTaskCommand(
      engine,
      prompt,
      {
        type: options.type as any,
        model: options.model,
        agent: options.agent,
        maxTurns: options.maxTurns ? Number(options.maxTurns) : undefined,
        preset: options.preset,
        expectedFiles: options.expectedFiles
          ? options.expectedFiles.split(',').map((s) => s.trim())
          : undefined,
        json: options.json,
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
  .option('--json', 'Output in JSON format')
  .description('Show scheduling decision without executing')
  .action(async (prompt, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { planTaskCommand } = await import('./commands.js');
    const result = await planTaskCommand(engine, prompt, {
      type: options.type as any,
      model: options.model,
      agent: options.agent,
      json: options.json,
    });
    console.log(result.output);
    process.exit(result.code);
  });

taskCmd
  .command('status')
  .argument('<id>', 'Task ID')
  .description('Show task status')
  .action((id) => {
    console.log(chalk.green(`Task ${id}: queued`));
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
  .option('--max-turns <number>', 'Maximum turns per task')
  .option('--type <type>', 'Task type: chat, coding, research, etc.')
  .option('--preset <name>', 'Runtime preset (e.g. standard, minimal)')
  .option('--expected-files <files>', 'Expected changed files (comma-separated)')
  .option('--json', 'Output in JSON format')
  .description('Run a new task (alias for wa task run)')
  .action(async (prompt, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { runTaskCommand } = await import('./commands.js');
    const result = await runTaskCommand(
      engine,
      prompt,
      {
        type: options.type as any,
        model: options.model,
        agent: options.agent,
        maxTurns: options.maxTurns ? Number(options.maxTurns) : undefined,
        preset: options.preset,
        expectedFiles: options.expectedFiles
          ? options.expectedFiles.split(',').map((s) => s.trim())
          : undefined,
        json: options.json,
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

program.addCommand(contextCmd);

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
  .action(async () => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { listAgents } = await import('./commands.js');
    console.log(listAgents(engine));
  });

agentsCmd.command('capabilities').description('List registered agent capabilities and their providers')
  .option('--json', 'Output JSON')
  .action(async (options: { json?: boolean }) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ readOnlyLifecycle: true });
    const catalog = engine.agents.catalog();
    console.log(options.json ? JSON.stringify({ capabilities: catalog }) : catalog.map(entry => `${entry.capability}: ${entry.agents.join(', ')}`).join('\n'));
  });

program.addCommand(agentsCmd);

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

// auth command — hosted provider authentication (Anthropic, OpenAI, Google)
const authCmd = new Command()
  .name('auth')
  .description('Authenticate hosted AI providers (Anthropic, OpenAI, Google)');

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
  .option('--allow-hosted', 'Allow this command to route to an authenticated hosted provider (Anthropic/OpenAI/Google)')
  .action(async (prompt, options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { askCommand } = await import('./commands.js');
    const result = await askCommand(engine, prompt, options);
    if (result.output) {
      console.log(result.output);
    }
    process.exit(result.code);
  });

// chat command — interactive fleet coding agent TUI
program
  .command('chat')
  .alias('fleet')
  .description('Open interactive fleet-scale coding agent TUI session')
  .option('--concurrency <number>', 'Concurrent agent limit across the fleet (default: 4)')
  .option('--no-worktrees', 'Disable git worktree isolation')
  .option('--auto-merge', 'Automatically merge completed agent branches into main')
  .option('--timeout <seconds>', 'Stop a job automatically after this many seconds (default: no limit)')
  .option('--planner', 'Enable 3-layer Planner-Supervisor-Executor architecture (pre-execution DAG planning)')
  .action(async (options) => {
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
      concurrencyLimit: options.concurrency ? Number(options.concurrency) : 4,
      useWorktrees: options.worktrees !== false,
      autoMerge: options.autoMerge === true,
      timeoutSeconds: timeout,
      enablePlanner: options.planner === true,
    });
    // A closed/dead controlling terminal (the pty itself going away — distinct from
    // stdin's own 'end' event, which FleetTui already handles) delivers SIGHUP, and
    // Ctrl-C delivers SIGINT. Routed through the shared ShutdownController rather
    // than a one-off handler so both get the same bounded-timeout-then-force-exit
    // behavior as every other long-running command, and a second interrupt during a
    // hung tui.stop() forces exit instead of leaving the process stuck.
    const { shutdownController } = await import('./shutdownController.js');
    shutdownController().register('chat-tui', () => tui.stop());
    await tui.start();
    await tui.waitForExit();
  });

// dashboard command — launch web dashboard & control plane
program
  .command('dashboard')
  .alias('web')
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

program.parse();
