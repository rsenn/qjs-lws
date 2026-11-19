/* Shape parity: every field of a saved freellmapi /v1/models entry must be on a bridge entry,
   unless it is listed as deliberately absent below.
   Usage: qjsm shape.js http://127.0.0.1:8089/v1 [model] */
import { fetch } from '../../../lib/fetch.js';
import { loadFile, exit } from 'std';

const base = scriptArgs[1];
const model = scriptArgs[2] ?? 'fake';

/* gateway only: the bridge has no creation date, and its reason is `unavailable` */
const ABSENT = new Set(['created', 'unavailable_reason']);

const fixture = JSON.parse(loadFile(import.meta.url.replace(/^file:\/\//, '').replace(/[^/]*$/, 'fixtures/freellm-model.json')));
const entry = (await (await fetch(`${base}/models`)).json()).data.find(m => m.id == model);
const missing = Object.keys(fixture).filter(k => !(k in (entry ?? {})) && !ABSENT.has(k));
const types = Object.keys(fixture).filter(k => k in (entry ?? {}) && typeof entry[k] != typeof fixture[k] && fixture[k] !== null);

if(!entry) console.log('❌ shape: no entry for', model);
else if(missing.length || types.length) console.log('❌ shape: missing', missing.join(', ') || '-', '; wrong type', types.join(', ') || '-');
else console.log('✅ shape: a bridge entry has every field of a gateway entry');

exit(!entry || missing.length || types.length ? 1 : 0);
