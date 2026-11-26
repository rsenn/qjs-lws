/* test-transcript-text.js: the pure helpers behind the coloured transcript lines and the exploration queue */
import { exploreOrder, makeModelName, routeFailure, servedIds, soonestReset, earliestReset } from '../lib/transcript-text.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-transcript-text: ${what}`);
};
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

/* the model name: bold, in the colour of its strength tier; plain when piped or without a name */
const fgHex = (hex, text) => `<${hex}>${text}`;
const name = makeModelName({ fgHex, strengthColor: t => (t === 1 ? '#d946ef' : '#22c55e'), tierOf: id => (id === 'strong' ? 1 : 9) });
check('strong model in its colour', name('strong') === '\x1b[1m<#d946ef>strong\x1b[0m');
check('weak model in another colour', name('weak') === '\x1b[1m<#22c55e>weak\x1b[0m');
check('no id stays as it is', name('') === '' && name(null) === null);
check('piped: plain', makeModelName({ piped: true, fgHex, strengthColor: () => '#000', tierOf: () => 0 })('strong') === 'strong');

/* the reset time the gateway names */
check('reset time read', soonestReset('All models rate-limited. Soonest cooldown reset ~48s.') === '48s');
check('no reset time', soonestReset('upstream error') === null && soonestReset(undefined) === null);

/* one failed route as a card line */
const line = routeFailure('kilo/nvidia/nemotron', 'Rate limit exceeded. Soonest cooldown reset ~48s.', { dim: s => `[${s}]`, modelName: s => `{${s}}` });
check('provider dim, model named, first sentence, reset amber', strip(line) === '[kilo/nvidia/]{nemotron}  Rate limit exceeded  back in ~48s');
check('the reset time is amber', line.includes('\x1b[38;2;251;191;36mback in ~48s\x1b[0m'));
const bare = routeFailure('auto', 'boom', { piped: true });
check('a route without a provider, piped: no escapes', bare === 'auto  boom');
check('the error is cut at 90 characters', strip(routeFailure('a/b', 'x'.repeat(200))).length < 120);

/* models that answered lately */
const rows = [{ routedVia: 'kilo/m1' }, { routedVia: 'kilo/m2', error: 'x' }, { routedVia: undefined }, { routedVia: 'google/m3' }];
const served = servedIds(rows, id => id.split('/')[1]);
check('only error-free routed rows count', served.has('m1') && served.has('m3') && !served.has('m2') && served.size === 2);

/* the exploration order: served first (+100), then by rating; platforms passed through */
const o = exploreOrder({ served: new Set(['b']), platformsOf: id => [id], rateOf: id => ({ a: 90, b: 40, c: undefined })[id] });
check('a served model outranks a better rated one', o.priority('b') > o.priority('a'));
check('a missing rating counts as 0', o.priority('c') === 0);
check('platformsOf is passed through', o.platformsOf('x')[0] === 'x');

/* the give-up panel names the earliest reset */
check('earliest of several', earliestReset([['a/x', 'Rate limit. Soonest cooldown reset ~3m.'], ['b/y', 'refused'], ['c/z', 'Soonest cooldown reset ~48s.']]) === 'earliest reset in ~48s: c/z');
check('none names a time', earliestReset([['a/x', 'boom']]) === null && earliestReset([]) === null);
console.log('test-transcript-text: ok');
