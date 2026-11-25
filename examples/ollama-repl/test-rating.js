/* test-rating.js: the rating of a model and how events move it */
import { score, Ratings, setRater, rateOf, sortByRating } from './lib/rating.js';
import { setenv } from 'std';

setenv('XDG_CACHE_HOME', '/tmp/ollama-repl-test-rating');
const check = (what, ok) => {
  if(!ok) throw new Error(`test-rating: ${what}`);
};
const now = 1e12;

check('stronger model rates higher', score({}, { intelligence: 0.9 }, now) > score({}, { intelligence: 0.4 }, now));
check('tier guess when the gateway has no score', score({}, { tier: 1 }, now) > score({}, { tier: 8 }, now));
check('limited is far below usable', score({}, { intelligence: 0.9, blocked: true }, now) < score({}, { intelligence: 0.5 }, now));
check('cooling costs a little', score({}, { intelligence: 0.5, cooling: true }, now) === score({}, { intelligence: 0.5 }, now) - 10);
check('bigger context helps', score({}, { intelligence: 0.5, ctx: 200000 }, now) > score({}, { intelligence: 0.5, ctx: 4000 }, now));
check('clamped 0..100', score({ adj: 25, probe: { ok: true, toolOk: true } }, { intelligence: 1, ctx: 2e5 }, now) <= 100 && score({}, { intelligence: 0, blocked: true, permanent: true }, now) === 0);
check('adjustment decays with time', score({ adj: 20, at: now - 21 * 86400e3 }, { intelligence: 0.5 }, now) < score({ adj: 20, at: now }, { intelligence: 0.5 }, now));
check('fast beats slow', score({ latMs: 1000 }, { intelligence: 0.5 }, now) > score({ latMs: 40000 }, { intelligence: 0.5 }, now));

const r = new Ratings('http://t');
const base = r.rating('m', { intelligence: 0.5 }, now);
for(let i = 0; i < 5; i++) r.recordResult('m', { ok: true, ms: 1500 }, now);
const good = r.rating('m', { intelligence: 0.5 }, now);
check('successes raise it', good > base);
for(let i = 0; i < 6; i++) r.recordResult('m', { ok: false, error: 'HTTP 500 boom' }, now);
check('failures lower it', r.rating('m', { intelligence: 0.5 }, now) < good);
const before = r.get('m').fail;
r.recordResult('m', { ok: false, error: 'HTTP 429 rate limited' }, now);
check('a limit is not the model\'s fault', r.get('m').fail === before);

r.recordProbe('p', { ok: true, toolOk: true, systemOk: true, latencyMs: 900 }, now);
r.recordProbe('q', { ok: false }, now);
check('passed probe beats failed probe', r.rating('p', { intelligence: 0.5 }, now) > r.rating('q', { intelligence: 0.5 }, now));
check('a failed probe is forgiven after an hour', r.rating('q', { intelligence: 0.5 }, now + 2 * 3600e3) > r.rating('q', { intelligence: 0.5 }, now));

setRater(id => ({ a: 10, b: 90, c: 50 })[id] ?? null);
check('sortByRating: best first, unknown last', sortByRating(['x', 'a', 'b', 'c']).join() === 'b,c,a,x' && rateOf('b') === 90);
r.flush();
console.log('test-rating: ok');
