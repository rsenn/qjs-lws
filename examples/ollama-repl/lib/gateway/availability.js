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
import { formatTable, fitTable, fmtNum } from '../session/usage-stats.js';
import { quotaCell, paint } from '../look.js';
import { probeBrief } from './exploration.js';
import { rateOf, ratingCell } from './rating.js';
import { loadFile } from 'std';
import { setTimeout, clearTimeout } from 'os';
import { writeConfigFile } from '../config.js';
import { cooldownsPath } from '../session/persist.js';
import { emit } from '../events.js';
import { timed, slicer } from '../lag.js';
import { reportKeys } from './key-events.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * Learned cooldown tracking.
 * Maps model key (platform/modelId) -> { lastFailure: number|null, avgCooldown: number }
 * Uses exponential moving average: 70% old, 30% new.
 */
const learnedCooldowns = new Map();

let dirty = null;

/** the learned cooldowns and the unexpired shadow blocks are kept in cooldowns.json (lib/session/persist.js), written a few seconds after a change */
const markDirty = () => {
  if(dirty) return;
  dirty = setTimeout(saveCooldowns, 5000);
};

export function saveCooldowns() {
  if(dirty) clearTimeout(dirty);
  dirty = null;
  const now = Date.now();
  writeConfigFile(cooldownsPath(), JSON.stringify({ learned: Object.fromEntries(learnedCooldowns), shadow: Object.fromEntries([...shadowBlocks].filter(([, b]) => b.until > now)) }));
}

/** reads cooldowns.json back, once at startup; shadow blocks that ran out meanwhile are dropped */
export function loadCooldowns() {
  try {
    const d = JSON.parse(loadFile(cooldownsPath())) ?? {};
    for(const [k, v] of Object.entries(d.learned ?? {})) if(!learnedCooldowns.has(k)) learnedCooldowns.set(k, v);
    for(const [k, v] of Object.entries(d.shadow ?? {})) if(v.until > Date.now() && !shadowBlocks.has(k)) shadowBlocks.set(k, v);
  } catch(e) {}
}

/**
 * Record a cooldown event for a model.
 * @param {string} modelKey - The model key (platform/modelId)
 * @param {'failure'|'success'} event - Whether this is a failure or success
 * @param {number} [now=Date.now()] - Current timestamp
 */
export function recordCooldownEvent(modelKey, event, now = Date.now()) {
  if (!modelKey || typeof modelKey !== 'string') return;
  let entry = learnedCooldowns.get(modelKey);
  if (!entry) {
    entry = { lastFailure: null, avgCooldown: null };
    learnedCooldowns.set(modelKey, entry);
  }

  if (event === 'failure') {
    entry.lastFailure = now;
    markDirty();
  } else if (event === 'success') {
    if (entry.lastFailure !== null) {
      const actualDuration = now - entry.lastFailure;
      if (entry.avgCooldown === null) {
        entry.avgCooldown = actualDuration;
      } else {
        // Exponential moving average: 70% old, 30% new
        entry.avgCooldown = Math.round(entry.avgCooldown * 0.7 + actualDuration * 0.3);
      }
      entry.lastFailure = null;
      markDirty();
    }
  }
}

/**
 * Retrieve the learned average cooldown for a model.
 * @param {string} modelKey
 * @returns {number|null} The learned average cooldown in milliseconds, or null if none
 */
export function getLearnedCooldown(modelKey) {
  const entry = learnedCooldowns.get(modelKey);
  return entry?.avgCooldown ?? null;
}

/**
 * Local shadow blocklist: modelId -> { until: epoch ms, reason: string }.
 * Updated immediately on a transient failure, before the dashboard API
 * reflects it. applyShadowBlocks() merges these into byModel so the
 * router refuses to pick a model we just saw fail. Entries are pruned
 * on read; the unexpired ones persist in cooldowns.json.
 */
const shadowBlocks = new Map();

/** Record a transient failure for a model id. Called from repl.js. */
export function recordLocalFailure(modelId, error, now = Date.now()) {
  if (!modelId || typeof modelId !== 'string') return;
  const status = error?.status ?? error?.statusCode;
  const retryAfter = error?.headers?.['retry-after'] ?? error?.retryAfter;
  let waitMs = MINUTE;
  if (status === 429) waitMs = retryAfter ? Math.max(MINUTE, parseInt(retryAfter, 10) * 1000) : MINUTE;
  else if (status === 500 || status === 502 || status === 503) waitMs = 30_000;
  else if (/timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|network/i.test(String(error?.message ?? ''))) waitMs = 15_000;
  shadowBlocks.set(modelId, { until: now + waitMs, reason: String(error?.message ?? `status ${status}`).slice(0, 120) });
  markDirty();
}

/**
 * Merge shadow blocks into byModel in place. A shadow block only
 * OVERRIDES the dashboard when the dashboard says the model is ready;
 * if the dashboard already has a longer `until`, we keep that.
 * Expired shadow entries are pruned here.
 */
export function applyShadowBlocks(byModel, now = Date.now()) {
  for (const [id, block] of shadowBlocks) {
    if (block.until <= now) { shadowBlocks.delete(id); continue; }
    const entry = byModel.get(id);
    if (!entry) continue;
    if (!entry.blocked) {
      entry.blocked = true;
      entry.status = 'exhausted';
      entry.until = block.until;
      entry.approx = false;
      if (!entry.kinds.includes('shadow')) entry.kinds.push('shadow');
      entry.blocks.push({ kind: 'shadow', until: block.until, detail: `local failure: ${block.reason}` });
    } else if (block.until > (entry.until ?? 0)) {
      entry.until = block.until;
      entry.approx = false;
      if (!entry.kinds.includes('shadow')) entry.kinds.push('shadow');
    }
  }
}

/** error texts that point at the caller's address (or region) rather than at the account */
const IP_ERROR = /\b(ips?|ip address)\b|your (ip|network|region|country)|region|country|geo[- ]?(block|restrict)|location|vpn|proxy|data ?cent(er|re)|too many requests from|not available in your/i;

/** the id the gateway gives a group of rows: stripProviderSuffix() of the display name, then slugifyGroupLabel() */
const groupIds = new Map();
export const groupId = displayName => {
  const raw = String(displayName ?? '');
  let id = groupIds.get(raw);
  if(id === undefined) {
    id = groupIdOf(raw);
    if(groupIds.size > 5000) groupIds.clear();
    groupIds.set(raw, id);
  }
  return id;
};
const groupIdOf = displayName => {
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

/* the first error of a row that points at the address, found once per errors array (the rows share it across their keys) */
const ipErrors = new WeakMap();
const ipError = errors => {
  if(!ipErrors.has(errors)) ipErrors.set(errors, errors.find(e => IP_ERROR.test(e)));
  return ipErrors.get(errors);
};

/** why one key cannot serve one model right now: [] when it can */
function keyBlocks(k, modelId, errors, now) {
  if(!k.enabled) return [{ kind: 'key', until: null, detail: `key ${k.id} is disabled` }];
  if(k.status !== 'healthy' && k.status !== 'unknown') return [{ kind: 'key', until: null, detail: `key ${k.id} is ${k.status}${k.lastHealthError ? `: ${String(k.lastHealthError).slice(0, 60)}` : ''}` }];
  if(Array.isArray(k.modelScope) && !k.modelScope.includes(modelId)) return [{ kind: 'scope', until: null, detail: `outside the model scope of key ${k.id}` }];

  const out = [];

  for(const c of k.cooldowns ?? []) {
    if(c.modelId !== modelId || c.expiresAtMs <= now) continue;
    const ip = c.source !== 'credit' && c.source !== 'tier' && ipError(errors);
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
function rowBlocks(row, { rate, budget, keys, errors, now }, byRow) {
  // Record failure event if there are existing blocks (meaning the model is currently limited)
  const modelKey = key(row.platform, row.modelId);
  const existingBlocks = byRow?.get(modelKey);
  if (existingBlocks && existingBlocks.length > 0) {
    recordCooldownEvent(modelKey, 'failure', now);
  }

  const blocks = [];

  // Helper to get learned cooldown or fall back to fixed constant
  const getDuration = (kind, fixedMs) => {
    const learned = getLearnedCooldown(modelKey);
    if (learned !== null) return learned;
    return fixedMs;
  };

  for(const [kind, label, ms] of [['rpm', 'requests per minute', MINUTE], ['tpm', 'tokens per minute', MINUTE], ['rpd', 'requests per day', DAY]]) {
    const w = rate?.[kind];
    if(w && w.limit > 0 && w.used >= w.limit) blocks.push({ kind, until: now + getDuration(kind, ms), approx: true, detail: `${label} ${w.used}/${w.limit}` });
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
let lastSeen = null;
let lastIpChange = 0;

/** the exit address of the proxy changed (or the proxy was switched): models that come back soon after are reported as such */
export function noteIpChange(at = Date.now()) {
  lastIpChange = at;
  /* what was limited just before, by kind: the later looks say which of those limits the new address really lifted */
  ipBaseline = new Map([...(lastSeen ?? [])].filter(([, e]) => e.blocked).map(([id, e]) => [id, e.kinds ?? []]));
}

let ipBaseline = null;
const IP_TALLY_AFTER_MS = 25e3;

/**
 * which limits an address change lifted: of the models limited before it, per kind of limit, how many are usable now
 *
 * @param {Map<string, string[]>} baseline  model id -> its limit kinds before the change
 * @param {Map<string, {blocked: boolean}>} current  the models now
 * @returns {{lifted: number, total: number, kinds: [string, number, number][]}}  kinds: [kind, lifted, total], the most frequent first
 */
export function ipLiftTally(baseline, current) {
  const by = new Map();
  let lifted = 0;
  for(const [id, kinds] of baseline) {
    const back = !current.get(id)?.blocked;
    if(back) lifted++;
    for(const k of kinds.length ? kinds : ['unknown']) {
      const x = by.get(k) ?? [0, 0];
      x[1]++;
      if(back) x[0]++;
      by.set(k, x);
    }
  }
  return { lifted, total: baseline.size, kinds: [...by].map(([k, [l, t]]) => [k, l, t]).sort((a, b) => b[2] - a[2]) };
}

const IP_WINDOW_MS = 15 * 60e3;

/**
 * what changed since the previous look at the gateway: models that became limited (with why and until when), models
 * that are usable again, models that vanished or appeared. Reported as events (lib/events.js), a few per look.
 */
export function reportChanges(av) {
  const now = new Map([...av.byModel].map(([id, e]) => [id, { blocked: !!e.blocked, kinds: e.kinds ?? [], until: e.until, platforms: e.platforms ?? [] }]));
  const before = lastSeen;
  lastSeen = now;

  /* the verdict on the last address change, once its recheck has come in (the address change settles within seconds) */
  if(ipBaseline && Date.now() - lastIpChange >= IP_TALLY_AFTER_MS) {
    const base = ipBaseline;
    ipBaseline = null;
    if(Date.now() - lastIpChange < IP_WINDOW_MS && base.size) {
      const t = ipLiftTally(base, now);
      emit('proxy', `the address change lifted ${t.lifted} of ${t.total} limits: ${t.kinds.slice(0, 6).map(([k, l, n]) => `${KIND[k] ?? k} ${l}/${n}`).join(', ')}`, t.lifted ? 'good' : 'warn');
    }
  }
  if(!before) return;

  const limited = [];
  const back = [];
  for(const [id, e] of now) {
    const b = before.get(id);
    if(!b) continue;
    if(e.blocked && !b.blocked) limited.push([id, e]);
    else if(!e.blocked && b.blocked) back.push([id, b]);
  }

  const why = e => (e.kinds.length ? e.kinds.map(k => KIND[k] ?? k).join(', ') : 'exhausted');
  const names = (list, f) => (list.length > 3 ? `${list.slice(0, 3).map(f).join(', ')} and ${list.length - 3} more` : list.map(f).join(', '));
  if(limited.length) emit('gateway', `${limited.length} model${limited.length > 1 ? 's' : ''} limited: ${names(limited, ([id, e]) => `${id} (${why(e)}${e.until ? `, back ${untilText(e.until)}` : ''})`)}`, 'warn');
  /* why it is back: the exit address changed lately (or it was limited as an IP matter), its pace time ran out, or the gateway just says so */
  const afterIp = Date.now() - lastIpChange < IP_WINDOW_MS;
  const groups = { ip: [], pace: [], other: [] };
  for(const [id, b] of back) {
    if(b.kinds.includes('ip') || (afterIp && !b.kinds.some(k => ['credit', 'tier', 'scope', 'key'].includes(k)))) groups.ip.push([id, b]);
    else if(b.until != null && b.until <= Date.now() + 5000) groups.pace.push([id, b]);
    else groups.other.push([id, b]);
  }
  const lim = ([id, b]) => `${id}${b.kinds.length ? ` (was ${b.kinds.map(k => KIND[k] ?? k).join(', ')})` : ''}`;
  if(groups.ip.length) emit('gateway', `${groups.ip.length} model${groups.ip.length > 1 ? 's' : ''} accessible again after the IP change: ${names(groups.ip, lim)}`, 'good');
  if(groups.pace.length) emit('gateway', `${groups.pace.length} model${groups.pace.length > 1 ? 's' : ''} usable again, the pace time has run out: ${names(groups.pace, lim)}`, 'good');
  if(groups.other.length) emit('gateway', `${groups.other.length} model${groups.other.length > 1 ? 's' : ''} usable again: ${names(groups.other, lim)}`, 'good');

  const gone = [...before.keys()].filter(id => !now.has(id));
  const fresh = [...now.keys()].filter(id => !before.has(id));
  if(gone.length) emit('gateway', `${gone.length} model${gone.length > 1 ? 's' : ''} left the catalog: ${names(gone, id => id)}`, 'warn');
  if(fresh.length) emit('gateway', `${fresh.length} new model${fresh.length > 1 ? 's' : ''} in the catalog: ${names(fresh, id => id)}`, 'info');
}

const loading = new Map(); /* gateway -> the load in flight */

/** the last answer of each dashboard table, by origin and path: stands in when a later call fails */
const lastTables = new Map(); /* origin+path -> { r, at }: the last answer of a dashboard table */
/** the dashboard tables that change rarely (the fallback chain and its routing scores), with how long an answer stands; usage, limits, penalties and keys (cooldowns) are read every load */
const SLOW_TABLES = { '/api/models': 60e3, '/api/fallback/routing': 60e3 };

let missingAt = 0;

/** says (at most once a minute) that tables of a load did not answer and the previous ones were used */
export function reportMissing(missing, now = Date.now()) {
  if(!missing.length || now - missingAt < 60e3) return false;
  missingAt = now;
  emit('gateway', `the availability load missed ${missing.length} table${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}; the previous answer is used`, 'warn');
  return true;
}

export function loadAvailability(gateway, { fresh = false } = {}) {
  const running = loading.get(gateway);
  if(running && !fresh) return running;

  const run = async () => {
    if(running) await running.catch(() => {});
    const av = await loadAvailabilityNow(gateway, fresh);
    try {
      timed('reportChanges', () => reportChanges(av));
    } catch(e) {}
    return av;
  };

  const p = run().finally(() => loading.get(gateway) === p && loading.delete(gateway));
  loading.set(gateway, p);
  return p;
}

async function loadAvailabilityNow(gateway, fresh = false) {
  if(gateway.isBridge) return loadBridgeAvailability(gateway);

  const now = Date.now();
  /* a dashboard table that does not answer (the gateway allows 120 requests a minute, so a 429 is likely) is not
     silently dropped: the previous answer stands in for it and the load says which tables are missing */
  const missing = [];
  const get = p => {
    const k = `${gateway.origin}${p}`;
    const last = lastTables.get(k);
    /* the tables that change rarely are asked once a minute, unless the caller changed gateway state */
    if(!fresh && SLOW_TABLES[p] && last && now - last.at < SLOW_TABLES[p]) return Promise.resolve(last.r);
    return gateway.api(p).then(
      r => (lastTables.set(k, { r, at: now }), r),
      e => (missing.push(`${p.replace(/^\/api\//, '')} (${e?.status ?? String(e?.message ?? e).split('\n')[0].slice(0, 40)})`), last?.r ?? null),
    );
  };

  const [models, chain, rateRes, tokenRes, penRes, keyRes, routing] = await Promise.all([gateway.models(true), get('/api/models'), get('/api/fallback/rate-limit-usage'), get('/api/fallback/token-usage'), get('/api/fallback/penalty-inspector'), get('/api/keys'), get('/api/fallback/routing')]);

  const av = await availabilityFrom(now, { models, chain, rateRes, tokenRes, penRes, keyRes, routing });
  av.missing = missing;
  reportMissing(missing, now);
  reportKeys(Array.isArray(keyRes) ? keyRes : []);
  return av;
}

/** the computing part of loadAvailabilityNow: what the answers of the gateway mean for each model; it gives the event loop a turn every 20 ms (a gateway of 700 models and 1500 rows took 220 to 270 ms in one block) */
async function availabilityFrom(now, { models, chain, rateRes, tokenRes, penRes, keyRes, routing }) {
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
  const turn = slicer();

  for(const r of Array.isArray(chain) ? chain : []) {
    await turn();
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
    if(!byRow.has(k)) byRow.set(k, rowBlocks(r, { rate: rate.get(k), budget: budget.get(k), keys: keysOf.get(r.platform) ?? [], errors: errorsOf.get(k) ??[], now }, byRow));
    return byRow.get(k);
  };

  // Record success events for ready models to update learned cooldowns
  for(const m of models) {
    await turn();
    if (m.execution_status !== 'exhausted') {
      const rows = rowsOf.get(m.id) ?? [];
      for(const row of rows) {
        const k = key(row.platform, row.modelId);
        recordCooldownEvent(k, 'success', now);
      }
    }
  }

  const byModel = new Map();

  for(const m of models) {
    await turn();
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

  applyShadowBlocks(byModel, now);
  return { at: now, byModel, byRow, rate, budget, keyCounts: new Map([...keysOf].map(([p, ks]) => [p, ks.filter(k => k.enabled !== false).length])) };
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

  applyShadowBlocks(byModel, now);
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
const windowText = (w, bar) => (w && w.limit > 0 ? quotaCell(w.used, w.limit, bar) : '-');

/** '67m · 08:59', '17h 07m · 26.11. 01:00': how long, and the clock time it ends */
export function backShort(until, now, approx) {
  if(until == null) return '?';
  const t = new Date(until);
  const day = t.toDateString() === new Date(now).toDateString() ? '' : `${t.getDate()}.${t.getMonth() + 1}. `;
  return `${approx ? '≤ ' : ''}${spanText(until - now)} · ${day}${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

/**
 * the limits table: columns that are empty ('-') in every row are left out, and a narrow terminal drops tok/min, req/min,
 * the probe and the meters, in that order, before the provider/model column is cut
 */
function limitsTable(width, rows, ex) {
  const cols = ['provider/model', 'req/min', 'req/day', 'tok/min', 'month tok', 'limited by', 'back', ...(ex?.any ? ['probe'] : [])];
  const sample = rows.map(r => r.cells(0));
  const empty = i => i > 0 && i < 5 && sample.every(c => c[i] === '-');
  const keep = cols.map((_, i) => i).filter(i => !empty(i));
  const at = name => keep.indexOf(cols.indexOf(name));

  return fitTable(width, bar => [keep.map(i => `\x1b[1m${cols[i]}\x1b[0m`), ...rows.map(r => {
    const c = r.cells(bar);
    if(ex?.any) c.push(probeBrief(ex, r.k));
    return keep.map(i => c[i]);
  })], [0, at('back')], ['tok/min', 'req/min', 'probe', 'req/day'].map(at).filter(i => i > 0));
}

/**
 * /gateway limits [FILTER]: for each provider row the requests and tokens
 * used of every period (minute, day, month), what is limited right now and
 * when it ends. Without FILTER only rows that have usage or a limit are shown.
 */
export const limitsText = (...args) => timed('limitsText', () => limitsTextNow(...args));
function limitsTextNow(av, filter = '', width = 0, ex = null) {
  const f = filter.toLowerCase();
  const names = new Set([...av.rate.keys(), ...av.budget.keys()]);

  const rows = [...names]
    .filter(k => (f ? k.toLowerCase().includes(f) : av.byRow.get(k)?.length || av.rate.get(k)?.rpm?.used || av.rate.get(k)?.rpd?.used || av.budget.get(k)?.used))
    .map(k => {
      const r = av.rate.get(k);
      const b = av.budget.get(k);
      const blocks = av.byRow.get(k) ?? [];
      const until = blocks.length && !blocks.some(x => x.until == null) ? Math.max(...blocks.map(x => x.until)) : null;
      const when = blocks.length ? (blocks.every(x => x.until == null && (x.kind === 'scope' || x.kind === 'key')) ? 'not by waiting' : backShort(until, av.at, blocks.some(x => x.approx))) : '';
      const slash = k.indexOf('/');
      const name = slash > 0 ? `\x1b[2m${k.slice(0, slash + 1)}\x1b[0m${k.slice(slash + 1)}` : k;
      const by = blocks.length ? `\x1b[33m${[...new Set(blocks.map(x => KIND[x.kind] ?? x.kind))].join(', ')}\x1b[0m` : '';
      return { k, until, limited: blocks.length > 0, cells: bar => [name, windowText(r?.rpm, bar), windowText(r?.rpd, bar), windowText(r?.tpm, bar), b ? quotaCell(b.used, b.budget, bar) : '-', by, when && until != null && until - av.at < 10 * 60e3 ? `\x1b[32m${when}\x1b[0m` : when ? `\x1b[2m${when}\x1b[0m` : ''] };
    })
    .sort((a, b) => (b.limited ? 1 : 0) - (a.limited ? 1 : 0) || (a.until ?? Infinity) - (b.until ?? Infinity) || a.k.localeCompare(b.k));

  if(!rows.length) return f ? `(no model matches "${filter}")` : '(nothing is limited or used yet - /gateway limits FILTER lists any model)';

  return [
    `limits per provider row, used/limit: minute and day windows slide, the month budget ends ${new Date(firstOfNextMonth(av.at)).toISOString().slice(0, 10)} (UTC)`,
    '',
    limitsTable(width, rows, ex)
  ].join('\n');
}

/**
 * the table of /gateway limited, one line per model at any width: the detail, the probe and the providers give up
 * width first (cut with an ellipsis, then dropped), then the model name; the end of the limit is '67m · 08:59'
 */
function limitedTable(width, rows, av, ex) {
  const cols = ['model', 'rate', 'providers', 'limited by', 'back', ...(ex?.any ? ['probe'] : []), 'detail'];
  const at = n => cols.indexOf(n);

  return fitTable(width, () => [cols.map(c => `\x1b[1m${c}\x1b[0m`), ...rows.map(([id, e]) => [
    id,
    ratingCell(rateOf(id)),
    e.platforms.join(',') || '-',
    paint(kindsText(e), '#f87171'),
    paint(e.permanent ? 'not by waiting' : backShort(e.until, av.at, e.approx), '#fbbf24'),
    ...(ex?.any ? [probeBrief(ex, id)] : []),
    e.blocks[0]?.detail ?? 'the gateway does not say why',
  ])], [at('detail'), at('model'), at('providers'), at('back')], [at('detail'), at('probe'), at('providers')].filter(i => i > 0));
}

/** /gateway limited [FILTER]: the model ids that cannot serve a request now, soonest back first */
export const limitedText = (...args) => timed('limitedText', () => limitedTextNow(...args));
function limitedTextNow(av, filter = '', width = 0, ex = null) {
  const f = filter.toLowerCase();
  const rates = new Map(); /* rateOf walks the catalog: once per model, not twice per comparison */
  const rate = id => (rates.has(id) ? rates.get(id) : rates.set(id, rateOf(id) ?? -1).get(id));
  const rows = [...av.byModel]
    .filter(([id, e]) => e.blocked && (!f || id.toLowerCase().includes(f)))
    .sort((a, b) => rate(b[0]) - rate(a[0]) || (a[1].until ?? Infinity) - (b[1].until ?? Infinity) || a[0].localeCompare(b[0]));

  if(!rows.length) return f ? `(no limited model matches "${filter}")` : '(no model is limited right now)';

  const ip = rows.filter(([, e]) => e.kinds.includes('ip')).length;
  return [
    `${rows.length} models cannot serve a request right now, best rated first`,
    '',
    limitedTable(width, rows, av, ex),
    ...(ip ? ['', `${ip} look limited by IP or region: /proxy exit asks for another exit address, /proxy off sends requests directly`] : []),
  ].join('\n');
}
