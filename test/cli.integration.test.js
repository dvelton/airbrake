'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function size(file) {
  return fs.existsSync(file) ? fs.statSync(file).size : 0;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error('Timed out waiting for condition.');
}

test('CLI run command completes the hold, release, and shutdown flow', {
  skip: process.platform === 'win32',
  timeout: 15000,
}, async (context) => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-cli-'));
  const connectionFile = path.join(temp, 'connection.json');
  const agentOutput = path.join(temp, 'agent.log');
  const workerOutput = path.join(temp, 'worker.log');

  const child = spawn(process.execPath, [
    path.join(root, 'bin', 'airbrake'),
    'run',
    '--no-open',
    '--lease-ms',
    '300',
    '--url-file',
    connectionFile,
    '--',
    process.execPath,
    path.join(root, 'test', 'fixtures', 'file-agent.js'),
    agentOutput,
    workerOutput,
  ], {
    cwd: temp,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  context.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(2000),
      ]);
    }
    fs.rmSync(temp, { force: true, recursive: true });
  });

  await waitFor(() => fs.existsSync(connectionFile));
  const connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
  const token = connection.controlUrl.split('#')[1];
  const headers = { Authorization: `Bearer ${token}` };

  assert.equal(size(agentOutput), 0);
  await fetch(`${connection.baseUrl}/api/hold/start?generation=1`, { method: 'POST', headers });
  const heartbeat = setInterval(() => {
    fetch(`${connection.baseUrl}/api/hold/heartbeat?generation=1`, {
      method: 'POST',
      headers,
    }).catch(() => {});
  }, 75);

  await waitFor(() => size(agentOutput) > 0 && size(workerOutput) > 0);
  clearInterval(heartbeat);
  await fetch(`${connection.baseUrl}/api/hold/release?generation=2`, {
    method: 'POST',
    headers,
  });
  await sleep(175);

  const agentSize = size(agentOutput);
  const workerSize = size(workerOutput);
  await sleep(250);
  assert.equal(size(agentOutput), agentSize);
  assert.equal(size(workerOutput), workerSize);
  assert.match(stderr, /control: http:\/\/127\.0\.0\.1:/);
  assert.match(stderr, /BRAKED/);

  child.kill('SIGTERM');
  const [code] = await new Promise((resolve) => {
    child.once('exit', (...values) => resolve(values));
  });
  assert.equal(code, 143);
  assert.equal(size(agentOutput), agentSize);
  assert.equal(size(workerOutput), workerSize);
});

test('shutdown does not execute a command that was never armed', {
  skip: process.platform === 'win32',
  timeout: 10000,
}, async (context) => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-never-armed-'));
  const connectionFile = path.join(temp, 'connection.json');
  const marker = path.join(temp, 'executed.txt');

  const child = spawn(process.execPath, [
    path.join(root, 'bin', 'airbrake'),
    'run',
    '--no-open',
    '--url-file',
    connectionFile,
    '--',
    '/bin/sh',
    '-c',
    `printf executed > ${JSON.stringify(marker)}`,
  ], {
    cwd: temp,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  context.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(temp, { force: true, recursive: true });
  });

  await waitFor(() => fs.existsSync(connectionFile));
  child.kill('SIGTERM');
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 143);
  assert.equal(fs.existsSync(marker), false);
});

test('startup failure unwinds the stopped command without executing it', {
  skip: process.platform === 'win32',
  timeout: 10000,
}, async (context) => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-startup-failure-'));
  const marker = path.join(temp, 'executed.txt');

  const child = spawn(process.execPath, [
    path.join(root, 'bin', 'airbrake'),
    'run',
    '--no-open',
    '--url-file',
    temp,
    '--',
    '/bin/sh',
    '-c',
    `printf executed > ${JSON.stringify(marker)}`,
  ], {
    cwd: temp,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  context.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(temp, { force: true, recursive: true });
  });

  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 1);
  assert.equal(fs.existsSync(marker), false);
});

test('invalid working directory exits instead of leaving a session running', {
  skip: process.platform === 'win32',
  timeout: 10000,
}, async () => {
  const root = path.resolve(__dirname, '..');
  const child = spawn(process.execPath, [
    path.join(root, 'bin', 'airbrake'),
    'run',
    '--no-open',
    '--cwd',
    path.join(os.tmpdir(), 'airbrake-directory-that-does-not-exist'),
    '--',
    process.execPath,
    '-e',
    'setInterval(() => {}, 1000)',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 1);
});

test('the watchdog stops observed process groups if Airbrake is killed', {
  skip: process.platform === 'win32',
  timeout: 15000,
}, async (context) => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-watchdog-'));
  const connectionFile = path.join(temp, 'connection.json');
  const agentOutput = path.join(temp, 'agent.log');
  const workerOutput = path.join(temp, 'worker.log');
  const child = spawn(process.execPath, [
    path.join(root, 'bin', 'airbrake'),
    'run',
    '--no-open',
    '--lease-ms',
    '300',
    '--url-file',
    connectionFile,
    '--',
    process.execPath,
    path.join(root, 'test', 'fixtures', 'file-agent.js'),
    agentOutput,
    workerOutput,
  ], {
    cwd: temp,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  context.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(temp, { force: true, recursive: true });
  });

  await waitFor(() => fs.existsSync(connectionFile));
  const connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
  const token = connection.controlUrl.split('#')[1];
  const headers = { Authorization: `Bearer ${token}` };
  await fetch(`${connection.baseUrl}/api/hold/start?generation=1`, {
    method: 'POST',
    headers,
  });
  const heartbeat = setInterval(() => {
    fetch(`${connection.baseUrl}/api/hold/heartbeat?generation=1`, {
      method: 'POST',
      headers,
    }).catch(() => {});
  }, 75);

  await waitFor(() => size(agentOutput) > 0 && size(workerOutput) > 0);
  await sleep(100);
  clearInterval(heartbeat);
  process.kill(-child.pid, 'SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  await sleep(200);
  const agentSize = size(agentOutput);
  const workerSize = size(workerOutput);
  await sleep(400);
  assert.equal(size(agentOutput), agentSize);
  assert.equal(size(workerOutput), workerSize);
});
