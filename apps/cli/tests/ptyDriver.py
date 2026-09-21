#!/usr/bin/env python3
"""PTY driver for realistic terminal tests (stdlib only, no dependencies).

Spawns a command under a real pseudo-terminal, executes a scripted sequence
of steps, and prints a single JSON result on stdout:

  {
    "exitCode":    int|null,   # process exit status, or null if signalled/killed
    "signalName":  str|null,   # e.g. "SIGINT" when the process died by signal
    "killed":      bool,       # true if the driver had to SIGKILL a live child
    "steps":       [{"op":..., "ok":bool, "detail":str?}],
    "outputBytes": int,        # total bytes rendered on the PTY
    "outputTail":  str         # last 32KB of PTY output (lossy utf-8)
  }

Usage:
  ptyDriver.py --json '<script>' -- <cmd> [args...]

Script fields:
  cols, rows        initial PTY window size (default 200x50)
  cwd               child working directory (default: driver cwd)
  env               extra environment variables merged over the parent env
  stepTimeout       default seconds for wait/exit steps (default 30)
  steps             ordered step list:
    {"op":"wait","text":str,"timeout"?:sec}   wait until text appears on the PTY
    {"op":"send","data":str,"delayMs"?:int}   write raw bytes to the PTY
    {"op":"resize","cols":int,"rows":int}     TIOCSWINSZ on the master
    {"op":"signal","name":"SIGINT"|...}       real signal(2) to the child PID
    {"op":"closemaster"}                      close the PTY master (terminal dies)
    {"op":"sleep","ms":int}                   wait
    {"op":"exit","timeout"?:sec,"expectCode"?:int}  wait for the child to exit
"""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

WINDOW = 262_144  # bytes of tail window kept for needle search


def emit(obj):
    print(json.dumps(obj))


def fail(msg):
    emit({"error": msg})
    sys.exit(1)


def main():
    argv = sys.argv[1:]
    if len(argv) < 3 or argv[0] != "--json" or argv[2] != "--":
        fail("usage: ptyDriver.py --json '<script>' -- <cmd> [args...]")
    try:
        script = json.loads(argv[1])
    except Exception as e:  # noqa: BLE001
        fail(f"bad script: {e}")
    cmd = argv[3:]
    if not cmd:
        fail("no command")

    cols = int(script.get("cols", 200))
    rows = int(script.get("rows", 50))
    cwd = script.get("cwd")
    extra_env = dict(script.get("env") or {})
    default_timeout = float(script.get("stepTimeout", 30))
    steps = script.get("steps") or []

    master, slave = pty.openpty()
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(master, termios.TIOCSWINSZ, winsize)
    try:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, winsize)
    except OSError:
        pass

    env = dict(os.environ)
    env.update(extra_env)

    pid = os.fork()
    if pid == 0:  # child
        os.close(master)
        try:
            os.setsid()
            os.dup2(slave, 0)
            os.dup2(slave, 1)
            os.dup2(slave, 2)
            if slave > 2:
                os.close(slave)
            if cwd:
                os.chdir(cwd)
            os.execvpe(cmd[0], cmd, env)
        except Exception as e:  # noqa: BLE001
            try:
                os.write(2, ("ptyDriver child exec failed: %s\n" % e).encode())
            except OSError:
                pass
            os._exit(127)

    os.close(slave)

    buf = bytearray()
    state = {"alive": True, "exitCode": None, "signalName": None, "killed": False}
    results = []

    def reap():
        if not state["alive"]:
            return
        try:
            p, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            state["alive"] = False
            return
        if p == pid:
            state["alive"] = False
            if os.WIFEXITED(status):
                state["exitCode"] = os.WEXITSTATUS(status)
            elif os.WIFSIGNALED(status):
                state["signalName"] = signal.Signals(os.WTERMSIG(status)).name

    def read_chunk():
        try:
            r, _, _ = select.select([master], [], [], 0.05)
        except (OSError, ValueError):
            # master closed by a closemaster step
            return False
        if not r:
            return False
        try:
            data = os.read(master, 65536)
        except OSError:
            return False
        if not data:
            return False
        buf.extend(data)
        if len(buf) > 1_048_576:  # keep memory bounded; tail window is far smaller
            del buf[:-1_000_000]
        return True

    def needle_in(needle):
        return needle.encode("utf-8") in bytes(buf[-WINDOW:])

    def pump_until(needle, timeout):
        deadline = time.time() + timeout
        while True:
            reap()
            read_chunk()
            if needle and needle_in(needle):
                return True
            if not state["alive"]:
                end = time.time() + 0.4
                while time.time() < end:
                    if not read_chunk():
                        break
                return bool(needle and needle_in(needle))
            if time.time() >= deadline:
                return bool(needle) and needle_in(needle)

    for step in steps:
        op = step.get("op")
        rec = {"op": op}
        try:
            if op == "wait":
                text = step.get("text", "")
                ok = pump_until(text, float(step.get("timeout", default_timeout)))
                rec["detail"] = "found=%s needle=%r" % (ok, text)
                rec["ok"] = ok
            elif op == "send":
                os.write(master, step.get("data", "").encode("utf-8"))
                delay = int(step.get("delayMs", 0))
                if delay:
                    time.sleep(delay / 1000.0)
            elif op == "resize":
                ws = struct.pack("HHHH", int(step["rows"]), int(step["cols"]), 0, 0)
                fcntl.ioctl(master, termios.TIOCSWINSZ, ws)
                time.sleep(0.2)
                read_chunk()
            elif op == "signal":
                name = step.get("name", "SIGINT").upper()
                if not name.startswith("SIG"):
                    name = "SIG" + name
                sig = getattr(signal, name)
                if not state["alive"]:
                    rec["detail"] = "child already exited"
                else:
                    os.kill(pid, sig)
                    time.sleep(0.3)
            elif op == "closemaster":
                # Kill the terminal itself: the child's stdin hits EOF and its
                # stdout writes fail (EIO). Graceful apps notice the dead terminal
                # and exit on their own; hung ones get SIGKILLed below and report
                # killed=true.
                try:
                    os.close(master)
                except OSError:
                    pass
            elif op == "sleep":
                time.sleep(int(step.get("ms", 0)) / 1000.0)
            elif op == "exit":
                timeout = float(step.get("timeout", default_timeout))
                deadline = time.time() + timeout
                while state["alive"] and time.time() < deadline:
                    reap()
                    read_chunk()
                time.sleep(0.2)
                read_chunk()
                reap()
                expect = step.get("expectCode")
                rec["detail"] = "exitCode=%s signal=%s" % (state["exitCode"], state["signalName"])
                if expect is not None and state["exitCode"] != expect:
                    rec["ok"] = False
                    rec["detail"] += " (expected exitCode=%s)" % expect
            else:
                fail("unknown op %r" % op)
        except Exception as e:  # noqa: BLE001
            rec["ok"] = False
            rec["detail"] = "error: %s" % e
        rec.setdefault("ok", True)
        results.append(rec)

    if state["alive"]:
        try:
            os.kill(pid, signal.SIGKILL)
            state["killed"] = True
        except ProcessLookupError:
            pass
        time.sleep(0.1)
    reap()

    try:
        os.close(master)
    except OSError:
        pass

    emit(
        {
            "exitCode": state["exitCode"],
            "signalName": state["signalName"],
            "killed": state["killed"],
            "steps": results,
            "outputBytes": len(buf),
            "outputTail": bytes(buf[-32768:]).decode("utf-8", "replace"),
        }
    )


if __name__ == "__main__":
    main()
