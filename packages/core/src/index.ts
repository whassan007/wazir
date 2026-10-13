export * from './types/index.js';
export * from './services/index.js';
export * from './fixtures/deterministicSemanticCorpus.js';
// Platform and text utilities shared with tools and agents, which depend on core but not shared.
export {
  keepEnds,
  isWindows,
  isMacOS,
  isLinux,
  GIT_NULL_DEVICE,
  GIT_NO_HOOKS,
  isPathInside,
  isProcessAlive,
  killProcessTree,
  terminateProcessTree,
  resolveExecutable,
  isExecutableOnPath,
  sanitizeChildEnvironment,
  isBatchScript,
  getSpawnCommand,
  isWindowsReservedName,
  normalizePathForComparison,
  quoteWindowsArg,
  quotePosixArg,
} from '@wazir/shared';

// Qwen-Live-Harness adapted components
export * from './subagents/types.js';
export * from './subagents/ledger.js';
export * from './permissions/adaptorUtils.js';
export * from './permissions/importantOperation.js';
export * from './permissions/permissionBroker.js';
export * from './proactive/toolReceipt.js';
export * from './proactive/taskManager.js';
export * from './resources/index.js';
