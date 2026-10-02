'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function projectRoot() {
  return path.resolve(__dirname, '..', '..');
}

function install({ home = os.homedir(), source = projectRoot() } = {}) {
  const installDir = path.join(home, '.local', 'share', 'airbrake');
  const binDir = path.join(home, '.local', 'bin');
  const binPath = path.join(binDir, 'airbrake');
  const sourceReal = fs.realpathSync(source);

  if (fs.existsSync(installDir) && fs.realpathSync(installDir) === sourceReal) {
    return { binPath: path.join(sourceReal, 'bin', 'airbrake'), installDir: sourceReal };
  }

  fs.rmSync(installDir, { force: true, recursive: true });
  fs.mkdirSync(path.dirname(installDir), { recursive: true });
  fs.cpSync(sourceReal, installDir, {
    recursive: true,
    filter: (entry) => {
      const relative = path.relative(sourceReal, entry);
      const first = relative.split(path.sep)[0];
      return first !== '.git' && first !== 'dist' && first !== 'node_modules';
    },
  });

  fs.mkdirSync(binDir, { recursive: true });
  fs.rmSync(binPath, { force: true });
  fs.symlinkSync(path.join(installDir, 'bin', 'airbrake'), binPath);
  fs.chmodSync(path.join(installDir, 'bin', 'airbrake'), 0o755);

  return { binPath, installDir };
}

module.exports = { install, projectRoot };
