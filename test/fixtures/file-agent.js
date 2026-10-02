'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const output = process.argv[2];
const workerOutput = process.argv[3];

spawn(process.execPath, [require.resolve('./file-worker'), workerOutput], {
  detached: true,
  stdio: 'ignore',
}).unref();

setInterval(() => {
  fs.appendFileSync(output, `${Date.now()}\n`);
}, 20);
