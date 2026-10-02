'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ControlServer } = require('../src/lib/control-server');
const { PresenceLease } = require('../src/lib/lease');

test('a stale start cannot re-arm after a newer release', async (context) => {
  const lease = new PresenceLease({ leaseMs: 250 });
  const server = new ControlServer({
    command: 'test',
    heartbeatMs: 75,
    lease,
    onLeaseChange: async () => {},
  });
  const connection = await server.start();
  context.after(() => server.close());

  const token = connection.controlUrl.split('#')[1];
  const headers = { Authorization: `Bearer ${token}` };
  await fetch(`${connection.baseUrl}/api/hold/release?generation=2`, {
    method: 'POST',
    headers,
  });
  await fetch(`${connection.baseUrl}/api/hold/start?generation=1`, {
    method: 'POST',
    headers,
  });

  const response = await fetch(`${connection.baseUrl}/api/status`, { headers });
  const status = await response.json();
  assert.equal(status.armed, false);
  assert.equal(status.controlGeneration, 2);

  const page = await fetch(connection.baseUrl).then((result) => result.text());
  assert.match(page, /"generation":2/);

  await fetch(`${connection.baseUrl}/api/hold/start?generation=3`, {
    method: 'POST',
    headers,
  });
  const reopenedStatus = await fetch(`${connection.baseUrl}/api/status`, { headers });
  assert.equal((await reopenedStatus.json()).armed, true);
});

test('release invalidates a pending arm transition immediately', async (context) => {
  const lease = new PresenceLease({ leaseMs: 500 });
  let finishArm;
  const armBlocked = new Promise((resolve) => {
    finishArm = resolve;
  });
  const calls = [];
  const server = new ControlServer({
    command: 'test',
    heartbeatMs: 100,
    lease,
    onLeaseChange: async (armed) => {
      calls.push(armed);
      if (armed) await armBlocked;
    },
  });
  const connection = await server.start();
  context.after(() => server.close());
  const token = connection.controlUrl.split('#')[1];
  const headers = { Authorization: `Bearer ${token}` };

  const start = fetch(`${connection.baseUrl}/api/hold/start?generation=1`, {
    method: 'POST',
    headers,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const release = fetch(`${connection.baseUrl}/api/hold/release?generation=2`, {
    method: 'POST',
    headers,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(calls, [true, false]);
  finishArm();
  await Promise.all([start, release]);
  assert.equal(server.snapshot().armed, false);
});

test('closing rejects new holds and closes even when braking fails', async () => {
  const lease = new PresenceLease({ leaseMs: 500 });
  let failBrake = false;
  const server = new ControlServer({
    command: 'test',
    heartbeatMs: 100,
    lease,
    onLeaseChange: async (armed) => {
      if (!armed && failBrake) {
        throw new Error('brake failed');
      }
    },
  });
  const connection = await server.start();
  const token = connection.controlUrl.split('#')[1];
  const headers = { Authorization: `Bearer ${token}` };
  await fetch(`${connection.baseUrl}/api/hold/start?generation=1`, {
    method: 'POST',
    headers,
  });

  failBrake = true;
  const closing = server.close();
  const closingResult = assert.rejects(closing, /brake failed/);
  const response = await fetch(`${connection.baseUrl}/api/hold/start?generation=2`, {
    method: 'POST',
    headers,
  }).catch(() => null);
  if (response) {
    assert.equal(response.status, 503);
  }
  await closingResult;
  await assert.rejects(fetch(`${connection.baseUrl}/api/status`, { headers }));
});
