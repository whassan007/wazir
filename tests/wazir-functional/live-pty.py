#!/usr/bin/env python3
"""Drive one or more real `wa chat` prompts through a PTY and retain raw output."""
import argparse
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--transcript", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command and args.command[0] == "--":
        args.command = args.command[1:]
    if not args.command:
        parser.error("a command is required after --")
    spec = json.load(open(args.spec, encoding="utf-8"))
    prompts = spec["prompts"]
    rows, cols = int(spec.get("rows", 45)), int(spec.get("cols", 160))
    env = os.environ.copy()
    env.update(spec.get("env", {}))
    master, slave = pty.openpty()
    size = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(master, termios.TIOCSWINSZ, size)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, size)
    proc = subprocess.Popen(args.command, stdin=slave, stdout=slave, stderr=slave,
                            cwd=spec.get("cwd"), env=env, start_new_session=True,
                            close_fds=True)
    os.close(slave)
    output = bytearray()
    state = {"pid": proc.pid, "exit_code": None, "signal": None, "killed": False}
    results = []

    def pump(seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], min(0.1, deadline - time.monotonic()))
            if ready:
                try:
                    chunk = os.read(master, 65536)
                    if not chunk:
                        break
                    output.extend(chunk)
                except OSError:
                    break
            poll()

    def poll():
        code = proc.poll()
        if code is not None:
            state["exit_code"] = code if code >= 0 else None
            if code < 0:
                state["signal"] = signal.Signals(-code).name

    def wait_for(predicate, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pump(min(0.1, deadline - time.monotonic()))
            if predicate(output.decode("utf-8", "replace")):
                return True
            if proc.poll() is not None:
                return predicate(output.decode("utf-8", "replace"))
        return predicate(output.decode("utf-8", "replace"))

    try:
        ready = wait_for(lambda s: "Enter to send" in s, float(spec.get("startup_timeout", 45)))
        results.append({"step": "startup", "ok": ready})
        previous_ids = set()
        for index, item in enumerate(prompts, 1):
            before = output.decode("utf-8", "replace")
            before_ids = set(re.findall(r"Job (job-[a-zA-Z0-9-]+)", before))
            # The terminal UI treats a bare Enter as submit; backslash+Enter
            # inserts a literal newline while preserving the user's prompt.
            payload = item["prompt"].replace("\n", "\\\r") + "\r"
            os.write(master, payload.encode("utf-8"))
            timeout = float(item.get("timeout", spec.get("job_timeout", 180)))
            auto_approve = bool(item.get("auto_approve", spec.get("auto_approve", False)))
            holder = {"job_id": None, "approved_count": 0, "last_approve_len": 0}

            def terminal(screen):
                all_ids = re.findall(r"Job (job-[a-zA-Z0-9-]+)", screen)
                holder["job_id"] = next((x for x in reversed(all_ids) if x not in before_ids), None)
                job_id = holder["job_id"]
                if auto_approve and len(screen) > holder["last_approve_len"]:
                    tail = screen[holder["last_approve_len"]:]
                    if "A approve · D deny" in tail or "Waiting for approval:" in tail:
                        holder["last_approve_len"] = len(screen)
                        holder["approved_count"] += 1
                        os.write(master, b"a")
                if not job_id:
                    return False
                return (f"Job {job_id} completed!" in screen or f"Job {job_id} failed" in screen)

            finished = wait_for(terminal, timeout)
            screen = output.decode("utf-8", "replace")
            job_id = holder["job_id"]
            outcome = None
            if job_id and f"Job {job_id} completed!" in screen:
                outcome = "completed"
            elif job_id and f"Job {job_id} failed" in screen:
                outcome = "failed"
            results.append({"step": index, "prompt": item["prompt"], "job_id": job_id,
                            "outcome": outcome, "finished_marker_seen": finished,
                            "approved_count": holder["approved_count"],
                            "ok": bool(finished and outcome)})
            if index < len(prompts):
                pump(float(spec.get("between_prompts_seconds", 1)))
        os.write(master, b"/exit\r")
        wait_for(lambda _s: proc.poll() is not None, float(spec.get("exit_timeout", 20)))
    finally:
        pump(0.3)
        poll()
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
                state["killed"] = True
            except ProcessLookupError:
                pass
            proc.wait(timeout=5)
            poll()
        try:
            os.close(master)
        except OSError:
            pass
        with open(args.transcript, "wb") as stream:
            stream.write(output)
        summary = {**state, "steps": results, "output_bytes": len(output),
                   "transcript": args.transcript}
        with open(args.summary, "w", encoding="utf-8") as stream:
            json.dump(summary, stream, indent=2)
            stream.write("\n")
        print(json.dumps(summary))


if __name__ == "__main__":
    main()
