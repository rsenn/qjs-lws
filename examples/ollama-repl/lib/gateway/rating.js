/**
 * rating: a score 0..100 per gateway model that says how good a pick it is to use next. It is kept in
 * `~/.cache/ollama-repl/ratings.json` (key `ORIGIN|MODEL`) and adjusted by what the harness sees:
 * real requests (answered, failed, how fast), the async exploration (passed its prompts, tool calls) and
 * what the gateway reports now (limited, cooling, quota left).
 *
 * ```js
 * const r = new Ratings(gateway.origin);
 * r.recordResult('kimi-k2', { ok: true, ms: 2400 });              // a real request
 * r.recordProbe('kimi-k2', { ok: true, toolOk: true });           // the exploration
 * r.rating('kimi-k2', { intelligence: 0.8, ctx: 131072, blocked: false, quotaLeft: 0.6 });   // 74
 * setRater(id => r.rating(id, inputsOf(id)));  rateOf('kimi-k2');   // for the lists, without passing it around
 * sortByRating(ids)  // best first
 * ```
 *
 * The score adds up: what the model is (the gateway's intelligence score, else the tier guessed from its name,
 * up to 55), its context window (+4 .. -4), the learned part (an adjustment that decays with a half-life of a
 * week, and the share of requests that worked), its latency, the exploration result, and the state now (limited
 * -40, cooling -10, quota nearly used up -8). Failures that are only a limit (429, quota, cooldown) do not count
 * against the model: the availability term already says so.
 */
import { loadFile } from 'std';
import { setTimeout, clearTimeout } from 'os';
import { writeConfigFile } from '../config.js';
import { cacheDir } from '../session/session-cache.js';

export const ratingsPath = () => `${cacheDir()}/ratings.json`;

const HALF_LIFE_MS = 7 * 86400e3;
const ADJ_CAP = 25;
const LIMIT_ERROR = /rate.?limit|429|quota|cooldown|exhaust|too many|credit|limited/i;
/** tier 1 (a realistic compacted context): lost facts or a refused prompt count against the model, a clean pass and speed for it */
function deepScore(d) {
  if(!d || d.transient) return 0;
  if(!d.ok) return d.error ? -6 : d.recall >= 2 ? -3 : -6;
  return 4 + (d.tps >= 40 ? 2 : d.tps >= 15 ? 1 : 0);
}
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * what the share of requests that worked adds, -10 .. +10: steep near 100 % (a 7 % failure rate is already 0), weighted
 * by how many requests it rests on, so no data gives 0
 *
 *   reliability(428, 0)     // 9.8
 *   reliability(2314, 53)   // 6.6
 */
export function reliability(ok, fail) {
  const n = ok + fail;
  if(!n) return 0;
  return (n / (n + 10)) * clamp(10 - (150 * fail) / n, -10, 10);
}

/** the pure part: the score of a record and the live inputs */
export function score(rec = {}, { intelligence = null, tier = null, ctx = null, blocked = false, permanent = false, cooling = false, quotaLeft = null, toolsNeeded = false } = {}, now = Date.now()) {
  const i = typeof intelligence === 'number' ? intelligence : tier != null ? ((10 - tier) / 10) * 0.8 : 0.3;
  let s = 55 * clamp(i, 0, 1);

  if(ctx) s += ctx >= 128000 ? 4 : ctx >= 32000 ? 2 : ctx < 8000 ? -4 : 0;

  const age = rec.at ? Math.max(0, now - rec.at) : 0;
  s += clamp((rec.adj ?? 0) * 0.5 ** (age / HALF_LIFE_MS), -ADJ_CAP, ADJ_CAP);

  s += reliability(rec.ok ?? 0, rec.fail ?? 0);

  if(rec.latMs != null) s += rec.latMs < 2000 ? 6 : rec.latMs < 5000 ? 3 : rec.latMs < 15000 ? 0 : rec.latMs < 30000 ? -4 : -8;

  const p = rec.probe;
  if(p) {
    if(p.ok) s += 6 + (p.toolOk ? 4 : toolsNeeded ? -4 : 0) + (p.systemOk === false ? -2 : 0) + deepScore(p.deep);
    else if(!p.stale) s -= 10;
  }

  if(blocked) s -= permanent ? 60 : 40;
  else if(cooling) s -= 10;
  if(quotaLeft != null) s -= quotaLeft < 0.1 ? 8 : quotaLeft < 0.3 ? 3 : 0;

  return Math.round(clamp(s, 0, 100));
}

export class Ratings {
  #origin;
  #data = null;
  #timer = null;
  /** counts the events that moved a rating, so a cache of ratings knows when it is stale */
  version = 0;

  constructor(origin) {
    this.#origin = origin;
  }

  #load() {
    if(this.#data) return this.#data;
    try {
      this.#data = JSON.parse(loadFile(ratingsPath())) ?? {};
    } catch(e) {
      this.#data = {};
    }
    return this.#data;
  }

  #rec(id) {
    const d = this.#load();
    return (d[`${this.#origin}|${id}`] ??= { ok: 0, fail: 0, adj: 0 });
  }

  /** a throttled write: events come in bursts */
  #save() {
    if(this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      writeConfigFile(ratingsPath(), JSON.stringify(this.#data, null, 1));
    }, 3000);
  }

  /** flushes a pending write (at exit) */
  flush() {
    if(!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = null;
    writeConfigFile(ratingsPath(), JSON.stringify(this.#data, null, 1));
  }

  get(id) {
    return this.#load()[`${this.#origin}|${id}`];
  }

  /** a real request of the session: { ok, ms, error?, toolFailed? } */
  recordResult(id, { ok, ms, error, toolFailed = false } = {}, now = Date.now()) {
    const r = this.#rec(id);
    const decayed = (r.adj ?? 0) * 0.5 ** (Math.max(0, now - (r.at ?? now)) / HALF_LIFE_MS);

    if(ok) {
      r.ok++;
      r.adj = clamp(decayed + 0.5, -ADJ_CAP, ADJ_CAP);
      if(ms > 0) r.latMs = r.latMs == null ? ms : Math.round(0.7 * r.latMs + 0.3 * ms);
    } else if(!LIMIT_ERROR.test(String(error ?? ''))) {
      r.fail++;
      r.adj = clamp(decayed - (toolFailed ? 6 : 3), -ADJ_CAP, ADJ_CAP);
    } else return;

    r.at = now;
    this.version++;
    this.#save();
  }

  /** the exploration's result for a model: { ok, toolOk, systemOk, latencyMs } */
  recordProbe(id, p, now = Date.now()) {
    /* the provider was busy or down when it was asked: that says nothing about the model */
    if(p.transient) return;
    const r = this.#rec(id);
    const first = !r.probe;
    r.probe = { ok: !!p.ok, toolOk: !!p.toolOk, systemOk: p.systemOk, ...(p.deep ? { deep: p.deep } : {}), at: now };
    if(first || r.probe.ok !== !!p.ok) r.adj = clamp((r.adj ?? 0) + (p.ok ? 3 : -5), -ADJ_CAP, ADJ_CAP);
    if(p.ok && p.latencyMs > 0 && r.latMs == null) r.latMs = p.latencyMs;
    r.at = now;
    this.version++;
    this.#save();
  }

  rating(id, inputs = {}, now = Date.now()) {
    const rec = this.get(id);
    return score(rec ? { ...rec, probe: rec.probe && !rec.probe.ok && now - rec.probe.at > 3600e3 ? { ...rec.probe, stale: true } : rec.probe } : {}, inputs, now);
  }
}

let rater = () => null;

/** the lists ask for a rating without knowing where it comes from */
export const setRater = fn => (rater = fn);
export const rateOf = id => rater(id);

let provRater = () => null;

/** the rating of a provider: the mean of its best three models */
export const setProviderRater = fn => (provRater = fn);
export const rateProvider = platform => provRater(platform);

/** ids best first (unrated ones last), ties by name */
export const sortByRating = ids => [...ids].sort((a, b) => (rateOf(b) ?? -1) - (rateOf(a) ?? -1) || String(a).localeCompare(String(b)));

/** the rating as a cell: the number coloured red .. green, `-` when unknown */
export function ratingCell(n) {
  if(n == null) return '\x1b[90m-\x1b[0m';
  const c = n >= 70 ? '74;222;128' : n >= 50 ? '163;230;53' : n >= 30 ? '251;191;36' : '248;113;113';
  return `\x1b[38;2;${c}m${String(n).padStart(3)}\x1b[0m`;
}
