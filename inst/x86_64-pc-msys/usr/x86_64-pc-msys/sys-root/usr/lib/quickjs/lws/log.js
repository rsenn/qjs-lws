/**
 * Log formatting for the lws.so log pipe (the `(level, msg)` callback given to
 * `logLevel()`, see context.js). Turns the flat text lws.so emits, e.g.
 *
 *   [wsisrv|1|localhost|adopted|127.0.0.1]: RAW_RX: RX 99 bytes: 0000005a\n{...}
 *   [wsisrv|1|localhost|adopted|127.0.0.1]: TX 89 bytes (proto=HTTP): ...
 *
 * into entries ({ time, level, wsi, event, dir, bytes, proto, data }) and
 * renders them in one of three formats:
 *
 *  - 'ndjson': one JSON object per line, reparseable with parseNDJSON()
 *  - 'human':  one header line per entry (colour only on a tty), payload
 *              indented underneath, JSON payloads pretty-printed
 *  - 'curl':   imitates `curl --verbose`: `* ` info lines, `> ` / `< `
 *              header lines for HTTP traffic, `{ [n bytes data]` for bodies
 *
 *   logLevel(LLL_USER | LLL_ERR, createLogger({ format: 'human' }));
 */
import * as os from 'os';
import { out as stdout } from 'std';
import { getLogLevelName } from 'lws.so';

const NAMED = { a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };

/** Reverses lwsjs_log_user_line()'s echo -e style escaping. */
export function unescapeData(s) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|[abefnrtv\\])/g, (m, c) => (c[0] == 'x' && c.length == 3 ? String.fromCharCode(parseInt(c.slice(1), 16)) : NAMED[c]));
}

const TAG_RE = /^\[([^\]]*)\]:\s*/;
const TRAFFIC_RE = /^(?:(\w+):\s*)?(RX|TX)\s+(\d+)\s+bytes(?:\s+\(proto=([^)]*)\))?:\s?/;

/**
 * Parses one log-callback message.
 * @param  {number} level  LLL_* level
 * @param  {string} msg
 * @return {object}        entry
 */
export function parseEntry(level, msg, time = new Date()) {
  const entry = { time: time.toISOString(), level: getLogLevelName(level)?.trim() ?? String(level) };
  let m;

  if((m = TAG_RE.exec(msg))) {
    const [kind, id, ...rest] = m[1].split('|');
    const wsi = { kind, id: isNaN(+id) ? id : +id };

    // [wsisrv|id|vhost|state|peer] / [wsi|id|listen|vhost||port]
    if(kind == 'wsi') Object.assign(wsi, { role: rest[0], vhost: rest[1], port: rest[3] ? +rest[3] : undefined });
    else if(kind == 'wsicli') wsi.target = rest.join('|');
    else Object.assign(wsi, { vhost: rest[0], state: rest[1], peer: rest[2] });

    entry.wsi = wsi;
    msg = msg.slice(m[0].length);
  }

  if((m = TRAFFIC_RE.exec(msg))) {
    if(m[1]) entry.event = m[1];
    entry.dir = m[2].toLowerCase();
    entry.bytes = +m[3];
    if(m[4]) entry.proto = m[4];
    entry.data = unescapeData(msg.slice(m[0].length));
  } else {
    entry.event = msg.replace(/\s+$/, '');
  }

  return entry;
}

/* ---- helpers ---- */

const pad = (n, w = 2) => String(n).padStart(w, '0');
const clock = iso => iso.slice(11, 23);
const wsiName = w => (w ? `${w.kind}#${w.id}` : '');
const peerOf = w => w?.peer || w?.target || (w?.port ? `${w.vhost}:${w.port}` : w?.vhost) || '';

/** Strips the 8-hex-digit length line of the debugger framing, if present. */
function splitFrames(data) {
  const out = [];
  let m;

  while((m = /^([0-9a-f]{8})\n/.exec(data)) && data.length >= 9) {
    const n = parseInt(m[1], 16);
    out.push(data.slice(9, 9 + n));
    data = data.slice(9 + n);
  }
  if(data.length || !out.length) out.push(data);
  return out;
}

function prettyPayload(data, max) {
  const lines = [];

  for(const frame of splitFrames(data)) {
    let text = frame;

    try {
      if(/^\s*[[{]/.test(frame)) text = JSON.stringify(JSON.parse(frame), null, 2);
    } catch(e) {}

    lines.push(...text.split(/\r?\n/));
  }

  const out = lines.join('\n').replace(/\s+$/, '');
  return max > 0 && out.length > max ? out.slice(0, max) + `\n... (${out.length - max} more chars)` : out;
}

const isRequestLine = s => /^[A-Z]+ \S+ HTTP\/\d(?:\.\d)?\r?$/.test(s);
const isStatusLine = s => /^HTTP\/\d(?:\.\d)? \d{3}\b/.test(s);

/* ---- formatters: (entry, opts) => string (no trailing newline) ---- */

export function formatNDJSON(entry) {
  return JSON.stringify(entry);
}

export function formatHuman(entry, { color = false, maxData = 4096 } = {}) {
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const levelColor = { ERR: '1;31', WARN: '33', NOTICE: '33' }[entry.level];
  const head = [c(2, clock(entry.time))];

  if(entry.level != 'USER') head.push(c(levelColor ?? 2, entry.level.padEnd(5)));
  if(entry.wsi) head.push(c(1, wsiName(entry.wsi)), c(2, peerOf(entry.wsi)));

  if(entry.dir) {
    head.push(c(entry.dir == 'rx' ? '36' : '32', entry.dir.toUpperCase()), `${entry.bytes} bytes`);
    if(entry.event) head.push(c(2, entry.event));
    if(entry.proto) head.push(c(2, `(${entry.proto})`));
  } else head.push(c(entry.level == 'ERR' ? '1;31' : 0, entry.event));

  let out = head.join(' ');
  if(entry.data) out += '\n' + prettyPayload(entry.data, maxData).replace(/^/gm, '    ');
  return out;
}

export function formatCurl(entry, { color = false, maxData = 4096 } = {}) {
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const info = s => c(2, '* ' + s);
  const w = entry.wsi;

  if(!entry.dir) {
    if(entry.event == 'SERVER_NEW_CLIENT_INSTANTIATED') return info(`Connection #${w?.id} from ${peerOf(w)}`);
    if(entry.event == 'RAW_ADOPT') return info(`Adopted ${peerOf(w)} as raw socket`);
    if(/CLOSED/.test(entry.event)) return info(`Connection #${w?.id} to host ${peerOf(w)} left intact`);
    return info(entry.event + (w ? ` (${wsiName(w)})` : ''));
  }

  const lines = (entry.data || '').split('\n');
  const tx = entry.dir == 'tx';
  const out = [];
  let i = 0;

  // HTTP head: request line / status line plus headers up to the blank line
  if(isRequestLine(lines[0]) || isStatusLine(lines[0])) {
    const arrow = isRequestLine(lines[0]) ? '>' : '<';
    const col = arrow == '>' ? '36' : '32';

    for(; i < lines.length; i++) {
      const l = lines[i].replace(/\r$/, '');
      out.push(c(col, `${arrow} ${l}`));
      if(l === '') {
        i++;
        break;
      }
    }
  }

  const body = lines.slice(i).join('\n');
  if(body.length || !out.length) {
    out.push(c(tx ? '33' : '35', `${tx ? '}' : '{'} [${entry.proto ? entry.proto + ' ' : ''}${entry.bytes} bytes data]`));
    if(body.length) out.push(prettyPayload(body, maxData));
  }

  return out.join('\n');
}

export const formats = { ndjson: formatNDJSON, human: formatHuman, curl: formatCurl };

/** Reads back what the 'ndjson' format wrote; blank / non-JSON lines are skipped. */
export function parseNDJSON(text) {
  const out = [];

  for(const line of text.split('\n')) {
    if(!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch(e) {}
  }
  return out;
}

/**
 * Builds a `(level, msg)` callback for `logLevel()`.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.format='human']  'ndjson' | 'human' | 'curl'
 * @param {object|function} [opts.out]  file object with puts() (default stdout), or `(text) => void`
 * @param {boolean}  [opts.color]       default: on when `out` is a tty
 * @param {number}   [opts.maxData=4096] payload chars shown by human/curl (0 = unlimited)
 * @param {function} [opts.filter]      `(entry) => boolean`, drop entries returning false
 */
export function createLogger({ format = 'human', out, color, maxData = 4096, filter } = {}) {
  const fmt = formats[format];
  if(!fmt) throw new TypeError(`unknown log format '${format}' (ndjson, human, curl)`);

  const write = typeof out == 'function' ? out : (out ?? stdout).puts.bind(out ?? stdout);
  const isTTY = out === undefined || out === stdout ? os.isatty(1) : false;
  const opts = { color: color ?? (format != 'ndjson' && isTTY), maxData };

  return (level, msg) => {
    const entry = parseEntry(level, msg);

    if(filter && !filter(entry)) return;
    write(fmt(entry, opts) + '\n');
  };
}

export default createLogger;
