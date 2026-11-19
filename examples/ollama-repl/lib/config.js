/**
 * config: ollama-repl's global configuration, `~/.config/ollama-repl/`
 * (`$XDG_CONFIG_HOME/ollama-repl/` when set):
 *
 *   settings.json    defaults for command-line options, written by /config set
 *   delegates.json   which sub-agent models did well (lib/delegates.js)
 *
 * ```js
 * const opts = { provider: 'ollama', ...globalSettings() };   // then the command line on top
 * setSetting('provider', 'freellm');                           // /config set provider freellm
 * ```
 *
 * A command-line option always wins over settings.json. Only the options in
 * SETTINGS can be set; a wrong type in the file is ignored, not fatal.
 */
import { getenv, loadFile, open } from 'std';
import { mkdir, rename } from 'os';

/** option name (as in opts) -> type; the command-line spelling is --kebab-case of it */
export const SETTINGS = {
  provider: 'string',
  model: 'string',
  mode: 'string',
  stream: 'boolean',
  compactAt: 'number',
  standby: 'boolean',
  noDelegate: 'boolean',
  noFailover: 'boolean',
  noHandoff: 'boolean',
  fallbackModel: 'string',
  handoffTurns: 'number',
  handoffModel: 'string',
  numCtx: 'number',
  temperature: 'number',
  maxRounds: 'number',
  cdpHost: 'string',
  cdpPort: 'number',
};

export const configDir = () => `${getenv('XDG_CONFIG_HOME') || `${getenv('HOME')}/.config`}/ollama-repl`;
export const settingsPath = () => `${configDir()}/settings.json`;

function mkdirs(dir) {
  const at = dir.lastIndexOf('/');
  if(at > 0) mkdirs(dir.slice(0, at));
  mkdir(dir, 0o755);
}

/** atomically writes text to path, creating the directory; returns whether it worked */
export function writeConfigFile(path, text) {
  mkdirs(path.slice(0, path.lastIndexOf('/')));
  const f = open(`${path}.tmp`, 'w');
  if(!f) return false;
  f.puts(text);
  f.close();
  return rename(`${path}.tmp`, path) === 0;
}

/** the saved settings that are known options of the right type */
export function globalSettings() {
  let data;

  try {
    data = JSON.parse(loadFile(settingsPath()) ?? '{}');
  } catch(e) {
    return {};
  }

  const out = {};
  for(const [k, v] of Object.entries(data ?? {})) if(SETTINGS[k] && typeof v === SETTINGS[k]) out[k] = v;
  return out;
}

/**
 * Parses text as the type of option `key` and saves it.
 *
 * @returns {string|null} an error message, null when saved
 */
export function setSetting(key, text) {
  const type = SETTINGS[key];
  if(!type) return `unknown setting "${key}" (${Object.keys(SETTINGS).join(', ')})`;

  let v = text;
  if(type === 'number') v = Number(text);
  if(type === 'boolean') v = text === 'true' || text === 'on' || text === '1' ? true : text === 'false' || text === 'off' || text === '0' ? false : null;
  if(v === null || (type === 'number' && !Number.isFinite(v)) || v === '' || v === undefined) return `${key} takes a ${type}`;

  return save({ ...globalSettings(), [key]: v });
}

export function unsetSetting(key) {
  const all = globalSettings();
  delete all[key];
  return save(all);
}

const save = all => (writeConfigFile(settingsPath(), JSON.stringify(all, null, 2) + '\n') ? null : `cannot write ${settingsPath()}`);
