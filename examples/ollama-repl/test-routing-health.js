/* test-routing-health.js: when the status bar shows the routing-health segment */
import { routingHealth } from './lib/routing-health.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-routing-health: ${what}`);
};
const now = Date.parse('2026-11-24T12:00:00');
const m = (blocked, until = null, permanent = false) => ({ blocked, until, permanent });
const av = list => ({ byModel: new Map(list.map((e, i) => [`m${i}`, e])) });

check('quiet when all is well', routingHealth({ skips: [], av: av([m(false), m(false), m(false), m(true)]), now }) === null);
check('quiet with one skip', routingHealth({ skips: [{ until: now + 1000 }], av: null, now }) === null);
check('expired skips do not count', routingHealth({ skips: [{ until: now - 1 }, { until: now - 5 }], av: null, now }) === null);

const two = routingHealth({ skips: [{ until: now + 1000 }, { until: now + 2000 }], av: null, now });
check('two skips warn', two.level === 'warn' && two.text === 'routing 2 skipped');

const tight = routingHealth({ skips: [], av: av([m(true, now + 180000), m(true, now + 60000), m(false), m(false)]), now });
check('half limited warns with the soonest return', tight.level === 'warn' && /^routing 2\/4 ready, first back in 60s/.test(tight.text));

const dry = routingHealth({ skips: [], av: av([m(true, now + 60000), m(true, null, true), m(true), m(true)]), now });
check('all limited is bad', dry.level === 'bad' && dry.text.startsWith('routing 0/4 ready'));
console.log('test-routing-health: ok');
