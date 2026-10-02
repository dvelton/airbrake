# Agent adapters

The generic wrapper works with any local CLI command. Adapters add a hook-level
check for agents that expose pre-tool lifecycle events.

## GitHub Copilot CLI

The installer writes:

```text
~/.copilot/hooks/airbrake.json
```

The repository can also be installed directly as a Copilot plugin.

## OpenAI Codex

The installer merges an Airbrake `PreToolUse` group into:

```text
~/.codex/hooks.json
```

Open `/hooks` in Codex and review and trust the exact Airbrake hook definition.
Codex skips new or changed non-managed hooks until that review is complete. A
later Airbrake update that changes the command definition requires another
review.

The repository also contains `hooks/hooks.json` for local plugin testing.

## Claude Code

The installer merges an Airbrake `PreToolUse` group into:

```text
~/.claude/settings.json
```

The repository includes a Claude plugin manifest.

## Gemini CLI

The installer merges an Airbrake `BeforeTool` group into:

```text
~/.gemini/settings.json
```

Gemini uses a different event name and denial output, which `airbrake hook`
detects from the incoming payload.

The hook requires `AIRBRAKE_URL`, `AIRBRAKE_READ_TOKEN`, and
`AIRBRAKE_SESSION_ID`. If Gemini's hook environment removes one of those
values, Airbrake denies the tool call rather than treating it as an
unsupervised session.

## Configuration changes

Before modifying an existing JSON file, Airbrake creates a one-time sibling
backup ending in `.airbrake-backup`. Uninstall removes only the Airbrake hook
handler and preserves unrelated handlers in the same matcher group.
