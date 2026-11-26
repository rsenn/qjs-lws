/* test-usage-baseline.js: turns, failure runs and error classes of the usage baseline */
import { baseline, baselineText, errorClass, proxyLatency } from '../lib/usage-baseline.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-usage-baseline: ${what}`);
};

const t0 = Date.UTC(2026, 10, 25, 10, 0, 0);
let n = 0;
const row = (o = {}) => ({ at: t0 + 1000 * n++, session: 's', model: 'm', requested: 'm', platform: 'kilo', ms: 1000, ttfbMs: 500, fallbacks: 0, status: 200, usage: { total: 100 }, ...o });
const fail = (o = {}) => row({ status: 429, platform: undefined, ms: 300, error: 'All models exhausted: 3 routes checked', ...o });

const rows = [
  row(), /* turn 1: ok */
  fail(), /* turn 2: first try fails ... */
  fail({ attempt: 1 }),
  row({ attempt: 2 }), /* ... the third try succeeds: the turn is ok, two hops failed */
  fail(), /* turn 3: fails alone */
  row({ error: 'interrupted', status: undefined }), /* turn 4: the user interrupted */
  row({ session: 'other' }), /* another session */
  row({ fallbacks: 1, ms: 3000 }),
];

const b = baseline(rows);
check('records', b.records === 8);
check('turns: a retry joins the turn before it', b.turns === 6 && b.turnsOk === 4 && b.turnsFailed === 1 && b.turnsInterrupted === 1);
check('failed hops count every failing request but not the interrupted one', b.hopsFailed === 3);
check('turn failure rate over finished turns', Math.abs(b.turnFailRate - 1 / 5) < 1e-9);
check('error classes', b.errors.length === 1 && b.errors[0][0] === 'all models exhausted/rate-limited' && b.errors[0][1] === 3);
check('retries by the gateway', b.fallbacks.find(f => f.fallbacks === 1)?.msMedian === 3000);
check('platform table has kilo', b.platforms.find(p => p.platform === 'kilo').n === 5 && b.platforms.find(p => p.platform === '?').failed === 3);
check('failure run: one failed turn, recovered by the next ok turn', b.runs.n === 1 && b.runs.longest === 1 && b.runs.recoverMs !== 0);
check('text has the headline numbers', /8 requests/.test(baselineText(b)) && /1 failed = 20.0%/.test(baselineText(b)));

/* rows without attempt: every row is its own turn (the old usage.jsonl) */
const old = baseline([row({ session: 'o' }), fail({ session: 'o' }), fail({ session: 'o' }), row({ session: 'o' })]);
check('old rows: each is a turn, one run of two failures', old.turns === 4 && old.turnsFailed === 2 && old.runs.longest === 2);

check('classes', errorClass("'colorReasoning' is not defined") === 'harness exception' && errorClass('Rate limit exceeded: more than 120 requests per minute') === 'gateway rpm cap' && errorClass('All 3 routed attempt(s) failed with upstream provider errors') === 'upstream provider errors' && errorClass('weird') === 'other');
check('empty input', baseline([]).records === 0 && baselineText(baseline([])).includes('no rows'));

/* a proxied platform is its own row, so the two routes of one provider can be compared */
{
  const b = baseline([row({ ms: 1000 }), row({ ms: 1200 }), row({ ms: 2400, proxied: true }), row({ ms: 2600, proxied: true })]);
  const direct = b.platforms.find(p => p.platform === 'kilo');
  const socks = b.platforms.find(p => p.platform === 'kilo +socks');
  check('direct and proxied are separate rows', direct?.n === 2 && socks?.n === 2);
  check('with their own latency', direct.msMedian < socks.msMedian);
}

/* rows of the other clients are not turns */
{
  const mix = baseline([row(), row({ label: 'explore' }), row({ label: 'standby', error: 'x', status: 500 }), row()]);
  check('labelled rows are no turns', mix.turns === 2 && mix.turnsFailed === 0 && mix.records === 4);
}
{
  const { usageRow } = await import('../lib/persist.js');
  check('usageRow keeps the label of another client', usageRow('o', 's', { model: 'm' }, 'explore').label === 'explore');
  check('the main client has none', usageRow('o', 's', { model: 'm' }, 'main').label === undefined && usageRow('o', 's', { model: 'm' }).label === undefined);
}
/* what the proxy adds per platform */
{
  const r = (platform, proxied, ttfbMs, o = {}) => ({ at: t0, session: 's', platform, proxied, ttfbMs, ...o });
  const rows = [
    ...[1000, 1100, 1200].map(t => r('kilo', false, t)), ...[1600, 1700, 1800].map(t => r('kilo', true, t)),
    ...[500, 500, 500].map(t => r('groq', false, t)), r('groq', true, 900),
    r('nvidia', true, 100, { error: 'x' }), r('nvidia', undefined, 100),
  ];
  const c = proxyLatency(rows);
  check('proxy latency: the platform with both sides', c.length === 1 && c[0].platform === 'kilo');
  check('proxy latency: medians and the difference', c[0].direct === 1100 && c[0].proxied === 1700 && c[0].added === 600 && c[0].nDirect === 3 && c[0].nProxied === 3);
}
console.log('test-usage-baseline: ok');
