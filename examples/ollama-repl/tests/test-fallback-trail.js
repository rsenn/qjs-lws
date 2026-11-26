/* test-fallback-trail.js: parsing of X-Fallback-Trail and the models it marks as spent */
import { parseTrail, spentModels, spentPlatforms, trailText } from '../lib/failover/fallback-trail.js';
import { formatMeta, routeLine, retryText } from '../lib/session/usage-stats.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-fallback-trail: ${what}`);
};

const trail = 'groq/llama-3.3-70b key1=rate_limited; kilo/nvidia/nemotron:free key2=daily_quota_exhausted; google/gemini-2.5-flash key1=timeout; +3 more';
const hops = parseTrail(trail);

check('three hops, the "+N more" tail ignored', hops.length === 3);
check('platform and model split at the first slash', hops[1].platform === 'kilo' && hops[1].model === 'nvidia/nemotron:free');
check('key and class', hops[1].key === 2 && hops[1].cls === 'daily_quota_exhausted');
check('only spent classes', spentModels(trail).join() === 'llama-3.3-70b,nvidia/nemotron:free');
check('the answering route is never spent', spentModels(trail, 'groq/llama-3.3-70b').join() === 'nvidia/nemotron:free');
check('no header', parseTrail(undefined).length === 0 && spentModels('').length === 0);

/* a platform whose every key ran out */
const two = p => (p === 'kilo' ? 2 : p === 'groq' ? 3 : 0);
check('all keys of the platform spent', spentPlatforms('kilo/a key1=rate_limited; kilo/a key2=daily_quota_exhausted', undefined, two).join() === 'kilo');
check('one key left', spentPlatforms('kilo/a key1=rate_limited', undefined, two).length === 0);
check('a timeout is not spent', spentPlatforms('kilo/a key1=rate_limited; kilo/a key2=timeout', undefined, two).length === 0);
check('keys of different models do not add up', spentPlatforms('kilo/a key1=rate_limited; kilo/b key2=rate_limited', undefined, two).length === 0);
check('the answering route is not spent', spentPlatforms('kilo/a key1=rate_limited; kilo/a key2=rate_limited', 'kilo/a', two).length === 0);
check('no key count, no verdict', spentPlatforms('x/a key1=rate_limited', undefined).length === 0);

/* /last: the trail in words, and when the gateway said to come back */
check('trail text', trailText(trail).startsWith('groq/llama-3.3-70b key1: rate limited; kilo/nvidia/nemotron:free key2: daily quota exhausted;'));
check('retry from the header', retryText({ retryAfter: 180 }).includes('Retry-After') && retryText({}) === undefined);
check('retry from the body', /^gateway's soonest reset \d\d:\d\d:\d\dZ$/.test(retryText({ retryAtMs: Date.now() + 60000 })));
const meta = { requested: 'auto', error: 'All models exhausted', retryAfter: 90, trail, ms: 1200, status: 429 };
check('/last shows both', /trail +groq\/llama-3.3-70b key1: rate limited/.test(formatMeta(meta)) && /retry +.*Retry-After/.test(formatMeta(meta)));
check('route line names the wait', routeLine(meta).includes('retry in'));
console.log('test-fallback-trail: ok');
