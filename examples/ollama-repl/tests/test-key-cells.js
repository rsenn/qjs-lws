/* test-key-cells.js: the keys and spread cells of /gateway usage */
import { keyCells } from '../lib/freellm.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-key-cells: ${what}`);
};
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const by = [
  { keyId: 1, platform: 'google', tokens: 700, requests: 7 },
  { keyId: 2, platform: 'google', tokens: 200, requests: 2 },
  { keyId: 3, platform: 'google', tokens: 100, requests: 1 },
  { keyId: 4, platform: 'kilo', tokens: 500, requests: 5 },
  { keyId: 5, platform: 'nvidia', tokens: 950, requests: 9 },
  { keyId: 6, platform: 'nvidia', tokens: 50, requests: 1 },
  { keyId: 7, platform: 'free', tokens: 0, requests: 3 },
  { keyId: 8, platform: 'free', tokens: 0, requests: 1 },
];
const conf = new Map([['google', 4], ['kilo', 3], ['nvidia', 2], ['free', 2], ['idle', 2]]);

let [k, s] = keyCells('google', by, conf).map(strip);
check('three of four keys used, shares heaviest first', k === '3 of 4' && s === '70 · 20 · 10 %');
[k, s] = keyCells('kilo', by, conf).map(strip);
check('one key of three carries it, two idle', k === '1 of 3' && /100% on one key, 2 idle/.test(s));
check('one key nearly all is amber', keyCells('nvidia', by, conf)[1].includes('\x1b[33m'));
check('even spread is not amber', !keyCells('google', by, conf)[1].includes('\x1b[33m'));
[k, s] = keyCells('free', by, conf).map(strip);
check('no tokens: requests count', k === '2 of 2' && s === '75 · 25 %');
check('a configured platform without usage', strip(keyCells('idle', by, conf)[0]) === '0 of 2');
check('without a dashboard only the used keys are counted', strip(keyCells('google', by)[0]) === '3');
check('unknown platform', strip(keyCells('nothing', by)[0]) === '-');
console.log('test-key-cells: ok');
