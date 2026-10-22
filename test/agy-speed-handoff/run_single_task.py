#!/usr/bin/env python3
import subprocess, sys, time, json, os, datetime, re

base = os.path.expanduser("~/Code/Wazir/test/agy-speed-handoff")

def write_atomic(path, content):
    tmp = path + ".tmp." + str(os.getpid())
    with open(tmp, "w") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)

def append_fsync(path, content):
    with open(path, "a") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())

def verify_output(task_id, text, success):
    t = text.strip()
    if task_id == "E01":
        ok = bool(re.search(r'\b30\b', t))
    elif task_id == "E02":
        ok = bool(re.search(r'\b63\b', t))
    elif task_id == "E03":
        ok = "RIZAW" in t
    elif task_id == "E04":
        ok = "HELLO WORLD" in t
    elif task_id == "E05":
        ok = all(x in t for x in ["2", "3", "5", "7", "11"])
    elif task_id == "E06":
        ok = "def " in t and ("return" in t or "math.factorial" in t)
    elif task_id == "E07":
        ok = ("function" in t or "=>" in t or "Set" in t)
    elif task_id == "E08":
        ok = ("int" in t and ("return" in t or "std::max" in t))
    elif task_id == "E09":
        ok = ("status" in t and "ok" in t and "count" in t and "10" in t)
    elif task_id == "E10":
        ok = any(w in t.lower() for w in ["fifo", "first-in", "first in", "order", "elements", "enqueue", "front"])
    else:
        ok = len(t) > 0
    return bool(ok and success)

def main():
    run_id = sys.argv[1]
    phase = sys.argv[2]
    concurrency = int(sys.argv[3])
    task_id = sys.argv[4]
    prompt = sys.argv[5]
    cp_id = sys.argv[6]
    next_task_id = sys.argv[7]
    next_prompt = sys.argv[8]
    model = sys.argv[9] if len(sys.argv) > 9 else "gemma-4-26b-a4b-it-qat"
    extra_args = sys.argv[10:] if len(sys.argv) > 10 else []

    cmd = ["wa", "--no-banner", "run", "--model", model, "--json"] + extra_args + [prompt]
    t0 = time.perf_counter()
    now_ms = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]
    append_fsync(os.path.join(base, "execution-live.log"), f"[{now_ms}] AGY | TASK {task_id} | Submitted prompt: {prompt!r}\n")
    print(f"[{now_ms}] AGY | TASK {task_id} | Submitted prompt: {prompt!r}", flush=True)

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    ack_ms = (time.perf_counter() - t0) * 1000.0

    events = []
    raw_lines = []
    dispatch_ms = None
    first_token_ms = None
    completion_ms = None
    model_messages = []
    phases = []
    tools_run = []
    errors = []
    exec_id = "unknown"

    for line in proc.stdout:
        t_ev = (time.perf_counter() - t0) * 1000.0
        raw_lines.append(line)
        s = line.strip()
        if s.startswith("{") and s.endswith("}"):
            try:
                obj = json.loads(s)
                ev_type = obj.get("type")
                events.append({"t_ms": round(t_ev, 2), "event": obj})
                if ev_type == "start":
                    dispatch_ms = t_ev
                    exec_id = obj.get("executionId", exec_id)
                    ts = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]
                    print(f"[{ts}] AGY | DISPATCH | {task_id} ({exec_id}) accepted at {dispatch_ms:.1f}ms", flush=True)
                elif ev_type == "phase":
                    phases.append({"phase": obj.get("phase"), "t_ms": round(t_ev, 2)})
                elif ev_type in ("message", "done"):
                    c = obj.get("content", "")
                    if not c.startswith("runtime.protocol.") and not c.startswith("tool_surface.compiled:"):
                        if first_token_ms is None:
                            first_token_ms = t_ev
                        model_messages.append(c)
                elif ev_type == "tool":
                    tools_run.append({"tool": obj.get("tool"), "durationMs": obj.get("durationMs"), "ok": obj.get("ok"), "t_ms": round(t_ev, 2)})
                elif ev_type == "error":
                    errors.append(obj.get("error", ""))
                elif ev_type == "complete":
                    completion_ms = t_ev
            except Exception:
                pass

    stderr_data = proc.stderr.read()
    ret = proc.wait()
    total_ms = (time.perf_counter() - t0) * 1000.0
    if dispatch_ms is None:
        dispatch_ms = total_ms
    if first_token_ms is None:
        first_token_ms = completion_ms or total_ms
    if completion_ms is None:
        completion_ms = total_ms

    # Try to parse trailing multi-line JSON summary if any
    full_stdout = "".join(raw_lines)
    cli_success = (ret == 0)
    combined_msg = "\n".join(model_messages)
    # Also check if final json has output/response/answer
    try:
        idx = full_stdout.find("\n{\n")
        if idx != -1:
            summary_obj = json.loads(full_stdout[idx+1:])
            if summary_obj.get("output"):
                combined_msg += "\n" + str(summary_obj.get("output"))
            if summary_obj.get("response"):
                combined_msg += "\n" + str(summary_obj.get("response"))
    except Exception:
        pass

    is_correct = verify_output(task_id, combined_msg, cli_success)
    now_iso = datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(timespec="seconds")
    now_ms2 = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]

    note = f"exit={ret} phases={[p['phase'] for p in phases]} tools={[t['tool'] for t in tools_run]} errors={errors} msg_preview={combined_msg[:120]!r}".replace('"', "'").replace("\n", " ")
    csv_row = f'{run_id},{phase},{concurrency},{task_id},"{prompt.replace(chr(34), chr(39))}",{model},lmstudio,{ack_ms:.2f},{dispatch_ms:.2f},{first_token_ms:.2f},{completion_ms:.2f},{total_ms:.2f},{str(is_correct).lower()},"{note}",{now_iso}\n'
    append_fsync(os.path.join(base, "benchmark-results.csv"), csv_row)

    trace_obj = {
        "run_id": run_id,
        "phase": phase,
        "concurrency": concurrency,
        "task_id": task_id,
        "prompt": prompt,
        "model": model,
        "runtime": "lmstudio",
        "executionId": exec_id,
        "ack_ms": round(ack_ms, 2),
        "dispatch_ms": round(dispatch_ms, 2),
        "first_token_ms": round(first_token_ms, 2),
        "completion_ms": round(completion_ms, 2),
        "total_turnaround_ms": round(total_ms, 2),
        "exit_code": ret,
        "cli_success": cli_success,
        "correct": is_correct,
        "phases": phases,
        "tools_run": tools_run,
        "model_messages": model_messages,
        "errors": errors,
        "events": events,
        "timestamp": now_iso
    }
    append_fsync(os.path.join(base, "execution-traces.jsonl"), json.dumps(trace_obj) + "\n")

    if cp_id != "NONE":
        cp_content = f"""# AGY Handoff Checkpoint

Checkpoint ID: {cp_id}
Timestamp: {now_iso}
Current phase: Phase 3 — {phase} Benchmark (Task {task_id})
Repository: /home/wael/Code/Wazir
Git branch: improve/gemini-execution-integrity
Git commit: 6a6fb8b5d241673c48cb6e5384b5ce70429c868a
Wazir version: 0.2.5

## Objective
Execute benchmark task {task_id} (`{prompt}`) on model `{model}` (`lmstudio`), capture stage latencies and correctness, and persist handoff state.

## Action Taken
Executed `{' '.join(cmd)}` and instrumented NDJSON event stream timestamps.

## Observed Result
- **Execution ID:** `{exec_id}`
- **Ack Time:** {ack_ms:.2f} ms
- **Dispatch (`start` event):** {dispatch_ms:.2f} ms
- **First Model Message Time:** {first_token_ms:.2f} ms
- **Completion Event Time:** {completion_ms:.2f} ms
- **Total Turnaround:** {total_ms:.2f} ms
- **Exit Code / CLI Success:** `{ret}` (`{cli_success}`)
- **Phases Executed:** `{json.dumps(phases)}`
- **Tools Executed:** `{json.dumps(tools_run)}`
- **Model Messages:** `{json.dumps(model_messages)}`
- **Errors:** `{json.dumps(errors)}`
- **Verified Correctness:** `{is_correct}`

## Engineering Analysis
- Pre-execution bootstrap/discovery took {dispatch_ms:.2f} ms before `start` event.
- Model/orchestration phases took {completion_ms - dispatch_ms:.2f} ms across `{[p['phase'] for p in phases]}`.
- Verification tools took {sum(t.get('durationMs', 0) or 0 for t in tools_run)} ms.

## Decision
Persist Task {task_id} telemetry to `benchmark-results.csv` and `execution-traces.jsonl` and advance immediately to `{next_task_id}`.

## Files Modified
- `test/agy-speed-handoff/benchmark-results.csv` (Appended {task_id})
- `test/agy-speed-handoff/execution-traces.jsonl` (Appended {task_id} trace)
- `test/agy-speed-handoff/checkpoints/{cp_id}.md` (Created)
- `test/agy-speed-handoff/handoff-history.md` (Appended {cp_id})
- `test/agy-speed-handoff/HANDOFF.md` (Atomically updated)
- `test/agy-speed-handoff/execution-live.log` (Logged {task_id})

## Verification
Output verified (`correct={is_correct}`, `cli_success={cli_success}`).

## Outstanding Issues
- Same systemic orchestration/planning/verification bottlenecks observed on non-file-mutating tasks.

## Immediate Next Action
{f'Execute benchmark task {next_task_id} (`{next_prompt}`)' if next_task_id != 'DONE' else 'Proceed to next benchmark phase.'}

## Resume Command
`python3 ~/Code/Wazir/test/agy-speed-handoff/run_single_task.py {run_id} {phase} {concurrency} {next_task_id} "{next_prompt}" ...`

## Recovery Notes
All files flushed with `os.fsync`. Safe to resume directly at `{next_task_id}`.
"""
        write_atomic(os.path.join(base, f"checkpoints/{cp_id}.md"), cp_content)
        write_atomic(os.path.join(base, "HANDOFF.md"), cp_content)
        append_fsync(os.path.join(base, "handoff-history.md"), f"""
## [{cp_id}] — {now_iso}
- **Phase:** {phase} Benchmark (Task {task_id})
- **Action:** Executed `{task_id}` (`{prompt}`) via `wa run --model {model} --json`.
- **Result:** Turnaround={total_ms:.2f}ms (ack={ack_ms:.2f}ms, dispatch={dispatch_ms:.2f}ms, first_msg={first_token_ms:.2f}ms, exit={ret}, correct={is_correct}).
- **Decision:** Recorded metrics and checkpointed `{cp_id}`.
- **Next Action:** Proceed to `{next_task_id}`.
""")
    status_str = "PASS" if is_correct else f"FAIL (exit {ret})"
    log_block = (
        f"[{now_ms2}] AGY | DISPATCH | {task_id} accepted at {dispatch_ms:.2f}ms\n"
        f"[{now_ms2}] AGY | OUTPUT | {task_id} msg={combined_msg[:80]!r} errors={errors}\n"
        f"[{now_ms2}] AGY | VERIFY | {status_str} in {total_ms:.2f}ms\n"
        f"[{now_ms2}] AGY | HANDOFF | Checkpoint {cp_id} written\n"
        f"[{now_ms2}] AGY | NEXT | Starting {next_task_id}\n"
    )
    append_fsync(os.path.join(base, "execution-live.log"), log_block)
    print(log_block, end="", flush=True)

if __name__ == "__main__":
    main()
