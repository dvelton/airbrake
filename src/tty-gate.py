#!/usr/bin/env python3

import base64
import json
import os
import selectors
import signal
import sys
import termios
import time


def encode_attributes(attributes):
    encoded = list(attributes[:6])
    encoded.append([
        base64.b64encode(value).decode("ascii")
        if isinstance(value, bytes)
        else value
        for value in attributes[6]
    ])
    return encoded


def decode_attributes(encoded):
    attributes = list(encoded[:6])
    attributes.append([
        base64.b64decode(value)
        if isinstance(value, str)
        else value
        for value in encoded[6]
    ])
    return attributes


def save_attributes(file_path, attributes):
    temporary = f"{file_path}.tmp"
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
        0o600,
    )
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(encode_attributes(attributes), output)
    os.replace(temporary, file_path)


def load_attributes(file_path):
    with open(file_path, encoding="utf-8") as input_file:
        return decode_attributes(json.load(input_file))


def configure_terminal_helper():
    signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    signal.signal(signal.SIGTTIN, signal.SIG_IGN)


def capture_terminal(file_path):
    configure_terminal_helper()
    save_attributes(file_path, termios.tcgetattr(sys.stdin.fileno()))
    return 0


def current_foreground():
    configure_terminal_helper()
    print(os.tcgetpgrp(sys.stdin.fileno()))
    return 0


def handoff_terminal(expected_pgid, target_pgid, state_file):
    configure_terminal_helper()
    descriptor = sys.stdin.fileno()
    current = os.tcgetpgrp(descriptor)
    if current != expected_pgid:
        print(
            "Airbrake is not the foreground job. Run fg, then hold again.",
            file=sys.stderr,
        )
        return 3
    attributes = load_attributes(state_file)
    attributes[3] &= ~termios.TOSTOP
    termios.tcflush(descriptor, termios.TCIFLUSH)
    termios.tcsetattr(descriptor, termios.TCSADRAIN, attributes)
    os.tcsetpgrp(descriptor, target_pgid)
    return 0


def reclaim_terminal(expected_pgid, target_pgid, initial_file, agent_file):
    configure_terminal_helper()
    descriptor = sys.stdin.fileno()
    current = os.tcgetpgrp(descriptor)
    if current != expected_pgid:
        print("Terminal foreground group changed during braking.", file=sys.stderr)
        return 3
    save_attributes(agent_file, termios.tcgetattr(descriptor))
    os.tcsetpgrp(descriptor, target_pgid)
    termios.tcsetattr(descriptor, termios.TCSADRAIN, load_attributes(initial_file))
    termios.tcflush(descriptor, termios.TCIFLUSH)
    return 0


def restore_terminal(target_pgid, state_file, allowed_pgids):
    configure_terminal_helper()
    descriptor = sys.stdin.fileno()
    current = os.tcgetpgrp(descriptor)
    if current != target_pgid and current not in allowed_pgids:
        return 0
    os.tcsetpgrp(descriptor, target_pgid)
    termios.tcsetattr(descriptor, termios.TCSADRAIN, load_attributes(state_file))
    termios.tcflush(descriptor, termios.TCIFLUSH)
    return 0


def process_exists(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def kill_groups(groups):
    own_group = os.getpgrp()
    targets = [group for group in groups if group > 0 and group != own_group]
    for group in targets:
        try:
            os.killpg(group, signal.SIGSTOP)
        except (ProcessLookupError, PermissionError):
            pass
    for group in targets:
        try:
            os.killpg(group, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def watchdog(parent_pid, agent_pid, descriptor):
    for watched_signal in (
        signal.SIGHUP,
        signal.SIGINT,
        signal.SIGQUIT,
        signal.SIGTERM,
        signal.SIGPIPE,
        signal.SIGTTOU,
        signal.SIGTTIN,
        signal.SIGTSTP,
    ):
        signal.signal(watched_signal, signal.SIG_IGN)

    selector = selectors.DefaultSelector()
    selector.register(descriptor, selectors.EVENT_READ)
    buffer = b""
    groups = {agent_pid}
    armed = False
    last_ping = time.monotonic()

    while True:
        if os.getppid() != agent_pid or not process_exists(agent_pid):
            kill_groups(groups)
            return 0
        if not process_exists(parent_pid):
            kill_groups(groups)
            return 0

        for group in list(groups):
            if group == agent_pid:
                continue
            try:
                os.killpg(group, 0)
            except ProcessLookupError:
                groups.discard(group)
            except PermissionError:
                pass

        for _key, _events in selector.select(timeout=0.05):
            chunk = os.read(descriptor, 4096)
            if not chunk:
                kill_groups(groups)
                return 0
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                parts = line.decode("ascii", errors="ignore").split()
                if parts == ["PING"]:
                    last_ping = time.monotonic()
                elif len(parts) == 2 and parts[0] == "STATE":
                    armed = parts[1] == "RUNNING"
                    last_ping = time.monotonic()
                elif len(parts) == 2 and parts[0] == "GROUPS":
                    parsed = {agent_pid}
                    for value in parts[1].split(","):
                        try:
                            parsed.add(int(value))
                        except ValueError:
                            pass
                    groups = parsed

        if armed and time.monotonic() - last_ping > 0.75:
            kill_groups(groups)
            return 0


def reset_exec_signals():
    for exec_signal in (
        signal.SIGHUP,
        signal.SIGINT,
        signal.SIGQUIT,
        signal.SIGTERM,
        signal.SIGPIPE,
        signal.SIGXFSZ,
    ):
        signal.signal(exec_signal, signal.SIG_DFL)


def run_gate(gate_file, parent_pid, watchdog_file, command):
    os.setpgid(0, 0)
    agent_pid = os.getpid()
    watchdog_pid = os.fork()
    if watchdog_pid == 0:
        try:
            os.setpgid(0, 0)
            descriptor = os.open(
                watchdog_file,
                os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
                0o600,
            )
            with os.fdopen(descriptor, "w", encoding="ascii") as output:
                output.write(f"{os.getpid()} {os.getpgrp()}\n")
        except OSError as error:
            print(f"airbrake: could not isolate watchdog: {error}", file=sys.stderr)
            return 1
        return watchdog(parent_pid, agent_pid, 3)

    os.close(3)
    while not os.path.exists(gate_file):
        if os.getppid() != parent_pid:
            return 1
        time.sleep(0.01)

    reset_exec_signals()
    try:
        os.execvp(command[0], command)
    except OSError as error:
        print(f"airbrake: could not execute {command[0]}: {error}", file=sys.stderr)
        return 127


def main():
    if len(sys.argv) >= 6 and sys.argv[1] == "run":
        return run_gate(
            sys.argv[2],
            int(sys.argv[3]),
            sys.argv[4],
            sys.argv[5:],
        )
    if len(sys.argv) == 3 and sys.argv[1] == "capture":
        return capture_terminal(sys.argv[2])
    if len(sys.argv) == 2 and sys.argv[1] == "current":
        return current_foreground()
    if len(sys.argv) == 5 and sys.argv[1] == "handoff":
        return handoff_terminal(int(sys.argv[2]), int(sys.argv[3]), sys.argv[4])
    if len(sys.argv) == 6 and sys.argv[1] == "reclaim":
        return reclaim_terminal(
            int(sys.argv[2]),
            int(sys.argv[3]),
            sys.argv[4],
            sys.argv[5],
        )
    if len(sys.argv) == 5 and sys.argv[1] == "restore":
        allowed = {int(value) for value in sys.argv[4].split(",") if value}
        return restore_terminal(int(sys.argv[2]), sys.argv[3], allowed)
    print("usage: tty-gate.py run GATE_FILE PARENT_PID WATCHDOG_FILE COMMAND [ARGS...]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
