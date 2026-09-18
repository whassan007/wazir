import { createApiState, createApp } from './server.js';
import { isLoopbackHost } from './auth.js';

const port = Number(process.env.PORT ?? 4800);
const host = process.env.WAZIR_HOST ?? '127.0.0.1';

async function main(): Promise<void> {
  const state = await createApiState();
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
