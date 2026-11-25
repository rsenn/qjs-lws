/* test-skips.js: skips end early when the gateway says the model is usable again */
import { releaseRecovered } from '../lib/skips.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-skips: ${what}`);
};
const now = 1e12;
const skip = (reason, since = now - 60000, until = now + 600000) => ({ reason, since, until });
const av = (at, blocked) => ({ at, byModel: new Map(Object.entries(blocked).map(([k, b]) => [k, { blocked: b }])) });

const s = new Map([
  ['a', skip('rate limited')],
  ['b', skip('rate limited')],
  ['c', skip('manual')],
  ['d', skip('quota used up', now - 2000)],
  ['e', skip('no longer available')],
  ['f', skip('provider exhausted', now - 60000, now - 1)],
  ['g', skip('rate limited')],
]);
const out = releaseRecovered(s, av(now, { a: false, b: true, c: false, d: false, e: false, f: false }), now);

check('recovered model released', out.join() === 'a' && !s.has('a'));
check('still blocked stays', s.has('b'));
check('manual skip stays', s.has('c'));
check('picture too fresh to trust', s.has('d'));
check('gone model stays', s.has('e'));
check('expired skip dropped, not reported', !s.has('f') && !out.includes('f'));
check('unknown to the gateway stays', s.has('g'));
check('no availability: only expiry', releaseRecovered(new Map([['x', skip('rate limited')]]), null, now).length === 0);
console.log('test-skips: ok');
