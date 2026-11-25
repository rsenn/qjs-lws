/* test-ip-fix.js: which keyless keys a new IP address could help, and which keys are routed through the proxy */
import { ipCandidates, routedKeys, ANON_PROXY } from './lib/ip-fix.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-ip-fix: ${what}`);
};

const keys = [
  { id: 1, platform: 'kilo', keyless: true, enabled: true, maskedProxyUrl: '' },
  { id: 2, platform: 'ovh', keyless: true, enabled: true, maskedProxyUrl: 'socks5h://127.0.0.1:9050' },
  { id: 3, platform: 'google', keyless: false, enabled: true },
  { id: 4, platform: 'horde', keyless: true, enabled: true },
  { id: 5, platform: 'mistral', keyless: true, enabled: false },
  { id: 6, platform: 'free', keyless: true, enabled: true, maskedProxyUrl: 'http://other:3128' },
];
const m = (platforms, blocked, kinds, until = null) => ({ platforms, blocked, kinds, until });
const av = { byModel: new Map([
  ['kilo-a', m(['kilo'], true, ['rpd'], 5000)],
  ['kilo-b', m(['kilo'], true, ['ip'], 3000)],
  ['kilo-c', m(['kilo'], false, [])],
  ['ovh-a', m(['ovh'], true, ['exhausted'])],
  ['g-a', m(['google'], true, ['rpd'])],
  ['horde-a', m(['horde'], true, ['credit'])],
  ['mistral-a', m(['mistral'], true, ['rpd'])],
  ['free-a', m(['free'], true, ['cooldown'], 9000)],
]) };

const rows = ipCandidates(keys, av);
const by = id => rows.find(r => r.id === id);

check('keyless keys with limits by window, ip or exhaustion count', !!by(1) && !!by(2) && !!by(6));
check('a keyed provider does not', !by(3));
check('credits are not an IP matter', !by(4));
check('a disabled key does not', !by(5));
check('kilo: 2 of 3 limited, both kinds, earliest back', by(1).blocked === 2 && by(1).total === 3 && by(1).kinds.join() === 'rpd,ip' && by(1).until === 3000);
check('the limited model ids are listed', by(1).limitedIds.join() === 'kilo-a,kilo-b');
check('already through the proxy is known', by(2).routed === true && by(1).routed === false);
check('another proxy is shown, not counted as ours', by(6).routed === false && by(6).via === 'http://other:3128');
check('most limited first', rows[0].blocked / rows[0].total >= rows[rows.length - 1].blocked / rows[rows.length - 1].total);
check('routedKeys finds those on the proxy', routedKeys(keys, ANON_PROXY).map(k => k.id).join() === '2');
check('routedKeys by host and port, not scheme', routedKeys([{ keyless: true, maskedProxyUrl: 'socks5://127.0.0.1:9050' }], ANON_PROXY).length === 1);
