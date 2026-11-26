/* test-availability-missing.js: a dashboard table that does not answer (a 429) keeps its previous answer and is reported */
import { loadAvailability, reportMissing } from '../lib/availability.js';
import { recent } from '../lib/events.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-availability-missing: ${what}`);
};
const now = Date.now();
const rows = [{ platform: 'p1', modelId: 'a', displayName: 'Alpha (P1)', enabled: true, keyCount: 1 }];
const data = {
  '/api/models': rows,
  '/api/fallback/rate-limit-usage': { rows: [{ platform: 'p1', modelId: 'a', rpm: { used: 10, limit: 10 }, rpd: { used: 1, limit: 100 } }] },
  '/api/fallback/token-usage': { models: [] },
  '/api/fallback/penalty-inspector': { rows: [] },
  '/api/keys': [{ id: 1, platform: 'p1', enabled: true, status: 'healthy', modelScope: null, cooldowns: [], monthlyUsage: { requests: 0, tokens: 0, resetsAt: new Date(now + 86400e3).toISOString() } }],
};
let failing = null;
const gateway = {
  origin: 'http://fake-missing',
  models: async () => [{ id: 'alpha', execution_status: 'exhausted' }],
  api: async p => {
    if(p === failing) throw Object.assign(new Error('HTTP 429'), { status: 429 });
    return data[p];
  },
};

const first = await loadAvailability(gateway, { fresh: true });
check('a full load misses nothing', first.missing.length === 0);
check('the rate-limit table is read', first.byModel.get('alpha').kinds.includes('rpm'));

failing = '/api/fallback/rate-limit-usage';
const second = await loadAvailability(gateway, { fresh: true });
check('the 429 is named', second.missing.length === 1 && /rate-limit-usage \(429\)/.test(second.missing[0]));
check('the previous table stands in, the minute window still explains the limit', second.byModel.get('alpha').kinds.includes('rpm'));
check('an event says so', recent().some(e => e.kind === 'gateway' && /missed 1 table/.test(e.text)));

/* a table that never answered is null as before, and the report is throttled to once a minute */
failing = '/api/keys';
const third = await loadAvailability({ ...gateway, origin: 'http://other-origin' }, { fresh: true });
check('without a previous answer the table is simply missing', third.missing.length === 1 && /keys/.test(third.missing[0]));
check('the report is limited to one a minute', reportMissing(['x'], Date.now()) === false && reportMissing(['x'], Date.now() + 61e3) === true);

console.log('test-availability-missing: ok');
