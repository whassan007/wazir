import { configDefaults, defineConfig } from 'vitest/config';
if (process.platform === 'win32') throw new Error('Distributed POSIX SIGKILL qualification requires Linux or macOS');
export default defineConfig({ test: {
  fileParallelism: false,
  include: ['tests/distributed/**/*.test.ts'],
  exclude: [...configDefaults.exclude, '**/.wazir/**', '**/.worktrees/**', '**/tmp/**'],
  testTimeout: 90_000, hookTimeout: 15_000,
  env: { WAZIR_DISTRIBUTED: '1', WAZIR_SECRETS_BACKEND: 'encrypted-file' },
} });
