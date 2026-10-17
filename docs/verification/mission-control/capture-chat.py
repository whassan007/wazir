"""Capture the installed conversation-first `wa chat` through a real PTY."""

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

label, executable, cols, rows = sys.argv[1:5]
cols, rows = int(cols), int(rows)
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.environ["COLORTERM"] = "truecolor"
    os.execv(executable, [executable, "chat"])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
data = bytearray()
deadline = time.time() + 2
while time.time() < deadline:
    if select.select([fd], [], [], 0.05)[0]:
        try:
            data.extend(os.read(fd, 65536))
        except OSError:
            break

path = os.path.join(os.path.dirname(__file__), label + ".ansi")
with open(path, "wb") as capture:
    capture.write(data)

try:
    os.write(fd, b"/exit\r")
except OSError:
    pass
deadline = time.time() + 3
while time.time() < deadline:
    if select.select([fd], [], [], 0.05)[0]:
        try:
            data.extend(os.read(fd, 65536))
        except OSError:
            break
    try:
        waited, _ = os.waitpid(pid, os.WNOHANG)
        if waited:
            break
    except ChildProcessError:
        break
else:
    os.kill(pid, signal.SIGTERM)
    os.waitpid(pid, 0)
print(path)
