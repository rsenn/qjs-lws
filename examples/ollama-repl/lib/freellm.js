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
 * over CDP, see lib/cdp-token.js) it also reads:
 *
 *   GET /api/fallback/rate-limit-usage  rpm/rpd/tpm used vs limit per model
 *   GET /api/fallback/token-usage       monthly token budget and use per model, totals
 *   GET /api/models                     context window per platform model
 */
import { getenv } from 'std';
import { fmtNum, formatTable } from './usage-stats.js';
import { dashboardTokenFromBrowser } from './cdp-token.js';

/* refresh() reads the gateway at most this often */
const REFRESH_MS = 3000;

/** 'used/limit' with short numbers, '' when there is no limit */
const ofLimit = w => (w ? `${fmtNum(w.used)}/${fmtNum(w.limit)}` : '');

/** default endpoint of a local freellmapi */
export const FREELLM_URL = 'http://localhost:3001/v1';

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
    const jobs = [this.usage().then(u => (st.usage = u))];

    if(this.dashboard) {
      jobs.push(this.#api('/api/fallback/rate-limit-usage').then(r => (st.rate = r.rows ?? [])));
      jobs.push(this.#api('/api/fallback/token-usage').then(r => (st.budget = r)));
      if(!st.dashModels || force) jobs.push(this.#api('/api/models').then(r => (st.dashModels = r)));
    }

    await Promise.allSettled(jobs);
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
  async quotaText(filter = '') {
    if(!this.dashboard) return `(per-model quotas need a dashboard session: ${this.dashboardNote})\n\n${await this.usageText()}`;

    await this.refresh(true);
    const { rate = [], budget } = this.state;
    const byId = new Map((budget?.models ?? []).map(m => [`${m.platform}/${m.modelId}`, m]));
    const f = filter.toLowerCase();

    const rows = (rate ?? [])
      .map(r => ({ id: `${r.platform}/${r.modelId}`, r, b: byId.get(`${r.platform}/${r.modelId}`) }))
      .filter(({ id, r, b }) => (f ? id.toLowerCase().includes(f) : r.rpd?.used || r.rpm?.used || b?.used))
      .sort((a, b) => (b.b?.used ?? 0) - (a.b?.used ?? 0) || (b.r.rpd?.used ?? 0) - (a.r.rpd?.used ?? 0));

    const total = budget ? `month: ${fmtNum(budget.totalUsed)} of ${fmtNum(budget.totalBudget)} budgeted tokens used (${budget.totalBudget ? Math.round((100 * budget.totalUsed) / budget.totalBudget) : 0}%)` : '';

    return [
      total,
      '',
      rows.length
        ? formatTable([['model', 'req/min', 'req/day', 'tok/min', 'month tok'], ...rows.map(({ id, r, b }) => [id, ofLimit(r.rpm) || '-', ofLimit(r.rpd) || '-', ofLimit(r.tpm) || '-', b ? (b.budget ? `${fmtNum(b.used)}/${fmtNum(b.budget)}` : fmtNum(b.used)) : '-'])])
        : f
          ? `(no model matches "${filter}")`
          : '(no model used in the last day - /gateway quota FILTER lists any)',
    ].join('\n');
  }

  /** @returns {Promise<boolean>} whether the endpoint answers /usage the freellmapi way */
  async detect() {
    try {
      this.enabled = (await this.#client.getJSON('/usage'))?.object === 'usage';
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

  /** /gateway usage: this month on the gateway, all clients together */
  async usageText() {
    const u = await this.usage();
    const keys = u.byKey ?? [];
    const cap = (used, c) => (c ? `${fmtNum(used)}/${fmtNum(c)}` : fmtNum(used));

    return [
      `gateway month ${u.month}: ${u.requests} requests, ${fmtNum(u.tokens)} tokens (resets ${u.resetsAt})`,
      '',
      formatTable([['platform', 'req', 'tokens'], ...(u.byPlatform ?? []).map(p => [p.platform, p.requests, fmtNum(p.tokens)])]),
      ...(keys.some(k => k.requestCap || k.tokenCap || k.label)
        ? ['', 'by key:', formatTable([['key', 'platform', 'label', 'req', 'tokens'], ...keys.map(k => [k.keyId, k.platform, k.label || '', cap(k.requests, k.requestCap), cap(k.tokens, k.tokenCap)])])]
        : []),
    ].join('\n');
  }

  /** /gateway providers: health of every upstream platform */
  async providersText() {
    const { providers = [], counts = {} } = await this.providers();

    return [
      Object.entries(counts)
        .map(([k, v]) => `${k} ${v}`)
        .join(', '),
      '',
      formatTable([
        ['platform', 'name', 'status', 'keys', 'note'],
        ...providers.map(p => [p.platform, p.name, p.status, p.keys, [p.resume_at && `resumes ${p.resume_at}`, p.requests_remaining_pct != null && `${p.requests_remaining_pct}% requests left`, p.last_error].filter(Boolean).join(', ')]),
      ]),
    ].join('\n');
  }

  /** /gateway forecast: request quotas the providers reported */
  async forecastText() {
    const { pools = [] } = await this.forecast();
    if(!pools.length) return '(no provider has reported a request quota yet)';

    return formatTable([
      ['pool', 'used', 'left', 'limit', 'left%', 'resets', 'low'],
      ...pools.map(p => [p.pool, p.used ?? '-', p.remaining ?? '-', p.limit, p.remaining_pct ?? '-', p.reset_at ?? '-', p.low_balance ? 'LOW' : '']),
    ]);
  }

  /**
   * /gateway models [FILTER]: the models a request can use right now,
   * FILTER a substring of id or name
   */
  async modelsText(filter = '') {
    const all = await this.models(true);
    const f = filter.toLowerCase();
    const rows = all.filter(m => (m.execution_status ?? 'ready') === 'ready' && (!f || m.id.toLowerCase().includes(f) || (m.name ?? '').toLowerCase().includes(f)));

    return `${rows.length} of ${all.length} models ready${f ? ` matching "${filter}"` : ''}\n\n` + formatTable([['id', 'ctx', 'name'], ...rows.map(m => [m.id, fmtNum(m.context_window ?? m.context_length), m.name ?? ''])]);
  }
}
