/**
 * diagnose: why did the exploration's probe of a model fail? The error text says something, the gateway's own state
 * says more (is the model limited, is its provider down, has the platform a usable key), and a second try tells a
 * hiccup from a real outage.
 *
 * ```js
 * const d = await diagnose({ id, error, entry, keys, providers, retry });
 * d.cause      // 'flaky' | 'rate-limited' | 'limited' | 'upstream' | 'timeout' | 'model-gone' | 'no-key' | 'auth'
 *              // | 'system-prompt' | 'empty' | 'unknown'
 * d.detail     // one line for the Says column: "rate limited at electronhub, resets in ~43s"
 * d.transient  // the model itself is fine, the provider was busy or down: no rating penalty
 * d.retryInMs  // when it is worth asking again
 * d.steps      // what was looked at, for the verbose view
 * ```
 */

import { causeOfStatus } from '../failover/cause-of-status.js';

/** "electronhub/deepseek-v4-flash key1: rate_limited; bazaarlink/x key2: upstream_error" -> [{route, key, reason}] */
export function parseTrail(error) {
  const out = [];
  for(const m of String(error ?? '').matchAll(/([\w.-]+\/[\w./:-]+)\s+(key\d+|no key):\s*([\w-]+)/g)) out.push({ route: m[1], platform: m[1].split('/')[0], key: m[2], reason: m[3] });
  return out;
}

/** the first cause the error text alone suggests */
export function causeOfError(error) {
  const e = String(error ?? '');
  if(/system prompt/i.test(e)) return 'system-prompt';
  if(/empty answer|empty reply/i.test(e)) return 'empty';
  if(/model_not_found|no longer available|does not exist|unknown model/i.test(e) && !/rate.?limit|upstream_error/i.test(e.replace(/model_not_found/g, ''))) return 'model-gone';
  if(/\b40[13]\b|unauthori[sz]ed|invalid.*key|forbidden|authentication/i.test(e)) return 'auth';
  if(/rate.?limit|429|too many|quota|exhaust|cooldown/i.test(e)) return 'rate-limited';
  if(/timeout|timed out|no response|aborted/i.test(e)) return 'timeout';
  if(/upstream|5\d\d\b|bad gateway|overloaded|unavailable|connection|ECONN/i.test(e)) return 'upstream';
  return 'unknown';
}

const TRANSIENT_CAUSES = new Set(['flaky', 'rate-limited', 'limited', 'upstream', 'timeout']);
const minutes = ms => (ms < 90e3 ? `${Math.max(1, Math.round(ms / 1e3))}s` : ms < 5400e3 ? `${Math.round(ms / 60e3)} min` : `${Math.round(ms / 3600e3)} h`);

/**
 * @param {object} i
 * @param {string} i.id
 * @param {string} i.error  the probe's error text
 * @param {number} [i.status]  HTTP status of the failure, when it had one
 * @param {string} [i.code]    error code of the answer (upstream_error, rate_limit_exceeded, ...)
 * @param {object} [i.entry]  the gateway's availability entry of the model: { blocked, kinds, until, platforms }
 * @param {object[]} [i.keys]  GET /api/keys
 * @param {object[]} [i.providers]  GET /api/keys/providers (providers)
 * @param {() => Promise<{ok: boolean, error?: string}>} [i.retry]  one small request to the model, run when the failure looks transient
 * @param {(ms: number) => Promise<void>} [i.wait]
 * @param {number} [i.now]
 * @returns {Promise<{cause: string, detail: string, transient: boolean, retryInMs: number|null, steps: string[]}>}
 */
export async function diagnose({ id, error, status, code, entry, keys = [], providers = [], retry, wait = ms => new Promise(r => setTimeout(r, ms)), now = Date.now() }) {
  const steps = [];
  /* the status and error code of the failure say more than its text; the text decides only without them */
  let cause = causeOfError(error);
  const byCode = causeOfStatus(status, code);
  if(byCode && byCode !== 'refused' && !['system-prompt', 'empty'].includes(cause)) cause = byCode;
  const trail = parseTrail(error);
  let detail = '';
  let retryInMs = null;
  steps.push(`error says: ${cause}${trail.length ? ` (${trail.map(t => `${t.platform} ${t.reason}`).join(', ')})` : ''}`);

  const reset = /(?:reset|back|retry)[^~\d]{0,20}~?(\d+)\s*(ms|s|m|min|h)\b/i.exec(String(error ?? ''));
  if(reset) retryInMs = +reset[1] * { ms: 1, s: 1e3, m: 60e3, min: 60e3, h: 3600e3 }[reset[2].toLowerCase()];

  /* the gateway's own picture of the model */
  if(entry) {
    if(entry.blocked) {
      steps.push(`the gateway lists it as limited: ${(entry.kinds ?? []).join(', ') || 'exhausted'}${entry.until ? `, back in ${minutes(entry.until - now)}` : ''}`);
      if(!['model-gone', 'auth', 'system-prompt', 'empty'].includes(cause)) {
        cause = 'limited';
        if(entry.until) retryInMs = Math.max(0, entry.until - now);
        detail = `limited by the gateway (${(entry.kinds ?? []).join(', ') || 'exhausted'})${entry.until ? `, back in ${minutes(entry.until - now)}` : ''}`;
      }
    } else steps.push('the gateway lists it as usable');
  }

  /* the providers behind it and their keys */
  const platforms = [...new Set([...(entry?.platforms ?? []), ...trail.map(t => t.platform)])];
  const down = [];
  const keyless = [];
  for(const p of platforms) {
    const prov = providers.find(x => x.platform === p);
    const mine = keys.filter(k => k.platform === p);
    const usable = mine.filter(k => k.enabled && k.status !== 'invalid');
    if(prov && prov.status && !['healthy', 'unknown'].includes(prov.status)) down.push(`${p} is ${prov.status}${prov.last_error ? ` (${String(prov.last_error).slice(0, 60)})` : ''}${prov.resume_at ? `, resumes in ${minutes(Date.parse(prov.resume_at) - now)}` : ''}`);
    if(mine.length && !usable.length) keyless.push(p);
    steps.push(`${p}: ${prov?.status ?? 'status unknown'}, ${usable.length}/${mine.length} usable key${mine.length === 1 ? '' : 's'}${mine.some(k => k.cooldowns?.length) ? `, ${mine.reduce((n, k) => n + (k.cooldowns?.length ?? 0), 0)} cooling` : ''}`);
  }

  if(keyless.length && platforms.length === keyless.length) {
    cause = 'no-key';
    detail = `no usable key for ${keyless.join(', ')}`;
  } else if(down.length && ['rate-limited', 'upstream', 'timeout', 'unknown'].includes(cause)) detail = down.join('; ');

  /* a hiccup or an outage: one more try, after the short wait the error asks for */
  if(retry && ['rate-limited', 'upstream', 'timeout', 'unknown'].includes(cause) && (retryInMs ?? 0) <= 15000) {
    const w = Math.min(retryInMs ?? 3000, 15000);
    steps.push(`asking again after ${minutes(w)}`);
    await wait(w);
    const r = await retry().catch(e => ({ ok: false, error: String(e.message ?? e) }));
    if(r.ok) {
      cause = 'flaky';
      detail = 'it answered on a second try: the first failure was a hiccup';
      steps.push('the second try answered');
      retryInMs = 0;
    } else steps.push(`the second try failed too: ${String(r.error ?? '').slice(0, 80)}`);
  }

  if(!detail) {
    detail = {
      'model-gone': 'the provider no longer serves this model id',
      auth: 'the provider refused the key (401/403)',
      'system-prompt': 'it does not follow a system prompt',
      empty: 'it answered with nothing',
      timeout: 'no answer within the time limit',
      upstream: 'the provider answered with a server error',
      'rate-limited': `rate limited${retryInMs ? `, resets in ~${minutes(retryInMs)}` : ''}`,
      unknown: String(error ?? 'no usable answer').slice(0, 100),
    }[cause] ?? String(error ?? '').slice(0, 100);
  }

  const transient = TRANSIENT_CAUSES.has(cause);
  if(retryInMs == null) retryInMs = { 'model-gone': 24 * 3600e3, auth: 3600e3, 'system-prompt': 3600e3, empty: 3600e3, 'no-key': 3600e3, upstream: 10 * 60e3, timeout: 10 * 60e3, 'rate-limited': 10 * 60e3, unknown: 3600e3 }[cause] ?? 10 * 60e3;

  return { cause, detail, transient, retryInMs, steps };
}
