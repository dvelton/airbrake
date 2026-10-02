'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PresenceLease } = require('../src/lib/lease');

test('presence lease starts braked and expires without a heartbeat', () => {
  let now = 1000;
  const lease = new PresenceLease({ leaseMs: 300, now: () => now });

  assert.equal(lease.snapshot().armed, false);
  lease.start();
  assert.equal(lease.snapshot().armed, true);

  now = 1299;
  assert.equal(lease.isArmed(), true);
  now = 1300;
  assert.equal(lease.isArmed(), false);
  assert.equal(lease.snapshot().reason, 'lease-expired');
});

test('heartbeat extends the active lease and release applies the brake', () => {
  let now = 0;
  const lease = new PresenceLease({ leaseMs: 300, now: () => now });

  lease.start();
  now = 200;
  lease.heartbeat();
  now = 400;
  assert.equal(lease.isArmed(), true);

  lease.release('test-release');
  assert.deepEqual(
    { armed: lease.snapshot().armed, reason: lease.snapshot().reason },
    { armed: false, reason: 'test-release' },
  );
});

test('an expired lease requires a new hold before heartbeat can renew it', () => {
  let now = 0;
  const lease = new PresenceLease({ leaseMs: 150, now: () => now });
  lease.start();
  now = 200;

  assert.equal(lease.heartbeat().armed, false);
  assert.equal(lease.snapshot().held, false);
  assert.equal(lease.snapshot().reason, 'lease-expired');
});

test('wall-clock rollback does not extend an active lease', () => {
  let monotonicNow = 0;
  let wallNow = 100_000;
  const lease = new PresenceLease({
    leaseMs: 300,
    now: () => monotonicNow,
    wallNow: () => wallNow,
  });

  lease.start();
  wallNow -= 60_000;
  monotonicNow = 301;

  assert.equal(lease.isArmed(), false);
  assert.equal(lease.snapshot().reason, 'lease-expired');
});
