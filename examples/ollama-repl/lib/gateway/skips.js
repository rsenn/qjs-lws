/* skips.js: the session's skipped models against what the gateway says (lib/gateway/availability.js). A skip the
   session set by itself (a 429, an exhausted provider, a failed chain) ends early once a fresh availability
   shows the model usable again; one the user typed, or a model that is gone, stays until its time is up. */

/** skip reasons that never end early */
const KEEP = /^(manual|no longer available)$/;

/** a gateway picture younger than this after the skip may not know about the failure yet */
export const SETTLE_MS = 5000;

/**
 * @param {Map<string, {until: number, since?: number, reason: string}>} skipped edited in place
 * @param {{at: number, byModel: Map<string, {blocked: boolean}>}|null} av
 * @returns {string[]} the models released
 */
export function releaseRecovered(skipped, av, now = Date.now()) {
  const out = [];

  for(const [name, info] of skipped) {
    if(info.until <= now) {
      skipped.delete(name);
    } else if(av && !KEEP.test(info.reason) && av.at > (info.since ?? now) + SETTLE_MS) {
      const e = av.byModel.get(name);
      if(e && !e.blocked) {
        skipped.delete(name);
        out.push(name);
      }
    }
  }
  return out;
}
