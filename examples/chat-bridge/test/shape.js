/* Shape parity: every field of a saved freellmapi answer must be in the bridge's answer, unless it is listed as
   deliberately absent below. A field inside an array is compared on the first element, when the bridge has one.
   Usage: qjsm shape.js http://127.0.0.1:8089/v1 [model] */
import { fetch } from '../../../lib/fetch.js';
import { loadFile, exit } from 'std';

const base = scriptArgs[1];
const model = scriptArgs[2] ?? 'fake';
const dir = import.meta.url.replace(/^file:\/\//, '').replace(/[^/]*$/, 'fixtures/');

/* gateway only: the bridge has no creation date and its reason is `unavailable`; it has no keys, so `byKey` is
   empty, and its providers are all in `counts` that happen to occur */
const ABSENT = { models: ['created', 'unavailable_reason'], usage: ['byKey'], providers: [], 'quota-forecast': [] };

const compare = (want, got, path, absent, out) => {
  if(Array.isArray(want)) {
    if(Array.isArray(got) && got.length && want.length) compare(want[0], got[0], `${path}[0]`, absent, out);
    return;
  }

  if(want === null || typeof want != 'object') return;

  for(const k of Object.keys(want)) {
    const p = path ? `${path}.${k}` : k;
    if(absent.includes(p)) continue;
    if(!got || !(k in got)) out.push(`${p} missing`);
    else if(want[k] !== null && got[k] !== null && typeof want[k] != typeof got[k]) out.push(`${p} is ${typeof got[k]}, want ${typeof want[k]}`);
    else compare(want[k], got[k], p, absent, out);
  }
};

let failed = 0;

for(const [name, path] of [['models', 'models'], ['usage', 'usage'], ['providers', 'providers'], ['quota-forecast', 'quota-forecast']]) {
  const file = name == 'models' ? 'freellm-model.json' : `freellm-${name}.json`;
  const want = JSON.parse(loadFile(dir + file));
  let got = await (await fetch(`${base}/${path}`)).json();
  if(name == 'models') got = got.data.find(m => m.id == model);

  const out = [];
  compare(want, got, '', ABSENT[name], out);
  if(out.length) failed++;
  console.log(out.length ? '❌' : '✅', `shape ${name}:`, out.length ? out.join(', ') : 'every field of a gateway answer is there');
}

exit(failed ? 1 : 0);
