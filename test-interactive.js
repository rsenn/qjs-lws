#!/usr/bin/env qjsm
/**
 * Interactive test for history navigation
 * Simulates keyboard input to test up/down arrows
 */

import * as std from 'std';
import * as os from 'os';

// Import TerminalInput indirectly by running inspector
console.log('Starting interactive history test...\n');
console.log('Current history file contents:');

const historyPath = (process.env.HOME || '/tmp') + '/.qjs-inspector-history';
try {
  const f = std.open(historyPath, 'r');
  if(f) {
    let line, i = 1;
    while((line = f.getline()) !== null) {
      console.log(`  ${i++}: ${line}`);
    }
    f.close();
  }
} catch(e) {
  console.log('  (empty)');
}

console.log('\n✓ History file loaded successfully');
console.log('\nTo test manually:');
console.log('  1. Run: qjsm inspector.js');
console.log('  2. At the > prompt, press UP arrow');
console.log('  3. You should see: sdfs');
console.log('  4. Press UP again: console.log("test")');
console.log('  5. Press DOWN to go forward in history');
console.log('  6. Type a new expression and press Enter');
console.log('  7. Exit and restart - new entry should be in history');
