'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { runHook } = require('../src/lib/hook');

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('hook is inert outside an Airbrake session', async () => {
  const output = await runHook({
    env: {},
    input: { hook_event_name: 'PreToolUse' },
  });
  assert.deepEqual(output, {});
});

test('hook allows an active lease', async () => {
  const output = await runHook({
    env: {
      AIRBRAKE_READ_TOKEN: 'token',
      AIRBRAKE_SESSION_ID: 'session',
      AIRBRAKE_URL: 'http://local',
    },
    fetchImpl: async () => response(200, { armed: true }),
    input: { hook_event_name: 'PreToolUse' },
  });
  assert.deepEqual(output, {});
});

test('hook denies a braked Claude-compatible tool call', async () => {
  const output = await runHook({
    env: { AIRBRAKE_READ_TOKEN: 'token', AIRBRAKE_URL: 'http://local' },
    fetchImpl: async () => response(200, { armed: false }),
    input: { hook_event_name: 'PreToolUse' },
  });
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});

test('hook stops a braked Gemini tool call', async () => {
  const output = await runHook({
    env: { AIRBRAKE_READ_TOKEN: 'token', AIRBRAKE_URL: 'http://local' },
    fetchImpl: async () => response(200, { armed: false }),
    input: { hook_event_name: 'BeforeTool' },
  });
  assert.deepEqual(
    { continue: output.continue, decision: output.decision },
    { continue: undefined, decision: 'deny' },
  );
});

test('hook fails closed when an Airbrake session cannot be reached', async () => {
  const output = await runHook({
    env: { AIRBRAKE_READ_TOKEN: 'token', AIRBRAKE_URL: 'http://local' },
    fetchImpl: async () => {
      throw new Error('offline');
    },
    input: { hook_event_name: 'PreToolUse' },
  });
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});

test('hook fails closed when an Airbrake session token is redacted', async () => {
  const output = await runHook({
    env: {
      AIRBRAKE_SESSION_ID: 'session',
      AIRBRAKE_URL: 'http://local',
    },
    input: { hook_event_name: 'BeforeTool' },
  });
  assert.equal(output.decision, 'deny');
});

test('hook executable reads a real payload from stdin', async () => {
  const bin = path.join(__dirname, '..', 'bin', 'airbrake');
  const child = spawn(process.execPath, [bin, 'hook'], {
    env: {},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end('{"hook_event_name":"PreToolUse"}\n');

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0, stderr);
  assert.equal(stdout, '');
});
