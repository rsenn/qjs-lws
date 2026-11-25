/* test-pane-scroll.js: the split pane scrolls by itself (wheel over it, Shift-PgUp/PgDn), the offset stays within its lines */
import { open } from 'std';
import { Tui } from './lib/tui.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-pane-scroll: ${what}`);
};

const out = open('/tmp/ollama-repl-test-pane.out', 'w');
const tui = new Tui({ status: () => 'status', out, mouse: false });
tui.start();
const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
const height = () => tui.top - 1;

if(!tui.setPane(() => lines)) {
  console.log('test-pane-scroll: skipped (terminal under 80 columns)');
} else {
  check('starts at the top', tui.paneOff === 0 && tui.paneMax === 100 - height());
  check('scrolls down', tui.scrollPane(3) && tui.paneOff === 3);
  check('does not go above the first line', tui.scrollPane(-10) && tui.paneOff === 0 && !tui.scrollPane(-1));
  check('does not go below the last line', tui.scrollPane(1000) && tui.paneOff === tui.paneMax && !tui.scrollPane(1));
  tui.setPane(() => lines.slice(0, 10));
  check('a new pane starts at the top', tui.paneOff === 0);
  check('a short pane does not scroll', !tui.scrollPane(5));
  console.log('test-pane-scroll: ok');
}

tui.close();
