#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';

const program = new Command();

program
  .name('wazir')
  .description('Wazir CLI — control plane command line')
  .version('0.1.0');

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
    const result = planTaskCommand(engine, prompt, {
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

program.addCommand(policyCmd);

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
    console.log(chalk.green(`Asking: ${prompt}`));
    
    const response = {
      answer: '[Response from selected model]',
      metadata: {
        computer: options.computer || 'auto-selected',
        model: options.model || 'auto-selected'
      }
    };
    
    console.log('\n' + chalk.cyan(response.answer));
  });

program.parse();
