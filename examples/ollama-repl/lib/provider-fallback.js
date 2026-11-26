/**
 * provider-fallback: when the route a request goes over fails for a reason
 * that retrying cannot fix (a bad key, a spent quota, an outage, a dead
 * connection), mark the route unviable for a cool-down and let the caller
 * retry the same request on the next candidate, without the user.
 *
 * ```js
 * const kind = classify(err);                 // { kind: 'auth', cooldownMs, reason } | null
 * const pf = new ProviderFallback(() => [{ key: 'ollama/qwen3', label: 'ollama/qwen3', make }]);
 * pf.mark('openai/auto', kind);               // cool the failed route down
 * const c = await pf.next();                  // first candidate not cooling down, null if none
 * ```
 *
 * The models of one gateway are failed over by the existing hooks
 * (autoSkipHook, standby, Failover in repl.js); this layer is for what they
 * cannot reach: the endpoint itself refusing (401/403) or every gateway
 * route failing, where the only way on is another provider, finally the
 * local Ollama model.
 */

const MIN = 60000;

/**
 * how long an error says the route stays dry, in ms: the Retry-After header (seconds, `err.retryAfter`), else the gateway's
 * "Soonest cooldown reset ~48s|3m|2h" text; null when it names no time
 *
 *   resetMs(Object.assign(new Error('Soonest cooldown reset ~3m.'), { status: 429 }))   // 180000
 */
export function resetMs(err) {
  if(err?.retryAfter > 0) return err.retryAfter * 1000;
  const m = /Soonest cooldown reset ~?(\d+(?:\.\d+)?)\s*(s|m|min|h|d)\b/i.exec(`${err?.detail ?? ''} ${err?.message ?? ''} ${err?.body ?? ''}`);
  return m ? Math.round(+m[1] * { s: 1000, m: MIN, min: MIN, h: 60 * MIN, d: 24 * 60 * MIN }[m[2].toLowerCase()]) : null;
}

/** the cool-down of a limit: what the error says (and a cushion), kept within 30 s and 60 min; `fallback` without a time */
const coolFor = (err, fallback) => {
  const ms = resetMs(err);
  return ms ? Math.min(60 * MIN, Math.max(30000, ms + 5000)) : fallback;
};

/**
 * What kind of failure `err` is, null when another route would not help
 * (a bad request: 400, 404, 413, 422 - the same request fails everywhere).
 *
 * @returns {{kind: 'auth'|'gone'|'limit'|'upstream'|'network', cooldownMs: number, reason: string}|null}
 */
export function classify(err) {
  const status = err?.status;
  const reason = shortReason(err);

  if(isGone(err)) return { kind: 'gone', cooldownMs: 12 * 60 * MIN, reason };

  if(status === 401 || status === 403) return { kind: 'auth', cooldownMs: 30 * MIN, reason };
  if(status === 402 || status === 429 || err?.isRateLimit) return { kind: 'limit', cooldownMs: coolFor(err, 5 * MIN), reason };
  if(status >= 500 && status < 600) return { kind: 'upstream', cooldownMs: coolFor(err, 2 * MIN), reason };
  if(status === 408 || /no response after|stream stalled|timed? ?out|connection (failed|closed|refused|reset)|ECONN|EPIPE|ENOTFOUND/i.test(String(err?.message ?? ''))) return { kind: 'network', cooldownMs: MIN, reason };

  return null;
}

/** a model the endpoint no longer serves (a stale catalog entry): 404 model_not_found, "no longer available" */
export function isGone(err) {
  if(err?.status !== 404 && err?.status !== 410) return false;
  return err.code === 'model_not_found' || /model_not_found|no longer available|does not exist|not found/i.test(`${err.detail ?? ''} ${err.message ?? ''} ${err.body ?? ''}`);
}

/** "401 Invalid API key": status and message, one short line, no headers */
export function shortReason(err) {
  const msg = String(err?.detail ?? err?.message ?? err ?? '')
    .split('\n')[0]
    .replace(/^(OpenAI|Ollama|Gemini) HTTP \d+:?\s*/, '')
    .trim();
  return `${err?.status ?? ''} ${msg}`.trim().slice(0, 80);
}

export class ProviderFallback {
  #candidates;
  #cool = new Map();

  /** @param {() => Array<{key: string, label: string}>|Promise<Array>} candidates  later candidates, in order of preference */
  constructor(candidates) {
    this.#candidates = candidates;
  }

  /** puts a route out of use for the cool-down of its failure kind */
  mark(key, fail, now = Date.now()) {
    this.#cool.set(key, { until: now + fail.cooldownMs, kind: fail.kind, reason: fail.reason });
  }

  /** forgets the cool-down of a route (a key was changed, /gateway login) */
  clear(key) {
    if(key === undefined) this.#cool.clear();
    else this.#cool.delete(key);
  }

  /** ends the cool-downs of the given kinds (a retry after a back-off: a bad key stays bad) */
  release(kinds) {
    for(const [k, c] of this.#cool) if(kinds.includes(c.kind)) this.#cool.delete(k);
  }

  /** the cool-down of a route, undefined when it may be used */
  cooling(key, now = Date.now()) {
    const c = this.#cool.get(key);
    if(c && c.until <= now) this.#cool.delete(key);
    return this.#cool.get(key);
  }

  /** the first candidate that is not cooling down and not in `tried` */
  async next(tried = new Set(), now = Date.now()) {
    for(const c of await this.#candidates()) if(!tried.has(c.key) && !this.cooling(c.key, now)) return c;
    return null;
  }

  /** every route and why it is out, as one line: "a 401 Invalid API key, b 502 Bad Gateway" */
  summary(routes) {
    return routes.map(([label, why]) => `${label} ${why}`).join(', ');
  }
}
