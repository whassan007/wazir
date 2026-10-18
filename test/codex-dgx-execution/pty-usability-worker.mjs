import pty from 'node-pty';
import fs from 'node:fs';

function stripAnsi(str) {
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const mode = process.argv[2] || 'baseline';
  const cliEntry = process.argv[3] || '/home/wael/Code/Wazir/apps/cli/dist/index.js';
  const wazirHome = process.argv[4] || process.env.WAZIR_HOME || '';
  const startMs = Date.now();
  let rawTranscript = '';
  const events = [];

  const env = { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' };
  if (wazirHome) env.WAZIR_HOME = wazirHome;

  const term = pty.spawn(process.execPath, [cliEntry, 'chat', '--routing-mode', 'LOCAL_ONLY', '--model', 'gemma-4-26b-a4b-it-qat'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: '/home/wael/Code/Wazir',
    env,
  });

  let firstFrameMs = null;
  let readyPromptMs = null;

  term.onData((data) => {
    const now = Date.now() - startMs;
    rawTranscript += data;
    const clean = stripAnsi(rawTranscript);
    if (firstFrameMs === null && clean.trim().length > 0) {
      firstFrameMs = now;
      events.push({ t: now, event: 'first_frame', snippet: clean.trim().slice(0, 200) });
    }
    if (readyPromptMs === null && /WAZIR|Wazir|Ready/i.test(clean)) {
      readyPromptMs = now;
      events.push({ t: now, event: 'ready_prompt', snippet: clean.slice(-300) });
    }
  });

  // Wait up to 22s for startup prompt
  const waitStart = Date.now();
  while (readyPromptMs === null && Date.now() - waitStart < 22000) {
    await sleep(100);
  }

  await sleep(300);
  const startupScreen = stripAnsi(rawTranscript);

  // Test 1 & 2: Check startup clarity & active model visibility
  const hasWhatWazirDoes = /autonomous|coding|assistant|conversation|task|help/i.test(startupScreen);
  const hasActiveModelShown = startupScreen.includes('gemma-4-26b-a4b-it-qat');
  const hasReadyState = /Ready|Wazir >/i.test(startupScreen);
  const hasHowToSend = /Enter|submit|Type a|help/i.test(startupScreen);
  const hasHowToCancel = /Esc|Ctrl\+C|cancel/i.test(startupScreen);
  const hasHowToExit = /\/exit|\/quit|Ctrl\+C/i.test(startupScreen);

  // Test 5: Empty input handling
  const beforeEmptyLen = rawTranscript.length;
  term.write('\r');
  await sleep(300);
  const afterEmptyScreen = stripAnsi(rawTranscript.slice(beforeEmptyLen));

  // Test 3 & 6: Typing latency + Backspace / cursor navigation
  const charLatencies = [];
  const testWord = 'helxlo';
  for (const ch of testWord) {
    const t0 = Date.now();
    const lenBefore = rawTranscript.length;
    term.write(ch);
    while (rawTranscript.length === lenBefore && Date.now() - t0 < 500) {
      await sleep(5);
    }
    charLatencies.push(Date.now() - t0);
  }
  // Backspace and cursor movement: move left 2, backspace 'x', move right 2, clear line
  term.write('\x1b[D\x1b[D\x7f\x1b[C\x1b[C');
  await sleep(150);
  const afterEditSnippet = stripAnsi(rawTranscript.slice(-200));
  // Clear current input using Backspaces
  for (let i = 0; i < 10; i++) term.write('\x7f');
  await sleep(100);

  // Test 7: Multiline paste handling (with bracketed paste or newline)
  const beforePasteLen = rawTranscript.length;
  term.write('\x1b[200~line1\nline2\x1b[201~');
  await sleep(200);
  const afterPasteSnippet = stripAnsi(rawTranscript.slice(beforePasteLen));
  // Clear line
  for (let i = 0; i < 20; i++) term.write('\x7f');
  await sleep(100);

  // Test 4 & 8 & 9: Enter submission, streaming response, and cancellation via Esc
  const beforeSubmitLen = rawTranscript.length;
  const submitStart = Date.now();
  term.write('Say READY\r');
  await sleep(600);
  const afterSubmitSnippet = stripAnsi(rawTranscript.slice(beforeSubmitLen));
  const acknowledgedSubmission = afterSubmitSnippet.includes('Say READY') || afterSubmitSnippet.includes('Running') || afterSubmitSnippet.includes('Executing');

  // Test 9: Send Esc to cancel active task after 1.5s
  await sleep(1200);
  const beforeEscLen = rawTranscript.length;
  term.write('\x1b');
  await sleep(400);
  const afterEscSnippet = stripAnsi(rawTranscript.slice(beforeEscLen));

  // Test 10: Safe exit via /exit
  const exitStart = Date.now();
  for (let i = 0; i < 15; i++) term.write('\x7f');
  term.write('/exit\r');

  let exitedCode = null;
  term.onExit(({ exitCode }) => {
    exitedCode = exitCode;
  });

  while (exitedCode === null && Date.now() - exitStart < 3000) {
    await sleep(50);
  }
  if (exitedCode === null) {
    term.write('\x03'); // Ctrl+C fallback
    await sleep(500);
  }
  const exitDurationMs = Date.now() - exitStart;
  try { term.kill(); } catch {}

  const report = {
    mode,
    firstFrameMs,
    readyPromptMs,
    startupScreen,
    checks: {
      hasWhatWazirDoes,
      hasActiveModelShown,
      hasReadyState,
      hasHowToSend,
      hasHowToCancel,
      hasHowToExit,
      charLatenciesMs: charLatencies,
      maxCharLatencyMs: Math.max(...charLatencies, 0),
      afterEmptyScreen,
      afterEditSnippet,
      afterPasteSnippet,
      acknowledgedSubmission,
      afterSubmitSnippet: afterSubmitSnippet.slice(0, 400),
      afterEscSnippet: afterEscSnippet.slice(0, 400),
      exitedCleanly: exitedCode === 0,
      exitedCode,
      exitDurationMs,
    },
    events,
  };
  console.log('__PTY_REPORT_START__');
  console.log(JSON.stringify(report, null, 2));
  console.log('__PTY_REPORT_END__');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
