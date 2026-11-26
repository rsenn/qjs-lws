/**
 * freellm: queries against a freellmapi gateway (an OpenAI-compatible
 * router over many free providers, ~/Sources/freellmapi) behind an
 * OpenAIClient. Each request's own route and tokens come with the reply
 * (OpenAIClient.lastMeta); this module asks the gateway about everything
 * else, with the same unified key.
 *
 * ```js
 * const gw = new Gateway(client);
 * if(await gw.detect()) console.log(await gw.usageText());
 * ```
 *
 *   GET /v1/usage           month ledger: requests and tokens per platform and key
 *   GET /v1/providers       upstream platforms, health, keys, cooldowns
 *   GET /v1/quota-forecast  request quotas per pool, low balance, reset
 *   GET /v1/models          catalog, execution_status ready|needsKey|exhausted
 *
 * Per-model quotas are only in the dashboard API. With a dashboard session
 * (FREELLMAPI_DASHBOARD_TOKEN, or FREELLMAPI_EMAIL and FREELLMAPI_PASSWORD
 * for POST /api/auth/login, or the token of a logged-in dashboard tab read
 * over CDP, see lib/gateway/cdp-token.js) it also reads:
 *
 *   GET /api/fallback/rate-limit-usage  rpm/rpd/tpm used vs limit per model
 *   GET /api/fallback/token-usage       monthly token budget and use per model, totals
 *   GET /api/models                     context window per platform model
 */
import { getenv } from 'std';
import { fmtNum, formatTable, fitTable } from '../session/usage-stats.js';
import { piped } from '../ansi.js';
import { quotaCell, pctCell, paint, statusWord, shareBar } from '../look.js';
import { probeBrief } from './exploration.js';
import { rateOf, rateProvider, ratingCell } from './rating.js';
import { saveQuota, loadQuota } from '../session/persist.js';
import { emit } from '../events.js';
import { reportKeys } from './key-events.js';
import { dashboardTokenFromBrowser } from './cdp-token.js';

/* refresh() reads the gateway at most this often */
const REFRESH_MS = 3000;

/** 'used/limit' with short numbers, '' when there is no limit */
const ofLimit = (w, bar) => (w ? quotaCell(w.used, w.limit, bar) : '');

/** a time span as words: 2d 3h 45min, 3h 5min, 45min, under a minute; `now` for a past time */
export function inText(ms) {
  if(!(ms > 0)) return 'now';

  const min = Math.round(ms / 60000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  const parts = [d && `${d}d`, (d || h) && `${h}h`, m && `${m}min`].filter(Boolean);

  return !parts.length ? 'under a minute' : `in ${parts.join(' ').replace(/^(\d+d) 0h/, '$1').replace(/ 0h /, ' ')}`;
}

/** default endpoint of a local freellmapi */
export const FREELLM_URL = 'http://localhost:3001/v1';

/**
 * the keys and spread cells of a platform row: how many keys carried the month's usage (of how many are enabled,
 * when the dashboard says), and each key's share of the tokens, heaviest first - one key carrying nearly everything
 * is amber, the rest of the keys idle
 *
 * @param {string} platform
 * @param {{keyId: number, platform: string, tokens: number, requests: number}[]} byKey  /usage byKey (keys with usage only)
 * @param {Map<string, number>} configured  enabled keys per platform, empty without a dashboard session
 * @returns {[string, string]}
 */
export function keyCells(platform, byKey, configured = new Map()) {
  const mine = byKey.filter(k => k.platform === platform);
  if(!mine.length) return [configured.has(platform) ? `0 of ${configured.get(platform)}` : '-', ''];

  const weight = k => (k.tokens > 0 ? k.tokens : k.requests);
  const all = mine.reduce((n, k) => n + weight(k), 0);
  const shares = mine.map(k => (all ? weight(k) / all : 0)).sort((a, b) => b - a);
  const have = configured.get(platform);
  const count = have != null ? `${mine.length} of ${Math.max(have, mine.length)}` : String(mine.length);

  if(mine.length === 1) return [count, have > 1 ? `\x1b[33m100% on one key, ${have - 1} idle\x1b[0m` : '100%'];

  const shown = shares.slice(0, 5).map(s => `${Math.round(s * 100)}`).join(' · ');
  const uneven = shares[0] > 0.9;
  const text = `${shown}${shares.length > 5 ? ` +${shares.length - 5}` : ''} %`;
  return [count, uneven ? `\x1b[33m${text}\x1b[0m` : text];
}

export class Gateway {
  #client;
  #models = null;
  #origin;
  #token = null;
  #refreshedAt = 0;

  /** whether detect() found a freellmapi */
  enabled = false;

  /** whether a dashboard session is open (see login()) */
  dashboard = false;

  /** why there is no dashboard session, for /gateway quota */
  dashboardNote = 'no FREELLMAPI_DASHBOARD_TOKEN or FREELLMAPI_EMAIL/FREELLMAPI_PASSWORD set';

  /** last answers of refresh(): /v1/usage, rate-limit rows, token-usage, /api/models */
  state = { usage: null, rate: null, budget: null, dashModels: null };

  /** @param {OpenAIClient} client */
  constructor(client) {
    this.#client = client;
    this.#origin = client.baseUrl.replace(/\/v1$/, '');
  }

  /** the gateway's base address without /v1 */
  get origin() {
    return this.#origin;
  }

  #api(path, opts) {
    return this.#client.fetchJSON(this.#origin + path, { ...opts, token: this.#token });
  }

  /** GET (or with opts.method/body, e.g. PUT) a dashboard API path (/api/...) with the session token, after login() */
  api(path, opts) {
    if(!this.#token) throw new Error('no dashboard session: /gateway login');
    return this.#api(path, opts);
  }

  /**
   * opens a dashboard session, from the first source that has one:
   * FREELLMAPI_DASHBOARD_TOKEN, FREELLMAPI_EMAIL + FREELLMAPI_PASSWORD, a
   * logged-in dashboard tab of the browser at cdp.host:cdp.port
   *
   *   cdp.open   open a background dashboard tab when none is open
   *
   * @returns {Promise<boolean>} whether it worked
   */
  async login({ cdp = {} } = {}) {
    const email = getenv('FREELLMAPI_EMAIL'),
      password = getenv('FREELLMAPI_PASSWORD');

    this.#token = getenv('FREELLMAPI_DASHBOARD_TOKEN') ?? null;
    this.tokenSource = this.#token ? 'FREELLMAPI_DASHBOARD_TOKEN' : null;

    try {
      if(!this.#token && email && password) {
        this.#token = (await this.#client.fetchJSON(`${this.#origin}/api/auth/login`, { method: 'POST', body: { email, password } })).token;
        this.tokenSource = 'FREELLMAPI_EMAIL login';
      }

      if(!this.#token && cdp) {
        this.#token = await dashboardTokenFromBrowser(this.#origin, cdp).catch(e => {
          this.dashboardNote = `no FREELLMAPI_DASHBOARD_TOKEN, and the browser at ${cdp.host ?? '127.0.0.1'}:${cdp.port ?? 9222} cannot be asked (${e.message}) - start it with --remote-debugging-port, log in to ${this.#origin}, then /gateway login`;
          return null;
        });

        if(this.#token) this.tokenSource = 'browser (CDP)';
        else if(!this.dashboardNote.includes('cannot be asked')) this.dashboardNote = `no dashboard token: no logged-in ${this.#origin} tab in the browser - log in there, then /gateway login`;
      }

      if(!this.#token) return (this.dashboard = false);

      await this.#api('/api/fallback/token-usage');
      this.dashboard = true;
    } catch(e) {
      this.dashboard = false;
      this.dashboardNote = `dashboard login failed: ${e.detail ?? e.message.split('\n')[0]}`;
    }

    return this.dashboard;
  }

  /**
   * reads month usage and, with a dashboard session, the per-model quotas
   * into `state`. Calls closer than REFRESH_MS apart return at once.
   */
  async refresh(force = false) {
    if(!this.enabled || (!force && Date.now() - this.#refreshedAt < REFRESH_MS)) return;
    this.#refreshedAt = Date.now();

    const st = this.state;

    /* the first time: the last snapshot of an earlier run stands in until the gateway has answered */
    if(this.#preloaded !== true) {
      this.#preloaded = true;
      const snap = loadQuota(this.#origin);
      if(snap) {
        st.usage ??= snap.usage ?? null;
        st.budget ??= snap.budget ?? null;
        st.rate ??= snap.rate ?? null;
        st.snapshotAt = snap.at;
      }
    }

    const jobs = [this.usage().then(u => (st.usage = u))];

    if(this.dashboard) {
      jobs.push(this.#api('/api/fallback/rate-limit-usage').then(r => (st.rate = r.rows ?? [])));
      jobs.push(this.#api('/api/fallback/token-usage').then(r => (st.budget = r)));
      if(!st.dashModels || force) jobs.push(this.#api('/api/models').then(r => (st.dashModels = r)));
    }

    const done = await Promise.allSettled(jobs);

    /* reachability: said once when it changes */
    const down = done.every(j => j.status === 'rejected');
    if(down && !this.#down) emit('gateway', `the gateway at ${this.#origin} does not answer: ${String(done[0].reason?.message ?? done[0].reason).split('\n')[0].slice(0, 100)}`, 'bad');
    else if(!down && this.#down) emit('gateway', `the gateway at ${this.#origin} answers again`, 'good');
    this.#down = down;

    if(!down) this.#reportQuota();

    /* an answered refresh replaces the snapshot of the earlier run and is kept for the next one */
    if(done.every(j => j.status === 'fulfilled')) {
      st.snapshotAt = null;
      saveQuota(this.#origin, { usage: st.usage, budget: st.budget, rate: st.rate });
    }
  }

  #preloaded = false;
  #down = false;

  #quotaLevel = new Map();

  /** a platform's monthly token budget crossing 80%, 95% and 100%: said once per step (and again after a month rollover) */
  #reportQuota() {
    const per = new Map();
    for(const m of this.state.budget?.models ?? []) {
      const p = per.get(m.platform) ?? per.set(m.platform, { used: 0, budget: 0 }).get(m.platform);
      p.used += m.used ?? 0;
      p.budget += m.budget ?? 0;
    }

    for(const [platform, p] of per) {
      if(!(p.budget > 0)) continue;
      const f = p.used / p.budget;
      const level = f >= 1 ? 3 : f >= 0.95 ? 2 : f >= 0.8 ? 1 : 0;
      const was = this.#quotaLevel.get(platform);
      this.#quotaLevel.set(platform, level);
      if(was === undefined || level === was) continue;

      if(level > was) emit('quota', `${platform}: ${Math.round(f * 100)}% of the monthly token budget used (${fmtNum(p.used)}/${fmtNum(p.budget)})`, level === 3 ? 'bad' : 'warn');
      else emit('quota', `${platform}: monthly token budget back below ${was === 3 ? 100 : was === 2 ? 95 : 80}% (${fmtNum(p.used)}/${fmtNum(p.budget)})`, 'good');
    }
  }

  /**
   * quota facts of the model a request was routed to (meta.routedVia =
   * platform/modelId), from the last refresh()
   *
   * @returns {{rpm?: object, rpd?: object, tpm?: object, month?: {used: number, limit: number}}|null}
   */
  modelQuota(meta) {
    if(!meta?.platform || !meta.routedVia) return null;

    const modelId = meta.routedVia.slice(meta.platform.length + 1);
    const rate = this.state.rate?.find(r => r.platform === meta.platform && r.modelId === modelId);
    const budget = this.state.budget?.models?.find(m => m.platform === meta.platform && m.modelId === modelId);
    if(!rate && !budget) return null;

    return { rpm: rate?.rpm, rpd: rate?.rpd, tpm: rate?.tpm, month: budget?.budget ? { used: budget.used, limit: budget.budget } : undefined };
  }

  /**
   * context window of the model that served `meta` (the dashboard's model
   * table, else the catalog entry with that id), falling back to the
   * window of the requested id
   */
  async effectiveContext(meta, requested) {
    const modelId = meta?.routedVia && meta.platform ? meta.routedVia.slice(meta.platform.length + 1) : undefined;
    const dash = modelId && this.state.dashModels?.find(m => m.platform === meta.platform && m.modelId === modelId);
    if(dash?.contextWindow) return dash.contextWindow;

    for(const id of [meta?.model, modelId]) {
      const w = id && (await this.contextWindow(id));
      if(w) return w;
    }

    return requested ? this.contextWindow(requested) : undefined;
  }

  /** /gateway quota [FILTER]: per-model windows and month budget, models used today first */
  async quotaText(filter = '', width = 0, ex = null) {
    if(this.isBridge) return `(a chat-bridge counts per site, see /gateway limits)\n\n${await this.usageText(width)}`;
    if(!this.dashboard) return `(per-model quotas need a dashboard session: ${this.dashboardNote})\n\n${await this.usageText(width)}`;

    await this.refresh(true);
    const { rate = [], budget } = this.state;
    const stale = this.state.snapshotAt ? `${paint(`(last known quota, from ${new Date(this.state.snapshotAt).toISOString().slice(0, 16).replace('T', ' ')}: the gateway did not answer)`, '#fbbf24')}\n` : '';
    const byId = new Map((budget?.models ?? []).map(m => [`${m.platform}/${m.modelId}`, m]));
    const f = filter.toLowerCase();

    const rows = (rate ?? [])
      .map(r => ({ id: `${r.platform}/${r.modelId}`, r, b: byId.get(`${r.platform}/${r.modelId}`) }))
      .filter(({ id, r, b }) => (f ? id.toLowerCase().includes(f) : r.rpd?.used || r.rpm?.used || b?.used))
      .sort((a, b) => (b.b?.used ?? 0) - (a.b?.used ?? 0) || (b.r.rpd?.used ?? 0) - (a.r.rpd?.used ?? 0));

    const total = budget ? `month: ${quotaCell(budget.totalUsed, budget.totalBudget, 24)} budgeted tokens used` : '';

    return [
      stale + total,
      '',
      rows.length
        ? fitTable(width, bar => [['model', 'req/min', 'req/day', 'tok/min', 'month tok', ...(ex?.any ? ['probe'] : [])], ...rows.map(({ id, r, b }) => [id, ofLimit(r.rpm, bar) || '-', ofLimit(r.rpd, bar) || '-', ofLimit(r.tpm, bar) || '-', b ? quotaCell(b.used, b.budget, bar) : '-', ...(ex?.any ? [probeBrief(ex, id)] : [])])])
        : f
          ? `(no model matches "${filter}")`
          : '(no model used in the last day - /gateway quota FILTER lists any)',
    ].join('\n');
  }

  /** who answered /usage: 'freellmapi', or the `source` it names ('chat-bridge') */
  kind = null;

  /** a chat-bridge: usage, providers, forecast and models only; no dashboard, routing profiles, proxy or sticky sessions */
  get isBridge() {
    return this.kind === 'chat-bridge';
  }

  /** whether per-model limits can be read: a dashboard session of a freellmapi, or a bridge's own endpoints */
  get hasLimits() {
    return this.dashboard || this.isBridge;
  }

  /** @returns {Promise<boolean>} whether the endpoint answers /usage the freellmapi way */
  async detect() {
    try {
      const u = await this.#client.getJSON('/usage');
      /* a chat-bridge answers the same endpoints with its own counters (source: 'chat-bridge'): the same
         questions work, but it has no auto routing, dashboard or sticky sessions (see isBridge) */
      this.kind = u?.source ?? 'freellmapi';
      this.enabled = u?.object === 'usage';
    } catch(e) {
      this.enabled = false;
    }

    return this.enabled;
  }

  usage() {
    return this.#client.getJSON('/usage');
  }

  providers() {
    return this.#client.getJSON('/providers');
  }

  forecast() {
    return this.#client.getJSON('/quota-forecast');
  }

  /**
   * the catalog, cached after the first call (refresh = true reloads)
   *
   * @returns {Promise<object[]>} /v1/models entries
   */
  /** the catalog as last loaded, [] before the first models() (for completion, which cannot wait) */
  modelsCached() {
    return this.#models ?? [];
  }

  async models(refresh = false) {
    if(!this.#models || refresh) this.#models = (await this.#client.getJSON('/models')).data ?? [];
    return this.#models;
  }

  /** context window of a model id (auto included), undefined if unknown */
  async contextWindow(id) {
    try {
      const m = (await this.models()).find(m => m.id === id);
      return m?.context_window ?? m?.context_length;
    } catch(e) {
      return undefined;
    }
  }

  /** /gateway usage: this month on the gateway, all clients together; each platform with its share of the tokens */
  async usageText(width = 0) {
    const u = await this.usage();
    const keys = u.byKey ?? [];
    const plats = u.byPlatform ?? [];
    const total = u.tokens || plats.reduce((n, p) => n + p.tokens, 0);
    /* the keys the gateway has per platform (the usage ledger lists only keys that were used): from the dashboard when there is a session */
    const configured = new Map();
    if(this.dashboard && !this.isBridge) {
      const all = await this.api('/api/keys').catch(() => null);
      for(const k of Array.isArray(all) ? all : []) if(k.enabled) configured.set(k.platform, (configured.get(k.platform) ?? 0) + 1);
    }
    const left = u.resetsAt ? Math.max(0, Date.parse(u.resetsAt) - Date.now()) : 0;

    return [
      `${paint('gateway month', '#2dd4bf', true)} ${u.month}: ${paint(u.requests, '#fbbf24')} requests, ${paint(fmtNum(u.tokens), '#fbbf24')} tokens (resets ${u.resetsAt}${left ? `, in ${Math.floor(left / 864e5)}d ${Math.floor((left % 864e5) / 36e5)}h` : ''})`,
      '',
      fitTable(width, bar => [['platform', 'req', 'tokens', 'share', 'keys', 'spread over the keys'], ...plats.map(p => [p.platform, p.requests, fmtNum(p.tokens), total ? pctCell(p.tokens / total, bar) : '-', ...keyCells(p.platform, keys, configured)])], 0, [5, 4]),
      ...(keys.some(k => k.requestCap || k.tokenCap || k.label)
        ? ['', paint('by key:', '#2dd4bf', true), fitTable(width, bar => [['key', 'platform', 'label', 'req', 'tokens'], ...keys.map(k => [k.keyId, k.platform, k.label || '', k.requestCap ? quotaCell(k.requests, k.requestCap, bar) : k.requests, k.tokenCap ? quotaCell(k.tokens, k.tokenCap, bar) : fmtNum(k.tokens)])], 2)]
        : []),
    ].join('\n');
  }

  /**
   * /gateway keys [all|FILTER]: the providers the gateway has keys for and their keys, as the dashboard's Keys
   * page lists them (GET /api/keys, /api/keys/providers; needs a dashboard session). Only the masked key is
   * shown, never a real one: the reveal and export endpoints are not used. `all` adds the providers without a key.
   */
  async keysText(filter = '', width = 0, sort = 'use') {
    if(this.isBridge) return '(a chat-bridge has no provider keys, see /gateway providers)';
    if(!this.dashboard) return `(the keys need a dashboard session: ${this.dashboardNote})`;

    const [{ providers = [], summary }, keys] = await Promise.all([this.api('/api/keys/providers'), this.api('/api/keys'), this.refresh(true)]);
    const all = filter === 'all';
    const f = all ? '' : filter.toLowerCase();
    const names = new Map(providers.map(p => [p.platform, p.name]));
    reportKeys(Array.isArray(keys) ? keys : [], p => names.get(p) ?? p);
    const nameOf = k => k.platform === 'custom' ? (k.groupLabel ?? 'custom') : (names.get(k.platform) ?? k.platform);
    const rows = (Array.isArray(keys) ? keys : []).filter(k => !f || `${nameOf(k)} ${k.platform} ${k.label ?? ''}`.toLowerCase().includes(f));

    /* sort orders: use = tokens then requests this month, heaviest first; quota = share of the platform quota used;
       ok = longest without a healthy answer first (never first); status = unhealthy and cooling first */
    const pool0 = new Map();
    for(const m of this.state.budget?.models ?? []) {
      const p = pool0.get(m.platform) ?? pool0.set(m.platform, { used: 0, budget: 0 }).get(m.platform);
      p.used += m.used ?? 0;
      p.budget += m.budget ?? 0;
    }
    const share = k => { const p = pool0.get(k.platform); return p?.budget ? p.used / p.budget : -1; };
    const bad = k => (k.status === 'healthy' || k.status === 'unknown' ? 0 : 2) + (k.cooldowns?.length ? 1 : 0);
    const byName = (a, b) => nameOf(a).localeCompare(nameOf(b)) || a.id - b.id;
    const order = {
      use: (a, b) => (b.monthlyUsage?.tokens ?? 0) - (a.monthlyUsage?.tokens ?? 0) || (b.monthlyUsage?.requests ?? 0) - (a.monthlyUsage?.requests ?? 0) || byName(a, b),
      requests: (a, b) => (b.monthlyUsage?.requests ?? 0) - (a.monthlyUsage?.requests ?? 0) || byName(a, b),
      quota: (a, b) => share(b) - share(a) || byName(a, b),
      ok: (a, b) => (a.lastHealthyAt ? Date.parse(a.lastHealthyAt) : 0) - (b.lastHealthyAt ? Date.parse(b.lastHealthyAt) : 0) || byName(a, b),
      status: (a, b) => bad(b) - bad(a) || byName(a, b),
      provider: byName,
      id: (a, b) => a.id - b.id,
    };
    if(!order[sort]) return `unknown sort "${sort}": ${Object.keys(order).join(', ')}`;
    rows.sort(order[sort]);

    const ago = t => {
      if(!t) return '-';
      const ms = Date.now() - Date.parse(t);
      return ms < 90e3 ? `${Math.round(ms / 1e3)}s` : ms < 5400e3 ? `${Math.round(ms / 60e3)}m` : ms < 129600e3 ? `${Math.round(ms / 3600e3)}h` : `${Math.round(ms / 86400e3)}d`;
    };

    const head = `${paint(summary?.configured ?? rows.length, '#4ade80', true)} of ${summary?.total ?? '?'} providers configured, ${keys.length} keys (${keys.filter(k => k.enabled).length} enabled), sorted by ${sort}${f ? `, ${rows.length} matching "${filter}"` : ''}\n${paint('meters: tokens/month = the cap of the key where it has one, else its share of the heaviest key; platform quota = what the gateway budgets the platform per month, used by all its keys; last ok: green within 2 h, amber within 2 days, red older', '#787878')}`;
    if(!rows.length) return `${head}\n\n(no key matches "${filter}")`;

    /* the monthly token quota of a platform as the gateway budgets it (the sum over its models), shared by the platform's keys */
    const pool = new Map();
    for(const m of this.state.budget?.models ?? []) {
      const p = pool.get(m.platform) ?? pool.set(m.platform, { used: 0, budget: 0 }).get(m.platform);
      p.used += m.used ?? 0;
      p.budget += m.budget ?? 0;
    }

    /* usage as a meter: of the monthly cap where the key has one, else of the heaviest key (so heavy users stand out) */
    const maxReq = Math.max(1, ...rows.map(k => k.monthlyUsage?.requests ?? 0));
    const maxTok = Math.max(1, ...rows.map(k => k.monthlyUsage?.tokens ?? 0));
    const usage = (n, cap, max, bar) => (!n ? paint('0', '#787878') : cap ? quotaCell(n, cap, bar) : `${bar && !piped ? `${shareBar(n / max, bar)} ` : ''}${fmtNum(n)}`);

    /* when the key last worked: green within 2 hours, amber within 2 days, red older, grey never */
    const lastOk = t => {
      if(!t) return paint('never', '#787878');
      const ms = Date.now() - Date.parse(t);
      return paint(`${ago(t)} ago`, ms < 7200e3 ? '#4ade80' : ms < 172800e3 ? '#fbbf24' : '#f87171');
    };

    const table = fitTable(
      width,
      bar => [
        ['id', 'provider', 'label', 'key', 'status', 'on', 'requests/month', 'tokens/month', 'platform quota', 'last ok', 'note'],
        ...rows.map(k => [
          k.id,
          nameOf(k),
          k.label || '',
          k.keyless ? paint('no key needed', '#787878') : k.maskedKey,
          statusWord(k.status ?? 'unknown'),
          k.enabled ? paint('✔', '#4ade80') : paint('off', '#787878'),
          usage(k.monthlyUsage?.requests ?? 0, k.monthlyRequestCap, maxReq, bar),
          usage(k.monthlyUsage?.tokens ?? 0, k.monthlyTokenCap, maxTok, bar),
          pool.get(k.platform)?.budget ? quotaCell(pool.get(k.platform).used, pool.get(k.platform).budget, bar) : paint('-', '#787878'),
          lastOk(k.lastHealthyAt),
          [k.cooldowns?.length ? `${k.cooldowns.length} cooling` : '', k.lastHealthError ?? ''].filter(Boolean).join(' '),
        ]),
      ],
      [10, 2, 1],
    );

    const missing = all ? providers.filter(p => !p.configured).map(p => p.name) : [];
    return [head, '', table, ...(missing.length ? ['', `${paint('no key:', '#787878', true)} ${missing.join(', ')}`] : [])].join('\n');
  }

  /**
   * /gateway providers: health of every upstream platform, the heaviest used first. Usage is what the gateway
   * recorded this month (/v1/usage): tokens with their share of all tokens, and requests.
   */
  async providersText(width = 0, ex = null, sort = 'rating') {
    const [{ providers = [], counts = {} }, usage] = await Promise.all([this.providers(), this.usage().catch(() => null)]);
    const used = new Map((usage?.byPlatform ?? []).map(p => [p.platform, p]));
    const total = usage?.tokens || [...used.values()].reduce((n, p) => n + p.tokens, 0);
    const byUse = (a, b) => (used.get(b.platform)?.tokens ?? 0) - (used.get(a.platform)?.tokens ?? 0) || (used.get(b.platform)?.requests ?? 0) - (used.get(a.platform)?.requests ?? 0) || String(a.name).localeCompare(String(b.name));
    /* sort:rating (default) puts the providers with the best models first, sort:use the heaviest used */
    const heavy = [...providers].sort(sort === 'use' ? byUse : (a, b) => (rateProvider(b.platform) ?? -1) - (rateProvider(a.platform) ?? -1) || byUse(a, b));

    return [
      Object.entries(counts)
        .map(([k, v]) => `${statusWord(k)} ${v}`)
        .join(', ') + (usage ? ` ${paint(`· month ${usage.month}: ${fmtNum(usage.tokens)} tokens, ${usage.requests} requests, ${sort === 'use' ? 'heaviest used first' : 'best rated first'}`, '#787878')}` : ''),
      '',
      fitTable(
        width,
        bar => [
          ['platform', 'name', 'rate', 'status', 'keys', 'tokens/month', 'requests', 'requests used', ...(ex?.any ? ['explored'] : []), 'note'],
          ...heavy.map(p => {
            const x = ex?.any ? ex.byPlatform(p.platform) : null;
            const u = used.get(p.platform);
            return [
              p.platform,
              p.name,
              ratingCell(rateProvider(p.platform)),
              statusWord(p.status),
              p.keys,
              u ? `${pctCell(total ? u.tokens / total : 0, bar)} ${fmtNum(u.tokens)}` : '-',
              u ? u.requests : '-',
              p.requests_remaining_pct != null ? pctCell(1 - p.requests_remaining_pct / 100, bar) : '-',
              ...(x ? [x.ok || x.bad ? `\x1b[32m✔${x.ok}\x1b[0m \x1b[31m✗${x.bad}\x1b[0m` : '\x1b[2m·\x1b[0m'] : []),
              [p.resume_at && `resumes ${inText(Date.parse(p.resume_at) - Date.now())}`, p.last_error].filter(Boolean).join(', '),
            ];
          }),
        ],
        ex?.any ? 9 : 8,
      ),
    ].join('\n');
  }

  /** /gateway forecast: request quotas the providers reported, used as a meter, LOW in red */
  async forecastText(width = 0) {
    const { pools = [] } = await this.forecast();
    if(!pools.length) return '(no provider has reported a request quota yet)';

    return fitTable(width, bar => [
      ['pool', 'used', 'left', 'limit', 'used %', 'resets', 'low'],
      ...pools.map(p => [p.pool, p.used ?? '-', p.remaining ?? '-', p.limit, p.remaining_pct != null ? pctCell(1 - p.remaining_pct / 100, bar) : p.limit > 0 && p.used != null ? pctCell(p.used / p.limit, bar) : '-', p.reset_at ?? '-', p.low_balance ? paint('LOW', '#f87171', true) : '']),
    ]);
  }

  /**
   * /gateway models [FILTER]: the models a request can use right now,
   * FILTER a substring of id or name; the vendor of an id in color
   */
  async modelsText(filter = '', width = 0, ex = null) {
    const all = await this.models(true);
    const f = filter.toLowerCase();
    const rate = new Map(all.map(m => [m.id, rateOf(m.id) ?? -1])); /* once per model, not twice per comparison */
    const rows = all.filter(m => (m.execution_status ?? 'ready') === 'ready' && (!f || m.id.toLowerCase().includes(f) || (m.name ?? '').toLowerCase().includes(f))).sort((a, b) => rate.get(b.id) - rate.get(a.id));

    return `${paint(rows.length, '#4ade80', true)} of ${all.length} models ready${f ? ` matching "${filter}"` : ''}, best rated first\n\n` + fitTable(width, () => [['id', 'rate', 'ctx', ...(ex?.any ? ['probe'] : []), 'name'], ...rows.map(m => [m.id, ratingCell(rateOf(m.id)), fmtNum(m.context_window ?? m.context_length), ...(ex?.any ? [probeBrief(ex, m.id)] : []), m.name ?? ''])], ex?.any ? 4 : 3);
  }
}
