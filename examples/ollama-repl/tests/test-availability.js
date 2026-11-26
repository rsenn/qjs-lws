/* test-availability.js: loadAvailability() against a fake gateway: every kind of limit, its end, the provider column */
import { loadAvailability, backText, limitsText } from '../lib/availability.js';

const now = Date.now();
const rows = [
  { platform: 'p1', modelId: 'a', displayName: 'Alpha (P1)', enabled: true, keyCount: 1 },
  { platform: 'p2', modelId: 'b', displayName: 'Beta (P2)', enabled: true, keyCount: 1 },
  { platform: 'p3', modelId: 'c', displayName: 'Gamma (P3)', enabled: true, keyCount: 1 },
  { platform: 'p4', modelId: 'd', displayName: 'Delta (P4)', enabled: true, keyCount: 1 },
  { platform: 'p5', modelId: 'e', displayName: 'Eps (P5)', enabled: true, keyCount: 2 },
  { platform: 'p6', modelId: 'f', displayName: 'Zeta (P6)', enabled: true, keyCount: 1 },
];
const key = (platform, extra = {}) => ({ id: 1, platform, enabled: true, status: 'healthy', modelScope: null, cooldowns: [], monthlyUsage: { requests: 0, tokens: 0, resetsAt: '2099-01-01T00:00:00.000Z' }, ...extra });
const data = {
  '/api/models': rows,
  '/api/fallback/rate-limit-usage': { rows: [{ platform: 'p1', modelId: 'a', rpm: { used: 10, limit: 10 }, rpd: { used: 1, limit: 100 } }] },
  '/api/fallback/token-usage': { models: [{ platform: 'p2', modelId: 'b', used: 500, budget: 500 }] },
  '/api/fallback/penalty-inspector': { rows: [{ platform: 'p3', modelId: 'c', recentErrors: [{ error: '403 not available in your region' }] }] },
  '/api/keys': [
    key('p1'),
    key('p2'),
    key('p3', { cooldowns: [{ modelId: 'c', source: 'heuristic', expiresAtMs: now + 3600_000 }] }),
    key('p4', { modelScope: ['other'] }),
    key('p5', { id: 5 }),
    key('p5', { id: 6, cooldowns: [{ modelId: 'e', source: 'authoritative', expiresAtMs: now + 60_000 }] }),
    key('p6', { monthlyRequestCap: 10, monthlyUsage: { requests: 10, tokens: 0, resetsAt: new Date(now + 5 * 86400_000).toISOString() } }),
  ],
};
const ids = ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta'];
const gateway = {
  models: async () => ids.map(id => ({ id, execution_status: id === 'eps' ? 'ready' : 'exhausted' })),
  api: async p => data[p],
};

const av = await loadAvailability(gateway);
const check = (what, ok) => {
  if(!ok) throw new Error(`test-availability: ${what}`);
};
const m = id => av.byModel.get(id);

check('rpm block ends within a minute', m('alpha').kinds[0] === 'rpm' && m('alpha').until - now <= 61_000 && m('alpha').approx);
check('month budget ends at the start of next month', m('beta').kinds[0] === 'month' && new Date(m('beta').until).getUTCDate() === 1);
check('cooldown with an IP error is an ip limit', m('gamma').kinds[0] === 'ip' && m('gamma').until >= now + 3600_000 - 1000);
check('a key scope never ends', m('delta').permanent && m('delta').until === null && backText(m('delta')) === 'not by waiting');
check('one free key keeps the model ready', !m('eps').blocked && m('eps').platforms[0] === 'p5');
check('key cap ends at its reset', m('zeta').kinds[0] === 'cap' && m('zeta').until === now + 5 * 86400_000 || Math.abs(m('zeta').until - (now + 5 * 86400_000)) < 2000);
check('providers come from the rows', m('alpha').platforms.join() === 'p1');

/* the tables that change rarely are asked once a minute; fresh asks them all */
{
  const asked = [];
  const slow = { origin: 'http://fake-ttl', models: async () => ids.map(id => ({ id, execution_status: 'ready' })), api: async p => (asked.push(p), data[p]) };
  await loadAvailability(slow);
  asked.length = 0;
  await loadAvailability(slow);
  check('the rarely changing tables are not asked again', !asked.includes('/api/models') && !asked.includes('/api/fallback/routing') && asked.includes('/api/keys') && asked.includes('/api/fallback/rate-limit-usage'));
  asked.length = 0;
  await loadAvailability(slow, { fresh: true });
  check('fresh asks every table', asked.includes('/api/models') && asked.includes('/api/fallback/routing'));
}

/* /gateway limits: limited rows first, the earliest end first (the order is decided once per row, not by formatting rows in the comparator) */
{
  const lines = limitsText(av, 'p', 200).replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(l => /^p\d\//.test(l));
  check('limits lists the limited rows, the rpm window ending first', lines.length === 2 && lines[0].startsWith('p1/a') && lines[1].startsWith('p2/b'));
}

/* a chat-bridge: the sites are the models, limits come from its own endpoints */
const until = new Date(now + 3 * 3600_000).toISOString();
const bridge = {
  isBridge: true,
  models: async () => [
    { id: 'deepseek', execution_status: 'ready' },
    { id: 'qwen', execution_status: 'exhausted', unavailable: 'rate_limit', resets_at: until },
    { id: 'chatgpt', execution_status: 'needsKey', available: false },
  ],
  providers: async () => ({ providers: [{ platform: 'qwen', status: 'rate_limited', last_error: 'rate_limit: daily limit' }] }),
  forecast: async () => ({ pools: [{ pool: 'qwen', limit: 30, used: 30, remaining: 0 }] }),
  usage: async () => ({ byPlatform: [{ platform: 'qwen', requests: 30, tokens: 12000 }] }),
};
const bv = await loadAvailability(bridge);
const b = id => bv.byModel.get(id);
check('bridge: a site that refused is blocked until its cooldown ends', b('qwen').blocked && Math.abs(b('qwen').until - (now + 3 * 3600_000)) < 2000 && b('qwen').kinds[0] === 'cooldown');
check('bridge: the reason is the last error', b('qwen').blocks[0].detail === 'rate_limit: daily limit');
check('bridge: a ready site is free, a login site is not blocked but not ready', !b('deepseek').blocked && b('chatgpt').status === 'needsKey' && !b('chatgpt').blocked);
check('bridge: the site is its own provider', b('qwen').platforms.join() === 'qwen');
check('bridge: the learned budget shows as the day window', bv.rate.get('qwen').rpd.limit === 30 && bv.budget.get('qwen').used === 12000);

console.log('test-availability ok');

/* concurrent loads share one load; a caller that changed gateway state asks for a fresh one after it */
{
  let calls = 0;
  const counting = { models: async () => (calls++, ids.map(id => ({ id, execution_status: 'ready' }))), api: async p => data[p] };
  const [a, b, c] = await Promise.all([loadAvailability(counting), loadAvailability(counting), loadAvailability(counting)]);
  check('three concurrent loads are one', calls === 1 && a === b && b === c);

  calls = 0;
  const [x, y] = await Promise.all([loadAvailability(counting), loadAvailability(counting, { fresh: true })]);
  check('fresh waits for the running load and runs its own', calls === 2 && x !== y);

  calls = 0;
  await loadAvailability(counting);
  await loadAvailability(counting);
  check('sequential loads each run', calls === 2);
}
