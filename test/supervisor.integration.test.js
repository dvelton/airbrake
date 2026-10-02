'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ControlServer } = require('../src/lib/control-server');
const { PresenceLease } = require('../src/lib/lease');
const { ProcessSupervisor } = require('../src/lib/supervisor');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function size(file) {
  return fs.existsSync(file) ? fs.statSync(file).size : 0;
}

async function waitFor(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error('Timed out waiting for condition.');
}

test('hold runs the agent and release pauses it and its child process', {
  skip: process.platform === 'win32',
  timeout: 15000,
}, async (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-supervisor-'));
  const agentOutput = path.join(temp, 'agent.log');
  const workerOutput = path.join(temp, 'worker.log');
  const lease = new PresenceLease({ leaseMs: 250 });
  let supervisor;

  const server = new ControlServer({
    chord: ['Space'],
    command: 'file-agent',
    heartbeatMs: 75,
    lease,
    onLeaseChange: async (armed) => {
      if (supervisor) await supervisor.setArmed(armed);
    },
  });
  const connection = await server.start();

  supervisor = new ProcessSupervisor({
    args: [
      path.join(__dirname, 'fixtures', 'file-agent.js'),
      agentOutput,
      workerOutput,
    ],
    command: process.execPath,
    cwd: temp,
    env: process.env,
  });
  await supervisor.start();

  context.after(async () => {
    await server.close();
    await supervisor.terminate({ graceMs: 200 });
    fs.rmSync(temp, { force: true, recursive: true });
  });

  await sleep(150);
  assert.equal(size(agentOutput), 0);
  assert.equal(size(workerOutput), 0);

  const token = connection.controlUrl.split('#')[1];
  const headers = { Authorization: `Bearer ${token}` };
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

  const stoppedAgentSize = size(agentOutput);
  const stoppedWorkerSize = size(workerOutput);
  await sleep(250);
  assert.equal(size(agentOutput), stoppedAgentSize);
  assert.equal(size(workerOutput), stoppedWorkerSize);

  await fetch(`${connection.baseUrl}/api/hold/start?generation=3`, {
    method: 'POST',
    headers,
  });
  await waitFor(() => size(agentOutput) > stoppedAgentSize && size(workerOutput) > stoppedWorkerSize);
});

test('a worker is terminated when the root agent exits normally', {
  skip: process.platform === 'win32',
  timeout: 10000,
}, async (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-root-exit-'));
  const pidFile = path.join(temp, 'worker.pid');
  const workerOutput = path.join(temp, 'worker.log');
  const supervisor = new ProcessSupervisor({
    args: [
      path.join(__dirname, 'fixtures', 'exit-agent.js'),
      pidFile,
      workerOutput,
    ],
    command: process.execPath,
    cwd: temp,
    env: process.env,
  });

  context.after(async () => {
    await supervisor.terminate({ graceMs: 100 });
    fs.rmSync(temp, { force: true, recursive: true });
  });

  await supervisor.start();
  await supervisor.setArmed(true);
  await waitFor(() => fs.existsSync(pidFile));
  const workerPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  await new Promise((resolve) => supervisor.once('exit', resolve));

  assert.throws(() => process.kill(workerPid, 0), /ESRCH/);
});

test('resume discovery failure reapplies the brake', {
  skip: process.platform === 'win32',
  timeout: 10000,
}, async (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-resume-failure-'));
  const agentOutput = path.join(temp, 'agent.log');
  const workerOutput = path.join(temp, 'worker.log');
  const supervisor = new ProcessSupervisor({
    args: [
      path.join(__dirname, 'fixtures', 'file-agent.js'),
      agentOutput,
      workerOutput,
    ],
    command: process.execPath,
    cwd: temp,
    env: process.env,
    processScanner: async () => {
      throw new Error('process discovery failed');
    },
  });

  context.after(async () => {
    await supervisor.terminate({ graceMs: 100 });
    fs.rmSync(temp, { force: true, recursive: true });
  });

  await supervisor.start();
  await assert.rejects(
    supervisor.setArmed(true),
    /process discovery failed/,
  );
  await sleep(100);

  const stoppedSize = size(agentOutput);
  await sleep(250);
  assert.equal(supervisor.state, 'braked');
  assert.equal(size(agentOutput), stoppedSize);
});

test('a valid retry resumes a gate stopped by a failed first arm', {
  skip: process.platform === 'win32',
  timeout: 10000,
}, async (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-retry-'));
  const agentOutput = path.join(temp, 'agent.log');
  const workerOutput = path.join(temp, 'worker.log');
  const { listProcessRows } = require('../src/lib/process-tree');
  let failDiscovery = true;
  const supervisor = new ProcessSupervisor({
    args: [
      path.join(__dirname, 'fixtures', 'file-agent.js'),
      agentOutput,
      workerOutput,
    ],
    command: process.execPath,
    cwd: temp,
    env: process.env,
    processScanner: async () => {
      if (failDiscovery) {
        throw new Error('process discovery failed');
      }
      return listProcessRows();
    },
  });

  context.after(async () => {
    await supervisor.terminate();
    fs.rmSync(temp, { force: true, recursive: true });
  });

  await supervisor.start();
  await assert.rejects(supervisor.setArmed(true), /process discovery failed/);
  await supervisor.setArmed(false);
  failDiscovery = false;
  await supervisor.setArmed(true);
  await waitFor(() => size(agentOutput) > 0);
  assert.equal(supervisor.state, 'running');
});

test('termination during startup prevents a later gate spawn', {
  skip: process.platform === 'win32',
  timeout: 5000,
}, async () => {
  let resolveLookup;
  const lookup = new Promise((resolve) => {
    resolveLookup = resolve;
  });
  const supervisor = new ProcessSupervisor({
    args: ['-e', 'process.exit(0)'],
    command: process.execPath,
    cwd: process.cwd(),
    env: process.env,
    processGroupLookup: async () => lookup,
  });

  const starting = supervisor.start();
  await sleep(25);
  await supervisor.terminate();
  resolveLookup(1);
  await assert.rejects(starting, /startup was cancelled/);
  assert.equal(supervisor.child, null);
});

test('process discovery scans never overlap', {
  skip: process.platform === 'win32',
  timeout: 5000,
}, async () => {
  let active = 0;
  let maximum = 0;
  const supervisor = new ProcessSupervisor({
    args: [],
    command: process.execPath,
    cwd: process.cwd(),
    env: process.env,
    processScanner: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await sleep(75);
      active -= 1;
      return [{ pid: 1000, ppid: 1, pgid: 1000 }];
    },
  });
  supervisor.agentPgid = 1000;
  supervisor.gatePid = 1000;
  supervisor.trackedPgids.add(1000);

  supervisor.startMonitor();
  await sleep(225);
  supervisor.stopMonitor();
  await supervisor.refreshTrackedGroups();
  assert.equal(maximum, 1);
});
