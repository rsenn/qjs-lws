/* test-session-browser.js: the layout and texts of the session browser (no terminal needed) */
import { splitHeights, scrollOffset, columnWidths, rowText, detailLines, transcriptText, ageText } from '../lib/tui/session-browser.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-session-browser: ${what}`);
};

/* heights: header, rule and key line take 3; list about 45%, details at least 6 */
for(const rows of [10, 14, 24, 40, 60]) {
  const h = splitHeights(rows);
  check(`heights ${rows}`, h.list >= 3 && h.list + h.detail === Math.max(2, rows - 3) && (h.detail >= 6 || rows < 12));
}
check('24 rows', splitHeights(24).list === 9 && splitHeights(24).detail === 12);

/* scrolling keeps the cursor in the window and the window inside the list */
check('cursor below', scrollOffset(12, 0, 5, 30) === 8);
check('cursor above', scrollOffset(2, 10, 5, 30) === 2);
check('stays', scrollOffset(7, 5, 5, 30) === 5);
check('never past the end', scrollOffset(29, 0, 5, 30) === 25 && scrollOffset(0, 40, 5, 30) === 0);
check('short list', scrollOffset(3, 0, 10, 4) === 0);

check('age', ageText(5e3) === '5s' && ageText(5 * 60e3) === '5m' && ageText(3 * 3600e3) === '3h' && ageText(40 * 86400e3) === '40d');

/* columns: wide gets everything, narrow loses project then model, the row never exceeds the width */
const sessions = [
  { key: 'ollama-repl-1k3f9a', at: Date.now() - 3600e3, messages: 44, model: 'qwen-3.8-27b', root: '/home/u/Sources/p', title: 'Bounded task: create tests/x.js' },
  { key: 'x', at: Date.now() - 86400e3 * 3 },
];
for(const cols of [60, 80, 120, 200]) {
  const w = columnWidths(cols, sessions);
  const t = rowText(sessions[0], w, { pointer: '▶', marker: '◉', home: '/home/u' });
  check(`row fits ${cols}`, t.length <= cols - 1);
  check(`row has the key ${cols}`, t.includes('ollama-repl-1k3f9a'.slice(0, w.key)));
}
check('wide shows the project', rowText(sessions[0], columnWidths(200, sessions), { home: '/home/u' }).includes('~/Sources/p'));
check('narrow drops the project', columnWidths(60, sessions).project === 0);
check('pointer and marker first', rowText(sessions[1], columnWidths(80, sessions), { pointer: '▶', marker: '●' }).startsWith('▶● x') && rowText(sessions[1], columnWidths(80, sessions)).startsWith(' ○ x'));
check('missing fields', rowText(sessions[1], columnWidths(80, sessions)).includes('-'));

/* details */
const info = {
  state: { name: 'cerebras', provider: 'cerebras', model: 'qwen-3.8-27b', root: '/home/u/Sources/p', messages: 44, title: 't', settings: { mode: 'auto', stream: true, numCtx: 16384 } },
  size: 43008,
  updatedAt: Date.now() - 60e3,
  messages: [{ role: 'system', content: 's' }, { role: 'user', content: '(automatic project scan at session start)\nx' }, { role: 'user', content: 'first line\nsecond line\nthird' }, { role: 'assistant', content: 'done.\nall green' }],
};
const text = detailLines(sessions[0], info, { ownKey: 'other', live: null, home: '/home/u' }).join('\n');
check('details: project', text.includes('project   ~/Sources/p'));
check('details: model', text.includes('cerebras/qwen-3.8-27b'));
check('details: size', text.includes('session.json 42 KB'));
check('details: settings in order', text.includes('mode=auto  stream=true  numCtx=16384'));
check('details: last prompt two lines, scan skipped', text.includes('last you   first line') && text.includes('second line') && !text.includes('third') && !text.includes('automatic project scan'));
check('details: last reply', text.includes('last model done.') && text.includes('all green'));
check('details: saved', text.includes('-  saved'));
check('details: this session', detailLines(sessions[0], info, { ownKey: 'ollama-repl-1k3f9a' }).join('\n').includes('this session'));
check('details: running elsewhere', detailLines(sessions[0], info, { live: { pid: 7, name: 'w' } }).join('\n').includes('running in pid 7 (w)'));
check('details: no file', detailLines(sessions[1], { state: {}, messages: null, size: 0 }).length >= 3);
check('details: unreadable', detailLines(sessions[1], { state: {}, messages: null, size: 10 }).join('\n').includes('cannot be read'));
check('details: too big', detailLines(sessions[1], { state: {}, messages: null, size: 9e6, big: true }).join('\n').includes('too big'));

/* directories: shown only when the session has been elsewhere */
const moved = detailLines(sessions[0], { state: { root: '/home/u/b', startRoot: '/home/u/a', roots: [{ root: '/home/u/a' }, { root: '/home/u/b' }] }, messages: null, size: 0 }, { home: '/home/u' }).join('\n');
check('started in', moved.includes('started   ~/a'));
check('moves', moved.includes('moves     1 directory change: ~/a > ~/b'));
check('never moved: no rows', !detailLines(sessions[0], { state: { root: '/x', startRoot: '/x', roots: [{ root: '/x' }] }, messages: null, size: 0 }).join('\n').includes('moves'));

/* transcript */
const tr = transcriptText([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'x'.repeat(2500), toolCalls: [{ name: 'read_file', args: { path: 'a.js' } }] }, { role: 'tool', name: 'read_file', content: { ok: 1 } }]);
check('transcript headers', tr.includes('#1 user') && tr.includes('#2 assistant') && tr.includes('#3 tool read_file'));
check('transcript cut', tr.includes('[... 500 more characters]'));
check('transcript calls', tr.includes('(calls: read_file({"path":"a.js"}))'));
check('transcript object content', tr.includes('{"ok":1}'));
check('transcript empty', transcriptText([]) === '(no conversation saved)');

console.log('test-session-browser: ok');
