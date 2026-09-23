import { installGlobalCrashHandlers } from '../../src/crashHandler.ts';
installGlobalCrashHandlers();
setTimeout(() => {
  throw new Error('boom-uncaught');
}, 5);
