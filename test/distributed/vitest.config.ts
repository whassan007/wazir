import { configDefaults, defineConfig } from 'vitest/config';
if (process.platform !== 'linux') throw new Error('Distributed SIGKILL qualification requires Linux');
export default defineConfig({ test: {
  fileParallelism: false,
  include: ['test/distributed/**/*.test.ts'],
  exclude: [...configDefaults.exclude, '**/.wazir/**', '**/.worktrees/**'],
  testTimeout: 90_000, hookTimeout: 15_000,
  env: { WAZIR_DISTRIBUTED: '1', WAZIR_SECRETS_BACKEND: 'encrypted-file' },
} });
