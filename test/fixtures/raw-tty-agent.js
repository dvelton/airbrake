'use strict';

const fs = require('node:fs');

const output = process.argv[2];

fs.appendFileSync(output, 'started\n');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(output, chunk);
});
setInterval(() => {}, 1000);
