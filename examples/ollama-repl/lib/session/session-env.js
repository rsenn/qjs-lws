/**
 * session-env: the environment variables a session uses (API keys and URLs), kept with the session so it can be
 * taken up from a shell that does not export them. Decided in doc/ARCHITECTURE.md, "Environment".
 *
 * ```js
 * const names = relevantEnv(opts);                    // ['CEREBRAS_API_KEY', 'CEREBRAS_API_URL']
 * restoreEnv(readEnvRecord(key), names);              // sets the ones the shell does not have, returns their names
 * writeEnvRecord(key, captureEnv(names));             // after the client is made
 * maskValue('CEREBRAS_API_KEY', 'csk-v9wc2vd5c4nn8c8rccyy');   // 'csk-…cyy'
 * ```
 *
 * The values are secrets: `env.json` is mode 0600 and nothing else of the session carries them.
 */
import { getenv, setenv, loadFile, fdopen } from 'std';
import { open as osopen, remove, rename, O_WRONLY, O_CREAT, O_TRUNC } from 'os';
import { sessionDir, sessionFile } from './session-cache.js';

const SECRET = /KEY|TOKEN|SECRET|PASSWORD|AUTH/i;

/** the variables the run reads for its provider (opts as parseArgs leaves them) */
export function relevantEnv(opts) {
  if(opts.provider === 'gemini') return ['GEMINI_API_KEY'];
  if(opts.provider !== 'openai') return [];

  const names = [opts.apiKeyEnv ?? 'OPENAI_API_KEY', opts.apiUrlEnv ?? 'OPENAI_API_URL'];
  if(opts.label === 'freellm') names.push('FREELLMAPI_URL', 'FREELLMAPI_KEY', 'FREELLMAPI_DASHBOARD_TOKEN');
  return [...new Set(names)];
}

/** the value for display: a secret keeps its first 4 and last 3 characters (16 or more, else ***), a URL loses its password */
export function maskValue(name, value) {
  const v = String(value ?? '');
  if(SECRET.test(name)) return v.length >= 16 ? `${v.slice(0, 4)}…${v.slice(-3)}` : '***';
  return v.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1***@');
}

/** { NAME: value } of the names that are set (and not empty) in the environment now */
export function captureEnv(names, get = getenv) {
  const vars = {};
  for(const n of names) {
    const v = get(n);
    if(v) vars[n] = v;
  }
  return vars;
}

/** sets the recorded variables of `names` that the environment lacks; returns the names set */
export function restoreEnv(record, names, get = getenv, set = setenv) {
  const done = [];
  for(const n of names)
    if(!get(n) && record?.vars?.[n]) {
      set(n, record.vars[n]);
      done.push(n);
    }
  return done;
}

export const envPath = key => `${sessionDir(key)}/env.json`;

/** a file only its owner can read: a 0600 temp file, renamed over the target */
function writePrivate(path, text) {
  const tmp = `${path}.tmp`;
  remove(tmp);
  const fd = osopen(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0o600);
  if(fd < 0) return false;

  const f = fdopen(fd, 'w');
  f.puts(text);
  f.close();
  return rename(tmp, path) === 0;
}

/** { version, updatedAt, vars } or { vars: {} } */
export function readEnvRecord(key) {
  try {
    const d = JSON.parse(loadFile(envPath(key)));
    return d && typeof d.vars === 'object' && d.vars ? d : { vars: {} };
  } catch(e) {
    return { vars: {} };
  }
}

/** merges `vars` into the record (a name set now replaces the old value); returns whether the file was written */
export function writeEnvRecord(key, vars) {
  const old = readEnvRecord(key);
  const merged = { ...old.vars, ...vars };
  if(JSON.stringify(merged) === JSON.stringify(old.vars)) return true;

  sessionFile(key, 'env.json'); // makes the directory
  return writePrivate(envPath(key), JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), vars: merged }, null, 2));
}

/** deletes the record; returns whether there was one */
export function forgetEnvRecord(key) {
  return remove(envPath(key)) === 0;
}

/** the record as lines for display, secrets masked */
export function envText(record) {
  const names = Object.keys(record?.vars ?? {});
  return names.length ? names.map(n => `${n}=${maskValue(n, record.vars[n])}`).join('\n') : '(nothing recorded)';
}
