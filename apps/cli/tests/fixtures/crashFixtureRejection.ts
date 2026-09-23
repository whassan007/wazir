import { installGlobalCrashHandlers } from '../../src/crashHandler.ts';
installGlobalCrashHandlers();
setTimeout(() => {
  void Promise.reject(new Error('boom-rejection'));
}, 5);
