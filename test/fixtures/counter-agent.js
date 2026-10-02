'use strict';

let count = 0;
console.log('Airbrake demo agent started.');
setInterval(() => {
  count += 1;
  console.log(`agent tick ${count}`);
}, 250);
