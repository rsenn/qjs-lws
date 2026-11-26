/* test-quota-panel.js: the /quota panel: width, content, tone of the border */
import { stripAnsi } from 'terminal';
import { quotaPanel } from '../lib/look.js';
import { quotaData } from '../lib/session/usage-stats.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-quota-panel: ${what}`);
};

const hdr = (win, kind, rem, lim) => ({ [`x-ratelimit-remaining-${kind}-${win}`]: String(rem), [`x-ratelimit-limit-${kind}-${win}`]: String(lim) });
const rec = headers => [{ model: 'gpt-oss-120b', at: Date.UTC(2026, 10, 26, 10, 33, 22), headers }];
const make = (headers, cols = 100) => quotaPanel(quotaData(rec(headers)), cols);
const plain = s => stripAnsi(s);
const COLOR = { red: '38;2;248;113;113', amber: '38;2;251;191;36', teal: '38;2;45;212;191' };

const ok = make({ ...hdr('minute', 'requests', 999, 1000), ...hdr('minute', 'tokens', 482052, 500000), ...hdr('day', 'requests', 1439999, 1440000) });
const t = plain(ok);
check('rounded box', t.startsWith('╭') && t.trimEnd().endsWith('╯'));
check('title', t.includes('◈ quota'));
check('route and time', t.includes('gpt-oss-120b') && t.includes('as of 10:33:22Z'));
check('window glyphs', t.includes('◔ minute') && t.includes('● day'));
check('figures', t.includes('999 / 1,000') && t.includes('482,052 / 500,000') && t.includes('96% left'));
check('plenty left: teal border', ok.split('\n')[0].includes(COLOR.teal));
check('a full bar for a full window', t.split('\n').find(l => l.includes('999 / 1,000')).includes('█'.repeat(10)));

for(const cols of [40, 60, 80, 120]) {
  const w = Math.max(...plain(make(hdr('minute', 'requests', 5, 10), cols)).split('\n').map(l => [...l].length));
  check(`fits ${cols}`, w <= cols - 1);
}

check('amber from 60% used', make(hdr('hour', 'tokens', 300, 1000)).split('\n')[0].includes(COLOR.amber));
check('red from 85% used', make(hdr('hour', 'tokens', 100, 1000)).split('\n')[0].includes(COLOR.red));
check('almost nothing left is red in the row too', make(hdr('hour', 'tokens', 100, 1000)).split('\n')[3].includes(COLOR.red));

const odd = make(hdr('hour', 'tokens', 89982052, 30000000));
check('above its limit: flagged, not red', plain(odd).includes('89,982,052 / 30,000,000 ?') && !odd.split('\n')[0].includes(COLOR.red));

check('reset time', plain(make({ 'x-ratelimit-remaining-requests': '5', 'x-ratelimit-limit-requests': '10', 'x-ratelimit-reset-requests': '1s' })).includes('↻ 1s'));
check('no figures', plain(make({ 'x-ratelimit-reset-requests': '1s' })).includes('no limits with figures'));
check('no headers: no data', quotaData(rec({})) === null);

console.log('test-quota-panel: ok');
