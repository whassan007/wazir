#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';

const program = new Command();

program
  .name('mh')
  .description('Rook Meta-Harness CLI')
  .version('0.1.0');

// computers command
const computersCmd = new Command()
  .name('computers')
  .description('Manage target computers');

computersCmd
  .command('list')
  .description('List all registered computers')
  .action(() => {
    console.log(chalk.green('Computers:'));
    console.log('  - dgx-primary (online)');
    console.log('  - mac-m4max (online)');
  });

computersCmd
  .command('inspect')
  .argument('<id>', 'Computer ID')
  .description('Inspect a specific computer')
  .action((id) => {
    console.log(chalk.green(`Computer: ${id}`));
    // Implementation will query API
  });

program.addCommand(computersCmd);

// runtimes command
const runtimesCmd = new Command()
  .name('runtimes')
  .description('Manage AI runtimes');

runtimesCmd
  .command('list')
  .description('List available runtimes')
  .action(() => {
    console.log(chalk.green('Runtimes:'));
    console.log('  - ollama (healthy)');
    console.log('  - lmstudio (healthy)');
  });

program.addCommand(runtimesCmd);

// models command
const modelsCmd = new Command()
  .name('models')
  .description('Manage AI models');

modelsCmd
  .command('list')
  .description('List available models')
  .action(() => {
    console.log(chalk.green('Models:'));
    console.log('  - qwen3-coder (loaded)');
    console.log('  - gemma-7b (loaded)');
    console.log('  - nemotron-mini (available)');
  });

program.addCommand(modelsCmd);

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
  .option('--priority <level>', 'Priority: low, normal, high, critical', 'normal')
  .option('--local-only', 'Only run on local computers')
  .description('Run a new task')
  .action(async (prompt, options) => {
    console.log(chalk.green('Submitting task...'));
    
    // Implementation will call API
    const task = {
      input: prompt,
      priority: options.priority,
      execution: {
        targetComputer: options.computer,
        targetModel: options.model,
        targetRuntime: options.runtime
      }
    };

    console.log(JSON.stringify(task, null, 2));
  });

taskCmd
  .command('plan')
  .argument('<prompt>', 'Task prompt or description')
  .description('Show scheduling decision without executing')
  .action(async (prompt) => {
    console.log(chalk.green('Planning task execution...'));
    
    // Implementation will call API /tasks/plan endpoint
    console.log(`Task: ${prompt}`);
    console.log('');
    console.log('Selected computer: dgx-primary');
    console.log('Selected runtime: ollama');
    console.log('Selected model: qwen3-coder');
    console.log('');
    console.log('Reasons:');
    console.log('  ✓ required reasoning capability');
    console.log('  ✓ required coding capability');
    console.log('  ✓ sufficient GPU memory');
    console.log('  ✓ local-only policy satisfied');
    console.log('  ✓ model already loaded');
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
  .action(() => {
    console.log(chalk.green('Executions:'));
    console.log('  - exec-001 completed in 42s');
    console.log('  - exec-002 failed (timeout)');
  });

execCmd
  .command('inspect')
  .argument('<id>', 'Execution ID')
  .description('Inspect execution details')
  .action((id) => {
    console.log(chalk.green(`Execution ${id}:`));
    console.log('  Status: completed');
    console.log('  Duration: 42315ms');
    console.log('  Tokens/sec: 28.7');
  });

program.addCommand(execCmd);

// benchmark command
const benchCmd = new Command()
  .name('benchmark')
  .description('Run model benchmarks');

benchCmd
  .command('run')
  .argument('[model]', 'Model to benchmark (all if not specified)')
  .description('Run benchmarks on available models')
  .action(async (model) => {
    console.log(chalk.green(`Benchmarking ${model || 'all models'}...`));
    
    // Implementation will call API
  });

program.addCommand(benchCmd);

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
    
    // Implementation will call API
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
