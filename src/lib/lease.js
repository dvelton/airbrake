'use strict';

const { performance } = require('node:perf_hooks');

class PresenceLease {
  constructor({
    leaseMs,
    now = () => performance.now(),
    wallNow = () => Date.now(),
  }) {
    this.leaseMs = leaseMs;
    this.now = now;
    this.wallNow = wallNow;
    this.held = false;
    this.expiresAt = 0;
    this.sequence = 0;
    this.lastReason = 'session-start';
  }

  start() {
    this.held = true;
    this.sequence += 1;
    this.expiresAt = this.now() + this.leaseMs;
    this.lastReason = 'hold-started';
    return this.snapshot();
  }

  heartbeat() {
    if (!this.isArmed()) {
      return this.snapshot();
    }
    this.expiresAt = this.now() + this.leaseMs;
    return this.snapshot();
  }

  release(reason = 'released') {
    this.held = false;
    this.expiresAt = 0;
    this.lastReason = reason;
    return this.snapshot();
  }

  isArmed() {
    if (!this.held) {
      return false;
    }
    if (this.now() >= this.expiresAt) {
      this.release('lease-expired');
      return false;
    }
    return true;
  }

  snapshot() {
    const armed = this.isArmedWithoutMutation();
    const expiresInMs = armed ? Math.max(0, this.expiresAt - this.now()) : 0;
    return {
      armed,
      held: this.held,
      leaseMs: this.leaseMs,
      expiresAt: armed ? this.wallNow() + expiresInMs : null,
      expiresInMs,
      sequence: this.sequence,
      reason: this.lastReason,
    };
  }

  isArmedWithoutMutation() {
    return this.held && this.now() < this.expiresAt;
  }
}

module.exports = { PresenceLease };
