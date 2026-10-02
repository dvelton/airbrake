'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { URL } = require('node:url');
const { renderControlPage } = require('../control-page');

function json(response, statusCode, body) {
  const content = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(content),
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(content);
}

function bearerToken(request) {
  const value = request.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

class ControlServer {
  constructor({
    chord = ['Space'],
    command,
    heartbeatMs,
    lease,
    onError = () => {},
    onLeaseChange,
    sessionId = crypto.randomUUID(),
  }) {
    this.chord = chord;
    this.command = command;
    this.closing = false;
    this.controlGeneration = 0;
    this.controlToken = crypto.randomBytes(32).toString('base64url');
    this.heartbeatMs = heartbeatMs;
    this.lease = lease;
    this.onError = onError;
    this.onLeaseChange = onLeaseChange;
    this.readToken = crypto.randomBytes(32).toString('base64url');
    this.server = null;
    this.sessionId = sessionId;
    this.monitor = null;
    this.requestedArmed = false;
  }

  async start() {
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        json(response, 500, { error: error.message });
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });

    this.monitor = setInterval(() => {
      this.publishIfChanged().catch((error) => {
        if (this.onError) {
          this.onError(error);
        }
      });
    }, 25);
    const address = this.server.address();
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    return {
      baseUrl: this.baseUrl,
      controlUrl: `${this.baseUrl}/#${this.controlToken}`,
      readToken: this.readToken,
      sessionId: this.sessionId,
    };
  }

  async handle(request, response) {
    const url = new URL(request.url, this.baseUrl || 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/') {
      const html = renderControlPage({
        chord: this.chord,
        command: this.command,
        generation: this.controlGeneration,
        heartbeatMs: this.heartbeatMs,
        leaseMs: this.lease.leaseMs,
        sessionId: this.sessionId,
      });
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(html),
        'Content-Security-Policy': [
          "default-src 'none'",
          "script-src 'unsafe-inline'",
          "style-src 'unsafe-inline'",
          "connect-src 'self'",
          "img-src 'self' data:",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join('; '),
        'Content-Type': 'text/html; charset=utf-8',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(html);
      return;
    }

    if (url.pathname === '/api/lease') {
      if (bearerToken(request) !== this.readToken) {
        json(response, 401, { error: 'unauthorized' });
        return;
      }
      json(response, 200, this.snapshot());
      return;
    }

    if (bearerToken(request) !== this.controlToken) {
      json(response, 401, { error: 'unauthorized' });
      return;
    }

    if (this.closing && url.pathname.startsWith('/api/hold/')) {
      json(response, 503, { error: 'server-closing' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/status') {
      json(response, 200, this.snapshot());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/hold/start') {
      const generation = this.readGeneration(url, response);
      if (generation === null) return;
      const snapshot = generation < this.controlGeneration
        ? this.snapshot()
        : this.acceptStart(generation);
      await this.publishIfChanged();
      json(response, 200, snapshot);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/hold/heartbeat') {
      const generation = this.readGeneration(url, response);
      if (generation === null) return;
      const snapshot = generation === this.controlGeneration
        ? this.heartbeat()
        : this.snapshot();
      await this.publishIfChanged();
      json(response, 200, snapshot);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/hold/release') {
      const generation = this.readGeneration(url, response);
      if (generation === null) return;
      const snapshot = generation < this.controlGeneration
        ? this.snapshot()
        : this.acceptRelease(generation, url.searchParams.get('reason') || 'released');
      await this.publishIfChanged();
      json(response, 200, snapshot);
      return;
    }

    json(response, 404, { error: 'not-found' });
  }

  readGeneration(url, response) {
    const generation = Number(url.searchParams.get('generation'));
    if (!Number.isInteger(generation) || generation <= 0) {
      json(response, 400, { error: 'invalid-generation' });
      return null;
    }
    return generation;
  }

  acceptStart(generation) {
    this.controlGeneration = generation;
    this.lease.start();
    return this.snapshot();
  }

  heartbeat() {
    this.lease.heartbeat();
    return this.snapshot();
  }

  acceptRelease(generation, reason) {
    this.controlGeneration = generation;
    this.lease.release(reason);
    return this.snapshot();
  }

  snapshot() {
    return {
      ...this.lease.snapshot(),
      controlGeneration: this.controlGeneration,
    };
  }

  async publishIfChanged() {
    const armed = this.lease.isArmed();
    if (armed === this.requestedArmed) {
      return;
    }
    this.requestedArmed = armed;
    try {
      await this.onLeaseChange(armed, this.lease.snapshot());
    } catch (error) {
      if (armed && this.requestedArmed) {
        this.lease.release('actuation-failed');
        this.requestedArmed = false;
        await this.onLeaseChange(false, this.lease.snapshot()).catch(() => {});
      }
      throw error;
    }
  }

  async close() {
    if (this.closing) {
      return this.closePromise;
    }
    this.closing = true;
    clearInterval(this.monitor);
    this.monitor = null;
    this.lease.release('server-closed');
    const actuation = this.publishIfChanged();
    const server = this.server;
    this.server = null;
    this.closePromise = (async () => {
      if (server) {
        const closed = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections?.();
        await closed;
      }
      await actuation;
    })();
    return this.closePromise;
  }
}

module.exports = { ControlServer };
