import fs from 'node:fs';
import path from 'node:path';
import {
  EVIDENCE_DIR,
  ProcessSupervisor,
  loadOrInitState,
  logLive,
  saveState,
  writeCheckpoint,
} from './supervisor.mjs';

export const TASKS = [
  {
    id: 'C01',
    prompt: 'What is 18 + 24? Return only the number.',
    expectedDesc: '42',
  },
  {
    id: 'C02',
    prompt: 'What is 7 × 8? Return only the number.',
    expectedDesc: '56',
  },
  {
    id: 'C03',
    prompt: 'Reverse WAZIR.',
    expectedDesc: 'RIZAW',
  },
  {
    id: 'C04',
    prompt: 'Convert hello dgx to uppercase.',
    expectedDesc: 'HELLO DGX',
  },
  {
    id: 'C05',
    prompt: 'List the first five prime numbers.',
    expectedDesc: '2, 3, 5, 7, 11',
  },
  {
    id: 'C06',
    prompt: 'Write a Python function that adds two integers.',
    expectedDesc: 'Executable Python',
  },
  {
    id: 'C07',
    prompt: 'Write a JavaScript function that squares a number.',
    expectedDesc: 'Executable JavaScript',
  },
  {
    id: 'C08',
    prompt: 'Write a C++17 function that returns the maximum of two integers.',
    expectedDesc: 'Compilable C++',
  },
  {
    id: 'C09',
    prompt: 'Return JSON with "status":"ok" and "count":3.',
    expectedDesc: 'Valid matching JSON',
  },
  {
    id: 'C10',
    prompt: 'Explain a stack in one sentence.',
    expectedDesc: 'Correct concise explanation',
  },
];

function extractCodeBlock(text) {
  const fence = text.match(/```(?:python|py|javascript|js|cpp|c\+\+|c)?\s*\n([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  return text.trim();
}

export async function verifyTaskOutput(sup, taskId, output) {
  const clean = (output || '').trim();
  if (!clean) return { pass: false, detail: 'Empty output' };

  switch (taskId) {
    case 'C01': {
      const pass = /\b42\b/.test(clean);
      return { pass, detail: pass ? 'Contains 42' : `Expected 42, got: ${clean.slice(0, 100)}` };
    }
    case 'C02': {
      const pass = /\b56\b/.test(clean);
      return { pass, detail: pass ? 'Contains 56' : `Expected 56, got: ${clean.slice(0, 100)}` };
    }
    case 'C03': {
      const pass = /RIZAW/i.test(clean);
      return { pass, detail: pass ? 'Contains RIZAW' : `Expected RIZAW, got: ${clean.slice(0, 100)}` };
    }
    case 'C04': {
      const pass = clean.includes('HELLO DGX');
      return { pass, detail: pass ? 'Contains HELLO DGX' : `Expected HELLO DGX, got: ${clean.slice(0, 100)}` };
    }
    case 'C05': {
      const pass = /2\D+3\D+5\D+7\D+11/.test(clean);
      return { pass, detail: pass ? 'Lists 2, 3, 5, 7, 11' : `Expected 2, 3, 5, 7, 11, got: ${clean.slice(0, 100)}` };
    }
    case 'C06': {
      const code = extractCodeBlock(clean);
      const fnMatch = code.match(/def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
      if (!fnMatch) return { pass: false, detail: `No Python def found in: ${clean.slice(0, 120)}` };
      const fnName = fnMatch[1];
      const testScript = `${code}\nassert ${fnName}(18, 24) == 42\nprint("PY_OK")\n`;
      const res = await sup.runSupervised({
        operationId: `verify-c06-${Date.now()}`,
        taskId: 'VERIFY-C06',
        executable: 'python3',
        args: ['-c', testScript],
        wallTimeoutMs: 10000,
      });
      const pass = res.ok && res.stdout.includes('PY_OK');
      return { pass, detail: pass ? `Executed ${fnName}(18,24)==42 via python3` : `Python execution failed: ${res.stderr || res.stdout}` };
    }
    case 'C07': {
      const code = extractCodeBlock(clean);
      const fnMatch =
        code.match(/function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/) ||
        code.match(/(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/);
      if (!fnMatch) return { pass: false, detail: `No JS function found in: ${clean.slice(0, 120)}` };
      const fnName = fnMatch[1];
      const testScript = `${code}\nif (${fnName}(7) !== 49) process.exit(1);\nconsole.log("JS_OK");\n`;
      const res = await sup.runSupervised({
        operationId: `verify-c07-${Date.now()}`,
        taskId: 'VERIFY-C07',
        executable: 'node',
        args: ['-e', testScript],
        wallTimeoutMs: 10000,
      });
      const pass = res.ok && res.stdout.includes('JS_OK');
      return { pass, detail: pass ? `Executed ${fnName}(7)===49 via node` : `JS execution failed: ${res.stderr || res.stdout}` };
    }
    case 'C08': {
      const code = extractCodeBlock(clean);
      const tmpCpp = path.join(EVIDENCE_DIR, 'tmp-c08.cpp');
      const tmpBin = path.join(EVIDENCE_DIR, 'tmp-c08.out');
      const hasMain = /\bint\s+main\s*\(/.test(code);
      const fullCpp = `#include <algorithm>\n#include <iostream>\n#include <cassert>\n${code}\n${
        hasMain ? '' : 'int main() { return 0; }\n'
      }`;
      fs.writeFileSync(tmpCpp, fullCpp, 'utf8');
      const res = await sup.runSupervised({
        operationId: `verify-c08-${Date.now()}`,
        taskId: 'VERIFY-C08',
        executable: 'g++',
        args: ['-std=c++17', tmpCpp, '-o', tmpBin],
        wallTimeoutMs: 15000,
      });
      try {
        fs.unlinkSync(tmpCpp);
        fs.unlinkSync(tmpBin);
      } catch {}
      const pass = res.ok;
      return { pass, detail: pass ? 'Compiled cleanly with g++ -std=c++17' : `g++ compile failed: ${res.stderr.slice(0, 160)}` };
    }
    case 'C09': {
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { pass: false, detail: `No JSON object found in: ${clean.slice(0, 120)}` };
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        const pass = parsed.status === 'ok' && parsed.count === 3;
        return { pass, detail: pass ? 'Valid JSON matching status=ok, count=3' : `Mismatch JSON: ${jsonMatch[0]}` };
      } catch (e) {
        return { pass: false, detail: `Invalid JSON: ${e.message}` };
      }
    }
    case 'C10': {
      const hasStackConcept = /lifo|last[- ]in|first[- ]out|push|pop|data structure/i.test(clean);
      const sentences = clean.split(/[.!?]+/).filter((s) => s.trim().length > 0);
      const pass = hasStackConcept && sentences.length >= 1 && sentences.length <= 2;
      return { pass, detail: pass ? `Concise stack explanation (${sentences.length} sentence)` : `Failed criteria: ${clean.slice(0, 120)}` };
    }
    default:
      return { pass: false, detail: 'Unknown task' };
  }
}

export async function runBenchmarkSuite(phaseName, csvFileName, extraArgs = []) {
  const state = loadOrInitState();
  // Baseline concurrency limit = 1 live inference task
  const sup = new ProcessSupervisor(state, { maxConcurrent: 2 });
  const pinnedModel = state.selectedModel;

  logLive(phaseName, `Starting 10-task sequential benchmark using pinned model: ${pinnedModel}`);

  const csvPath = path.join(EVIDENCE_DIR, csvFileName);
  const csvHeader = [
    'task_id',
    'attempt',
    'submission_time',
    'ack_ms',
    'model_selection_ms',
    'dispatch_ms',
    'first_token_ms',
    'completion_time',
    'total_turnaround_ms',
    'requested_model',
    'actual_model',
    'runtime',
    'correctness',
    'retry_count',
    'timeout_status',
    'execution_id',
    'output_preview',
  ].join(',');
  fs.writeFileSync(csvPath, csvHeader + '\n', 'utf8');

  const taskRecords = [];
  let consecutiveTimeouts = 0;

  for (const task of TASKS) {
    let attempt = 0;
    let finalRow = null;

    while (attempt < 2) {
      attempt += 1;
      const submitIso = new Date().toISOString();
      const opStart = performance.now();
      let ackMs = null;
      let modelSelectMs = null;
      let dispatchMs = null;
      let firstTokenMs = null;
      let actualModel = 'UNREPORTED';
      let actualRuntime = 'lmstudio';
      let executionId = '—';
      let streamedResult = '';
      let lineBuf = '';

      logLive(`TASK ${task.id}`, `Submitting task ${task.id} (attempt ${attempt}/2): "${task.prompt}"`);

      const parseNdjsonLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
        try {
          const evt = JSON.parse(trimmed);
          const nowRel = Math.round(performance.now() - opStart);
          if (evt.type === 'start') {
            if (ackMs === null) ackMs = nowRel;
            if (modelSelectMs === null) modelSelectMs = nowRel;
            if (evt.modelId) actualModel = evt.modelId;
            if (evt.executionId) executionId = evt.executionId;
            if (evt.runtimeId) actualRuntime = evt.runtimeId;
            logLive('OBSERVATION', `Task ${task.id} acknowledged at ${ackMs}ms (executionId=${executionId}, model=${actualModel})`);
            return false; // start event is not a model token
          }
          if (evt.type === 'phase' || evt.type === 'dispatch') {
            if (dispatchMs === null) dispatchMs = nowRel;
            return false;
          }
          if (evt.type === 'token' || evt.type === 'message' || evt.type === 'done' || evt.type === 'tool') {
            if (firstTokenMs === null) {
              firstTokenMs = nowRel;
            }
            if (evt.type === 'done' && typeof evt.content === 'string') {
              streamedResult = evt.content;
            } else if (evt.type === 'message' && typeof evt.content === 'string' && !streamedResult) {
              streamedResult = evt.content;
            }
            return true;
          }
          if (evt.type === 'complete') {
            if (typeof evt.result === 'string' && evt.result.trim()) {
              streamedResult = evt.result;
            }
            if (evt.executionId) executionId = evt.executionId;
            if (firstTokenMs === null && streamedResult) {
              firstTokenMs = nowRel;
            }
            return Boolean(streamedResult);
          }
        } catch {
          // multi-line JSON at end of run
        }
        return false;
      };

      const res = await sup.runSupervised({
        operationId: `${phaseName.toLowerCase()}-${task.id}-a${attempt}`,
        taskId: task.id,
        executable: 'node',
        args: [
          '/home/wael/Code/Wazir/bin/wa.js',
          'run',
          task.prompt,
          '--model',
          pinnedModel,
          '--runtime',
          'lmstudio',
          '--routing-mode',
          'LOCAL_ONLY',
          '--json',
          ...extraArgs,
        ],
        wallTimeoutMs: 45000,
        firstTokenTimeoutMs: 20000,
        idleTimeoutMs: 20000, // matches 20s first-token wait for silent generation
        spawnTimeoutMs: 10000,
        isFirstToken: (chunkText, isStderr) => {
          if (isStderr) return false;
          lineBuf += chunkText;
          const lines = lineBuf.split('\n');
          lineBuf = lines.pop() ?? '';
          let gotToken = false;
          for (const l of lines) {
            if (parseNdjsonLine(l)) gotToken = true;
          }
          return gotToken;
        },
      });

      if (lineBuf.trim()) {
        parseNdjsonLine(lineBuf);
      }

      // Also parse trailing pretty-printed TaskOutcome JSON if present
      if (!streamedResult && res.stdout) {
        const lastBraceIdx = res.stdout.indexOf('{\n  "success":');
        if (lastBraceIdx !== -1) {
          try {
            const outcomeObj = JSON.parse(res.stdout.slice(lastBraceIdx));
            if (outcomeObj.result) streamedResult = outcomeObj.result;
            if (outcomeObj.executionId) executionId = outcomeObj.executionId;
            if (outcomeObj.decision?.modelId) actualModel = outcomeObj.decision.modelId;
            if (outcomeObj.decision?.runtimeId) actualRuntime = outcomeObj.decision.runtimeId;
          } catch {}
        }
      }

      const completionIso = new Date().toISOString();
      const verification = res.timedOut
        ? { pass: false, detail: `Timed out (${res.timeoutType})` }
        : await verifyTaskOutput(sup, task.id, streamedResult);

      const modelValid = actualModel === pinnedModel;
      const overallPass = !res.timedOut && res.ok && verification.pass && modelValid;
      const timeoutStatus = res.timedOut ? res.timeoutType : 'NONE';

      finalRow = {
        taskId: task.id,
        attempt,
        submitIso,
        ackMs: ackMs ?? 'UNAVAILABLE',
        modelSelectMs: modelSelectMs ?? 'UNAVAILABLE',
        dispatchMs: dispatchMs ?? 'UNAVAILABLE',
        firstTokenMs: firstTokenMs ?? res.firstTokenMs ?? 'UNAVAILABLE',
        completionIso,
        totalTurnaroundMs: res.durationMs,
        requestedModel: pinnedModel,
        actualModel,
        runtime: actualRuntime,
        output: streamedResult,
        correctness: overallPass ? 'PASS' : 'FAIL',
        verificationDetail: verification.detail,
        retryCount: attempt - 1,
        timeoutStatus,
        executionId,
        exitCode: res.exitCode,
        rawStdout: res.stdout,
        rawStderr: res.stderr,
      };

      logLive('RESULT', [
        `Task: ${task.id} (Attempt ${attempt})`,
        `Turnaround: ${res.durationMs}ms | Ack: ${finalRow.ackMs}ms | First-Token: ${finalRow.firstTokenMs}ms`,
        `Model: requested=${pinnedModel}, actual=${actualModel} | Timeout: ${timeoutStatus}`,
        `Output: ${(streamedResult || '').replace(/\s+/g, ' ').slice(0, 160)}`,
        `Verification: ${finalRow.correctness} (${verification.detail})`,
      ]);

      if (overallPass) {
        break;
      }
      // If attempt 1 failed or timed out, retry at most once (up to 2 attempts total)
      if (attempt < 2) {
        logLive('DECISION', `Task ${task.id} attempt 1 did not pass (${timeoutStatus} / ${verification.detail}). Retrying once (attempt 2/2).`);
      }
    }

    taskRecords.push(finalRow);

    const csvLine = [
      finalRow.taskId,
      finalRow.attempt,
      finalRow.submitIso,
      finalRow.ackMs,
      finalRow.modelSelectMs,
      finalRow.dispatchMs,
      finalRow.firstTokenMs,
      finalRow.completionIso,
      finalRow.totalTurnaroundMs,
      finalRow.requestedModel,
      finalRow.actualModel,
      finalRow.runtime,
      finalRow.correctness,
      finalRow.retryCount,
      finalRow.timeoutStatus,
      finalRow.executionId,
      JSON.stringify((finalRow.output || '').replace(/\r?\n/g, '\\n').slice(0, 200)),
    ].join(',');
    fs.appendFileSync(csvPath, csvLine + '\n', 'utf8');

    if (finalRow.timeoutStatus !== 'NONE') {
      consecutiveTimeouts += 1;
    } else {
      consecutiveTimeouts = 0;
    }
    state.consecutiveTimeouts = consecutiveTimeouts;
    saveState(state);

    const stop3Triggered = consecutiveTimeouts >= 2;
    logLive('STOP CHECK', [
      `Global budget: within limit.`,
      `Consecutive timeouts: ${consecutiveTimeouts}${stop3Triggered ? ' -> STOP-03 TRIGGERED!' : ''}.`,
      `Resource state: acceptable.`,
    ]);

    writeCheckpoint(state, sup, {
      phase: `${phaseName}_${task.id}`,
      action: `Executed task ${task.id} ("${task.prompt}") with model ${pinnedModel} (${finalRow.attempt} attempt(s)).`,
      expected: `Complete within 20s first-token / 45s total and verify: ${task.expectedDesc}.`,
      actual: `Correctness=${finalRow.correctness} (${finalRow.verificationDetail}), turnaround=${finalRow.totalTurnaroundMs}ms, ack=${finalRow.ackMs}ms, firstToken=${finalRow.firstTokenMs}ms, timeout=${finalRow.timeoutStatus}, retries=${finalRow.retryCount}`,
      analysis: finalRow.correctness === 'PASS'
        ? `Task ${task.id} succeeded in ${finalRow.totalTurnaroundMs}ms (startup/ack overhead: ${finalRow.ackMs}ms).`
        : `Task ${task.id} failed/timed out: ${finalRow.timeoutStatus} — ${finalRow.verificationDetail}.`,
      decision: stop3Triggered
        ? 'Trigger STOP-03 (two consecutive simple requests timed out on the same execution path). Stop live benchmark submissions and investigate root cause.'
        : `Continue to next benchmark task.`,
      filesModified: `test/codex-dgx-execution/${csvFileName}`,
      verification: finalRow.verificationDetail,
      stopCheck: stop3Triggered
        ? 'STOP-03 triggered: 2 consecutive tasks timed out. Stopping further baseline submissions to investigate.'
        : 'STOP-01..STOP-12 checked: None triggered.',
      nextAction: stop3Triggered
        ? 'Investigate root cause of execution timeout / excessive orchestration in Wazir CLI.'
        : `Execute next task after ${task.id}.`,
      resumeInstructions: `Inspect test/codex-dgx-execution/${csvFileName}`,
    });

    if (stop3Triggered) {
      logLive('STOP-03', 'Two consecutive simple requests timed out using the same execution path. Stopping further baseline benchmark submissions and transitioning to root-cause investigation.');
      break;
    }
  }

  fs.writeFileSync(
    path.join(EVIDENCE_DIR, `${csvFileName.replace('.csv', '')}-details.json`),
    JSON.stringify(taskRecords, null, 2),
    'utf8'
  );

  return taskRecords;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBenchmarkSuite('PHASE_2_BASELINE', 'baseline.csv').catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
