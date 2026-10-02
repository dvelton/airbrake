'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  if (!fs.existsSync(file)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const backup = `${file}.airbrake-backup`;
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(file, backup);
    }
  }
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

module.exports = { readJson, writeJson };
