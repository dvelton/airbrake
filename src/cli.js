'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { adapterStatus, installAdapters, uninstallAdapters } = require('./lib/adapters');
const {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_MS,
  MAX_LEASE_MS,
  MIN_LEASE_MS,
  VERSION,
} = require('./lib/constants');
const { ControlServer } = require('./lib/control-server');
const { runHook } = require('./lib/hook');
const { install } = require('./lib/installer');
const { PresenceLease } = require('./lib/lease');
const { openBrowser } = require('./lib/open-browser');
const { ProcessSupervisor } = require('./lib/supervisor');

function usage() {
  return `Airbrake ${VERSION}

Proof-of-concept hold-to-run supervision for local coding agents.

Usage:
  airbrake run [options] -- <command> [args...]
  airbrake demo [options]
  airbrake hook
  airbrake adapters install [all|copilot|codex|claude|gemini]
  airbrake adapters uninstall [all|copilot|codex|claude|gemini]
  airbrake adapters status
  airbrake install
  airbrake doctor
  airbrake version

Run options:
  --no-open             Print the control URL without opening a browser.
  --lease-ms <number>   Lease timeout in milliseconds (${DEFAULT_LEASE_MS}).
  --chord <codes>       Browser key chord, such as ShiftLeft+Space.
  --url-file <path>     Write control connection details as JSON.
  --cwd <path>          Working directory for the agent command.
`;
}

function parseRunArgs(args) {
  const separator = args.indexOf('--');
  if (separator === -1 || separator === args.length - 1) {
    throw new Error('Expected -- followed by the agent command.');
  }

  const options = {
    chord: ['Space'],
    cwd: process.cwd(),
    leaseMs: DEFAULT_LEASE_MS,
    noOpen: false,
    urlFile: null,
  };

  for (let index = 0; index < separator; index += 1) {
    const arg = args[index];
    if (arg === '--no-open') {
      options.noOpen = true;
    } else if (arg === '--chord') {
      const chord = args[++index] || '';
      if (!/^[A-Za-z0-9]+(?:\+[A-Za-z0-9]+)*$/.test(chord)) {
        throw new Error('--chord must contain KeyboardEvent.code names joined by +.');
      }
      options.chord = chord.split('+');
    } else if (arg === '--lease-ms') {
      options.leaseMs = Number(args[++index]);
    } else if (arg === '--url-file') {
      options.urlFile = path.resolve(args[++index]);
    } else if (arg === '--cwd') {
      options.cwd = path.resolve(args[++index]);
    } else {
      throw new Error(`Unknown run option: ${arg}`);
    }
  }

  if (
    !Number.isFinite(options.leaseMs) ||
    options.leaseMs < MIN_LEASE_MS ||
    options.leaseMs > MAX_LEASE_MS
  ) {
    throw new Error(`--lease-ms must be between ${MIN_LEASE_MS} and ${MAX_LEASE_MS}.`);
  }

  return {
    command: args[separator + 1],
    commandArgs: args.slice(separator + 2),
    options,
  };
}

function commandExists(command, cwd, env = process.env) {
  const candidates = command.includes(path.sep)
    ? [path.isAbsolute(command) ? command : path.resolve(cwd, command)]
    : (env.PATH || '')
      .split(path.delimiter)
      .map((directory) => path.join(
        path.isAbsolute(directory) ? directory : path.resolve(cwd, directory || '.'),
        command,
      ));
  return candidates.some((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

async function runSession(args) {
  const { command, commandArgs, options } = parseRunArgs(args);
  if (!commandExists(command, options.cwd)) {
    const error = new Error(`Command not found or not executable: ${command}`);
    error.exitCode = 127;
    throw error;
  }
  const lease = new PresenceLease({ leaseMs: options.leaseMs });
  let supervisor;
  let shuttingDown = false;
  let cleanupPromise = null;
  const ignoreClosedTerminal = (error) => {
    if (error.code !== 'EIO' && error.code !== 'EPIPE') {
      process.exitCode = 1;
    }
  };
  process.stderr.on('error', ignoreClosedTerminal);

  const displayCommand = [command, ...commandArgs].join(' ');
  const server = new ControlServer({
    chord: options.chord,
    command: displayCommand,
    heartbeatMs: DEFAULT_HEARTBEAT_MS,
    lease,
    onError: (error) => {
      console.error(`[airbrake] control error: ${error.message}`);
    },
    onLeaseChange: async (armed, snapshot) => {
      if (supervisor) {
        await supervisor.setArmed(armed);
      }
      console.error(`[airbrake] ${armed ? 'ARMED' : 'BRAKED'} (${snapshot.reason})`);
    },
  });

  const connection = await server.start();
  const childEnv = {
    ...process.env,
    AIRBRAKE_READ_TOKEN: connection.readToken,
    AIRBRAKE_SESSION_ID: connection.sessionId,
    AIRBRAKE_URL: connection.baseUrl,
  };

  supervisor = new ProcessSupervisor({
    args: commandArgs,
    command,
    cwd: options.cwd,
    env: childEnv,
  });

  const cleanup = async (exitCode = 0) => {
    if (cleanupPromise) {
      return cleanupPromise;
    }
    shuttingDown = true;
    cleanupPromise = (async () => {
      await Promise.all([
        server.close().catch((error) => {
          console.error(`[airbrake] control shutdown error: ${error.message}`);
        }),
        supervisor.terminate().catch((error) => {
          console.error(`[airbrake] process shutdown error: ${error.message}`);
        }),
      ]);
      process.exitCode = exitCode;
    })();
    return cleanupPromise;
  };

  const onSigint = () => cleanup(130);
  const onSigterm = () => cleanup(143);
  const onSighup = () => cleanup(129);
  const onSigquit = () => cleanup(131);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  process.once('SIGHUP', onSighup);
  process.once('SIGQUIT', onSigquit);

  supervisor.on('state', (state) => {
    if (state === 'running' || state === 'braked') {
      console.error(`[airbrake] agent process ${state}`);
    }
  });
  supervisor.on('error', (error) => {
    console.error(`[airbrake] agent process error: ${error.message}`);
  });
  const exitPromise = new Promise((resolve) => supervisor.once('exit', resolve));

  try {
    await supervisor.start();

    if (options.urlFile) {
      fs.mkdirSync(path.dirname(options.urlFile), { recursive: true });
      fs.writeFileSync(
        options.urlFile,
        `${JSON.stringify(connection, null, 2)}\n`,
        { mode: 0o600 },
      );
    }

    console.error(`[airbrake] control: ${connection.controlUrl}`);
    console.error('[airbrake] agent starts braked; hold the browser control to run it');
    if (!options.noOpen && !openBrowser(connection.controlUrl, {
      onError: (error) => {
        console.error(`[airbrake] browser could not be opened automatically: ${error.message}`);
      },
    })) {
      console.error('[airbrake] browser could not be opened automatically');
    }

    const { code, signal } = await exitPromise;
    if (cleanupPromise) {
      await cleanupPromise;
    } else {
      shuttingDown = true;
      await server.close();
      process.exitCode = typeof code === 'number' ? code : signal ? 1 : 0;
    }
  } catch (error) {
    if (shuttingDown) {
      if (cleanupPromise) {
        await cleanupPromise;
      }
      return;
    }
    await cleanup(1);
    throw error;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGHUP', onSighup);
    process.removeListener('SIGQUIT', onSigquit);
    process.stderr.removeListener('error', ignoreClosedTerminal);
  }
}

async function runDemo(args) {
  const fixture = path.join(__dirname, '..', 'test', 'fixtures', 'counter-agent.js');
  return runSession([...args, '--', process.execPath, fixture]);
}

function printAdapterResults(results) {
  for (const result of results) {
    console.log(`${result.adapter.padEnd(8)} ${result.installed ? 'installed' : 'not installed'}  ${result.file}`);
    if (result.note) {
      console.log(`         ${result.note}`);
    }
  }
}

function doctor() {
  const major = Number(process.versions.node.split('.')[0]);
  const python = process.env.AIRBRAKE_PYTHON || 'python3';
  const pythonCheck = spawnSync(python, ['--version'], { encoding: 'utf8' });
  const pythonVersion = (pythonCheck.stdout || pythonCheck.stderr || python).trim();
  const checks = [
    ['Node.js 20 or later', major >= 20, process.version],
    ['Supported hard-pause operating system', process.platform === 'darwin' || process.platform === 'linux', process.platform],
    ['Python 3', pythonCheck.status === 0, pythonVersion],
    ['ps command', fs.existsSync('/bin/ps') || fs.existsSync('/usr/bin/ps'), process.platform],
  ];
  for (const [name, okay, detail] of checks) {
    console.log(`${okay ? 'PASS' : 'FAIL'}  ${name} (${detail})`);
  }
  printAdapterResults(adapterStatus());
  if (checks.some(([, okay]) => !okay)) {
    process.exitCode = 1;
  }
}

async function main(args) {
  const command = args[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(VERSION);
    return;
  }

  if (command === 'run') {
    await runSession(args.slice(1));
    return;
  }

  if (command === 'demo') {
    await runDemo(args.slice(1));
    return;
  }

  if (command === 'hook') {
    const output = await runHook();
    if (Object.keys(output).length > 0) {
      console.log(JSON.stringify(output));
    }
    return;
  }

  if (command === 'adapters') {
    const action = args[1] || 'status';
    const name = args[2] || 'all';
    if (action === 'install') {
      printAdapterResults(installAdapters(name));
      return;
    }
    if (action === 'uninstall') {
      printAdapterResults(uninstallAdapters(name));
      return;
    }
    if (action === 'status') {
      printAdapterResults(adapterStatus());
      return;
    }
    throw new Error(`Unknown adapters action: ${action}`);
  }

  if (command === 'install') {
    const result = install();
    console.log(`Installed Airbrake in ${result.installDir}`);
    console.log(`Command: ${result.binPath}`);
    if (!(process.env.PATH || '').split(path.delimiter).includes(path.dirname(result.binPath))) {
      console.log(`Add ${path.dirname(result.binPath)} to PATH.`);
    }
    return;
  }

  if (command === 'doctor') {
    doctor();
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

module.exports = {
  commandExists,
  main,
  parseRunArgs,
  runSession,
  usage,
};
