
// ================================  *
//   Copyright Xialia.com  2013-2026 *
//   FILE  : test/memory-watch.js
//   TYPE  : test
// ================================  *

process.env.MEMWATCH_INTERVAL = '1';
process.env.MEMWATCH_WINDOW = '5';
process.env.MEMWATCH_GROWTH_MB = '10';
process.env.MEMWATCH_ZOMBIE_AGE = '2';
process.env.MEMWATCH_ZOMBIE_MAX = '3';
process.env.MEMWATCH_COOLDOWN = '5';

const MemoryWatch = require('../memory-watch');
const Logger = require('../logger');

class LeakyComponent extends Logger { }

const retained = [];
const hoard = [];

console.log('--- initial report:', JSON.stringify(MemoryWatch.report()));

for (let i = 0; i < 10; i++) {
  let c = new LeakyComponent();
  c.stop();
  retained.push(c);
}

let leaker = setInterval(() => {
  hoard.push(Buffer.alloc(4 * 1024 * 1024, 1));
}, 1000);

setTimeout(() => {
  clearInterval(leaker);
  let report = MemoryWatch.report();
  console.log('--- final report:', JSON.stringify(report, null, 2));
  let ok = report.enabled && report.tracking
    && report.topLive.some((r) => r.name === 'LeakyComponent');
  if (ok) {
    console.log('memory-watch: OK');
    process.exit(0);
  }
  console.error('memory-watch: FAILED');
  process.exit(1);
}, 15000);
