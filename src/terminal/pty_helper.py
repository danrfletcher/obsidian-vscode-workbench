#!/usr/bin/env python3
"""PTY helper for the VS Code Workbench terminal drawer.

Starts one shell on a pseudo-terminal and relays it over this process's stdin and
stdout pipes (the plugin opens no socket). Only the Python standard library is used.

Frames (a type byte, a 4-byte big-endian length, then the payload); see
src/terminal/pty-protocol.ts, which implements the same format:

  plugin -> helper   "I"  input bytes for the shell
                     "W"  resize: rows (uint16 BE), cols (uint16 BE)
  helper -> plugin   "O"  output bytes from the shell
                     "X"  the shell exited: exit code (int32 BE; minus the signal number)

When the plugin goes away (stdin closes) or this process is told to stop, the shell's
whole session is hung up and killed, so nothing is left behind.
"""
import argparse
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

MAX_PAYLOAD = 1 << 20
READ_SIZE = 65536


class Terminate(Exception):
    """Raised from a signal handler: the plugin asked this helper to stop."""


def _on_signal(signum, frame):
    raise Terminate()


def send_frame(kind, payload):
    data = struct.pack(">cI", kind, len(payload)) + payload
    view = memoryview(data)
    while len(view):
        try:
            n = os.write(1, view)
        except InterruptedError:
            continue
        view = view[n:]


class Decoder(object):
    def __init__(self):
        self.buf = bytearray()

    def push(self, chunk):
        self.buf += chunk
        frames = []
        while len(self.buf) >= 5:
            kind = bytes(self.buf[0:1])
            (length,) = struct.unpack(">I", bytes(self.buf[1:5]))
            if length > MAX_PAYLOAD:
                raise ValueError("frame too long: %d" % length)
            if len(self.buf) < 5 + length:
                break
            frames.append((kind, bytes(self.buf[5:5 + length])))
            del self.buf[:5 + length]
        return frames


def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def reap(pid, block):
    """Exit code of the child (minus the signal number if signalled), or None if it still runs."""
    try:
        done, status = os.waitpid(pid, 0 if block else os.WNOHANG)
    except ChildProcessError:
        return 0
    if done == 0:
        return None
    if os.WIFSIGNALED(status):
        return -os.WTERMSIG(status)
    return os.WEXITSTATUS(status)


def descendants(pid):
    """Every process under `pid` (jobs the shell started can leave its process group)."""
    try:
        out = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5).stdout.decode("ascii", "replace")
    except Exception:
        return []
    children = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            children.setdefault(int(parts[1]), []).append(int(parts[0]))
    found, queue = [], [pid]
    while queue:
        for child in children.get(queue.pop(0), []):
            found.append(child)
            queue.append(child)
    return found


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def stop_child(pid):
    """Hang up the shell's session and everything under it, then kill what ignores that. Returns the shell's exit code once it is reaped."""
    tree = descendants(pid)
    code = None
    for sig, wait in ((signal.SIGHUP, 1.0), (signal.SIGKILL, 2.0)):
        try:
            os.killpg(pid, sig)
        except OSError:
            try:
                os.kill(pid, sig)
            except OSError:
                pass
        for p in tree:
            if alive(p):
                try:
                    os.kill(p, sig)
                except OSError:
                    pass
        deadline = time.time() + wait
        while time.time() < deadline:
            if code is None:
                code = reap(pid, False)
            if code is not None and not any(alive(p) for p in tree):
                return code
            time.sleep(0.02)
    return code


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--shell", required=True)
    parser.add_argument("--rows", type=int, default=24)
    parser.add_argument("--cols", type=int, default=80)
    parser.add_argument("--login", action="store_true")
    args = parser.parse_args()
    rows = max(1, min(args.rows, 0xFFFF))
    cols = max(1, min(args.cols, 0xFFFF))

    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, _on_signal)

    pid, master = pty.fork()
    if pid == 0:
        # The shell: a session leader on the slave side of the pseudo-terminal.
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        signal.signal(signal.SIGHUP, signal.SIG_DFL)
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        try:
            os.chdir(args.cwd)
        except OSError as e:
            os.write(2, ("cannot start in %s: %s\r\n" % (args.cwd, e.strerror)).encode("utf-8", "replace"))
            os._exit(126)
        try:
            set_size(0, rows, cols)
        except OSError:
            pass
        argv = [args.shell] + (["-l"] if args.login else [])
        try:
            os.execv(args.shell, argv)
        except OSError as e:
            os.write(2, ("cannot run %s: %s\r\n" % (args.shell, e.strerror)).encode("utf-8", "replace"))
            os._exit(127)

    flags = fcntl.fcntl(master, fcntl.F_GETFL)
    fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)
    decoder = Decoder()
    to_shell = bytearray()
    code = None
    try:
        while True:
            want_write = [master] if to_shell else []
            try:
                readable, writable, _ = select.select([0, master], want_write, [], 0.25)
            except InterruptedError:
                continue

            if master in readable:
                try:
                    data = os.read(master, READ_SIZE)
                except BlockingIOError:
                    data = None
                except OSError as e:
                    if e.errno == errno.EIO:
                        data = b""  # every slave end is closed: the shell is gone
                    else:
                        raise
                if data == b"":
                    deadline = time.time() + 1.0
                    code = reap(pid, False)
                    while code is None and time.time() < deadline:
                        time.sleep(0.02)
                        code = reap(pid, False)
                    break
                if data:
                    send_frame(b"O", data)

            if 0 in readable:
                chunk = os.read(0, READ_SIZE)
                if not chunk:
                    break  # the plugin closed our stdin: it is gone or is stopping us
                try:
                    frames = decoder.push(chunk)
                except ValueError:
                    break
                for kind, payload in frames:
                    if kind == b"I":
                        to_shell += payload
                    elif kind == b"W" and len(payload) == 4:
                        r, c = struct.unpack(">HH", payload)
                        try:
                            set_size(master, max(r, 1), max(c, 1))
                        except OSError:
                            pass

            if master in writable and to_shell:
                try:
                    n = os.write(master, bytes(to_shell[:READ_SIZE]))
                    del to_shell[:n]
                except BlockingIOError:
                    pass
                except OSError as e:
                    if e.errno != errno.EIO:
                        raise
                    to_shell = bytearray()

            code = reap(pid, False)
            if code is not None:
                # The shell ended; hand over what it wrote last, then stop.
                while True:
                    try:
                        data = os.read(master, READ_SIZE)
                    except OSError:
                        break
                    if not data:
                        break
                    send_frame(b"O", data)
                break
    except (Terminate, BrokenPipeError, KeyboardInterrupt):
        pass
    finally:
        # Ignore further stop signals while cleaning up.
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(sig, signal.SIG_IGN)
        if code is None:
            code = stop_child(pid)
        else:
            # Whatever the shell left running in its session goes too.
            try:
                os.killpg(pid, signal.SIGHUP)
            except OSError:
                pass
    if code is not None:
        try:
            send_frame(b"X", struct.pack(">i", code))
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
