/* test-pager-rewrap.js: the pager's ScrollView keeps its wrapped lines per width (terminal.js source mode) */
import { ScrollView } from 'terminal/scrollview';
import { wrap } from 'terminal';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-pager-rewrap: ${what}`);
};

if(typeof ScrollView.prototype.setWidth !== 'function') {
  console.log('test-pager-rewrap: skipped (terminal.js has no source mode)');
} else {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'word '.repeat(20)}`);
  const v = new ScrollView(10);
  v.setWidth(40).setText(text);
  const lines40 = v.lines.length;
  check('wrapped at 40', lines40 === text.flatMap(l => wrap(l, 40)).length);

  const before = v.rewraps;
  v.resize(20).setWidth(40);
  check('a new height wraps nothing', v.rewraps === before);

  v.setWidth(80);
  check('a new width wraps again', v.rewraps > before && v.lines.length < lines40);
}
