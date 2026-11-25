/* test-pager-select.js: marking rows in a full-screen list (needs a tty: run under script/pty; skipped without one) */
import * as std from 'std';
import { isatty } from 'os';
import { Pager } from '../lib/pager.js';

if(!isatty(std.out.fileno())) {
  console.log('test-pager-select: skipped (no tty)');
  std.exit(0);
}

const check = (what, ok) => {
  if(!ok) {
    std.err.puts(`test-pager-select: ${what}\n`);
    std.exit(1);
  }
};

const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
const text = ['head', ...ids.map(i => `row ${i}`)].join('\n');
let got = null;
const p = new Pager({ title: 't', text, out: std.out, select: { ids, actions: { '\r': ['use', 'use'], e: ['explore', 'explore'] }, onAction: (n, l) => (got = [n, l]) } }).open();

p.key(' ');                  /* toggle a */
p.key('\x1b[B'); p.key('\x1b[B');   /* cursor on c */
p.key('\x1b[1;2B');          /* range c..d */
p.key('\x1b[1;2B');          /* range c..e */
check('cursor and range', p.cursor === 4 && [...p.marked].sort().join() === '0,2,3,4');
p.key('\x1b[1;2A');          /* shrinks back to c..d */
check('range shrinks', [...p.marked].sort().join() === '0,2,3');
p.key('\x1b[B');             /* a plain move ends the range, keeps the marks */
check('plain move keeps marks', p.cursor === 4 && p.marked.size === 3 && p.anchor === null);
p.key(' ');
check('space toggles', p.marked.has(4));
p.key(' ');
check('space toggles back', !p.marked.has(4));
p.key('c');
check('clear', p.marked.size === 0);
p.key('a');
check('all', p.marked.size === 6);
p.key('c');
p.key('G'); p.key('\r');     /* nothing marked: the row under the cursor */
check('enter acts on the cursor row when nothing is marked', got?.[0] === 'use' && got[1].join() === 'f' && !p.isOpen);

/* column filters: left/right focus a header, typing filters, marks survive hidden rows */
const cols = ['Model', 'Status'];
const data = [['alpha', 'READY'], ['beta', 'BUSY'], ['gamma', 'READY'], ['delta', 'BUSY']];
const fids = data.map(r => r[0]);
let got2 = null;
const build = ({ rows, focus, filters }) => ['head', ...rows.map(r => `${data[r][0]} ${data[r][1]}`)].join('\n') + `\n`.repeat(0);
const q = new Pager({ title: 'f', text: build({ rows: data.map((_, i) => i) }), out: std.out, select: { ids: fids, columns: cols, cell: (r, c) => data[r][c], build, actions: { '\r': ['use', 'use'] }, onAction: (n, l) => (got2 = [n, l]) } }).open();

q.key(' ');                                  /* mark alpha */
q.key('\x1b[C');                             /* focus Model */
check('right focuses the first column', q.focus === 0);
q.key('\x1b[C');                             /* Status */
q.key('b'); q.key('u');                      /* q, j, k, a, c are text here */
check('typing filters, letters that are keys are text', q.filters.get(1) === 'bu' && q.visible.join() === '1,3' && q.isOpen);
q.key('\x7f'); q.key('\x7f');
check('backspace removes the filter', q.filters.size === 0 && q.visible.length === 4);
q.key('r'); q.key('e');                      /* READY */
check('case-insensitive substring match', q.visible.join() === '0,2');
q.key('\x1b[D'); q.key('g');                 /* Model: g */
check('filters on two columns are ANDed', q.visible.join() === '2');
q.key('\x15');                               /* Ctrl-U clears Model */
check('ctrl-u clears the focused filter', !q.filters.has(0) && q.visible.join() === '0,2');
q.key('\x1b[B');                             /* back to the rows */
check('down leaves the header, the filter stays', q.focus === null && q.visible.join() === '0,2');
q.key('\x1b[B'); q.key(' ');                 /* cursor on gamma, mark it */
check('marks use the original rows', [...q.marked].sort().join() === '0,2');
q.key('\x1b\x1b');                           /* clears the filters, does not close */
check('esc esc in the rows clears the filters first', q.isOpen && q.filters.size === 0 && q.visible.length === 4);
q.key('\r');
check('marked rows are the result', got2?.[1].join() === 'alpha,gamma' && !q.isOpen);
std.out.puts('test-pager-select: ok\n');
