'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const pidFile = process.argv[2];
const workerOutput = process.argv[3];
const worker = spawn(process.execPath, [require.resolve('./file-worker'), workerOutput], {
  detached: true,
  stdio: 'ignore',
});
worker.unref();
fs.writeFileSync(pidFile, `${worker.pid}\n`);

setTimeout(() => process.exit(0), 75);
