/* test-diagnose.js: why did a probe fail */
import { parseTrail, causeOfError, diagnose } from '../lib/diagnose.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-diagnose: ${what}`);
};
const noWait = () => Promise.resolve();

check('trail', parseTrail('Attempt trail: electronhub/deepseek-v4-flash key1: rate_limited; bazaarlink/deepseek/deepseek-v4-flash key2: upstream_error').length === 2);
check('trail platform', parseTrail('kilo/x:free key1: rate_limited')[0].platform === 'kilo');
check('model gone', causeOfError('All 1 attempt(s) failed (model_not_found ×1)') === 'model-gone');
check('rate limit', causeOfError('All models rate-limited after 2 attempts') === 'rate-limited');
check('model_not_found next to a rate limit is a rate limit', causeOfError('upstream errors (model_not_found ×1, rate_limited ×1)') === 'rate-limited');
check('upstream', causeOfError('HTTP 503 bad gateway') === 'upstream');
check('system prompt', causeOfError('ignores the system prompt (says "hi")') === 'system-prompt');
check('auth', causeOfError('HTTP 401 unauthorized') === 'auth');

let d = await diagnose({ id: 'm', error: 'ignores the system prompt (says "hi")' });
check('a real failure is not transient', d.cause === 'system-prompt' && !d.transient);

d = await diagnose({ id: 'm', error: 'All models rate-limited after 2 attempts. Soonest cooldown reset ~43s.', wait: noWait });
check('a rate limit is transient, reset time read, long wait not retried', d.cause === 'rate-limited' && d.transient && d.retryInMs === 43000 && /43s/.test(d.detail));

let asked = 0;
d = await diagnose({ id: 'm', error: 'HTTP 503 upstream_error', retry: async () => (asked++, { ok: true }), wait: noWait });
check('a hiccup: the second try answers', asked === 1 && d.cause === 'flaky' && d.transient && d.retryInMs === 0);

d = await diagnose({ id: 'm', error: 'HTTP 503 upstream_error', retry: async () => ({ ok: false, error: 'HTTP 503' }), wait: noWait });
check('an outage: the second try fails too', d.cause === 'upstream' && d.steps.some(s => /failed too/.test(s)));

d = await diagnose({ id: 'm', error: 'HTTP 503 upstream_error', entry: { blocked: true, kinds: ['rpd'], until: Date.now() + 3600e3, platforms: ['kilo'] }, wait: noWait });
check('the gateway says limited: that is the cause, with the time', d.cause === 'limited' && /back in 60 min|back in 1 h/.test(d.detail) && d.retryInMs > 3500e3);

d = await diagnose({ id: 'm', error: 'HTTP 500', entry: { blocked: false, platforms: ['kilo'] }, keys: [{ platform: 'kilo', enabled: false }], providers: [], wait: noWait });
check('no usable key', d.cause === 'no-key' && /kilo/.test(d.detail));

d = await diagnose({ id: 'm', error: 'HTTP 502 bad gateway', entry: { blocked: false, platforms: ['kilo'] }, keys: [{ platform: 'kilo', enabled: true, status: 'healthy' }], providers: [{ platform: 'kilo', status: 'error', last_error: 'HTTP 502' }], wait: noWait });
check('the provider is down', d.cause === 'upstream' && /kilo is error/.test(d.detail));

d = await diagnose({ id: 'm', error: 'model_not_found', wait: noWait });
check('a model that is gone is not asked again for a day', d.cause === 'model-gone' && !d.transient && d.retryInMs === 24 * 3600e3);
console.log('test-diagnose: ok');
