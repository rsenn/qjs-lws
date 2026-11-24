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

/** the trail for people: "groq/llama key1: rate limited; kilo/x key2: daily quota exhausted" */
export const trailText = trail => String(trail ?? '').replace(/ key(\d+)=(\w+)/g, (_, k, c) => ` key${k}: ${c.replace(/_/g, ' ')}`);
