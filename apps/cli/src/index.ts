#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';

const program = new Command();

program
  .name('wa')
  .description('Wazir CLI — control plane command line')
  .version('0.1.7');

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

program.addCommand(runtimesCmd);

// models command
const modelsCmd = new Command()
  .name('models')
  .description('Manage AI models');

modelsCmd
  .command('list')
  .description('List available models')
  .action(async () => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { listModels } = await import('./commands.js');
    console.log(listModels(engine));
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
  .action(async (options) => {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine();
    const { FleetTui } = await import('./tui/index.js');
    const tui = new FleetTui({
      engine,
      concurrencyLimit: options.concurrency ? Number(options.concurrency) : 4,
      useWorktrees: options.worktrees !== false,
      autoMerge: options.autoMerge === true,
    });
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
    const server = await startDashboardServer(engine, { port, host });
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

    const shutdown = () => {
      console.log('\n  Shutting down Wazir dashboard...');
      server.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
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

