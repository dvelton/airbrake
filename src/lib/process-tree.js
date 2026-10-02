'use strict';

const { execFile } = require('node:child_process');

function listProcessRows() {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,pgid='],
      { encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(
          stdout
            .split('\n')
            .map((line) => line.trim().split(/\s+/))
            .filter((parts) => parts.length === 3)
            .map(([pid, ppid, pgid]) => ({
              pgid: Number(pgid),
              pid: Number(pid),
              ppid: Number(ppid),
            }))
            .filter(({ pgid, pid, ppid }) =>
              Number.isInteger(pgid) &&
              Number.isInteger(pid) &&
              Number.isInteger(ppid),
            ),
        );
      },
    );
  });
}

function descendantRows(rootPid, rows) {
  const children = new Map();
  for (const row of rows) {
    const siblings = children.get(row.ppid) || [];
    siblings.push(row);
    children.set(row.ppid, siblings);
  }

  const descendants = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const child of children.get(parent) || []) {
      descendants.push(child);
      queue.push(child.pid);
    }
  }
  return descendants;
}

function signalPid(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'EPERM') {
      return false;
    }
    throw error;
  }
}

function signalProcessGroup(pgid, signal) {
  if (!Number.isInteger(pgid) || pgid <= 0) {
    return false;
  }
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'EPERM') {
      return false;
    }
    throw error;
  }
}

function processState(pid) {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        if (error.code === 1) {
          resolve(null);
          return;
        }
        reject(error);
        return;
      }
      resolve(stdout.trim() || null);
    });
  });
}

async function processGroup(pid) {
  const rows = await listProcessRows();
  return rows.find((row) => row.pid === pid)?.pgid || null;
}

async function waitUntilStopped(pid, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await processState(pid);
    if (state && state.includes('T')) {
      return;
    }
    if (state === null) {
      throw new Error('The process gate exited before reaching the braked state.');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the process gate to apply the brake.');
}

async function waitUntilProcessGroup(pid, expectedPgid, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pgid = await processGroup(pid);
    if (pgid === expectedPgid) {
      return;
    }
    if (pgid === null) {
      throw new Error('The process gate exited before creating its process group.');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the process gate group.');
}

module.exports = {
  descendantRows,
  listProcessRows,
  processGroup,
  processState,
  signalPid,
  signalProcessGroup,
  waitUntilProcessGroup,
  waitUntilStopped,
};
