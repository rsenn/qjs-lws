/* test-ip-pane.js: the exit address change pane and the "every keyless provider is exhausted" test */
import { ipGroups, ipChangeParts, ipChangePanel } from '../lib/tui/ip-pane.js';
import { keylessExhausted } from '../lib/gateway/ip-fix.js';
import { stripAnsi } from 'terminal';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-ip-pane: ${what}`);
};

const now = 1e12;
const lim = (platforms, kinds, until = now + 3600e3) => ({ platforms, blocked: true, kinds, until });
const av = {
  byModel: new Map([
    ['kilo/a', lim(['kilo'], ['rpd'])],
    ['kilo/b', lim(['kilo'], ['cooldown'])],
    ['ovh/c', lim(['ovh'], ['exhausted'])],
    ['zai/d', lim(['zai'], ['credit'])],
    ['kilo/free', { platforms: ['kilo'], blocked: false, kinds: [] }],
  ]),
};
const keys = [{ id: 1, platform: 'kilo', keyless: true, enabled: true }, { id: 2, platform: 'ovh', keyless: true, enabled: true, maskedProxyUrl: 'socks5h://127.0.0.1:9050' }, { id: 3, platform: 'zai', keyless: false, enabled: true }];

const groups = ipGroups(av, keys);
check('groups: kilo and ovh, not the credit-limited zai', groups.map(g => g.platform).join() === 'kilo,ovh' && groups[0].models.length === 2);

const [title, text, opts] = ipChangeParts({ before: '1.1.1.1', after: '2.2.2.2', direct: '9.9.9.9', groups, now });
const plain = stripAnsi(text);
check('title says changed, amber border', stripAnsi(title) === '⚠ exit address changed' && opts.border === '#fbbf24');
check('old and new address', /old +1\.1\.1\.1/.test(plain) && /new +2\.2\.2\.2/.test(plain) && /ours +9\.9\.9\.9/.test(plain));
check('models that could work again', /3 models of 2 providers could work again/.test(plain) && /↻ kilo +kilo\/a, kilo\/b/.test(plain) && /↻ ovh +ovh\/c/.test(plain) && !/zai/.test(plain));
check('old address is struck through', text.includes('\x1b[9m') || /\x1b\[[0-9;]*9[;m]/.test(text));

const same = ipChangeParts({ before: '1.1.1.1', after: '1.1.1.1', groups, now });
check('unchanged: red, no model list', stripAnsi(same[0]) === '⚠ exit address UNCHANGED' && same[2].border === '#f87171' && !/could work again/.test(stripAnsi(same[1])));
const own = ipChangeParts({ before: '1.1.1.1', after: '9.9.9.9', direct: '9.9.9.9', groups, now });
check('own address: red', stripAnsi(own[0]) === '⚠ exit address is our own' && own[2].border === '#f87171');
check('no limited model: said so', /no model is limited per IP address/.test(stripAnsi(ipChangeParts({ before: 'a', after: 'b', groups: [], now })[1])));

const panelText = stripAnsi(ipChangePanel({ before: '1.1.1.1', after: '2.2.2.2', groups, now }, 100));
check('a panel with a border', panelText.startsWith('╭') && panelText.trim().endsWith('╯') && panelText.includes('exit address changed'));

/* every keyless provider exhausted */
check('kilo has a usable model: not exhausted', keylessExhausted(keys, av) === null);
av.byModel.get('kilo/free').blocked = true;
av.byModel.get('kilo/free').kinds = ['rpm'];
const ex = keylessExhausted(keys, av, 'socks5h://127.0.0.1:9050');
check('all keyless exhausted', ex && ex.platforms.join() === 'kilo,ovh');
check('routed flag per key', ex.keys.find(k => k.id === 1).routed === false && ex.keys.find(k => k.id === 2).routed === true);
check('no keyless key: not it', keylessExhausted([keys[2]], av) === null);
check('a credit-limited provider is not helped by an address', keylessExhausted([{ id: 3, platform: 'zai', keyless: true, enabled: true }], av) === null);

console.log('test-ip-pane: ok');
