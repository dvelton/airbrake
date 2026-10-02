'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { install, projectRoot } = require('../src/lib/installer');

test('installer copies Airbrake without npm and creates a command symlink', (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-install-'));
  context.after(() => fs.rmSync(home, { force: true, recursive: true }));

  const result = install({ home, source: projectRoot() });
  assert.equal(fs.existsSync(path.join(result.installDir, 'src', 'cli.js')), true);
  assert.equal(fs.lstatSync(result.binPath).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(result.installDir, '.git')), false);
});
