/* test-availability-events.js: events for models that become limited or usable again, and why */
import { reportChanges, noteIpChange } from '../lib/availability.js';
import { setSink } from '../lib/events.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-availability-events: ${what}`);
};
const e = (blocked, kinds = [], until = null) => ({ blocked, kinds, until, platforms: ['p'] });
const av = o => ({ byModel: new Map(Object.entries(o)) });
const seen = [];
setSink(ev => seen.push(ev.text));
const last = () => seen[seen.length - 1];

reportChanges(av({ a: e(false), b: e(false), c: e(false) }));
check('the first look reports nothing', seen.length === 0);

reportChanges(av({ a: e(true, ['rpm'], Date.now() + 1000), b: e(true, ['rpd'], Date.now() + 3600e3), c: e(true, ['ip']) }));
check('limited models are reported with the reason', seen.length === 1 && /3 models limited/.test(seen[0]) && /req\/min/.test(seen[0]));

reportChanges(av({ a: e(false), b: e(true, ['rpd'], Date.now() + 3500e3), c: e(true, ['ip']) }));
check('a model whose pace time ran out', seen.length === 2 && /pace time has run out/.test(last()) && /^1 model usable/.test(last()) && last().includes('a (was req/min)'));

reportChanges(av({ a: e(false), b: e(true, ['rpd'], Date.now() + 3500e3), c: e(false) }));
check('a model limited as an IP matter is accessible again', /accessible again after the IP change/.test(last()) && last().includes('c (was IP limit?)'));

reportChanges(av({ a: e(true, ['cooldown'], null), b: e(true, ['rpd'], Date.now() + 3500e3), c: e(false) }));
noteIpChange();
reportChanges(av({ a: e(false), b: e(true, ['rpd'], Date.now() + 3500e3), c: e(false) }));
check('soon after an exit change a model is reported as accessible again by it', /accessible again after the IP change/.test(last()) && last().includes('a ('));

reportChanges(av({ a: e(false), b: e(false), c: e(false) }));
check('a model back with a long way to its end is just usable again... after an IP change it is credited to it', /usable again|accessible again/.test(last()));
console.log('test-availability-events: ok');

/* /gateway limits: no wrapped rows, empty columns left out */
{
  const { limitsText } = await import('../lib/availability.js');
  const now = Date.now();
  const mk = (k, until) => [k, [{ kind: 'cooldown', until, row: k }]];
  const av = {
    at: now,
    rate: new Map([['ovh/Qwen3.8-27b-instruct', { rpm: { used: 0, limit: 2 } }]]),
    budget: new Map([['freeinference/some-very-long-model-name-here', { used: 16e6, budget: 0 }], ['xkiro/mistral-large-3-2512', { used: 1.1e6, budget: 15e6 }]]),
    byRow: new Map([mk('freeinference/some-very-long-model-name-here', now + 76e3), mk('xkiro/mistral-large-3-2512', now + 17 * 3600e3)]),
    byModel: new Map(),
  };
  for(const width of [0, 90, 60]) {
    const out = limitsText(av, '', width).split('\n').slice(2);
    const strip = x => x.replace(/\x1b\[[0-9;]*m/g, '');
    if(width && out.some(l => [...strip(l)].length > width)) throw new Error(`test-availability-events: limits row wider than ${width}: ${out.map(strip).join(' | ')}`);
    if(!/76s · \d\d:\d\d/.test(out.map(strip).join('\n'))) throw new Error('test-availability-events: back column');
  }
  const wide = limitsText(av, '', 0).split('\n')[2];
  if(/tok\/min/.test(wide)) throw new Error('test-availability-events: an empty column is shown');
}

/* /gateway limited: one line per model at any width */
{
  const { limitedText } = await import('../lib/availability.js');
  const now = Date.now();
  const entry = (platforms, until, kinds = ['cooldown']) => ({ blocked: true, kinds, until, platforms, blocks: [{ kind: kinds[0], until, detail: 'the provider named a retry time after a long wait that makes this detail very long indeed' }] });
  const av = { at: now, byModel: new Map([
    ['gemini-3.5-flash', entry(['google'], now + 43 * 60e3)],
    ['a-very-long-model-name-with-many-parts-instruct-2512', entry(['aclide', 'freemodel', 'ovh'], now + 17 * 3600e3, ['credit'])],
    ['qwen3.7-max', entry(['xkiro'], now + 49 * 60e3)],
  ]) };
  const strip = x => x.replace(/\x1b\[[0-9;]*m/g, '');
  for(const width of [0, 120, 90, 60, 40]) {
    const out = limitedText(av, '', width).split('\n');
    const table = out.slice(2, 6);
    if(table.length !== 4) throw new Error(`test-availability-events: limited rows at ${width}: ${table.length}\n${out.join('\n')}`);
    if(width && table.some(l => [...strip(l)].length > width)) throw new Error(`test-availability-events: limited row wider than ${width}:\n${table.map(strip).join('\n')}`);
  }
}
