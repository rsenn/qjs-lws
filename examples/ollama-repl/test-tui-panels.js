/* test-tui-panels.js: a live panel is replaced in the transcript where it was written */
import { open } from 'std';
import { Tui } from './lib/tui.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-tui-panels: ${what}`);
};
const plain = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const out = open('/tmp/ollama-repl-test-tui.out', 'w');
const tui = new Tui({ status: () => 'status', out, mouse: false });
tui.start();

tui.write('before\n');
const id = tui.openPanel('╭ one\n│ a\n╰', 0);
tui.write('after\n');
const lines = () => tui.transcript.map(plain);

check('panel is in the transcript between the lines', lines().join('|').startsWith('before|╭ one|│ a|╰|after'));

check('update in place', tui.updatePanel(id, '╭ one\n│ a\n│ b\n│ c\n╰') && lines().join('|').startsWith('before|╭ one|│ a|│ b|│ c|╰|after'));
check('fewer lines', tui.updatePanel(id, '╭ x\n╰') && lines().join('|').startsWith('before|╭ x|╰|after'));
check('lines written later stay after it', tui.updatePanel(id, '╭ y\n│ 1\n│ 2\n╰') && lines().join('|').includes('╰|after'));

const k = tui.openPanel('╭ verbose\n╰', 1);
check('verbose panel hidden in the compact view', !lines().some(l => l.includes('verbose')));
tui.updatePanel(k, '╭ verbose2\n│ x\n╰');
check('and its update is hidden, too', !lines().some(l => l.includes('verbose')));
tui.setVerbose(true);
check('verbose view shows the updated panel', lines().some(l => l.includes('verbose2')) && lines().includes('│ x'));
tui.setVerbose(false);
check('compact again', !lines().some(l => l.includes('verbose')));

check('unknown panel', tui.updatePanel(9999, 'x') === false && !tui.hasPanel(9999) && tui.hasPanel(id));

for(let i = 0; i < 10100; i++) tui.write(`line ${i}\n`);
check('a panel cut off the history is gone, not an error', tui.updatePanel(id, 'z') === false && !tui.hasPanel(id));

tui.close();
console.log('test-tui-panels: ok');
