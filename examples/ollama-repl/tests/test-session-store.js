/* test-session-store.js: session.json is written whole (tmp + rename), versioned, and an unreadable file is kept aside */
import { SessionStore } from '../lib/session/session-store.js';
import { getenv, loadFile, open, exit } from 'std';
import { mkdir, remove, readdir } from 'os';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-session-store: ${what}`);
};

const dir = `${getenv('TMPDIR') || '/tmp'}/test-session-store-${Date.now()}`;
mkdir(dir, 0o755);
const path = `${dir}/session.json`;
const put = (p, text) => {
  const f = open(p, 'w');
  f.puts(text);
  f.close();
};

const store = new SessionStore(path);
check('nothing yet', store.load() === null && store.corrupt === null);

check('save works', store.save([{ role: 'user', content: 'hi' }], 1, ['next']) === true);
check('no tmp left', readdir(dir)[0].every(n => !n.endsWith('.tmp')));
const raw = JSON.parse(loadFile(path));
check('version and time', raw.version === 1 && /^\d{4}-\d\d-\d\dT/.test(raw.updatedAt));

const got = store.load();
check('round trip', got.messages.length === 1 && got.baseMessageCount === 1 && got.queue[0] === 'next');

/* a file of the old form (no version) still loads */
put(path, JSON.stringify({ messages: [{ role: 'user', content: 'old' }], baseMessageCount: 0 }));
check('version 0 loads', store.load().messages[0].content === 'old');

/* a truncated file is set aside, not read and not overwritten by the next save */
put(path, '{"messages": [{"role": "us');
check('truncated gives null', store.load() === null);
check('moved aside', store.corrupt === `${path}.corrupt` && loadFile(`${path}.corrupt`).startsWith('{"messages"') && loadFile(path) === null);
check('save after corrupt', store.save([], 0) && store.load().messages.length === 0 && store.corrupt === null);

/* valid JSON without messages is just as unusable */
put(path, '{"hello":1}');
check('no messages is corrupt', store.load() === null && store.corrupt !== null);

for(const n of readdir(dir)[0]) if(n !== '.' && n !== '..') remove(`${dir}/${n}`);
remove(dir);
console.log('test-session-store: ok');
exit(0);
