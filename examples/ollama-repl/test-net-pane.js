/* test-net-pane.js: box lines are cut to the box width, so a box never wraps and changes height */
import { fitLine, netPaneLines, kindOf, block, TYPES } from './lib/net-pane.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-net-pane: ${what}`);
};
const plain = s => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

check('short line untouched', fitLine('abc', 10) === 'abc');
check('exact fit untouched', fitLine('abcdefghij', 10) === 'abcdefghij');
check('long line cut with an ellipsis', plain(fitLine('abcdefghijkl', 10)) === 'abcdefghi…');
check('escapes are not counted', plain(fitLine('\x1b[1mabcdefgh\x1b[0m', 8)) === 'abcdefgh' && fitLine('\x1b[1mabcdefgh\x1b[0m', 8).includes('\x1b[1m'));
check('coloured long line is cut and reset', fitLine('\x1b[31mabcdefghijkl\x1b[0m', 6).endsWith('…\x1b[0m') && plain(fitLine('\x1b[31mabcdefghijkl\x1b[0m', 6)) === 'abcde…');
check('newlines become spaces', plain(fitLine('a\nb', 10)) === 'a b');

const rec = (tail, request) => ({ t0: 0, done: false, phase: 'streaming', label: 'chat', meta: { url: 'http://localhost:3001/v1/chat/completions', requested: 'auto', routedVia: 'a-very-long-model-name-from-some-provider', ttfbMs: 100, chunks: 5, request, tail } });
const heights = [];
for(const tail of ['x', 'y'.repeat(400)]) {
  const lines = netPaneLines(40, [{ kind: 'tcp', state: 'ESTAB', local: '127.0.0.1:55555', peer: '127.0.0.1:3001', sent: 123456, received: 7654321, upRate: 1234, downRate: 99999, rtt: 3 }], [rec(tail, 'q'.repeat(300))], 5000);
  heights.push(lines.length);
  check('no line wider than the pane', lines.every(l => [...plain(l)].length <= 40));
}
check('height does not depend on the content width', heights[0] === heights[1]);

check('kinds by port and label', kindOf('9222') === 'cdp' && kindOf('3001', 'explore') === 'explore' && kindOf('3001', 'main') === 'model' && kindOf('3001', 'sub-agent') === 'sub' && kindOf('3001', 'standby') === 'standby' && kindOf('11434') === 'model' && kindOf('443') === 'http' && kindOf('22') === 'tcp' && kindOf('1', 'brief') === 'compact');
const b = block('model', ['ab', '\x1b[1mcd\x1b[0m ef'], 20);
check('rectangle: edge, one row per line, edge', b.length === 4 && b.every(l => [...plain(l)].length === 20));
check('background survives the resets inside a line', b[2].split('\x1b[0m').slice(0, -1).filter(x => x).length > 0 && b[2].includes('\x1b[0m\x1b[48;2;'));
check('half-block edges with corners', plain(b[0]).startsWith('▗') && plain(b[0]).endsWith('▖') && plain(b[3]).startsWith('▝') && plain(b[3]).endsWith('▘'));

/* the hops the gateway tried, from its fallback headers */
{
  const { hopsOf, netPaneLines } = await import('./lib/net-pane.js');
  const strip = x => x.replace(/\x1b\[[0-9;]*m/g, '');
  const m = { requested: 'glm-5.2', status: 429, error: 'All models exhausted', detail: 'blaze/glm-5.2 key1=rate_limited t=0+62ms msg=slow down; router9/zai/glm-5.2 key2=upstream_error t=62+7ms; +3 more' };
  const h = hopsOf(m);
  if(h.length !== 3 || h[0].platform !== 'blaze' || h[0].key !== 1 || h[0].ms !== 62 || h[1].model !== 'zai/glm-5.2' || !h[2].more) throw new Error(`test-net-pane: hops ${JSON.stringify(h)}`);
  if(hopsOf({ trail: 'kilo/x:free key3=upstream_error' })[0].outcome !== 'upstream_error') throw new Error('test-net-pane: trail header');
  const rec = { label: 'exploration', t0: Date.now() - 3000, endedAt: Date.now(), done: true, phase: 'idle', meta: { ...m, bytesIn: 0 } };
  const lines = netPaneLines(60, [{ kind: 'tcp', state: 'ESTAB', peer: '127.0.0.1:3001', local: '127.0.0.1:50702', sent: 1, received: 1 }], [rec]).map(strip).join('\n');
  if(!/↳ blaze\/glm-5\.2 key1 rate_limited 62ms/.test(lines) || !/↳ \+3 more/.test(lines)) throw new Error(`test-net-pane: pane hop lines:\n${lines}`);
}
