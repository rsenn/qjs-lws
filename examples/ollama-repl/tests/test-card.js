/* test-card.js: a note with a bulleted list under it (piped output: the plain form) */
import { card } from '../lib/look.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-card: ${what}`);
};
const lines = card('🚀', 'takeover: model-x looks better than auto', ['why  stronger', '\x1b[31mauto\x1b[0m pauses']).split('\n');

check('title', lines[0] === 'takeover: model-x looks better than auto');
check('items indented and bulleted, colours stripped', lines[1] === '  - why  stronger' && lines[2] === '  - auto pauses');
check('no items, one line', card('✅', 'done').split('\n').length === 1);

/* an embedded colour (a model name) must survive note(): the escape intact, the name not highlighted again */
{
  const { note, paintText } = await import('../lib/look.js');
  const name = '\x1b[1m\x1b[38;2;217;70;239mgemini-3.5-flash-lite\x1b[0m';
  const out = paintText(`switching to ${name} (best rated)`, {});
  check('escape bytes kept', out.includes(name) && !/[^\x1b]\[1m/.test(out.replace(name, '')));
  check('piped note stays plain text', typeof note('x') === 'string');
}
console.log('test-card: ok');
