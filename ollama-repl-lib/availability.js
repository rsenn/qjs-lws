/**
 * availability: which models of a freellmapi gateway can be used right now,
 * what limits the others and when they come back. Reads the dashboard API
 * (needs a dashboard session, see Gateway.login) and puts together
 *
 *   /v1/models                          execution_status: ready, exhausted, needsKey
 *   /api/models                         every provider row; grouped like the gateway's unified model ids
 *   /api/fallback/rate-limit-usage      requests/min, requests/day, tokens/min: used and limit
 *   /api/fallback/token-usage           monthly token budget: used and budget
 *   /api/fallback/penalty-inspector     the last errors per model (text hints at IP or region limits)
 *   /api/keys                           per key: cooldowns (exact expiry and source), monthly caps, model scope, status
 *
 * ```js
 * const av = await loadAvailability(gateway);
 * av.byModel.get('qwen3.6-35b-a3b');   // { blocked: true, until: 1795136874376, kinds: ['cooldown'], ... }
 * untilText(av.byModel.get(id).until); // 'in 2h 10m (01:07)'
 * ```
 *
 * The gateway says only that a model is exhausted, not when it recovers, so
 * the time is worked out here: a minute window frees in at most 60 s, a
 * cooldown has its own expiry, the monthly budget at the start of the next
 * UTC month, and a daily request window within 24 h (the oldest request
 * leaves it first; `approx` marks such a time).
 */
import { formatTable, fmtNum } from './usage-stats.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** error texts that point at the caller's address (or region) rather than at the account */
const IP_ERROR = /\b(ips?|ip address)\b|your (ip|network|region|country)|region|country|geo[- ]?(block|restrict)|location|vpn|proxy|data ?cent(er|re)|too many requests from|not available in your/i;

/** the id the gateway gives a group of rows: stripProviderSuffix() of the display name, then slugifyGroupLabel() */
const groupId = displayName => {
  let s = String(displayName ?? '').trim();
  for(let prev; prev !== s; ) {
    prev = s;
    s = s.replace(/\s*\([^()]*\)\s*$/, '').trim().replace(/\s+free$/i, '').trim();
  }
  return s.toLowerCase().replace(/[^a-z0-9.\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'model';
};

const key = (platform, modelId) => `${platform}/${modelId}`;
const firstOfNextMonth = now => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};

/**
 * @typedef {object} Block
 * @property {string} kind      rpm, tpm, rpd, month (budget), cap (key cap), cooldown, ip, credit, tier, scope or key
 * @property {number|null} until  when it ends (epoch ms), null if unknown or never
 * @property {boolean} [approx] until is an upper bound, not an exact time
 * @property {string} detail    one short phrase
 */

/** what a key's cooldown means, by the source the gateway records */
const COOLDOWN_KIND = { credit: ['credit', 'out of credits'], tier: ['tier', 'the model is not on the key\'s tier'], authoritative: ['cooldown', 'the provider named a retry time'], heuristic: ['cooldown', 'cooldown after a rate limit or error'], checkin: ['cooldown', 'waiting for the daily check-in'] };

/** why one key cannot serve one model right now: [] when it can */
function keyBlocks(k, modelId, errors, now) {
  if(!k.enabled) return [{ kind: 'key', until: null, detail: `key ${k.id} is disabled` }];
  if(k.status !== 'healthy' && k.status !== 'unknown') return [{ kind: 'key', until: null, detail: `key ${k.id} is ${k.status}${k.lastHealthError ? `: ${String(k.lastHealthError).slice(0, 60)}` : ''}` }];
  if(Array.isArray(k.modelScope) && !k.modelScope.includes(modelId)) return [{ kind: 'scope', until: null, detail: `outside the model scope of key ${k.id}` }];

  const out = [];

  for(const c of k.cooldowns ?? []) {
    if(c.modelId !== modelId || c.expiresAtMs <= now) continue;
    const ip = c.source !== 'credit' && c.source !== 'tier' && errors.find(e => IP_ERROR.test(e));
    const [kind, detail] = COOLDOWN_KIND[c.source] ?? COOLDOWN_KIND.heuristic;
    out.push(ip ? { kind: 'ip', until: c.expiresAtMs, detail: `the errors point at the IP or region: ${ip.slice(0, 80)}` } : { kind, until: c.expiresAtMs, detail });
  }

  const u = k.monthlyUsage;
  const reset = u?.resetsAt ? Date.parse(u.resetsAt) : firstOfNextMonth(now);
  if(k.monthlyRequestCap > 0 && u?.requests >= k.monthlyRequestCap) out.push({ kind: 'cap', until: reset, detail: `monthly request cap of key ${k.id}: ${u.requests}/${k.monthlyRequestCap}` });
  if(k.monthlyTokenCap > 0 && u?.tokens >= k.monthlyTokenCap) out.push({ kind: 'cap', until: reset, detail: `monthly token cap of key ${k.id}: ${u.tokens}/${k.monthlyTokenCap}` });

  return out;
}

/** when a list of blocks ends: the latest end, null when one of them has none */
const endOf = blocks => (blocks.some(b => b.until == null) ? null : Math.max(...blocks.map(b => b.until)));

/**
 * Blocks of one provider row (platform/modelId): the rate windows and the
 * monthly budget of the row, plus - when every key of the platform is
 * blocked - the blocks of the key that frees up first.
 */
function rowBlocks(row, { rate, budget, keys, errors, now }) {
  const blocks = [];

  for(const [kind, label, ms] of [['rpm', 'requests per minute', MINUTE], ['tpm', 'tokens per minute', MINUTE], ['rpd', 'requests per day', DAY]]) {
    const w = rate?.[kind];
    if(w && w.limit > 0 && w.used >= w.limit) blocks.push({ kind, until: now + ms, approx: true, detail: `${label} ${w.used}/${w.limit}` });
  }

  if(budget?.budget > 0 && budget.used >= budget.budget) blocks.push({ kind: 'month', until: firstOfNextMonth(now), detail: `monthly budget ${budget.used}/${budget.budget} tokens` });

  const perKey = keys.map(k => keyBlocks(k, row.modelId, errors, now));
  if(perKey.length && perKey.every(b => b.length)) {
    const ends = perKey.map(endOf);
    const best = ends.reduce((bi, e, i) => ((e ?? Infinity) < (ends[bi] ?? Infinity) ? i : bi), 0);
    blocks.push(...perKey[best]);
  }

  return blocks;
}

/**
 * Reads the gateway and works out, per model id of /v1/models, whether it is
 * usable and when it will be.
 *
 * @returns {Promise<{at: number, byModel: Map<string, {blocked: boolean, status: string, until: number|null, approx: boolean, kinds: string[], permanent: boolean, blocks: Block[], rows: number, platforms: string[]}>, byRow: Map<string, Block[]>}>}
 */
export async function loadAvailability(gateway) {
  if(gateway.isBridge) return loadBridgeAvailability(gateway);

  const now = Date.now();
  const get = p => gateway.api(p).catch(() => null);

  const [models, chain, rateRes, tokenRes, penRes, keyRes, routing] = await Promise.all([gateway.models(true), get('/api/models'), get('/api/fallback/rate-limit-usage'), get('/api/fallback/token-usage'), get('/api/fallback/penalty-inspector'), get('/api/keys'), get('/api/fallback/routing')]);

  const rate = new Map((rateRes?.rows ?? []).map(r => [key(r.platform, r.modelId), r]));
  const budget = new Map((tokenRes?.models ?? []).map(m => [key(m.platform, m.modelId), m]));
  const errorsOf = new Map((penRes?.rows ?? []).map(r => [key(r.platform, r.modelId), (r.recentErrors ?? []).map(e => e.error ?? '')]));

  const keysOf = new Map();
  for(const k of Array.isArray(keyRes) ? keyRes : []) (keysOf.get(k.platform) ?? keysOf.set(k.platform, []).get(k.platform)).push(k);

  /* provider rows of each model id: the gateway merges rows of one logical model (same display name
     without the "(Provider)" suffix) into the id slugifyGroupLabel() makes of it (model-groups.ts) */
  const rowsOf = new Map();
  const add = (id, r) => (rowsOf.get(id) ?? rowsOf.set(id, []).get(id)).push(r);
  const platformsOf = new Map();
  for(const r of Array.isArray(chain) ? chain : []) {
    if(r.enabled === false) continue;
    for(const id of new Set([groupId(r.displayName), r.modelId])) {
      (platformsOf.get(id) ?? platformsOf.set(id, new Set()).get(id)).add(r.platform);
      if(r.keyCount) add(id, r);
    }
  }

  /* the gateway's intelligence score (0..1) of a model id: the best of its provider rows */
  const intelOf = new Map();
  for(const r of routing?.scores ?? [])
    for(const id of new Set([groupId(r.displayName), r.modelId]))
      if(typeof r.intelligence === 'number' && r.intelligence > (intelOf.get(id) ?? -1)) intelOf.set(id, r.intelligence);

  const byRow = new Map();

  const blocksFor = r => {
    const k = key(r.platform, r.modelId);
    if(!byRow.has(k)) byRow.set(k, rowBlocks(r, { rate: rate.get(k), budget: budget.get(k), keys: keysOf.get(r.platform) ?? [], errors: errorsOf.get(k) ?? [], now }));
    return byRow.get(k);
  };

  const byModel = new Map();

  for(const m of models) {
    const rows = [...new Set(rowsOf.get(m.id) ?? [])];
    const blocks = rows.map(blocksFor);

    /* the gateway's own verdict decides, the rows only explain it: a model with one limited key and one free one is ready */
    const status = m.execution_status ?? 'ready';
    const blocked = status === 'exhausted';

    /* back as soon as the first row is: the earliest end of the rows' blocks */
    const known = blocks.filter(b => b.length).map(endOf).filter(e => e != null);
    const until = blocked && known.length ? Math.min(...known) : null;
    const flat = blocks.flat();

    byModel.set(m.id, {
      blocked,
      status,
      until,
      approx: blocked && flat.some(b => b.approx && b.until === until),
      /* no end to wait for: every key is outside the model's scope or unusable */
      permanent: blocked && flat.length > 0 && flat.every(b => b.until == null && (b.kind === 'scope' || b.kind === 'key')),
      kinds: [...new Set(flat.map(b => b.kind))],
      blocks: flat,
      rows: rows.length,
      intelligence: intelOf.get(m.id) ?? null,
      platforms: [...(platformsOf.get(m.id) ?? [])].sort(),
    });
  }

  return { at: now, byModel, byRow, rate, budget };
}

/**
 * The same picture for a chat-bridge, from its own endpoints: a site is a model and a provider at once. A site
 * that refused with a limit is blocked until the end of its cooldown (/v1/models resets_at); one that needs a
 * login or the billing guard is not blocked but not selectable (/v1/models available false). The requests of
 * its learned budget stand in the day window (a bridge knows no finer one) and the estimated tokens in the
 * month column.
 */
async function loadBridgeAvailability(gateway) {
  const now = Date.now();
  const [models, prov, fore, usage] = await Promise.all([gateway.models(true), gateway.providers().catch(() => null), gateway.forecast().catch(() => null), gateway.usage().catch(() => null)]);
  const provOf = new Map((prov?.providers ?? []).map(p => [p.platform, p]));
  const pools = new Map((fore?.pools ?? []).map(p => [p.pool, p]));
  const tokens = new Map((usage?.byPlatform ?? []).map(p => [p.platform, p.tokens]));
  const byModel = new Map(), byRow = new Map(), rate = new Map(), budget = new Map();

  for(const m of models) {
    const status = m.execution_status ?? 'ready';
    const blocked = status === 'exhausted';
    const until = blocked && m.resets_at ? Date.parse(m.resets_at) : null;
    const blocks = blocked ? [{ kind: 'cooldown', until, detail: provOf.get(m.id)?.last_error ?? 'the site refused: its limit is used up' }] : [];
    const pool = pools.get(m.id);

    byRow.set(m.id, blocks);
    if(pool) rate.set(m.id, { rpd: { used: pool.used, limit: pool.limit } });
    if(tokens.get(m.id)) budget.set(m.id, { used: tokens.get(m.id), budget: 0 });

    byModel.set(m.id, { blocked, status, until, approx: false, permanent: false, kinds: blocks.map(b => b.kind), blocks, rows: 1, intelligence: null, platforms: [m.id] });
  }

  return { at: now, byModel, byRow, rate, budget };
}

/** 90 s -> '1m 30s', 2 h 10 m -> '2h 10m' */
export function spanText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if(s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if(m < 120) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${Math.round(h / 24)}d`;
}

/** 'in 2h 10m (01:07)', '?' when the end is not known */
export function untilText(until, now = Date.now(), approx = false) {
  if(until == null) return '?';
  const t = new Date(until);
  const clock = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const day = t.toDateString() === new Date(now).toDateString() ? '' : `${t.getDate()}.${t.getMonth() + 1}. `;
  return `${approx ? '<= ' : ''}in ${spanText(until - now)} (${day}${clock})`;
}

const KIND = { rpm: 'req/min', tpm: 'tok/min', rpd: 'req/day', month: 'month budget', cap: 'key cap', cooldown: 'cooldown', ip: 'IP limit?', credit: 'no credits', tier: 'not on tier', scope: 'key scope', key: 'key unusable', exhausted: 'exhausted' };

/** when a limited model is back: 'in 2h 10m (01:07)', 'not by waiting' for a key scope, '?' when unknown */
export const backText = (entry, now = Date.now()) => (entry.permanent ? 'not by waiting' : untilText(entry.until, now, entry.approx));

/** short label of why a model is blocked: 'req/day, cooldown' */
export const kindsText = entry => (entry.kinds.length ? entry.kinds.map(k => KIND[k] ?? k).join(', ') : 'exhausted');

/** 'used/limit' of a window, '-' when the model has none */
const windowText = w => (w && w.limit > 0 ? `${fmtNum(w.used)}/${fmtNum(w.limit)}` : '-');

/**
 * /gateway limits [FILTER]: for each provider row the requests and tokens
 * used of every period (minute, day, month), what is limited right now and
 * when it ends. Without FILTER only rows that have usage or a limit are shown.
 */
export function limitsText(av, filter = '') {
  const f = filter.toLowerCase();
  const names = new Set([...av.rate.keys(), ...av.budget.keys()]);

  const rows = [...names]
    .filter(k => (f ? k.toLowerCase().includes(f) : av.byRow.get(k)?.length || av.rate.get(k)?.rpm?.used || av.rate.get(k)?.rpd?.used || av.budget.get(k)?.used))
    .map(k => {
      const r = av.rate.get(k);
      const b = av.budget.get(k);
      const blocks = av.byRow.get(k) ?? [];
      const until = blocks.length && !blocks.some(x => x.until == null) ? Math.max(...blocks.map(x => x.until)) : null;
      const month = b ? (b.budget > 0 ? `${fmtNum(b.used)}/${fmtNum(b.budget)}` : fmtNum(b.used)) : '-';

      return { k, until, cells: [k, windowText(r?.rpm), windowText(r?.rpd), windowText(r?.tpm), month, blocks.length ? [...new Set(blocks.map(x => KIND[x.kind] ?? x.kind))].join(', ') : '', blocks.length ? (blocks.every(x => x.until == null && (x.kind === 'scope' || x.kind === 'key')) ? 'not by waiting' : untilText(until, av.at, blocks.some(x => x.approx))) : ''] };
    })
    .sort((a, b) => (b.cells[5] ? 1 : 0) - (a.cells[5] ? 1 : 0) || (a.until ?? Infinity) - (b.until ?? Infinity) || a.k.localeCompare(b.k));

  if(!rows.length) return f ? `(no model matches "${filter}")` : '(nothing is limited or used yet - /gateway limits FILTER lists any model)';

  return [
    `limits per provider row, used/limit: minute and day windows slide, the month budget ends ${new Date(firstOfNextMonth(av.at)).toISOString().slice(0, 10)} (UTC)`,
    '',
    formatTable([['provider/model', 'req/min', 'req/day', 'tok/min', 'month tok', 'limited by', 'back'], ...rows.map(r => r.cells)]),
  ].join('\n');
}

/** /gateway limited [FILTER]: the model ids that cannot serve a request now, soonest back first */
export function limitedText(av, filter = '') {
  const f = filter.toLowerCase();
  const rows = [...av.byModel]
    .filter(([id, e]) => e.blocked && (!f || id.toLowerCase().includes(f)))
    .sort((a, b) => (a[1].until ?? Infinity) - (b[1].until ?? Infinity) || a[0].localeCompare(b[0]));

  if(!rows.length) return f ? `(no limited model matches "${filter}")` : '(no model is limited right now)';

  const ip = rows.filter(([, e]) => e.kinds.includes('ip')).length;
  return [
    `${rows.length} models cannot serve a request right now`,
    '',
    formatTable([['model', 'providers', 'limited by', 'back', 'detail'], ...rows.map(([id, e]) => [id, e.platforms.join(',') || '-', kindsText(e), backText(e, av.at), e.blocks[0]?.detail ?? 'the gateway does not say why'])]),
    ...(ip ? ['', `${ip} look limited by IP or region: /proxy exit asks for another exit address, /proxy off sends requests directly`] : []),
  ].join('\n');
}
