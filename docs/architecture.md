# Architecture

Airbrake has four components.

## Presence lease

The control server owns an in-memory lease. The browser can start, renew, or
release it with a control token. Hooks receive a separate read token that can
only query the current lease.

The lease defaults to 350 milliseconds and is renewed every 100 milliseconds
while the operator holds the control.

## Process supervisor

The supervisor starts the requested command behind `src/tty-gate.py`. The gate
waits for a one-time authorization file before executing the agent. Resuming a
stopped Airbrake shell job cannot create that file.

The gate and agent run in a dedicated POSIX process group. Interactive terminal
sessions transfer foreground terminal control between the agent's current
foreground group and Airbrake. When the lease expires, the supervisor sends
`SIGSTOP` to observed process groups, saves the agent's terminal attributes,
restores Airbrake's original attributes, and discards input typed while
braked before the next resume.

While the agent runs, Airbrake polls the process tree and records additional
process groups created by descendants. This covers observed commands that call
`setsid` or otherwise create their own group. Discovery is best effort; a
process that detaches and disappears from the ancestry before a poll is not
controlled.

The gate also starts a watchdog in its own process group, separate from both
Airbrake and the agent. Airbrake sends the watchdog the current set of observed
process groups and regular liveness pings while the agent is running. If
Airbrake exits, the pipe closes, or the running-state pings stop, the watchdog
stops and kills those groups. The same discovery limit applies to a process
that detaches before Airbrake observes it.

## Agent hooks

`airbrake hook` reads the hook payload from standard input and queries the
control server. It emits:

- no decision while the lease is active or Airbrake is not supervising the
  session, leaving the agent's ordinary permission handling unchanged;
- Claude-compatible `PreToolUse` denial output for Copilot, Codex, and Claude
  Code while braked; and
- Gemini-compatible `BeforeTool` denial output for Gemini CLI while braked.

No tool arguments are logged.

## Control page

The control page is served from `127.0.0.1` with no external assets. Pointer
events and a configurable key chord can hold the lease. Pointer cancellation,
key release, focus loss, page hiding, or page closure releases it.

The control token is initially supplied in the URL fragment. The page removes
the fragment from the visible address after reading it.
