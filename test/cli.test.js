'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { commandExists, parseRunArgs } = require('../src/cli');

test('run argument parser separates Airbrake options from agent arguments', () => {
  const parsed = parseRunArgs([
    '--no-open',
    '--lease-ms',
    '500',
    '--chord',
    'ShiftLeft+Space',
    '--cwd',
    '/tmp',
    '--',
    'claude',
    '--model',
    'opus',
  ]);

  assert.equal(parsed.command, 'claude');
  assert.deepEqual(parsed.commandArgs, ['--model', 'opus']);
  assert.deepEqual(parsed.options.chord, ['ShiftLeft', 'Space']);
  assert.equal(parsed.options.leaseMs, 500);
  assert.equal(parsed.options.noOpen, true);
  assert.equal(parsed.options.cwd, '/tmp');
});

test('run argument parser requires a command separator', () => {
  assert.throws(() => parseRunArgs(['claude']), /Expected --/);
});

test('command lookup rejects a missing executable before starting a session', () => {
  assert.equal(commandExists(process.execPath, process.cwd()), true);
  assert.equal(
    commandExists('airbrake-command-that-does-not-exist', process.cwd()),
    false,
  );
});

test('lease option rejects values below the supported response window', () => {
  assert.throws(
    () => parseRunArgs(['--lease-ms', '299', '--', process.execPath]),
    /between 300 and 5000/,
  );
});

test('command lookup resolves relative PATH entries against the requested cwd', (context) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-path-'));
  const bin = path.join(cwd, 'bin');
  const command = path.join(bin, 'agent');
  fs.mkdirSync(bin);
  fs.writeFileSync(command, '#!/bin/sh\n');
  fs.chmodSync(command, 0o755);
  context.after(() => fs.rmSync(cwd, { force: true, recursive: true }));

  assert.equal(commandExists('agent', cwd, { PATH: 'bin' }), true);
});
