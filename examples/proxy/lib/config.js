/**
 * CLI (util.getOpt) + Polipo-style (/etc/polipo/config) config file, merged.
 * Precedence: built-in defaults < config file < CLI flags.
 */
import { getOpt, showHelp } from 'util';
import { loadFile } from 'std';

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
  '@': [],
};

/**
 * @param  {string[]} args        Usually `scriptArgs.slice(1)`
 * @param  {string}    defaultConfigPath  Tried (silently, if missing) when
 *                                        `--config` isn't given
 */
export function loadConfig(args, defaultConfigPath = './proxy.conf') {
  const cli = getOpt(cliOptions, args);

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
