import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonFileStore, MemoryStore } from '@wazir/shared';
import { createApiState, createApp } from './server.js';
import { isLoopbackHost } from './auth.js';
import { listenOrFail } from './listenOrFail.js';

const port = Number(process.env.PORT ?? 4800);
const host = process.env.WAZIR_HOST ?? '127.0.0.1';

async function main(): Promise<void> {
  const store = process.env.WAZIR_DATABASE_URL
    ? await (async () => {
        const { createPool, runKvMigration, PostgresStore } = await import('@wazir/database');
        const pool = createPool({ connectionString: process.env.WAZIR_DATABASE_URL });
        await runKvMigration(pool);
        return new PostgresStore(pool);
      })()
    : process.env.WAZIR_IN_MEMORY === '1'
      ? new MemoryStore()
      : new JsonFileStore(path.join(process.env.WAZIR_HOME ?? path.join(os.homedir(), '.wazir'), 'wazir.json'));
  const configPath = path.join(process.env.WAZIR_HOME ?? path.join(os.homedir(), '.wazir'), 'config.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const state = await createApiState({ store, modelStartup: config.models?.startup });
  // Binding beyond loopback without an operator token exposes dispatch and
  // history to the whole network segment; make that an explicit choice.
  if (!isLoopbackHost(host) && !state.auth.operatorTokenRequired) {
    if (process.env.WAZIR_ALLOW_UNAUTHENTICATED !== '1') {
      console.error(`wazir-api: refusing to bind ${host}:${port} without WAZIR_API_TOKEN (set it, or WAZIR_ALLOW_UNAUTHENTICATED=1 to override)`);
      process.exit(2);
    }
    console.warn(`wazir-api: WARNING — listening on ${host}:${port} with no operator token; anyone on the network can dispatch work`);
  }
  if (!state.auth.registrationToken) {
    console.warn('wazir-api: WAZIR_REGISTRATION_TOKEN not set; any client may register new computers');
  }
  const app = createApp(state);
  const tlsCert = process.env.WAZIR_TLS_CERT;
  const tlsKey = process.env.WAZIR_TLS_KEY;
  const isTls = Boolean(tlsCert && tlsKey);

  const server = isTls
    ? https.createServer({
        cert: fs.readFileSync(tlsCert!),
        key: fs.readFileSync(tlsKey!),
      }, app)
    : http.createServer(app);

  await listenOrFail(server, port, host, 'wazir-api');
  const scheme = isTls ? 'https' : 'http';
  console.log(`wazir-api listening${isTls ? ' securely' : ''} on ${scheme}://${host}:${port}`);
  console.log(`  health: ${scheme}://${host}:${port}/health`);
  console.log(`  api:    ${scheme}://${host}:${port}/api/v1/overview`);

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  if (!(error as { alreadyReported?: boolean })?.alreadyReported) {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exit(1);
});
