'use strict';

const { spawn } = require('node:child_process');

function browserCommand(url) {
  if (process.platform === 'darwin') {
    return { command: 'open', args: [url] };
  }
  if (process.platform === 'linux') {
    return { command: 'xdg-open', args: [url] };
  }
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', url] };
  }
  return null;
}

function openBrowser(url, { onError = () => {} } = {}) {
  const spec = browserCommand(url);
  if (!spec) {
    return false;
  }
  const child = spawn(spec.command, spec.args, {
    detached: true,
    stdio: 'ignore',
  });
  child.once('error', onError);
  child.once('exit', (code) => {
    if (code !== 0) {
      onError(new Error(`Browser opener exited with code ${code}.`));
    }
  });
  child.unref();
  return true;
}

module.exports = { browserCommand, openBrowser };
