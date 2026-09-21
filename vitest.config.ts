import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A handful of integration tests (packages/database/tests,
    // apps/cli/tests/createStore.test.ts) share one live Postgres instance
    // via WAZIR_TEST_DATABASE_URL and call whole-table operations like
    // TRUNCATE/clear() against it. Running test *files* in parallel let two
    // of those race — one file's cleanup silently wiping another's
    // in-flight assertion. The rest of the suite is fast and has no shared
    // external state, so serializing files costs little.
    fileParallelism: false,
    // buildcpp.e2e.test.ts drives a full live multi-turn agentic loop against
    // whatever model LM Studio has loaded (minutes, non-reproducible run to
    // run) — deliberately excluded from the default sweep; run it explicitly
    // via `npm run test:buildcpp`.
    exclude: [...configDefaults.exclude, '**/.wazir/**', '**/buildcpp.e2e.test.ts'],
  },
});
