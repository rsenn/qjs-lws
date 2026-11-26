/**
 * session-cache: what a session keeps between runs, under
 * `~/.cache/ollama-repl/sessions/<key>/` (`$XDG_CACHE_HOME` when set), never
 * in the current directory:
 *
 *   session.json   the conversation (lib/session/session-store.js)
 *   session.log    the transcript (lib/session/session-log.js)
 *   diffs/         the diffs of the files the session wrote (lib/project/file-exchange.js)
 *   history        the input lines (up-arrow, ^R)
 *   state.json     metadata and settings: name, model, project, title, message
 *                  count, the /model pattern and the settings below
 *
 * and the debug logs of every run, `~/.cache/ollama-repl/logs/
 * DATE-TIME-NAME-PROVIDER.log` (-x / DEBUG, see debugLogPath()).
 *
 * ```js
 * const key = sessionKey({ name: 'work' });                  // 'work'
 * const key2 = sessionKey({ root: '.' });                    // 'ollama-repl-1k3f9a' (project)
 * sessionFile(key, 'history');
 * saveSessionState(key, { modelPattern: 'qwen*' });
 * ```
 *
 * The key is the name of --name, else the project directory's name and a hash
 * of its real path, so two projects do not resume each other's conversation
 * and a change of model keeps the conversation (doc/ARCHITECTURE.md,
 * "Sessions"). A directory of the old form MODEL-HASH is adopted once by
 * adoptLegacySession().
 */
import { getenv, loadFile } from 'std';
import { writeConfigFile } from '../config.js';
import { mkdir, readdir, realpath, remove, rename, stat } from 'os';

export const cacheDir = () => `${getenv('XDG_CACHE_HOME') || `${getenv('HOME')}/.cache`}/ollama-repl`;

/** mkdir -p */
function mkdirs(dir) {
  const at = dir.lastIndexOf('/');
  if(at > 0) mkdirs(dir.slice(0, at));
  mkdir(dir, 0o755);
}

/* a short string for a key */
const hash = s => {
  let h = 5381;
  for(let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

const clean = s => String(s).replace(/[^\w.@+-]/g, '_');
const realRoot = root => realpath(root)[0] ?? root;

/** the directory name of a session: its name, else BASENAME-HASH of the project root */
export const sessionKey = ({ name, root = '.' }) => {
  const dir = realRoot(root);
  return clean(name || `${dir.replace(/\/+$/, '').replace(/^.*\//, '') || 'root'}-${hash(dir)}`);
};

export const sessionDir = key => `${cacheDir()}/sessions/${key}`;

/** the path of a file of the session, its directory made */
export function sessionFile(key, file) {
  mkdirs(sessionDir(key));
  return `${sessionDir(key)}/${file}`;
}

export function loadSessionState(key) {
  try {
    return JSON.parse(loadFile(`${sessionDir(key)}/state.json`)) || {};
  } catch(e) {
    return {};
  }
}

/** merges `patch` into the saved state (version, updatedAt are kept current); returns whether it worked */
export function saveSessionState(key, patch) {
  return writeConfigFile(sessionFile(key, 'state.json'), JSON.stringify({ ...loadSessionState(key), ...patch, version: 1, updatedAt: new Date().toISOString() }, null, 2));
}

/** the options a session remembers (state.json `settings`); `verbose` is the UI's, kept beside them */
export const SESSION_SETTINGS = { mode: 'string', stream: 'boolean', think: 'any', temperature: 'number', numCtx: 'number', maxRounds: 'number', scan: 'boolean', fallbackModel: 'string', verbose: 'boolean' };

const ROOTS_KEEP = 100;

/**
 * the chain of working directories with `root` appended: [{ at, root, how }], how = start | cd | --root | fallback.
 * A directory equal to the last entry is not added; the first entry and the last 99 are kept.
 */
export function addRoot(roots = [], root, how, at = new Date().toISOString()) {
  if(roots.length && roots[roots.length - 1].root === root) return roots;
  const out = [...roots, { at, root, how }];
  return out.length > ROOTS_KEEP ? [out[0], ...out.slice(-(ROOTS_KEEP - 1))] : out;
}

/**
 * where a session goes on: its last directory, else the newest earlier one of its chain that exists, else the one
 * it started in. `exists(dir)` says whether a directory is there. Returns { root, fallback } or null.
 */
export function pickRoot(state, exists) {
  const wanted = [state.root, ...[...(state.roots ?? [])].reverse().map(r => r.root), state.startRoot].filter(Boolean);
  const root = wanted.find(exists);
  return root === undefined ? null : { root, fallback: root !== wanted[0] };
}

/** the settings of `opts` (and `extra`, e.g. { verbose }) worth saving: defined, of the right type */
export function pickSettings(opts, extra = {}) {
  const src = { ...opts, ...extra };
  const out = {};
  for(const [k, t] of Object.entries(SESSION_SETTINGS)) if(src[k] !== undefined && (t === 'any' || typeof src[k] === t)) out[k] = src[k];
  return out;
}

/**
 * puts saved settings into `opts` unless the command line gave that option
 * (`given`: the names it set). Returns the names it applied; a wrong type in
 * the file is ignored.
 */
export function applySettings(opts, saved, given = new Set()) {
  const applied = [];
  for(const [k, t] of Object.entries(SESSION_SETTINGS))
    if(saved && saved[k] !== undefined && !given.has(k) && (t === 'any' || typeof saved[k] === t) && opts[k] !== saved[k]) {
      opts[k] = saved[k];
      applied.push(k);
    }
  return applied;
}

/** rm -rf */
function rmrf(path) {
  const [st] = stat(path);
  if(st && (st.mode & 0o170000) === 0o040000) {
    for(const n of readdir(path)[0] ?? []) if(n !== '.' && n !== '..') rmrf(`${path}/${n}`);
  }
  return remove(path);
}

const mtimeOf = path => stat(path)[0]?.mtime ?? 0;

/** the newest write in a session directory, ms */
const touched = key => Math.max(mtimeOf(`${sessionDir(key)}/session.json`), mtimeOf(`${sessionDir(key)}/state.json`), mtimeOf(`${sessionDir(key)}/history`), mtimeOf(sessionDir(key)));

/** a directory of the old form MODEL-HASH for this project becomes the session of its new key; returns the old key or null */
export function adoptLegacySession({ root = '.' }) {
  const key = sessionKey({ root });
  if(stat(sessionDir(key))[0]) return null;

  const suffix = `-${hash(realRoot(root))}`;
  const old = (readdir(`${cacheDir()}/sessions`)[0] ?? []).filter(n => n.endsWith(suffix) && n !== key).sort((a, b) => touched(b) - touched(a))[0];
  if(!old) return null;
  return rename(sessionDir(old), sessionDir(key)) === 0 ? old : null;
}

/**
 * the saved sessions, newest first:
 * [{ key, at (ms), messages, model, root, title, name }]
 * (messages, title ... are blank for a session saved before state.json had them)
 */
export function listSavedSessions() {
  return (readdir(`${cacheDir()}/sessions`)[0] ?? [])
    .filter(n => n !== '.' && n !== '..' && stat(sessionDir(n))[0])
    .map(key => {
      const st = loadSessionState(key);
      return { key, at: touched(key), messages: st.messages, model: st.model, root: st.root ?? st.settings?.root, title: st.title, name: st.name };
    })
    .sort((a, b) => b.at - a.at);
}

const PEEK_MAX = 8 * 1024 * 1024;

/**
 * one session's details for the browser: { key, state, size, updatedAt (ms), big, messages }.
 * Read only: an unreadable session.json is not moved aside (SessionStore#load does that), `messages` is null;
 * a file over 8 MB is not read at all (`big`).
 */
export function readSession(key) {
  const path = `${sessionDir(key)}/session.json`;
  const st = stat(path)[0];
  const size = st?.size ?? 0;
  let data = null;

  if(size && size <= PEEK_MAX)
    try {
      data = JSON.parse(loadFile(path));
    } catch(e) {}

  return { key, state: loadSessionState(key), size, updatedAt: st?.mtime, big: size > PEEK_MAX, messages: Array.isArray(data?.messages) ? data.messages : null };
}

/**
 * deletes the sessions not touched for `days`, except the keys in `keep`
 * (the live ones); with `dry` only reports. Returns the keys.
 */
export function pruneSessions({ days = 30, keep = new Set(), dry = false, now = Date.now() } = {}) {
  const gone = listSavedSessions().filter(s => !keep.has(s.key) && now - s.at > days * 86400e3).map(s => s.key);
  if(!dry) for(const k of gone) rmrf(sessionDir(k));
  return gone;
}

const started = new Date().toISOString().slice(0, 19).replace('T', '-').replaceAll(':', '');
let logName = 'session';

/** the session name the debug logs carry; the REPL sets it as soon as it has one */
export const setLogName = name => (logName = String(name).replace(/[^\w.@+-]/g, '_'));

/**
 * where the request/response debug log of a client goes: `logs/DATE-TIME-NAME-PROVIDER.log`
 * in the cache directory, DATE-TIME the start of the process; the directory
 * is only made when debugging is on
 */
export function debugLogPath(provider, debug = false) {
  const dir = `${cacheDir()}/logs`;
  if(debug || getenv('DEBUG')) mkdirs(dir);
  return `${dir}/${started}-${logName}-${provider}.log`;
}
