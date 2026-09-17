import { createApiState, createApp } from './server.js';

const port = Number(process.env.PORT ?? 4800);
const host = process.env.WAZIR_HOST ?? '127.0.0.1';

async function main(): Promise<void> {
  const state = await createApiState();
  const app = createApp(state);
  const server = app.listen(port, host, () => {
    console.log(`wazir-api listening on http://localhost:${port}`);
    console.log(`  health: http://localhost:${port}/health`);
    console.log(`  api:    http://localhost:${port}/api/v1/overview`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
