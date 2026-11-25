/* test-verbose.js: verbose-only output (kind 1) stays out of the compact view, also when written without a kind under Tui.kind (inKind in repl.js) */
import { open } from 'std';
import { Tui } from '../lib/tui.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-verbose: ${what}`);
};
const plain = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const tui = new Tui({ status: () => 'status', out: open('/tmp/ollama-repl-test-verbose.out', 'w'), mouse: false });
tui.start();
const lines = () => tui.transcript.map(plain);
const has = s => lines().some(l => l.includes(s));

/* the same as inKind() in repl.js */
const inKind = (kind, fn) => {
  tui.kind = kind;
  try {
    return fn();
  } finally {
    tui.kind = 0;
  }
};

inKind(1, () => tui.write('RAW assistant panel read_file {"path":"x.js"}\n')); /* what console.log does: stdout.puts is Tui.write(text) */
tui.write('hello\n');
check('verbose off: plain text shown', has('hello'));
check('verbose off: raw panel hidden', !has('RAW assistant panel'));
tui.setVerbose(true);
check('verbose on: raw panel shown', has('RAW assistant panel'));
tui.setVerbose(false);
check('verbose off again: raw panel hidden', !has('RAW assistant panel'));

tui.write('explicit\n', 1);
tui.write('after explicit\n');
check('an explicit kind is for that write only', has('after explicit'));
check('explicit kind 1 hidden in the compact view', !lines().includes('explicit'));

tui.close();
console.log('test-verbose: ok');
