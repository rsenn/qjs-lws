/* test-fit-table.js: a table never gets wider than the terminal: columns give up width, then drop out */
import { fitTable } from '../lib/session/usage-stats.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-fit-table: ${what}`);
};
const plain = s => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const widest = t => Math.max(...t.split('\n').map(l => [...plain(l)].length));

const mk = () => [
  ['Model', 'Rate', 'Status', 'Probe', 'Says'],
  ['gemini-3.7-flash', '\x1b[32m 59\x1b[0m', '\x1b[32mREADY\x1b[0m', '\x1b[32m✔ usable\x1b[0m 4.3s no tools', 'I am Qwen, developed by Alibaba Cloud and a long identity sentence'],
  ['glm-5.3', '\x1b[33m 45\x1b[0m', '\x1b[32mREADY\x1b[0m', '\x1b[31m✗ All 2 routed attempts failed upstream\x1b[0m', ''],
];

for(const w of [200, 100, 70, 50, 40, 30]) check(`fits ${w}`, widest(fitTable(w, mk, [4, 3, 0], [4, 3])) <= w);
check('unlimited width keeps everything', plain(fitTable(0, mk, [4, 3, 0])).includes('failed upstream'));
const t = fitTable(70, mk, [4, 3, 0], [4, 3]);
check('coloured cells are cut without losing the reset', t.split('\n').every(l => !l.includes('\x1b[3') || l.includes('\x1b[0m')));
check('narrow: the Says column dropped before Model', fitTable(30, mk, [4, 3, 0], [4, 3]).includes('Model') && !fitTable(30, mk, [4, 3, 0], [4, 3]).includes('Says'));
console.log('test-fit-table: ok');
