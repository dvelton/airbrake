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

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error('Timed out waiting for condition.');
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function spawnInTerminal(command, cwd, env = process.env) {
  return spawn('python3', [
    path.join(__dirname, 'fixtures', 'pty-driver.py'),
    ...command,
  ], {
    cwd,
    detached: true,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function stopTerminal(child) {
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(1000),
  ]);
}

const terminalTestsSupported = process.platform !== 'win32';

test('TTY sessions accept input and complete repeated hold and release cycles', {
  skip: !terminalTestsSupported,
  timeout: 20000,
}, async (context) => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-tty-cycle-'));
  const connectionFile = path.join(temp, 'connection.json');
  const output = path.join(temp, 'agent.log');
  const child = spawnInTerminal([
    process.execPath,
    path.join(root, 'bin', 'airbrake'),
    'run',
    '--no-open',
    '--lease-ms',
    '300',
    '--url-file',
    connectionFile,
    '--',
    process.execPath,
    path.join(root, 'test', 'fixtures', 'tty-agent.js'),
    output,
  ], temp);

  context.after(async () => {
    await stopTerminal(child);
    fs.rmSync(temp, { force: true, recursive: true });
  });

  await waitFor(() => fs.existsSync(connectionFile));
  const connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
  const token = connection.controlUrl.split('#')[1];
  const headers = { Authorization: `Bearer ${token}` };

  assert.equal(fs.existsSync(output), false);
  await fetch(`${connection.baseUrl}/api/hold/start?generation=1`, {
    method: 'POST',
    headers,
  });
  let heartbeat = setInterval(() => {
    fetch(`${connection.baseUrl}/api/hold/heartbeat?generation=1`, {
      method: 'POST',
      headers,
    }).catch(() => {});
  }, 75);
  await waitFor(() => fs.existsSync(output));
  child.stdin.write('first\n');
  await waitFor(() => fs.readFileSync(output, 'utf8').includes('first\n'));

  clearInterval(heartbeat);
  await fetch(`${connection.baseUrl}/api/hold/release?generation=2`, {
    method: 'POST',
    headers,
  });
  await sleep(200);
  const stoppedSize = fs.statSync(output).size;
  await sleep(250);
  assert.equal(fs.statSync(output).size, stoppedSize);

  await fetch(`${connection.baseUrl}/api/hold/start?generation=3`, {
    method: 'POST',
    headers,
  });
  heartbeat = setInterval(() => {
    fetch(`${connection.baseUrl}/api/hold/heartbeat?generation=3`, {
      method: 'POST',
      headers,
    }).catch(() => {});
  }, 75);
  child.stdin.write('second\n');
  await waitFor(() => fs.readFileSync(output, 'utf8').includes('second\n'));

  clearInterval(heartbeat);
  await fetch(`${connection.baseUrl}/api/hold/release?generation=4`, {
    method: 'POST',
    headers,
  });
  await sleep(200);
  child.stdin.write('\x03');
  await waitFor(() => child.exitCode !== null);
  assert.match(fs.readFileSync(output, 'utf8'), /started\nfirst\nsecond\n/);
});

test('resuming a never-armed Airbrake shell job does not start the agent', {
  skip: !terminalTestsSupported || !fs.existsSync('/bin/bash'),
  timeout: 20000,
}, async (context) => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-tty-job-'));
  const connectionFile = path.join(temp, 'connection.json');
  const marker = path.join(temp, 'executed.txt');
  const child = spawnInTerminal(
    ['/bin/bash', '--noprofile', '--norc', '-i'],
    temp,
  );

  context.after(async () => {
    await stopTerminal(child);
    fs.rmSync(temp, { force: true, recursive: true });
  });

  const command = [
    process.execPath,
    path.join(root, 'bin', 'airbrake'),
    'run',
    '--no-open',
    '--url-file',
    connectionFile,
    '--',
    '/bin/sh',
    '-c',
    `printf executed > ${shellQuote(marker)}`,
  ].map(shellQuote).join(' ');
  child.stdin.write(`${command}\n`);

  await waitFor(() => fs.existsSync(connectionFile));
  child.stdin.write('\x1a');
  await sleep(300);
  child.stdin.write('fg\n');
  await sleep(400);
  assert.equal(fs.existsSync(marker), false);

  child.stdin.write('\x03');
  await sleep(1800);
  child.stdin.write('exit\n');
  await waitFor(() => child.exitCode !== null);
  assert.equal(fs.existsSync(marker), false);
});

test('braking restores terminal controls and discards raw-mode input', {
  skip: !terminalTestsSupported,
  timeout: 20000,
}, async (context) => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-tty-raw-'));
  const connectionFile = path.join(temp, 'connection.json');
  const output = path.join(temp, 'agent.log');
  const child = spawnInTerminal([
    process.execPath,
    path.join(root, 'bin', 'airbrake'),
    'run',
    '--no-open',
    '--lease-ms',
    '300',
    '--url-file',
    connectionFile,
    '--',
    process.execPath,
    path.join(root, 'test', 'fixtures', 'raw-tty-agent.js'),
    output,
  ], temp);

  context.after(async () => {
    await stopTerminal(child);
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
  let heartbeat = setInterval(() => {
    fetch(`${connection.baseUrl}/api/hold/heartbeat?generation=1`, {
      method: 'POST',
      headers,
    }).catch(() => {});
  }, 75);
  await waitFor(() => fs.existsSync(output));
  child.stdin.write('A');
  await waitFor(() => fs.readFileSync(output, 'utf8').includes('A'));

  clearInterval(heartbeat);
  await fetch(`${connection.baseUrl}/api/hold/release?generation=2`, {
    method: 'POST',
    headers,
  });
  await sleep(200);
  child.stdin.write('queued-while-braked\n');

  await fetch(`${connection.baseUrl}/api/hold/start?generation=3`, {
    method: 'POST',
    headers,
  });
  heartbeat = setInterval(() => {
    fetch(`${connection.baseUrl}/api/hold/heartbeat?generation=3`, {
      method: 'POST',
      headers,
    }).catch(() => {});
  }, 75);
  child.stdin.write('B');
  await waitFor(() => fs.readFileSync(output, 'utf8').includes('B'));
  assert.doesNotMatch(fs.readFileSync(output, 'utf8'), /queued-while-braked/);

  clearInterval(heartbeat);
  await fetch(`${connection.baseUrl}/api/hold/release?generation=4`, {
    method: 'POST',
    headers,
  });
  await sleep(200);
  child.stdin.write('\x03');
  await waitFor(() => child.exitCode !== null);
  assert.doesNotMatch(fs.readFileSync(output, 'utf8'), /\x03/);
});

test('resume returns the terminal to an agent child foreground group', {
  skip: !terminalTestsSupported,
  timeout: 20000,
}, async (context) => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-tty-child-'));
  const connectionFile = path.join(temp, 'connection.json');
  const output = path.join(temp, 'agent.log');
  const airbrake = spawnInTerminal([
    process.execPath,
    path.join(root, 'bin', 'airbrake'),
    'run',
    '--no-open',
    '--lease-ms',
    '300',
    '--url-file',
    connectionFile,
    '--',
    'python3',
    path.join(root, 'test', 'fixtures', 'foreground-child-agent.py'),
    output,
  ], temp);
  context.after(async () => {
    await stopTerminal(airbrake);
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
  let heartbeat = setInterval(() => {
    fetch(`${connection.baseUrl}/api/hold/heartbeat?generation=1`, {
      method: 'POST',
      headers,
    }).catch(() => {});
  }, 75);
  await waitFor(() => fs.existsSync(output));
  airbrake.stdin.write('first\n');
  await waitFor(() => fs.readFileSync(output, 'utf8').includes('first\n'));
  await sleep(100);

  clearInterval(heartbeat);
  await fetch(`${connection.baseUrl}/api/hold/release?generation=2`, {
    method: 'POST',
    headers,
  });
  await sleep(200);
  await fetch(`${connection.baseUrl}/api/hold/start?generation=3`, {
    method: 'POST',
    headers,
  });
  heartbeat = setInterval(() => {
    fetch(`${connection.baseUrl}/api/hold/heartbeat?generation=3`, {
      method: 'POST',
      headers,
    }).catch(() => {});
  }, 75);
  airbrake.stdin.write('second\n');
  await waitFor(() => fs.readFileSync(output, 'utf8').includes('second\n'));

  clearInterval(heartbeat);
  await fetch(`${connection.baseUrl}/api/hold/release?generation=4`, {
    method: 'POST',
    headers,
  });
  await sleep(200);
  airbrake.stdin.write('\x03');
  await waitFor(() => airbrake.exitCode !== null);
});

test('a background Airbrake job refuses to take the terminal on hold', {
  skip: !terminalTestsSupported || !fs.existsSync('/bin/bash'),
  timeout: 20000,
}, async (context) => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-tty-background-'));
  const connectionFile = path.join(temp, 'connection.json');
  const marker = path.join(temp, 'executed.txt');
  const child = spawnInTerminal(
    ['/bin/bash', '--noprofile', '--norc', '-i'],
    temp,
  );

  context.after(async () => {
    await stopTerminal(child);
    fs.rmSync(temp, { force: true, recursive: true });
  });

  const command = [
    process.execPath,
    path.join(root, 'bin', 'airbrake'),
    'run',
    '--no-open',
    '--url-file',
    connectionFile,
    '--',
    '/bin/sh',
    '-c',
    `printf executed > ${shellQuote(marker)}`,
  ].map(shellQuote).join(' ');
  child.stdin.write(`${command}\n`);
  await waitFor(() => fs.existsSync(connectionFile));

  child.stdin.write('\x1a');
  await sleep(300);
  child.stdin.write('bg\n');
  await sleep(300);

  const connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
  const token = connection.controlUrl.split('#')[1];
  const response = await fetch(`${connection.baseUrl}/api/hold/start?generation=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 500);
  assert.equal(fs.existsSync(marker), false);

  child.stdin.write('fg\n');
  await sleep(300);
  child.stdin.write('\x03');
  await sleep(500);
  child.stdin.write('exit\n');
  await waitFor(() => child.exitCode !== null);
  assert.equal(fs.existsSync(marker), false);
});

test('terminal TOSTOP cannot suspend Airbrake while the agent runs', {
  skip: !terminalTestsSupported,
  timeout: 20000,
}, async (context) => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-tty-tostop-'));
  const connectionFile = path.join(temp, 'connection.json');
  const agentOutput = path.join(temp, 'agent.log');
  const workerOutput = path.join(temp, 'worker.log');
  const command = [
    'stty tostop;',
    'exec',
    shellQuote(process.execPath),
    shellQuote(path.join(root, 'bin', 'airbrake')),
    'run',
    '--no-open',
    '--lease-ms',
    '350',
    '--url-file',
    shellQuote(connectionFile),
    '--',
    shellQuote(process.execPath),
    shellQuote(path.join(root, 'test', 'fixtures', 'file-agent.js')),
    shellQuote(agentOutput),
    shellQuote(workerOutput),
  ].join(' ');
  const child = spawnInTerminal(['/bin/sh', '-c', command], temp);

  context.after(async () => {
    await stopTerminal(child);
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
  await waitFor(() => fs.existsSync(agentOutput) && fs.statSync(agentOutput).size > 0);

  clearInterval(heartbeat);
  await fetch(`${connection.baseUrl}/api/hold/release?generation=2`, {
    method: 'POST',
    headers,
  });
  await sleep(200);
  const stoppedSize = fs.statSync(agentOutput).size;
  await sleep(300);
  assert.equal(fs.statSync(agentOutput).size, stoppedSize);
  child.stdin.write('\x03');
  await waitFor(() => child.exitCode !== null);
});

test('slow terminal helpers do not trigger the watchdog during transitions', {
  skip: !terminalTestsSupported,
  timeout: 30000,
}, async (context) => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-tty-slow-'));
  const connectionFile = path.join(temp, 'connection.json');
  const agentOutput = path.join(temp, 'agent.log');
  const workerOutput = path.join(temp, 'worker.log');
  const child = spawnInTerminal([
    process.execPath,
    path.join(root, 'bin', 'airbrake'),
    'run',
    '--no-open',
    '--lease-ms',
    '2000',
    '--url-file',
    connectionFile,
    '--',
    process.execPath,
    path.join(root, 'test', 'fixtures', 'file-agent.js'),
    agentOutput,
    workerOutput,
  ], temp, {
    ...process.env,
    AIRBRAKE_PYTHON: path.join(root, 'test', 'fixtures', 'delayed-python.sh'),
    AIRBRAKE_TEST_PYTHON_DELAY: '0.8',
  });

  context.after(async () => {
    await stopTerminal(child);
    fs.rmSync(temp, { force: true, recursive: true });
  });

  await waitFor(() => fs.existsSync(connectionFile), 10000);
  const connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
  const token = connection.controlUrl.split('#')[1];
  const headers = { Authorization: `Bearer ${token}` };
  await fetch(`${connection.baseUrl}/api/hold/start?generation=1`, {
    method: 'POST',
    headers,
  });
  let heartbeat = setInterval(() => {
    fetch(`${connection.baseUrl}/api/hold/heartbeat?generation=1`, {
      method: 'POST',
      headers,
    }).catch(() => {});
  }, 100);
  await waitFor(
    () =>
      fs.existsSync(agentOutput) &&
      fs.existsSync(workerOutput) &&
      fs.statSync(agentOutput).size > 0 &&
      fs.statSync(workerOutput).size > 0,
    5000,
  );

  clearInterval(heartbeat);
  const release = fetch(`${connection.baseUrl}/api/hold/release?generation=2`, {
    method: 'POST',
    headers,
  });
  await sleep(150);
  const stoppedAgentSize = fs.statSync(agentOutput).size;
  const stoppedWorkerSize = fs.statSync(workerOutput).size;
  await sleep(250);
  assert.equal(fs.statSync(agentOutput).size, stoppedAgentSize);
  assert.equal(fs.statSync(workerOutput).size, stoppedWorkerSize);
  await release;
  assert.equal(child.exitCode, null);

  await fetch(`${connection.baseUrl}/api/hold/start?generation=3`, {
    method: 'POST',
    headers,
  });
  heartbeat = setInterval(() => {
    fetch(`${connection.baseUrl}/api/hold/heartbeat?generation=3`, {
      method: 'POST',
      headers,
    }).catch(() => {});
  }, 100);
  await waitFor(
    () =>
      fs.statSync(agentOutput).size > stoppedAgentSize &&
      fs.statSync(workerOutput).size > stoppedWorkerSize,
  );
  assert.equal(child.exitCode, null);

  clearInterval(heartbeat);
  await fetch(`${connection.baseUrl}/api/hold/release?generation=4`, {
    method: 'POST',
    headers,
  });
  child.stdin.write('\x03');
  await waitFor(() => child.exitCode !== null, 5000);
});
