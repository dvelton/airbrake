'use strict';

const fs = require('node:fs');

const output = process.argv[2];
fs.appendFileSync(output, `${Date.now()}\n`);
setInterval(() => {
  fs.appendFileSync(output, `${Date.now()}\n`);
}, 20);
