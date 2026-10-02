# Airbrake

Airbrake is a proof of concept for running a local coding agent only while a
person holds an on-screen control or designated key chord. Release the control
and Airbrake pauses the agent process, pauses the child process groups it has
detected, and, when an adapter is installed, causes supported agent hooks to
refuse new tool calls.

This project is an experiment. It is not a safety system, a security boundary,
or evidence that a person reviewed an agent's actions.

## The railway idea

George Westinghouse's early air brake let a locomotive engineer operate brakes
throughout a train. The later automatic design made a loss of brake-pipe
pressure apply the brakes rather than remove the ability to brake. Each car
carried compressed air locally, and a reduction in the shared pipe pressure
caused valves on the cars to apply their brakes.

That mattered because a broken hose, a separated train, or another major loss
of pressure produced a stop instead of leaving the train without its normal
braking command. The Library of Congress describes Westinghouse's air brake as
a major improvement in railroad braking, and the Federal Railroad
Administration describes modern automatic brakes as applying when brake-pipe
pressure is reduced.

- [Library of Congress: George Westinghouse](https://guides.loc.gov/this-month-in-business-history/october/george-westinghouse)
- [Federal Railroad Administration: train-line air brake operation](https://railroads.fra.dot.gov/sites/fra.dot.gov/files/2021-09/HQ-2020-1401%20Summary%20Report.pdf)

Airbrake applies the same control idea to local coding agents:

```text
continuous operator signal -> agent may run
signal released or lost     -> agent is paused
```

The browser sends a short-lived lease while the control remains depressed.
Airbrake begins every session with the brake applied. A missing heartbeat,
closed control page, browser focus loss, expired lease, or deliberate release
returns the session to the braked state.

## What it controls

The process supervisor is agent-agnostic. Put any local CLI command after
`airbrake run --`:

```sh
airbrake run -- copilot
airbrake run -- codex
airbrake run -- claude
airbrake run -- gemini
airbrake run -- aider
airbrake run -- your-own-agent --flag value
```

Airbrake also installs optional pre-tool hooks for:

| Agent | Hook event |
|---|---|
| GitHub Copilot CLI | `PreToolUse` |
| OpenAI Codex | `PreToolUse` |
| Claude Code | `PreToolUse` |
| Gemini CLI | `BeforeTool` |

The wrapper pauses the local agent process regardless of whether an adapter is
installed. The adapters add a second control point before supported tool calls.
Other agents can still be tried through the generic process wrapper.

## Requirements

- macOS or Linux
- Node.js 20 or later
- Python 3
- A local, terminal-based coding agent
- A browser for the hold-to-run control

The current proof of concept does not implement hard process suspension on
Windows. Remote and cloud-hosted agents are outside its present scope.

## Install without npm

Airbrake is installed directly from its Git repository. It is not published to
npm and does not require `npm install`.

```sh
git clone https://github.com/dvelton/airbrake.git
cd airbrake
./scripts/install.sh
```

The installer copies the project to `~/.local/share/airbrake` and creates
`~/.local/bin/airbrake`. If necessary, add `~/.local/bin` to your `PATH`.

Run the environment check:

```sh
airbrake doctor
```

Install all supported hook adapters:

```sh
airbrake adapters install all
```

For Codex, open `/hooks` and review and trust the installed Airbrake hook.
Codex skips new or changed non-managed hooks until the user completes that
review.

Airbrake creates a one-time `*.airbrake-backup` before changing an existing
agent settings file. Remove the adapters with:

```sh
airbrake adapters uninstall all
```

## Try the demo

```sh
airbrake demo
```

Airbrake opens a local browser page and starts the demo process in the braked
state. Hold the large button or Space to let the counter run. Release the
control and the counter stops.

## Run a coding agent

```sh
cd your-project
airbrake run -- claude
```

The agent receives three environment variables:

```text
AIRBRAKE_URL
AIRBRAKE_READ_TOKEN
AIRBRAKE_SESSION_ID
```

Installed hooks use those values to query the local lease. Outside an Airbrake
session, the hooks do nothing.

Useful options:

```text
--no-open             Print the control URL without opening a browser
--lease-ms NUMBER     Set the heartbeat lease, from 300 to 5000 ms
--chord CODES         Set browser key codes, such as ShiftLeft+Space
--url-file PATH       Write connection details for testing or another UI
--cwd PATH            Set the agent's working directory
```

## Distribution

Airbrake is distributed only as a personal GitHub project. It is not published
to npm or an agent plugin marketplace.

Clone the repository, run `./scripts/install.sh`, and use
`airbrake adapters install` for the agent integrations. The included plugin
manifests are available for local source-based testing, but this project does
not maintain a marketplace listing.

## How the process brake works

Airbrake starts the requested command behind a launch gate, so the agent cannot
begin before the first operator hold. A Python helper waits for an explicit
one-time authorization file, then executes the agent in its own process group.

On release, Airbrake stops the primary agent process group. It also polls the
process tree for commands that created separate process groups or sessions and
stops the groups it detected. Interactive terminal sessions use a small Python
helper to place the agent in a separate process group and transfer terminal
control between Airbrake and that group. Airbrake saves the agent's terminal
settings, restores the original settings while braked, and discards input typed
while the agent was stopped before resuming it.

An independently grouped watchdog receives the current process groups Airbrake
has observed and liveness pings while the agent runs. If the supervisor exits
or stops responding, the watchdog stops and kills those groups. On ordinary
shutdown, Airbrake applies the brake and terminates the observed process tree
without releasing a never-armed launch gate.

## Limitations

- Holding a control indicates an input state. It does not establish that the
  operator is watching, understands the output, or approves each action.
- A request that has already reached an external service cannot be recalled by
  releasing the control.
- Process-group and terminal behavior has operating-system and shell
  dependencies.
- Process-group discovery is best effort. A process that detaches and
  disappears from the agent's ancestry before Airbrake observes it can escape
  both the brake and watchdog. External services and system-managed jobs are
  not controlled.
- Agent hooks can have unsupported tool paths, can be disabled by users, and
  can change as agent products change.
- The agent and Airbrake run under the same user account in this proof of
  concept.
- Browser controls and environment variables are intended for experimentation,
  not as tamper-resistant mechanisms.
- The on-screen control must remain visible and active. A physical hold switch
  is not included.

For an irreversible operation, a separate review and confirmation step remains
appropriate even while Airbrake is held.

## Potential experiments

Airbrake may be useful for testing workflows where continuous human presence is
more appropriate than giving an agent an open-ended run. Examples include:

| Experiment | What the operator can watch |
|---|---|
| Agents with broad local, cloud, or repository permissions | Commands, proposed changes, and signs that the task is moving outside its intended scope |
| Production or incident diagnostics | Live output while an agent inspects systems or prepares remediation steps |
| Database, infrastructure, deployment, or migration work | The transition from analysis into actions that may be difficult to reverse |
| Large refactors or automated test-repair loops | File churn, repeated failures, unexpected scope growth, or a loop that is no longer productive |
| Security testing in an authorized environment | Whether probes remain within the approved target and test plan |
| Expensive model runs | Whether continued token use is producing useful progress or repeating the same work |
| New agents, tools, plugins, or permission modes | Their actual behavior before allowing longer unattended sessions |
| Training, demonstrations, and evaluations | A visible connection between operator authorization and agent activity |

Airbrake does not measure tokens, enforce a budget, classify risk, or approve
individual actions. For cost supervision, it only gives the operator a direct
way to stop local work when the run no longer appears worthwhile. Separate
spending limits, permission controls, confirmations, backups, and change review
remain appropriate for the underlying task.

## Development

No dependency installation is required.

```sh
./scripts/test.sh
./scripts/package.sh
```

Tests use Node's built-in test runner. The integration test starts a harmless
writer process and child worker, then checks that both advance while held and
stop after release.

## License

MIT. See [LICENSE](LICENSE).
