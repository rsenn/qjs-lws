/* test-delegates.js: the delegate memory ranks by what worked, learns from runs and votes, keeps itself on disk */
import { Delegates, discoverGateway } from './lib/delegates.js';
import { getenv } from 'std';
import { remove } from 'os';

const path = `/tmp/test-delegates-${Date.now()}.json`;
const check = (what, ok) => {
  if(!ok) throw new Error(`test-delegates: ${what}`);
};

const d = new Delegates(path);
const ids = ['a', 'b', 'c'];

check('untried models keep discovery order', d.rank('docs', ids).map(r => r.id).join() === 'a,b,c');

d.record('b', 'docs', { ok: true, ms: 4000 });
d.record('b', 'docs', { ok: true, ms: 6000 });
d.record('a', 'docs', { ok: false });
check('good runs lead, failures trail', d.rank('docs', ids).map(r => r.id).join() === 'b,c,a');
check('mean time is kept', d.stats('b', 'docs').ms === 5000);
check('another kind is separate', d.rank('build', ids).map(r => r.id).join() === 'a,b,c');

d.vote('c', 'docs', 1);
d.vote('c', 'docs', 1);
check('votes weigh more than one run', d.rank('docs', ids)[0].id === 'c');

for(let i = 0; i < 3; i++) d.record('a', 'build', { ok: false });
check('three failures in a row bench a model for the kind', !d.rank('build', ids).some(r => r.id === 'a') && d.rank('docs', ids).some(r => r.id === 'a'));

d.pin('summary', 'z');
check('a pinned model leads even when unknown', d.rank('summary', ids)[0].id === 'z');
d.ban('b');
check('a banned model is left out', !d.rank('docs', ids).some(r => r.id === 'b'));
d.add('m', ['repetitive']);
check('added and pinned by hand', d.rank('repetitive', ids)[0].id === 'm' && d.rank('docs', ids).some(r => r.id === 'm'));

const again = new Delegates(path);
check('the memory survives a restart', again.stats('b', 'docs').ok === 2 && again.data.pinned.summary === 'z' && again.data.banned.includes('b'));

/* discovery without a dashboard: the gateway's order of ready models, minus the excluded */
const gateway = { dashboard: false, models: async () => [{ id: 'auto', execution_status: 'ready' }, { id: 'x', execution_status: 'ready' }, { id: 'y', execution_status: 'exhausted' }, { id: 'p', execution_status: 'ready' }] };
check('discovery skips auto, exhausted and excluded', (await discoverGateway(gateway, null, { exclude: ['p'] })).join() === 'x');

remove(path);
console.log('test-delegates ok');
