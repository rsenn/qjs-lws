/* test-provider-fallback.js: failure classes, cool-downs and the next-candidate pick of lib/clients/provider-fallback.js,
   and the one-line message of OpenAIError (no header dump) */
import { classify, shortReason, resetMs, ProviderFallback } from '../lib/clients/provider-fallback.js';
import { OpenAIError } from '../lib/clients/openai-client.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-provider-fallback: ${what}`);
};

const body = JSON.stringify({ error: { message: 'Invalid API key', type: 'authentication_error' } });
const headers = { 'content-security-policy': 'default-src none', 'x-powered-by': 'express' };

/* an error is one line, headers and body stay on the object */
const e401 = new OpenAIError(401, headers, body);
check('one-line message', e401.message === 'OpenAI HTTP 401: Invalid API key');
check('headers kept', e401.headers['x-powered-by'] === 'express' && e401.body === body);

/* what each status means */
const kind = (status, msg = '') => classify(Object.assign(new Error(msg), { status }))?.kind ?? null;
check('401 auth', classify(e401).kind === 'auth' && classify(e401).cooldownMs >= 10 * 60000);
check('403 auth', kind(403) === 'auth');
check('402 limit', kind(402) === 'limit');
check('429 limit', classify(new OpenAIError(429, {}, '{}')).kind === 'limit');
check('500 upstream', kind(500) === 'upstream');
check('503 upstream', kind(503) === 'upstream');
check('408 network', kind(408) === 'network');
check('timeout network', kind(undefined, 'no response after 30s') === 'network');
check('connection network', kind(undefined, 'Ollama connection failed: refused') === 'network');
/* the cool-down of a limit follows what the error says */
const lim = (msg, extra = {}) => classify(Object.assign(new Error(msg), { status: 429 }, extra)).cooldownMs;
check('no time: 5 min', lim('Rate limit') === 5 * 60000);
check('Retry-After 90 s', lim('Rate limit', { retryAfter: 90 }) === 95000);
check('text 3m', lim('All models rate-limited. Soonest cooldown reset ~3m.') === 185000);
check('text 48s', lim('Soonest cooldown reset ~48s.') === 53000);
check('text 2h is capped at 60 min', lim('Soonest cooldown reset ~2h.') === 60 * 60000);
check('a short reset is at least 30 s', lim('Soonest cooldown reset ~2s.') === 30000);
check('resetMs: none', resetMs(new Error('boom')) === null && resetMs(undefined) === null);
check('400 is not failed over', kind(400) === null);
check('404 is not failed over', kind(404) === null);
check('plain error is not failed over', kind(undefined, 'something else') === null);
check('short reason', shortReason(e401) === '401 Invalid API key');

/* cool-down and next pick */
const pf = new ProviderFallback(() => [
  { key: 'a', label: 'a' },
  { key: 'b', label: 'b' },
]);
const t = 1000;
check('first candidate', (await pf.next(new Set(), t)).key === 'a');
pf.mark('a', { kind: 'auth', cooldownMs: 60000, reason: '401 Invalid API key' }, t);
check('cooling', pf.cooling('a', t + 1)?.kind === 'auth');
check('skips the cooling one', (await pf.next(new Set(), t + 1)).key === 'b');
check('skips the tried one', (await pf.next(new Set(['b']), t + 120000)).key === 'a');
check('cool-down ends', pf.cooling('a', t + 60001) === undefined);
pf.mark('b', { kind: 'limit', cooldownMs: 60000, reason: '429' }, t);
check('none left', (await pf.next(new Set(), t + 1)) === null || (await pf.next(new Set(['a']), t + 1)) === null);
pf.clear();
check('clear', (await pf.next(new Set(), t + 1)).key === 'a');

console.log('test-provider-fallback: ok');
