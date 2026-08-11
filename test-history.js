#!/usr/bin/env qjsm
/**
 * Test history file I/O
 */
import * as std from 'std';

const historyPath = (process.env.HOME || '/tmp') + '/.qjs-inspector-history';
console.log('History path:', historyPath);

// Write test history
console.log('\nWriting test history...');
const f = std.open(historyPath, 'w');
f.puts('document.querySelector("body")\n');
f.puts('console.log("test")\n');
f.puts('window.location.href\n');
f.close();
console.log('✓ History file created');

// Read it back
console.log('\nReading history file...');
const f2 = std.open(historyPath, 'r');
let line, count = 0;
while((line = f2.getline()) !== null) {
  count++;
  console.log(`  ${count}: ${line}`);
}
f2.close();
console.log(`✓ ${count} entries loaded`);

console.log('\nHistory I/O works correctly.');
console.log('Run inspector.js interactively to test up/down arrow navigation.');
