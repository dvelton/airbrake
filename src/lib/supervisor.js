'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const {
  descendantRows,
  listProcessRows,
  processGroup,
  signalPid,
  signalProcessGroup,
  waitUntilProcessGroup,
  waitUntilStopped,
} = require('./process-tree');

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class ProcessSupervisor extends EventEmitter {
  constructor({
    command,
    args,
    env,
    cwd,
    processScanner = listProcessRows,
    processGroupLookup = processGroup,
  }) {
    super();
    this.agentPgid = null;
    this.agentTerminalState = null;
    this.airbrakePgid = null;
    this.args = args;
    this.child = null;
    this.command = command;
    this.cwd = cwd;
    this.desiredArmed = false;
    this.env = env;
    this.gateFile = null;
    this.gatePid = null;
    this.gateReleased = false;
    this.initialTerminalState = null;
    this.monitor = null;
    this.processScanner = processScanner;
    this.processGroupLookup = processGroupLookup;
    this.python = env.AIRBRAKE_PYTHON || 'python3';
    this.refreshPromise = null;
    this.watchdogHeartbeat = null;
    this.resumePgid = null;
    this.state = 'not-started';
    this.startPromise = null;
    this.tempDir = null;
    this.terminating = false;
    this.trackedPgids = new Set();
    this.transition = Promise.resolve();
    this.transitionVersion = 0;
    this.ttyGateScript = path.join(__dirname, '..', 'tty-gate.py');
    this.ttyMode = Boolean(process.stdin.isTTY);
    this.watchdogPipe = null;
    this.watchdogFile = null;
    this.watchdogClosed = false;
    this.watchdogPgid = null;
    this.watchdogPid = null;
  }

  start() {
    if (!this.startPromise) {
      this.startPromise = this.performStart();
    }
    return this.startPromise;
  }

  async performStart() {
    if (process.platform === 'win32') {
      throw new Error('The hard-pause supervisor currently supports macOS and Linux.');
    }
    if (this.child) {
      throw new Error('The supervised process is already running.');
    }

    this.airbrakePgid = await this.processGroupLookup(process.pid);
    this.throwIfTerminating();
    if (!this.airbrakePgid) {
      throw new Error('Could not determine the Airbrake process group.');
    }

    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-'));
    this.gateFile = path.join(this.tempDir, 'authorized');
    if (this.ttyMode) {
      this.initialTerminalState = path.join(this.tempDir, 'terminal-initial.json');
      this.agentTerminalState = path.join(this.tempDir, 'terminal-agent.json');
      await this.runTtyHelper(['capture', this.initialTerminalState]);
      this.throwIfTerminating();
    }
    this.watchdogFile = path.join(this.tempDir, 'watchdog');

    this.child = spawn(
      this.python,
      [
        this.ttyGateScript,
        'run',
        this.gateFile,
        String(process.pid),
        this.watchdogFile,
        this.command,
        ...this.args,
      ],
      {
        cwd: this.cwd,
        env: this.env,
        stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
      },
    );

    this.gatePid = this.child.pid;
    this.agentPgid = this.gatePid;
    this.resumePgid = this.agentPgid;
    this.trackedPgids.add(this.agentPgid);
    this.watchdogPipe = this.child.stdio[3];
    this.watchdogPipe.on('error', (error) => {
      if (
        error.code !== 'EPIPE' &&
        error.code !== 'ERR_STREAM_WRITE_AFTER_END' &&
        !this.terminating
      ) {
        this.emit('error', error);
      }
    });

    await new Promise((resolve, reject) => {
      this.child.once('spawn', resolve);
      this.child.once('error', reject);
    });
    this.throwIfTerminating();

    await waitUntilProcessGroup(this.gatePid, this.agentPgid);
    const watchdog = await this.waitForWatchdog();
    this.watchdogPid = watchdog.pid;
    this.watchdogPgid = watchdog.pgid;
    this.throwIfTerminating();
    this.syncWatchdogGroups();

    this.state = 'braked';
    this.emit('state', this.state);

    this.child.on('error', (error) => this.emit('error', error));
    this.child.on('exit', async (code, signal) => {
      this.stopMonitor();
      this.stopWatchdogPings();
      this.state = 'exited';
      this.emit('state', this.state);
      await this.refreshTrackedGroups().catch(() => {});
      this.signalTrackedGroups('SIGKILL');
      await sleep(50);
      this.closeWatchdogPipe();
      await this.restoreTerminal().catch(() => {});
      this.cleanupTemporaryFiles();
      this.emit('exit', { code, signal });
    });

    return this.gatePid;
  }

  setArmed(armed) {
    if (this.terminating) {
      return this.transition;
    }

    this.desiredArmed = armed;
    const version = ++this.transitionVersion;
    const isCurrent = () =>
      !this.terminating &&
      version === this.transitionVersion &&
      this.desiredArmed === armed;

    this.transition = this.transition
      .catch(() => {})
      .then(async () => {
        if (this.startPromise) {
          await this.startPromise;
        }
        if (!isCurrent()) {
          return;
        }
        if (armed) {
          await this.resume(isCurrent);
        } else {
          await this.pause();
        }
      });
    return this.transition;
  }

  async pause({ force = false } = {}) {
    if (
      !this.child ||
      this.state === 'exited' ||
      (!force && this.state === 'braked')
    ) {
      return;
    }

    this.stopMonitor();
    this.signalTrackedGroups('SIGSTOP');
    let discoveryError = null;
    for (let pass = 0; pass < 2; pass += 1) {
      await this.refreshTrackedGroups().catch((error) => {
        discoveryError ||= error;
      });
      this.signalTrackedGroups('SIGSTOP');
      await sleep(10);
    }

    let foregroundPgid = null;
    if (this.ttyMode) {
      foregroundPgid = await this.currentForegroundPgid().catch(() => null);
      if (foregroundPgid && this.trackedPgids.has(foregroundPgid)) {
        this.resumePgid = foregroundPgid;
      }
    }

    await waitUntilStopped(this.gatePid).catch((error) => {
      discoveryError ||= error;
    });
    if (
      this.ttyMode &&
      foregroundPgid &&
      this.trackedPgids.has(foregroundPgid)
    ) {
      await this.runTtyHelper([
        'reclaim',
        String(foregroundPgid),
        String(this.airbrakePgid),
        this.initialTerminalState,
        this.agentTerminalState,
      ]).catch((error) => {
        discoveryError ||= error;
        return this.restoreTerminal().catch(() => {});
      });
    } else if (this.ttyMode && foregroundPgid === this.airbrakePgid) {
      await this.restoreTerminal().catch((error) => {
        discoveryError ||= error;
      });
    }

    await this.refreshTrackedGroups().catch((error) => {
      discoveryError ||= error;
    });
    this.signalTrackedGroups('SIGSTOP');

    if (this.ttyMode) {
      const lateForegroundPgid = await this.currentForegroundPgid().catch(() => null);
      if (
        lateForegroundPgid &&
        lateForegroundPgid !== this.airbrakePgid &&
        this.trackedPgids.has(lateForegroundPgid)
      ) {
        this.resumePgid = lateForegroundPgid;
        await this.runTtyHelper([
          'reclaim',
          String(lateForegroundPgid),
          String(this.airbrakePgid),
          this.initialTerminalState,
          this.agentTerminalState,
        ]).catch((error) => {
          discoveryError ||= error;
          return this.restoreTerminal().catch(() => {});
        });
      }
    }

    const changed = this.state !== 'braked';
    this.state = 'braked';
    this.setWatchdogState('BRAKED');
    this.stopWatchdogPings();
    if (changed) {
      this.emit('state', this.state);
    }
    if (discoveryError) {
      throw discoveryError;
    }
  }

  async resume(isCurrent = () => true) {
    if (!this.child || this.state === 'running' || this.state === 'exited') {
      return;
    }

    this.trackedPgids.add(this.agentPgid);
    this.syncWatchdogGroups();

    try {
      await this.refreshTrackedGroups();
      if (!isCurrent()) {
        return;
      }
      this.startWatchdogPings();
      this.setWatchdogState('RUNNING');
      if (this.ttyMode) {
        const terminalState = fs.existsSync(this.agentTerminalState)
          ? this.agentTerminalState
          : this.initialTerminalState;
        const targetPgid = this.trackedPgids.has(this.resumePgid)
          ? this.resumePgid
          : this.agentPgid;
        await this.runTtyHelper([
          'handoff',
          String(this.airbrakePgid),
          String(targetPgid),
          terminalState,
        ]);
        if (!isCurrent()) {
          await this.restoreTerminal();
          this.setWatchdogState('BRAKED');
          this.stopWatchdogPings();
          return;
        }
      }

      if (!this.gateReleased) {
        if (!isCurrent()) {
          this.setWatchdogState('BRAKED');
          this.stopWatchdogPings();
          return;
        }
        fs.writeFileSync(this.gateFile, 'go\n', { mode: 0o600 });
        this.gateReleased = true;
        this.signalTrackedGroups('SIGCONT');
      } else {
        this.signalTrackedGroups('SIGCONT');
      }

      this.state = 'running';
      this.emit('state', this.state);
      if (!isCurrent()) {
        await this.pause({ force: true });
        return;
      }
      this.startMonitor();
    } catch (error) {
      this.signalTrackedGroups('SIGSTOP');
      await this.restoreTerminal().catch(() => {});
      this.stopMonitor();
      this.state = 'braked';
      this.setWatchdogState('BRAKED');
      this.stopWatchdogPings();
      throw error;
    }
  }

  async terminate() {
    this.terminating = true;
    this.desiredArmed = false;
    this.transitionVersion += 1;
    if (!this.child) {
      this.cleanupTemporaryFiles();
      return;
    }
    await this.transition.catch(() => {});
    this.stopMonitor();
    this.stopWatchdogPings();
    await this.refreshTrackedGroups().catch(() => {});
    this.signalTrackedGroups('SIGSTOP');
    await this.restoreTerminal().catch(() => {});
    this.closeWatchdogPipe();
    this.signalTrackedGroups('SIGKILL');
    signalPid(this.gatePid, 'SIGKILL');
    this.cleanupTemporaryFiles();
  }

  async refreshTrackedGroups() {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    const refresh = this.performRefreshTrackedGroups();
    const wrapped = refresh.finally(() => {
      if (this.refreshPromise === wrapped) {
        this.refreshPromise = null;
      }
    });
    this.refreshPromise = wrapped;
    return this.refreshPromise;
  }

  async performRefreshTrackedGroups() {
    if (!this.agentPgid) {
      return;
    }
    const rows = await this.processScanner();
    const currentPgids = new Set(rows.map((row) => row.pgid));
    const excludedPgids = new Set(
      rows
        .filter((row) => row.pid === process.pid)
        .map((row) => row.pgid),
    );
    if (this.watchdogPgid) {
      excludedPgids.add(this.watchdogPgid);
    }
    const next = new Set(
      [...this.trackedPgids].filter((pgid) => currentPgids.has(pgid)),
    );
    next.add(this.agentPgid);
    for (const row of descendantRows(this.gatePid, rows)) {
      if (row.pgid > 0 && !excludedPgids.has(row.pgid)) {
        next.add(row.pgid);
      }
    }
    this.trackedPgids = next;
    this.syncWatchdogGroups();
  }

  signalTrackedGroups(signal) {
    for (const pgid of this.trackedPgids) {
      signalProcessGroup(pgid, signal);
    }
  }

  syncWatchdogGroups() {
    if (
      this.watchdogClosed ||
      !this.watchdogPipe ||
      this.watchdogPipe.destroyed ||
      this.watchdogPipe.writableEnded
    ) {
      return;
    }
    this.watchdogPipe.write(`GROUPS ${[...this.trackedPgids].join(',')}\n`);
  }

  setWatchdogState(state) {
    if (
      !this.watchdogClosed &&
      this.watchdogPipe &&
      !this.watchdogPipe.destroyed &&
      !this.watchdogPipe.writableEnded
    ) {
      this.watchdogPipe.write(`STATE ${state}\n`);
    }
  }

  pingWatchdog() {
    if (
      !this.watchdogClosed &&
      this.watchdogPipe &&
      !this.watchdogPipe.destroyed &&
      !this.watchdogPipe.writableEnded
    ) {
      this.watchdogPipe.write('PING\n');
    }
  }

  closeWatchdogPipe() {
    this.watchdogClosed = true;
    if (
      this.watchdogPipe &&
      !this.watchdogPipe.destroyed &&
      !this.watchdogPipe.writableEnded
    ) {
      this.watchdogPipe.end();
    }
  }

  startMonitor() {
    this.stopMonitor();
    this.monitor = setInterval(() => {
      this.refreshTrackedGroups().catch((error) => {
        if (!this.terminating) {
          this.emit('error', error);
        }
      });
    }, 25);
  }

  stopMonitor() {
    clearInterval(this.monitor);
    this.monitor = null;
  }

  startWatchdogPings() {
    if (this.watchdogHeartbeat) {
      return;
    }
    this.pingWatchdog();
    this.watchdogHeartbeat = setInterval(() => {
      this.pingWatchdog();
    }, 100);
  }

  stopWatchdogPings() {
    clearInterval(this.watchdogHeartbeat);
    this.watchdogHeartbeat = null;
  }

  async currentForegroundPgid() {
    const result = await this.runTtyHelper(['current']);
    const pgid = Number(result.stdout.trim());
    return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
  }

  async restoreTerminal() {
    if (!this.ttyMode || !this.airbrakePgid || !this.initialTerminalState) {
      return;
    }
    await this.runTtyHelper([
      'restore',
      String(this.airbrakePgid),
      this.initialTerminalState,
      [...this.trackedPgids].join(','),
    ]);
  }

  async runTtyHelper(args) {
    return new Promise((resolve, reject) => {
      const helper = spawn(
        this.python,
        [this.ttyGateScript, ...args],
        { stdio: ['inherit', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      helper.stdout.setEncoding('utf8');
      helper.stderr.setEncoding('utf8');
      helper.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      helper.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      helper.once('error', reject);
      helper.once('exit', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(stderr.trim() || `Terminal helper exited with code ${code}.`));
        }
      });
    });
  }

  async waitForWatchdog(timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const [pid, pgid] = fs.readFileSync(this.watchdogFile, 'utf8')
          .trim()
          .split(/\s+/)
          .map(Number);
        if (
          Number.isInteger(pid) &&
          pid > 0 &&
          Number.isInteger(pgid) &&
          pgid > 0
        ) {
          return { pid, pgid };
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
      await sleep(10);
    }
    throw new Error('Timed out waiting for the isolated watchdog process.');
  }

  throwIfTerminating() {
    if (this.terminating) {
      this.cleanupTemporaryFiles();
      const error = new Error('Airbrake startup was cancelled.');
      error.code = 'AIRBRAKE_STARTUP_CANCELLED';
      throw error;
    }
  }

  cleanupTemporaryFiles() {
    if (this.tempDir) {
      fs.rmSync(this.tempDir, { force: true, recursive: true });
      this.tempDir = null;
    }
  }
}

module.exports = { ProcessSupervisor };
