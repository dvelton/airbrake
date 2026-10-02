#!/usr/bin/env python3

import os
import pty
import selectors
import signal
import sys


def main():
    if len(sys.argv) < 2:
        print("usage: pty-driver.py COMMAND [ARGS...]", file=sys.stderr)
        return 2

    pid, master = pty.fork()
    if pid == 0:
        os.execvp(sys.argv[1], sys.argv[1:])

    def terminate_child(_signum, _frame):
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, terminate_child)
    signal.signal(signal.SIGHUP, terminate_child)

    selector = selectors.DefaultSelector()
    selector.register(master, selectors.EVENT_READ, "terminal")
    selector.register(sys.stdin.fileno(), selectors.EVENT_READ, "input")

    while True:
        waited_pid, status = os.waitpid(pid, os.WNOHANG)
        if waited_pid == pid:
            return os.waitstatus_to_exitcode(status)

        for key, _ in selector.select(timeout=0.05):
            if key.data == "input":
                chunk = os.read(sys.stdin.fileno(), 4096)
                if chunk:
                    os.write(master, chunk)
                else:
                    selector.unregister(sys.stdin.fileno())
            else:
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    chunk = b""
                if chunk:
                    os.write(sys.stdout.fileno(), chunk)


if __name__ == "__main__":
    raise SystemExit(main())
