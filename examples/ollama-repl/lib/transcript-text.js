/**
 * transcript-text: the small pure helpers behind the coloured transcript lines and the exploration queue, kept out
 * of repl.js (which runs main() on import and so cannot be tested)
 *
 * ```js
 * const modelName = makeModelName({ piped, fgHex, strengthColor, tierOf });
 * modelName('gemini-3.5-flash');                          // bold, in its strength colour (plain when piped)
 * routeFailure('kilo/nemotron', 'Rate limit. Soonest cooldown reset ~48s.', { piped, dim, modelName });
 * servedIds(rows, catalogId)                              // models that answered a request without an error
 * exploreOrder({ served, platformsOf, rateOf })           // the options Exploration.run takes
 * ```
 */

import { resetMs } from './provider-fallback.js';

/** a model name in its strength colour, as in /model list; plain when piped */
export function makeModelName({ piped = false, fgHex, strengthColor, tierOf }) {
  return id => (piped || !id ? id : `\x1b[1m${fgHex(strengthColor(tierOf(id)), id)}\x1b[0m`);
}

/** the reset time the gateway names in an error ("Soonest cooldown reset ~48s."), or null */
export const soonestReset = text => /Soonest cooldown reset ~?(\S+?)\.?(\s|$)/i.exec(String(text ?? ''))?.[1] ?? null;

/**
 * the summary line of the give-up panel: when the first route may be tried again, from the reset times the errors name
 * (null when none names one)
 *
 *   earliestReset([['kilo/x', 'Rate limit. Soonest cooldown reset ~3m.'], ['ollama/q', 'refused']])   // 'earliest reset in ~3m: kilo/x'
 */
export function earliestReset(attempts) {
  let best = null;
  for(const [route, why] of attempts ?? []) {
    const ms = resetMs({ message: String(why ?? '') });
    if(ms && (!best || ms < best.ms)) best = { ms, route, text: soonestReset(why) };
  }
  return best ? `earliest reset in ~${best.text}: ${best.route}` : null;
}

/** one route that failed, as a card line: provider dim, model by strength, the first sentence of the error, the reset time amber */
export function routeFailure(route, why, { piped = false, dim = s => s, modelName = s => s } = {}) {
  const text = String(why ?? '');
  const back = soonestReset(text);
  const what = text.split(/\.\s/)[0].replace(/\s+/g, ' ').slice(0, 90);
  const i = String(route).lastIndexOf('/');
  const name = i < 0 ? modelName(route) : `${dim(route.slice(0, i + 1))}${modelName(route.slice(i + 1))}`;
  return `${name}  ${what}${back ? `  ${piped ? '' : '\x1b[38;2;251;191;36m'}back in ~${back}${piped ? '' : '\x1b[0m'}` : ''}`;
}

/** the set of catalog ids that answered a request without an error (rows of usage.jsonl) */
export function servedIds(rows, catalogId = id => id) {
  return new Set((rows ?? []).filter(r => !r.error && r.routedVia).map(r => catalogId(r.routedVia)));
}

/**
 * options for an exploration run: the platforms of a model (a provider that just rate-limited is not probed
 * again), and the order, models that served a request lately first (+100), then by rating
 */
export function exploreOrder({ served = new Set(), platformsOf = () => [], rateOf = () => 0 } = {}) {
  return { platformsOf, priority: id => (served.has(id) ? 100 : 0) + (rateOf(id) ?? 0) };
}
