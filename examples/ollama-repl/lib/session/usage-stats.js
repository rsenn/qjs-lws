/**
 * usage-stats: the session's ledger of model requests - one record per
 * chat()/chatStream() call, failed ones included - and the text views of
 * it that /usage, /last and /requests print.
 *
 * ```js
 * const stats = new UsageStats();
 * client.onMeta = meta => stats.add(meta);
 * console.log(stats.summary());
 * ```
 *
 * A record is the metadata object lib/clients/openai-client.js builds (see the
 * field list above OpenAIClient). Other clients may pass a smaller one:
 * only requested, model and ms are expected.
 */

import { fmtUsd } from '../clients/pricing.js';
import * as terminal from 'terminal';
import { trailText } from '../failover/fallback-trail.js';

/** 1234 -> '1.2k', 3400000 -> '3.4M', undefined -> '-' */
export function fmtNum(n) {
  if(n == null || Number.isNaN(n)) return '-';
  if(n < 1000) return String(n);
  if(n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if(n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  return `${(n / 1e9).toFixed(1)}G`;
}

/** 850 -> '850ms', 31158 -> '31.2s', 95000 -> '1m35s' */
export function fmtMs(ms) {
  if(ms == null) return '-';
  if(ms < 1000) return `${ms}ms`;
  if(ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

/** where a request went, as one name: kilo/dots-3-note-preview:free, else the model */
export function routeName(meta) {
  return meta.routedVia ?? meta.model ?? meta.requested ?? '?';
}

/**
 * one dim line printed under a reply
 *
 *   kilo/dots-3:free (AtlasCloud) 19+2.3k tok, 2.2k reasoning, 31.2s, 1 fallback
 */
export function routeLine(meta) {
  const u = meta.usage;
  const parts = [`${routeName(meta)}${meta.provider ? ` (${meta.provider})` : ''}`];

  if(meta.requested && meta.requested !== meta.model && !routeName(meta).endsWith(meta.requested)) parts[0] = `${meta.requested} -> ${parts[0]}`;
  if(u) parts.push(`${fmtNum(u.prompt)}+${fmtNum(u.completion)} tok${u.reasoning ? `, ${fmtNum(u.reasoning)} reasoning` : ''}${u.cached ? `, ${fmtNum(u.cached)} cached` : ''}`);
  parts.push(fmtMs(meta.ms));
  if(meta.fallbacks) parts.push(`${meta.fallbacks} fallback${meta.fallbacks > 1 ? 's' : ''}`);
  if(meta.error) parts.push(`error: ${meta.error}`);
  if(meta.error && meta.retryAfter > 0) parts.push(`retry in ${fmtMs(meta.retryAfter * 1000)}`);
  return parts.join(', ');
}

/** when the gateway said the request could be tried again: its reset time, or the wait it asked for */
export function retryText(meta) {
  if(Number.isFinite(meta.retryAtMs)) return `gateway's soonest reset ${new Date(meta.retryAtMs).toISOString().slice(11, 19)}Z`;
  if(meta.retryAfter > 0) return `${fmtMs(meta.retryAfter * 1000)} after the request (Retry-After)`;
}

/** every known fact of one request, one per line, for /last */
export function formatMeta(meta) {
  if(!meta) return '(no request yet)';

  const u = meta.usage ?? {};
  const rows = [
    ['requested', meta.requested],
    ['model', meta.model],
    ['routed via', meta.routedVia],
    ['platform', meta.platform],
    ['provider', meta.provider],
    ['proxy', meta.proxied == null ? undefined : meta.proxied ? 'yes, upstream through the gateway proxy' : 'no, direct'],
    ['request id', meta.requestId],
    ['status', meta.error ? `${meta.status ?? '-'} error: ${meta.error}` : meta.status],
    ['finish', meta.nativeFinish && meta.nativeFinish !== meta.finish ? `${meta.finish} (upstream: ${meta.nativeFinish})` : meta.finish],
    ['gen id', meta.genId],
    ['fingerprint', meta.fingerprint],
    ['tier', meta.serviceTier],
    ['tokens', meta.usage ? `prompt ${u.prompt ?? '-'}, completion ${u.completion ?? '-'}, total ${u.total ?? '-'}` : 'not reported'],
    ['reason tok', u.reasoning],
    ['cached', u.cached],
    ['cache write', u.cacheWrite],
    ['cost', u.cost ?? (meta.costEst !== undefined ? `~${fmtUsd(meta.costEst)} (estimated from the price table)` : undefined)],
    ['usage raw', meta.usageRaw ? JSON.stringify(meta.usageRaw) : undefined],
    ['reasoning', meta.reasoning ? `${meta.reasoning.length} chars (Ctrl-O shows it)` : undefined],
    ['time', `${fmtMs(meta.ms)} total, ${fmtMs(meta.ttfbMs)} to headers${meta.firstTokenMs != null ? `, ${fmtMs(meta.firstTokenMs)} to first token` : ''}${meta.stream ? ' (streamed)' : ''}`],
    ['fallbacks', meta.fallbacks || undefined],
    ['trail', trailText(meta.trail)],
    ['retry', retryText(meta)],
    ['detail', meta.detail],
    ['compress', meta.compress],
    ['cache', meta.cache],
    ['rate limit', meta.rateLimit ? `${meta.rateLimit.remaining}/${meta.rateLimit.limit} left${Number.isFinite(meta.rateLimit.reset) ? `, resets ${new Date(meta.rateLimit.reset * 1000).toISOString().slice(11, 19)}Z` : ''}` : undefined],
    ['at', meta.at ? new Date(meta.at).toISOString() : undefined],
  ];

  const headers = Object.entries(meta.headers ?? {}).map(([k, v]) => `  ${k}: ${v}`);

  return rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k.padEnd(11)} ${v}`)
    .concat(headers.length ? ['headers', ...headers] : [])
    .join('\n');
}

/**
 * the rate-limit windows in a record's x-ratelimit-* headers: Cerebras names
 * them per window (remaining-requests-minute), OpenAI has one unnamed window
 * (remaining-requests, reset-requests). Returns [{ window, requests: {remaining, limit, reset}, tokens: {...} }]
 * in header order, [] when there are none.
 */
export function quotaWindows(headers = {}) {
  const wins = new Map();

  for(const [k, v] of Object.entries(headers)) {
    const m = /^x-ratelimit-(limit|remaining|reset)-(requests|tokens)(?:-(\w+))?$/.exec(k);
    if(!m) continue;
    const w = wins.get(m[3] ?? '') ?? { window: m[3] ?? '', requests: {}, tokens: {} };
    w[m[2]][m[1]] = v;
    wins.set(m[3] ?? '', w);
  }

  return [...wins.values()];
}

/**
 * the /quota text: the limits the endpoint reported with the newest answer
 * that carried any. A remaining above its limit is shown with a "?": some
 * endpoints (Cerebras, hourly tokens) report such figures.
 */
export function quotaText(records) {
  for(let i = records.length - 1; i >= 0; i--) {
    const wins = quotaWindows(records[i].headers);
    if(!wins.length) continue;

    const exact = v => (Number.isFinite(+v) ? String(Math.trunc(+v)).replace(/\B(?=(\d{3})+$)/g, ',') : String(v ?? '-'));
    const cell = q => (q.remaining === undefined && q.limit === undefined ? '-' : `${exact(q.remaining)} / ${exact(q.limit)}${+q.remaining > +q.limit ? ' ?' : ''}${q.reset ? ` (resets in ${q.reset})` : ''}`);
    const rows = [['window', 'requests left / limit', 'tokens left / limit'], ...wins.map(w => [w.window || '-', cell(w.requests), cell(w.tokens)])];
    return `${routeName(records[i])}, as of ${new Date(records[i].at).toISOString()}\n${formatTable(rows)}`;
  }

  return '(no x-ratelimit-* headers seen yet in this session: send a request first)';
}

/** fixed-width table: rows of cells, first row is the header, numbers right-aligned */
export function formatTable(rows) {
  /* colors do not take room: a cell is as wide as what it shows */
  const shown = c => String(c).replace(/\x1b\[[0-9;]*m/g, '');
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => shown(r[i]).length)));
  const fill = (c, i) => ' '.repeat(Math.max(0, widths[i] - shown(c).length));
  /* a column of numbers lines up on the right; one that also holds meters or text stays on the left, dashes included */
  const numeric = rows[0].map((_, i) => i > 0 && rows.slice(1).every(r => /^[\d.,kMG%-]*$/.test(String(r[i]))));

  return rows.map(r => r.map((c, i) => (numeric[i] && r !== rows[0] ? fill(c, i) + c : c + fill(c, i))).join('  ').trimEnd()).join('\n');
}

/**
 * a table that fits `width` columns: `make(bar)` builds the rows with meters
 * of `bar` cells; the meters shrink (6, 3, none), then the first column is
 * cut with an ellipsis (column `flex`, text without colors). Without a width
 * (or piped) the first try is used.
 */
function fitTableLocal(width, make, flex = 0, drop = []) {
  const gone = new Set();

  for(;;) {
    const r = fitOnce(width, bar => make(bar).map(row => row.filter((_, i) => !gone.has(i))), [].concat(flex).filter(i => !gone.has(i)).map(i => i - [...gone].filter(g => g < i).length));
    const next = drop.find(d => !gone.has(d));
    if(r.fits || next === undefined) return r.text;
    gone.add(next);
  }
}

/** terminal.js's fitTable (native in textcode on qjsm) when the installed qjs-modules has it, else the copy above */
export const fitTable = terminal.fitTable ?? fitTableLocal;

/** the visible width of a cell: escape sequences do not count */
const shown = c => String(c).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** a cell cut to n visible cells with an ellipsis; escape sequences are kept and a reset closes a coloured cut */
function cut(c, n) {
  const s = String(c);
  if([...shown(s)].length <= n) return s;

  const SGR = /\x1b\[[0-9;]*[A-Za-z]/y;
  let out = '';
  let seen = 0;
  for(let i = 0; i < s.length; ) {
    SGR.lastIndex = i;
    const m = SGR.exec(s);
    if(m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    if(seen >= n - 1) break;
    const ch = String.fromCodePoint(s.codePointAt(i));
    out += ch;
    seen++;
    i += ch.length;
  }

  return `${out}…${s.includes('\x1b') ? '\x1b[0m' : ''}`;
}

function fitOnce(width, make, cols) {
  const colWide = (rows, i) => Math.max(...rows.map(r => [...shown(r[i])].length));
  const wide = rows => rows[0].reduce((n, _, i) => n + colWide(rows, i), 2 * (rows[0].length - 1));
  let rows;

  /* the flexible columns give up what is missing, the widest first, each down to its header (at least 6); the meters shrink before that */
  for(const bar of [6, 3, 0]) {
    rows = make(bar);
    let over = width > 0 ? wide(rows) - width : 0;
    if(over <= 0) return { text: formatTable(rows), fits: true };

    if(bar !== 0 && cols.length && colWide(rows, cols[0]) - over < 24) continue;
    if(bar !== 0 && !cols.length) continue;

    const target = new Map(cols.map(i => [i, colWide(rows, i)]));
    const min = i => Math.max(6, [...shown(rows[0][i])].length);

    while(over > 0) {
      const [i] = [...target].filter(([i, w]) => w > min(i)).sort((a, b) => b[1] - a[1])[0] ?? [];
      if(i === undefined) break;
      target.set(i, target.get(i) - 1);
      over--;
    }

    const out = rows.map((r, n) => r.map((c, i) => (n && target.has(i) ? cut(c, target.get(i)) : c)));
    return { text: formatTable(out), fits: over <= 0 };
  }
}

export class UsageStats {
  records = [];

  /** adds one request's metadata, stamped with the time it ended */
  add(meta) {
    this.records.push({ ...meta, at: Date.now() });
  }

  last() {
    return this.records[this.records.length - 1] ?? null;
  }

  /**
   * sums over `records`
   *
   * @returns {{requests: number, failed: number, prompt: number, completion: number, reasoning: number, cached: number, total: number, ms: number, fallbacks: number}}
   */
  totals(records = this.records) {
    const t = { requests: 0, failed: 0, prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0, ms: 0, fallbacks: 0, costEst: 0, priced: 0 };

    for(const r of records) {
      t.requests++;
      if(r.error) t.failed++;
      t.prompt += r.usage?.prompt ?? 0;
      t.completion += r.usage?.completion ?? 0;
      t.reasoning += r.usage?.reasoning ?? 0;
      t.cached += r.usage?.cached ?? 0;
      t.total += r.usage?.total ?? 0;
      t.ms += r.ms ?? 0;
      t.fallbacks += r.fallbacks ?? 0;
      if(r.costEst !== undefined && r.usage?.cost == null) (t.costEst += r.costEst), t.priced++;
    }

    return t;
  }

  /** totals per key(record), largest token count first */
  groupBy(key) {
    const groups = new Map();

    for(const r of this.records) {
      const k = key(r) ?? '?';
      if(!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }

    return [...groups].map(([k, rs]) => ({ key: k, ...this.totals(rs) })).sort((a, b) => b.total - a.total || b.requests - a.requests);
  }

  /** the /usage text: session totals, then per routed model and per platform */
  summary(title = 'session') {
    if(!this.records.length) return title === 'session' ? '(no requests yet in this session)' : `(no requests recorded ${title})`;

    const t = this.totals();
    const head = ['', 'req', 'fail', 'prompt', 'compl', 'reason', 'total', 'time'];
    const row = g => [g.key, g.requests, g.failed || '-', fmtNum(g.prompt), fmtNum(g.completion), fmtNum(g.reasoning || undefined), fmtNum(g.total), fmtMs(g.ms)];
    const out = [
      `${title}: ${t.requests} requests (${t.failed} failed), ${fmtNum(t.total)} tokens: ${fmtNum(t.prompt)} prompt, ${fmtNum(t.completion)} completion (${fmtNum(t.reasoning)} reasoning), ${fmtNum(t.cached)} cached, ${t.fallbacks} gateway fallbacks, ${fmtMs(t.ms)} waiting${t.priced ? `, ~${fmtUsd(t.costEst)} estimated${t.priced < t.requests ? ` (${t.priced} of ${t.requests} requests priced)` : ''}` : ''}`,
      '',
      'by model:',
      formatTable([head, ...this.groupBy(routeName).map(row)]),
    ];

    const platforms = this.groupBy(r => r.platform ?? r.provider);
    if(platforms.some(g => g.key !== '?')) out.push('', 'by platform:', formatTable([head, ...platforms.map(row)]));
    return out.join('\n');
  }

  /** the /requests text: the last n records, oldest first */
  recent(n = 10) {
    const rs = this.records.slice(-n);
    if(!rs.length) return '(no requests yet in this session)';

    const first = this.records.length - rs.length;
    return formatTable([
      ['#', 'time', 'route', 'prompt', 'compl', 'reason', 'took', 'note'],
      ...rs.map((r, i) => [first + i + 1, new Date(r.at).toTimeString().slice(0, 8), routeName(r), fmtNum(r.usage?.prompt), fmtNum(r.usage?.completion), fmtNum(r.usage?.reasoning), fmtMs(r.ms), r.error ? `error: ${r.error.slice(0, 50)}` : r.fallbacks ? `${r.fallbacks} fallback(s)` : '']),
    ]);
  }

  /** record #n (1-based, as /requests numbers them), or the last one */
  get(n) {
    return n ? (this.records[n - 1] ?? null) : this.last();
  }
}
