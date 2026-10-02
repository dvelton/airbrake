'use strict';

function neutralOutput() {
  return {};
}

function denyOutput(eventName, reason) {
  if (eventName === 'BeforeTool') {
    return {
      decision: 'deny',
      reason,
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

async function readHookInput() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  if (!input.trim()) {
    return {};
  }
  return JSON.parse(input);
}

async function runHook({ env = process.env, fetchImpl = fetch, input } = {}) {
  const payload = input || await readHookInput();
  const eventName = payload.hook_event_name || payload.hookEventName || 'PreToolUse';
  const url = env.AIRBRAKE_URL;
  const token = env.AIRBRAKE_READ_TOKEN;
  const sessionId = env.AIRBRAKE_SESSION_ID;

  if (!url && !token && !sessionId) {
    return neutralOutput();
  }
  if (!url || !token || !sessionId) {
    return denyOutput(
      eventName,
      'Airbrake session credentials are incomplete. Tool execution remains braked.',
    );
  }

  try {
    const response = await fetchImpl(`${url}/api/lease`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) {
      return denyOutput(eventName, `Airbrake could not verify the operator lease (${response.status}).`);
    }
    const lease = await response.json();
    if (!lease.armed) {
      return denyOutput(eventName, 'Airbrake is applied. Hold the operator control to continue.');
    }
    return neutralOutput();
  } catch {
    return denyOutput(eventName, 'Airbrake could not reach its local presence daemon.');
  }
}

module.exports = {
  denyOutput,
  neutralOutput,
  runHook,
};
