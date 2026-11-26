/**
 * usage-baseline: the numbers of usage.jsonl that health, exploration and failover changes are measured against
 * (doc/HEALTH-EXPERIMENTS.md): requests, outcomes, latency, per platform, failure runs and the time to recover.
 *
 * ```js
 * const b = baseline(readUsage({ sinceMs: Date.now() - 86400e3 }));
 * console.log(baselineText(b));
 * ```
 *
 * A row is one request of the main client. `attempt` (lib/persist.js) says which try of its round it was; a turn is the
 * first try (attempt 0, or a row without the field) and the retries after it, and it failed only when its last row did.
 * `interrupted` rows (the user pressed a key) are neither failures nor successes.
 */
import { isHarnessError } from './harness-error.js';

/** the class of an error text, for the table of what failed */
export function errorClass(e) {
  const t = String(e ?? '');
  if(isHarnessError(t)) return 'harness exception';
  for(const [name, re] of [
    ['gateway rpm cap', /more than \d+ requests per minute/i],
    ['all models exhausted/rate-limited', /all models/i],
    ['upstream provider errors', /upstream provider|routed attempt/i],
    ['provider error', /provider error/i],
    ['model not found', /not found|removed upstream/i],
    ['connection', /connection|closed before/i],
    ['bad encoding', /utf-8/i],
  ])
    if(re.test(t)) return name;
  return 'other';
}

const median = xs => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const p90 = xs => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)] : null);
const count = (xs, key) => xs.reduce((m, x) => m.set(key(x), (m.get(key(x)) ?? 0) + 1), new Map());
const sorted = m => [...m].sort((a, b) => b[1] - a[1]);

/**
 * @param {object[]} rows  usage rows (lib/persist.js usageRow), any order
 * @returns {object} the numbers: see the field names; times are ms, rates are 0..1
 */
export function baseline(rows) {
  rows = [...rows].sort((a, b) => a.at - b.at);

  const interrupted = r => r.error === 'interrupted';
  const failed = r => !!r.error && !interrupted(r);
  const ok = rows.filter(r => !r.error);

  /* turns (the main client's rows only): per session, a row with attempt 0 starts one, a retry joins the open one */
  const open = new Map();
  const turns = [];
  for(const r of rows) {
    if(r.label) continue; /* explore, standby and sub-agent rows are traffic, not turns of the user */
    const t = open.get(r.session);
    if(!(r.attempt > 0) || !t) {
      const n = { session: r.session, rows: [r] };
      turns.push(n);
      open.set(r.session, n);
    } else t.rows.push(r);
  }
  for(const t of turns) {
    const last = t.rows[t.rows.length - 1];
    t.at = t.rows[0].at;
    t.state = interrupted(last) ? 'interrupted' : last.error ? 'failed' : 'ok';
  }

  /* failure runs: consecutive failed turns of a session, and the time to the next success */
  const runs = [];
  const by = new Map();
  for(const t of turns) by.set(t.session, [...(by.get(t.session) ?? []), t]);
  for(const ts of by.values())
    for(let i = 0; i < ts.length; i++) {
      if(ts[i].state !== 'failed') continue;
      let j = i;
      while(j < ts.length && ts[j].state === 'failed') j++;
      const next = ts[j]?.state === 'ok' ? ts[j] : ts.slice(j).find(t => t.state === 'ok');
      runs.push({ session: ts[i].session, turns: j - i, recoverMs: next ? next.at - ts[i].at : null });
      i = j - 1;
    }

  const platforms = new Map();
  for(const r of rows) {
    const p = `${r.platform ?? '?'}${r.proxied ? ' +socks' : ''}`; /* a proxied platform is its own row: the comparison of the two routes */
    const x = platforms.get(p) ?? { n: 0, failed: 0, fallback: 0, ms: [], ttfb: [], tokens: 0 };
    x.n++;
    if(failed(r)) x.failed++;
    if(r.fallbacks > 0) x.fallback++;
    if(!r.error && r.ms) x.ms.push(r.ms);
    if(r.ttfbMs) x.ttfb.push(r.ttfbMs);
    x.tokens += r.usage?.total ?? 0;
    platforms.set(p, x);
  }

  const hours = new Map();
  for(const t of turns) {
    const h = new Date(t.at).toISOString().slice(0, 13);
    const x = hours.get(h) ?? { turns: 0, failed: 0 };
    x.turns++;
    if(t.state === 'failed') x.failed++;
    hours.set(h, x);
  }

  const turnsOk = turns.filter(t => t.state === 'ok').length;
  const turnsFailed = turns.filter(t => t.state === 'failed').length;
  const recover = runs.map(r => r.recoverMs).filter(x => x != null);

  return {
    records: rows.length,
    from: rows[0]?.at ?? null,
    to: rows[rows.length - 1]?.at ?? null,
    status: sorted(count(rows, r => r.status ?? 'none')),
    interrupted: rows.filter(interrupted).length,
    hopsFailed: rows.filter(failed).length,
    turns: turns.length,
    turnsOk,
    turnsFailed,
    turnsInterrupted: turns.length - turnsOk - turnsFailed,
    turnFailRate: turnsOk + turnsFailed ? turnsFailed / (turnsOk + turnsFailed) : 0,
    errors: sorted(count(rows.filter(failed), r => errorClass(r.error))),
    msMedian: median(ok.map(r => r.ms).filter(Boolean)),
    msP90: p90(ok.map(r => r.ms).filter(Boolean)),
    ttfbMedian: median(ok.map(r => r.ttfbMs).filter(Boolean)),
    fallbacks: [0, 1, 2, 3].map(f => ({ fallbacks: f, n: ok.filter(r => (r.fallbacks ?? 0) === f).length, msMedian: median(ok.filter(r => (r.fallbacks ?? 0) === f).map(r => r.ms).filter(Boolean)) })).filter(x => x.n),
    platforms: [...platforms].map(([platform, x]) => ({ platform, n: x.n, failed: x.failed, fallback: x.fallback, msMedian: median(x.ms), msP90: p90(x.ms), ttfbMedian: median(x.ttfb), tokens: x.tokens })).sort((a, b) => b.n - a.n),
    runs: { n: runs.length, longest: Math.max(0, ...runs.map(r => r.turns)), recoverMedian: median(recover), recoverP90: p90(recover), recoverMax: recover.length ? Math.max(...recover) : null },
    hours: [...hours].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([hour, x]) => ({ hour, ...x })),
  };
}

const s = ms => (ms == null ? '-' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const pct = f => `${(100 * f).toFixed(1)}%`;

/** the numbers as text, one table per block */
export function baselineText(b) {
  const days = b.from ? new Date(b.from).toISOString().slice(0, 16) + ' to ' + new Date(b.to).toISOString().slice(0, 16) + ' UTC' : 'no rows';
  const out = [
    `usage baseline: ${b.records} requests, ${days}`,
    `turns: ${b.turns} (${b.turnsOk} ok, ${b.turnsFailed} failed = ${pct(b.turnFailRate)}, ${b.turnsInterrupted} interrupted); failed hops: ${b.hopsFailed}`,
    `status: ${b.status.map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `latency (ok): median ${s(b.msMedian)}, p90 ${s(b.msP90)}, first byte median ${s(b.ttfbMedian)}`,
    '',
    'failed hops by class:',
    ...(b.errors.length ? b.errors.map(([k, v]) => `  ${String(v).padStart(5)}  ${k}`) : ['  none']),
    '',
    `gateway retries: ${b.fallbacks.map(f => `${f.fallbacks} -> ${f.n} requests, median ${s(f.msMedian)}`).join('; ')}`,
    `failure runs: ${b.runs.n}, longest ${b.runs.longest} turns, time to the next success median ${s(b.runs.recoverMedian)}, p90 ${s(b.runs.recoverP90)}, max ${s(b.runs.recoverMax)}`,
    '',
    'platform         n  failed  retried   median     p90  first byte   tokens',
    ...b.platforms.slice(0, 20).map(p => `${p.platform.padEnd(14)}${String(p.n).padStart(5)}${String(p.failed).padStart(8)}${String(p.fallback).padStart(9)}${s(p.msMedian).padStart(9)}${s(p.msP90).padStart(8)}${s(p.ttfbMedian).padStart(12)}${(p.tokens >= 1e6 ? `${(p.tokens / 1e6).toFixed(1)}M` : p.tokens >= 1e3 ? `${Math.round(p.tokens / 1e3)}k` : String(p.tokens)).padStart(9)}`),
    '',
    `turns failed by hour (UTC): ${b.hours.map(h => `${h.hour.slice(11)}:${h.failed}/${h.turns}`).join(' ')}`,
  ];
  return out.join('\n');
}
