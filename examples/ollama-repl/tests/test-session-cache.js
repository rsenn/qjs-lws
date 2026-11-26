/* test-session-cache.js: session keys, legacy adoption, saved settings, listing and pruning */
import { sessionKey, sessionDir, sessionFile, saveSessionState, loadSessionState, adoptLegacySession, listSavedSessions, pruneSessions, pickSettings, applySettings, readSession, addRoot, pickRoot } from '../lib/session/session-cache.js';
import { getenv, setenv, open, exit, loadFile } from 'std';
import { mkdir, realpath, utimes } from 'os';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-session-cache: ${what}`);
};

const base = `${getenv('TMPDIR') || '/tmp'}/test-session-cache-${Date.now()}`;
mkdir(base, 0o755);
setenv('XDG_CACHE_HOME', `${base}/cache`);
mkdir(`${base}/proj`, 0o755);
mkdir(`${base}/proj/sub`, 0o755);
const root = realpath(`${base}/proj`)[0];
const put = (p, t) => {
  const f = open(p, 'w');
  f.puts(t);
  f.close();
};

/* keys */
check('a name is the key', sessionKey({ name: 'work', root }) === 'work');
check('bad characters in a name', sessionKey({ name: 'a b/c' }) === 'a_b_c');
const key = sessionKey({ root });
check('key is basename-hash', /^proj-[0-9a-z]+$/.test(key));
check('the model is not part of it', sessionKey({ root, model: 'x' }) === key && sessionKey({ root, model: 'y' }) === key);
check('another project, another key', sessionKey({ root: `${root}/sub` }) !== key);

/* the legacy form MODEL-HASH is adopted once, the newest one */
const hashPart = key.slice('proj-'.length);
for(const [m, at] of [['auto', 1000], ['qwen', 2000]]) {
  const k = `${m}-${hashPart}`;
  saveSessionState(k, { model: m });
  put(sessionFile(k, 'session.json'), '{"messages":[]}');
  utimes(`${sessionDir(k)}/session.json`, at, at);
  utimes(`${sessionDir(k)}/state.json`, at, at);
  utimes(sessionDir(k), at, at);
}
check('adopted the newest', adoptLegacySession({ root }) === `qwen-${hashPart}` && loadSessionState(key).model === 'qwen');
check('adopted once', adoptLegacySession({ root }) === null);
check('the other stays', loadSessionState(`auto-${hashPart}`).model === 'auto');

saveSessionState(key, {}); // a session in use: its state.json is fresh again

/* state.json is versioned; settings are picked by type and applied unless the command line gave them */
check('state versioned', loadSessionState(key).version === 1 && !!loadSessionState(key).updatedAt);
const picked = pickSettings({ mode: 'plan', stream: 'yes', temperature: 0.2, think: false, name: 'x', allowPaid: true }, { verbose: true });
check('picked', picked.mode === 'plan' && picked.temperature === 0.2 && picked.think === false && picked.verbose === true);
check('wrong type and unsaved options left out', !('stream' in picked) && !('name' in picked) && !('allowPaid' in picked));

const opts = { mode: 'auto', stream: true, temperature: undefined };
const applied = applySettings(opts, { mode: 'plan', stream: false, temperature: 0.5, numCtx: 'big' }, new Set(['stream']));
check('applied', opts.mode === 'plan' && opts.temperature === 0.5 && applied.join() === 'mode,temperature');
check('the command line wins', opts.stream === true);
check('wrong type ignored', !('numCtx' in opts));

/* listing and pruning */
saveSessionState('fresh', { name: 'fresh', messages: 4, title: 'hello' });
put(sessionFile('fresh', 'session.json'), '{"messages":[]}');
const later = Date.now() + 5000; // the file system may stamp both in one millisecond
for(const f of ['session.json', 'state.json']) utimes(`${sessionDir('fresh')}/${f}`, later, later);
const old = 1000; // ms since 1970: very old
for(const f of ['session.json', 'state.json']) utimes(`${sessionDir(`auto-${hashPart}`)}/${f}`, old, old);
utimes(sessionDir(`auto-${hashPart}`), old, old);
const list = listSavedSessions();
check('listed newest first', list[0].key === 'fresh' && list[0].messages === 4 && list[0].title === 'hello');
check('all listed', list.length === 3);
check('dry run deletes nothing', pruneSessions({ days: 30, dry: true }).join() === `auto-${hashPart}` && listSavedSessions().length === 3);
check('live ones are kept', pruneSessions({ days: 30, keep: new Set([`auto-${hashPart}`]) }).length === 0);
check('prune deletes', pruneSessions({ days: 30 }).join() === `auto-${hashPart}` && listSavedSessions().length === 2);
check('recent ones stay', listSavedSessions().some(s => s.key === 'fresh'));

/* readSession: read only, nothing moved aside, a missing or bad file is not an error */
put(sessionFile('rs', 'session.json'), JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }));
saveSessionState('rs', { title: 'T' });
const rs = readSession('rs');
check('readSession', rs.messages.length === 1 && rs.state.title === 'T' && rs.size > 0 && rs.big === false && rs.updatedAt > 0);
put(sessionFile('bad', 'session.json'), '{"messages": [');
const bad = readSession('bad');
check('bad file: no messages, kept in place', bad.messages === null && bad.size > 0 && loadFile(`${sessionDir('bad')}/session.json`) === '{"messages": [');
const none = readSession('nothing-here');
check('no file', none.messages === null && none.size === 0 && none.big === false);

/* the chain of working directories */
let chain = addRoot([], '/a', 'start', 't0');
check('first entry', chain.length === 1 && chain[0].how === 'start' && chain[0].at === 't0');
check('same directory twice is one entry', addRoot(chain, '/a', 'cd') === chain);
chain = addRoot(chain, '/b', 'cd', 't1');
check('cd appends', chain.map(r => r.root).join() === '/a,/b' && chain[1].how === 'cd');
for(let i = 0; i < 150; i++) chain = addRoot(chain, `/d${i}`, 'cd');
check('capped at 100, first kept', chain.length === 100 && chain[0].root === '/a' && chain[99].root === '/d149');
const st = { root: '/c', roots: [{ root: '/a' }, { root: '/b' }, { root: '/c' }], startRoot: '/a' };
check('goes on in the last directory', JSON.stringify(pickRoot(st, () => true)) === '{"root":"/c","fallback":false}');
check('falls back to the newest earlier one', JSON.stringify(pickRoot(st, d => d === '/b' || d === '/a')) === '{"root":"/b","fallback":true}');
check('falls back to the start', pickRoot({ root: '/c', startRoot: '/a' }, d => d === '/a').root === '/a');
check('nothing exists', pickRoot(st, () => false) === null && pickRoot({}, () => true) === null);

console.log('test-session-cache: ok');
exit(0);
