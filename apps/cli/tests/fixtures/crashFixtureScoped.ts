import { installGlobalCrashHandlers, withScopedRejectionHandler } from '../../src/crashHandler.ts';
installGlobalCrashHandlers();

let recovered = false;
const restore = withScopedRejectionHandler(() => {
  recovered = true;
});

setTimeout(() => {
  void Promise.reject(new Error('scoped-boom'));
}, 5);

// If the scoped handler actually intercepted the rejection instead of the
// fatal default, we're still alive here — print proof and exit clean.
// If it didn't, the fatal handler would have exited(1) before this ever runs.
setTimeout(() => {
  restore();
  console.log(`RECOVERED:${recovered}`);
  // Now trigger a second rejection with the fatal handler restored — this
  // one SHOULD crash the process, proving restore() actually put the fatal
  // handler back rather than leaving nothing installed.
  void Promise.reject(new Error('post-restore-boom'));
}, 50);
