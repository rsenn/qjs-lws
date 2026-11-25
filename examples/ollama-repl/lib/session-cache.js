/**
 * session-cache: what a session keeps between runs, under
 * `~/.cache/ollama-repl/sessions/<key>/` (`$XDG_CACHE_HOME` when set), never
 * in the current directory:
 *
 *   session.json   the conversation (lib/session-store.js)
 *   session.log    the transcript (lib/session-log.js)
 *   diffs/         the diffs of the files the session wrote (lib/file-exchange.js)
 *   history        the input lines (up-arrow, ^R)
 *   state.json     the /model pattern filter in use
 *
 * and the debug logs of every run, `~/.cache/ollama-repl/logs/
 * DATE-TIME-NAME-PROVIDER.log` (-x / DEBUG, see debugLogPath()).
 *
 * ```js
 * const key = sessionKey({ name: 'work' });                  // 'work'
 * const key2 = sessionKey({ model: 'auto', root: '.' });     // 'auto-1k3f9a' (model + project)
 * sessionFile(key, 'history');
 * saveSessionState(key, { modelPattern: 'qwen*' });
 * ```
 *
 * The key is the name of --name or /rename, else the model and a hash of the
 * project root, so two projects do not resume each other's conversation.
 */
import { getenv, loadFile } from 'std';
import { writeConfigFile } from './config.js';
import { mkdir, realpath } from 'os';

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

/** the directory name of a session: its name, else model-HASH of the project root */
export const sessionKey = ({ name, model, root = '.' }) => String(name || `${model}-${hash(realpath(root)[0] ?? root)}`).replace(/[^\w.@+-]/g, '_');

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

/** merges `patch` into the saved state; returns whether it worked */
export function saveSessionState(key, patch) {
  return writeConfigFile(sessionFile(key, 'state.json'), JSON.stringify({ ...loadSessionState(key), ...patch }, null, 2));
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
