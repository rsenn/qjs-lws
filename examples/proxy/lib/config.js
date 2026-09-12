/**
 * CLI + Polipo-style (/etc/polipo/config) config file, merged.
 * Precedence: built-in defaults < config file < CLI flags.
 */
import { loadFile, puts, exit } from 'std';

export const defaults = {
  proxyPort: 8123,
  socksPort: 1080,
  tlsCert: null,
  tlsKey: null,
  tlsDir: './tls',
  onward: { mode: 'direct', host: null, port: null, dnsServers: null },
  verbose: 0,
};

/** Accepts either a comma-separated string ("8.8.8.8, 1.1.1.1") - from the config file, or a CLI flag given verbatim - or an already-split array, and normalizes to an array (or null for "use the system default", i.e. /etc/resolv.conf via lib/lws/context.js's createContext()). */
function toDnsList(v) {
  if(v == null) return null;
  const list = Array.isArray(v) ? v : String(v).split(',');
  const trimmed = list.map(s => s.trim()).filter(Boolean);

  return trimmed.length ? trimmed : null;
}

/**
 * Parses a Polipo-style config file: `key = value` per line, `#` starts a
 * comment (to end of line), blank lines ignored. Returns a plain object of
 * raw string values, keyed exactly as written in the file.
 */
export function parseConfigFile(text) {
  const out = {};

  for(const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if(!line) continue;

    const eq = line.indexOf('=');
    if(eq < 0) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if(key) out[key] = value;
  }

  return out;
}

const cliOptions = {
  help: [false, (_v, _pv, opts) => showHelp(opts), 'h'],
  config: [true, null, 'c'],
  'proxy-port': [true, Number],
  'socks-port': [true, Number],
  'tls-cert': [true, null],
  'tls-key': [true, null],
  'tls-dir': [true, null],
  'onward-mode': [true, null], // direct | socks5 | socks4 | http-connect
  'onward-host': [true, null],
  'onward-port': [true, Number],
  'dns-servers': [true, null], // comma-separated - resolves onward hostnames via these instead of /etc/resolv.conf
  verbose: [false, (_v, prev) => (prev ?? 0) + 1, 'v'],
};

/** "--proxy-port"/"-c" -> canonical option name ("proxy-port"/"config"), built once from `cliOptions`. */
const aliases = new Map(Object.entries(cliOptions).flatMap(([name, [, , short]]) => [[`--${name}`, name], ...(short ? [[`-${short}`, name]] : [])]));

/**
 * Table-driven CLI parser, keyed entirely off `cliOptions`' own shape
 * (`name: [hasArg, handler?, shortAlias?]`) via the `aliases` lookup above -
 * no per-flag branching. Long options accept both `--flag value` and
 * `--flag=value`; anything that isn't a recognized flag collects into the
 * returned `@` array.
 */
function parseArgs(args) {
  const result = { '@': [] };

  for(let i = 0; i < args.length; i++) {
    const eq = args[i].indexOf('=');
    const name = aliases.get(eq === -1 ? args[i] : args[i].slice(0, eq));

    if(!name) {
      result['@'].push(args[i]);
      continue;
    }

    const [hasArg, handler] = cliOptions[name];
    const raw = !hasArg ? true : eq !== -1 ? args[i].slice(eq + 1) : args[++i];

    result[name] = handler ? handler(raw, result[name], cliOptions) : raw;
  }

  return result;
}

function showHelp(opts) {
  const maxlen = Object.keys(opts).reduce((n, k) => Math.max(n, k.length), 0);
  const lines = Object.entries(opts).map(([name, [hasArg, , short]]) => `  ${short ? `-${short}, ` : '    '}--${name.padEnd(maxlen)} ${hasArg ? 'ARG' : ''}`);

  puts(`Usage: ${scriptArgs[0].split('/').pop()} [OPTIONS]\n\n${lines.join('\n')}\n`);
  exit(0);
}

/**
 * @param  {string[]} args        Usually `scriptArgs.slice(1)`
 * @param  {string}    defaultConfigPath  Tried (silently, if missing) when
 *                                        `--config` isn't given
 */
export function loadConfig(args, defaultConfigPath = './proxy.conf') {
  const cli = parseArgs(args);

  const configPath = cli.config ?? defaultConfigPath;
  const explicit = cli.config != null;

  let fileConfig = {};
  const text = loadFile(configPath);

  if(text != null) fileConfig = parseConfigFile(text);
  else if(explicit) throw new Error(`config: could not read '${configPath}'`);

  const pick = (cliValue, fileKey, fallback) => (cliValue != null ? cliValue : fileConfig[fileKey] != null ? fileConfig[fileKey] : fallback);

  return {
    proxyPort: Number(pick(cli['proxy-port'], 'proxyPort', defaults.proxyPort)),
    socksPort: Number(pick(cli['socks-port'], 'socksPort', defaults.socksPort)),
    tlsCert: pick(cli['tls-cert'], 'tlsCert', defaults.tlsCert),
    tlsKey: pick(cli['tls-key'], 'tlsKey', defaults.tlsKey),
    tlsDir: pick(cli['tls-dir'], 'tlsDir', defaults.tlsDir),
    onward: {
      mode: pick(cli['onward-mode'], 'onwardMode', defaults.onward.mode),
      host: pick(cli['onward-host'], 'onwardHost', defaults.onward.host),
      port: (v => (v != null ? Number(v) : null))(pick(cli['onward-port'], 'onwardPort', defaults.onward.port)),
      dnsServers: toDnsList(pick(cli['dns-servers'], 'dnsServers', defaults.onward.dnsServers)),
    },
    verbose: cli.verbose || Number(fileConfig.verbose ?? defaults.verbose),
  };
}
