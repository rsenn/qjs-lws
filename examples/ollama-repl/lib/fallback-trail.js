/* fallback-trail.js: the X-Fallback-Trail header of a freellmapi gateway ("platform/model keyN=class; ...;
   +N more": the hops that failed before the response) and which of them are worth a short client-side skip */

/* the failure classes that mean "this model is out until some later time"; a timeout, an outage or a bad
   request says nothing about the next try */
const SPENT = new Set(['rate_limited', 'daily_quota_exhausted', 'out_of_credits', 'forbidden']);

/** how long a model that failed in the chain is left alone by the client's own picks */
export const TRAIL_SKIP_MS = 90000;

/**
 * @param {string} [trail]
 * @returns {{platform: string, model: string, key: number, cls: string}[]}
 */
export function parseTrail(trail) {
  const out = [];

  for(const seg of String(trail ?? '').split(/;\s*/)) {
    const m = /^([\w.-]+)\/(\S+) key(\d+)=(\w+)$/.exec(seg.trim());
    if(m) out.push({ platform: m[1], model: m[2], key: +m[3], cls: m[4] });
  }
  return out;
}

/** the model ids of the hops that ran out (not the one that answered, `routedVia` = "platform/model") */
export function spentModels(trail, routedVia) {
  return [...new Set(parseTrail(trail).filter(h => SPENT.has(h.cls) && `${h.platform}/${h.model}` !== routedVia).map(h => h.model))];
}

/**
 * the platforms whose every key ran out in the trail: some model of the platform has all its `keyCount(platform)` keys
 * (the ordinals key1..keyN) in a spent class. The header names the outcome of a key only as an ordinal, so this needs the
 * number of enabled keys (availability.keyCounts); a platform with no known key count is never reported.
 *
 *   spentPlatforms('kilo/a key1=rate_limited; kilo/a key2=rate_limited', 'groq/x', p => (p === 'kilo' ? 2 : 0))   // ['kilo']
 */
export function spentPlatforms(trail, routedVia, keyCount = () => 0) {
  const keys = new Map(); /* platform/model -> the key ordinals that ran out */

  for(const h of parseTrail(trail)) {
    if(!SPENT.has(h.cls) || `${h.platform}/${h.model}` === routedVia) continue;
    const k = `${h.platform}/${h.model}`;
    (keys.get(k) ?? keys.set(k, new Set()).get(k)).add(h.key);
  }

  const out = new Set();
  for(const [k, set] of keys) {
    const platform = k.slice(0, k.indexOf('/'));
    const n = keyCount(platform);
    if(n > 0 && set.size >= n) out.add(platform);
  }
  return [...out];
}

/** the trail for people: "groq/llama key1: rate limited; kilo/x key2: daily quota exhausted" */
export const trailText = trail => String(trail ?? '').replace(/ key(\d+)=(\w+)/g, (_, k, c) => ` key${k}: ${c.replace(/_/g, ' ')}`);
