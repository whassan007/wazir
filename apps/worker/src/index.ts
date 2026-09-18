#!/usr/bin/env node
import { Worker } from '@wazir/workers';
import { color } from './colors.js';

function parseArgs(argv: string[]): { server?: string; computer?: string; name?: string } {
  const out: { server?: string; computer?: string; name?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--server' && argv[i + 1]) out.server = argv[++i];
    else if (argv[i] === '--computer' && argv[i + 1]) out.computer = argv[++i];
    else if (argv[i] === '--name' && argv[i + 1]) out.name = argv[++i];
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const serverUrl = args.server ?? process.env.WAZIR_SERVER_URL;

  const worker = new Worker({
    computerId: args.computer ?? process.env.WAZIR_COMPUTER_ID ?? 'local',
    name: args.name ?? process.env.WAZIR_COMPUTER_NAME ?? 'local',
    serverUrl,
    registrationToken: process.env.WAZIR_REGISTRATION_TOKEN,
    token: process.env.WAZIR_WORKER_TOKEN,
  });

  const info = await worker.start();
  console.log(color.bold(`worker ${info.id} online`));
  console.log(color.gray(`  computer: ${info.computerId}`));
  console.log(color.gray(`  runtimes: ${info.runtimes.join(', ') || 'none'}`));
  console.log(color.gray(`  models:   ${info.models.length} discovered`));
  if (serverUrl) {
    console.log(color.gray(`  server:   ${serverUrl}`));
  } else {
    console.log(color.gray('  server:   none (local mode — no control plane registered)'));
  }
  console.log(color.gray('waiting for work… (Ctrl+C to stop)'));

  // Registering signal handlers does not, by itself, keep the Node event
  // loop alive — with no serverUrl configured, Worker.start() sets up no
  // heartbeat timer either, so without this the process would exit
  // immediately (exit code 0) right after printing the message above,
  // instead of staying resident as a daemon (surfaced by actually running
  // this under Docker/systemd rather than just typechecking it).
  const keepAlive = setInterval(() => {}, 1 << 30);

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      clearInterval(keepAlive);
      void worker.stop().then(resolve);
    });
    process.on('SIGTERM', () => {
      clearInterval(keepAlive);
      void worker.stop().then(resolve);
    });
  });

  console.log(color.gray('worker stopped'));
}

main().catch((error) => {
  console.error(color.red(`error: ${error instanceof Error ? error.message : String(error)}`));
  process.exit(1);
});
