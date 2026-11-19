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
 * A record is the metadata object lib/openai-client.js builds (see the
 * field list above OpenAIClient). Other clients may pass a smaller one:
 * only requested, model and ms are expected.
 */

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
  return parts.join(', ');
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
    ['cost', u.cost],
    ['usage raw', meta.usageRaw ? JSON.stringify(meta.usageRaw) : undefined],
    ['reasoning', meta.reasoning ? `${meta.reasoning.length} chars (Ctrl-O shows it)` : undefined],
    ['time', `${fmtMs(meta.ms)} total, ${fmtMs(meta.ttfbMs)} to headers${meta.firstTokenMs != null ? `, ${fmtMs(meta.firstTokenMs)} to first token` : ''}${meta.stream ? ' (streamed)' : ''}`],
    ['fallbacks', meta.fallbacks || undefined],
    ['trail', meta.trail],
    ['detail', meta.detail],
    ['compress', meta.compress],
    ['cache', meta.cache],
    ['rate limit', meta.rateLimit ? `${meta.rateLimit.remaining}/${meta.rateLimit.limit} left, resets ${new Date(meta.rateLimit.reset * 1000).toISOString().slice(11, 19)}Z` : undefined],
    ['at', meta.at ? new Date(meta.at).toISOString() : undefined],
  ];

  const headers = Object.entries(meta.headers ?? {}).map(([k, v]) => `  ${k}: ${v}`);

  return rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k.padEnd(11)} ${v}`)
    .concat(headers.length ? ['headers', ...headers] : [])
    .join('\n');
}

/** fixed-width table: rows of cells, first row is the header, numbers right-aligned */
export function formatTable(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => String(r[i]).length)));

  return rows.map(r => r.map((c, i) => (i && /^[\d.,kMG%-]+$/.test(String(c)) ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i]))).join('  ').trimEnd()).join('\n');
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
    const t = { requests: 0, failed: 0, prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0, ms: 0, fallbacks: 0 };

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
  summary() {
    if(!this.records.length) return '(no requests yet in this session)';

    const t = this.totals();
    const head = ['', 'req', 'fail', 'prompt', 'compl', 'reason', 'total', 'time'];
    const row = g => [g.key, g.requests, g.failed || '-', fmtNum(g.prompt), fmtNum(g.completion), fmtNum(g.reasoning || undefined), fmtNum(g.total), fmtMs(g.ms)];
    const out = [
      `session: ${t.requests} requests (${t.failed} failed), ${fmtNum(t.total)} tokens: ${fmtNum(t.prompt)} prompt, ${fmtNum(t.completion)} completion (${fmtNum(t.reasoning)} reasoning), ${fmtNum(t.cached)} cached, ${t.fallbacks} gateway fallbacks, ${fmtMs(t.ms)} waiting`,
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
