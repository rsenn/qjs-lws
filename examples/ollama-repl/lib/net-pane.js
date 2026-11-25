/**
 * net-pane: the lines of the network pane (/split net), one box per TCP
 * connection of this process with its state, traffic, the request on it and
 * a peek at what flows right now. No box lines: a connection is a rectangle with a background colour by its
 * type (TYPES), separated from the next by half-block characters on the black ground.
 *
 * ```js
 * sockets = await ownSockets(getpid());
 * annotateRates(sockets);                       // per poll
 * const lines = netPaneLines(width, sockets, net.records);
 * ```
 *
 * Sockets come from lib/resources.js (ss), requests from lib/net-activity.js;
 * they are paired by the peer port of the request's URL, so connections of
 * other threads (the exploration worker) show without a request.
 */
import { panel } from 'terminal/widgets';
import { meter } from './look.js';
import { PORT_NAMES } from './resources.js';

const esc = n => s => `\x1b[${n}m${s}\x1b[0m`;
const dim = esc(2);
const bold = esc(1);
const col = (rgb, s) => `\x1b[38;2;${rgb}m${s}\x1b[0m`;

const bytes = n => (n == null ? '-' : n < 1024 ? `${Math.round(n)}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`);
const secs = ms => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const clip = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);
/** a peek at text: one line, newlines as ⏎, the end of it (what flowed last) */
const peek = (s, n) => {
  const t = String(s ?? '').replace(/\s*\n\s*/g, '⏎').trim();
  return t.length > n ? `…${t.slice(-(n - 1))}` : t;
};

/**
 * a line cut to n visible cells: escape sequences are kept and not counted, the cut gets an ellipsis and a reset.
 * A box line that is wider than the box wraps and makes the box grow and shrink from poll to poll.
 */
export function fitLine(line, n) {
  const s = String(line).replace(/[\r\n]+/g, ' ');
  const SGR = /\x1b\[[0-9;]*[A-Za-z]/y;
  if([...s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')].length <= n) return s;

  let out = '';
  let seen = 0;
  for(let i = 0; i < s.length; ) {
    SGR.lastIndex = i;
    const m = SGR.exec(s);
    if(m) {
      out += m[0];
      i += m[0].length;
      continue;
    }

    if(seen >= n - 1) break;
    const ch = String.fromCodePoint(s.codePointAt(i));
    out += ch;
    seen++;
    i += ch.length;
  }

  return `${out}…\x1b[0m`;
}

const prev = new Map();

/** adds sent/received rates (bytes/s) to the sockets, from the last call */
export function annotateRates(sockets, now = Date.now()) {
  const seen = new Set();

  for(const s of sockets) {
    if(s.kind !== 'tcp') continue;
    const key = `${s.local}>${s.peer}`;
    const p = prev.get(key);
    seen.add(key);
    if(p && now > p.t) {
      s.upRate = Math.max(0, ((s.sent - p.sent) * 1000) / (now - p.t));
      s.downRate = Math.max(0, ((s.received - p.received) * 1000) / (now - p.t));
    }
    prev.set(key, { t: now, sent: s.sent, received: s.received });
  }

  for(const k of prev.keys()) if(!seen.has(k)) prev.delete(k);
}

const portOf = url => /:(\d+)(?:\/|$)/.exec(String(url ?? ''))?.[1] ?? (/^https:/.test(url) ? '443' : '80');
const pathOf = url => /^[a-z]+:\/\/[^/]+(\/.*)?$/.exec(String(url ?? ''))?.[1] ?? '/';

const STATE_COLOR = { ESTAB: '#4ade80', 'TIME-WAIT': '#787878' };

/**
 * the hops the gateway tried, from its X-Fallback-Detail (with timings) or X-Fallback-Trail header:
 * "blaze/glm-5.2 key1=rate_limited t=0+62ms msg=...; router9/glm-5.2 key2=upstream_error" -> [{ route, platform, key, outcome, ms }]
 */
export function hopsOf(m) {
  const out = [];
  for(const part of String(m.detail ?? m.trail ?? '').split(/;\s*/)) {
    const h = /^(\S+?)\/(\S+) key(\d+)[=:]\s*(\w+)(?: t=\d+\+(\d+)ms)?/.exec(part);
    if(h) out.push({ platform: h[1], model: h[2], key: +h[3], outcome: h[4], ms: h[5] != null ? +h[5] : null });
    else if(/^\+\d+ more/.test(part)) out.push({ more: part });
  }
  return out;
}

const OUTCOME = { rate_limited: '251;191;36', upstream_error: '248;113;113', success: '74;222;128', ok: '74;222;128' };

/** at most `max` hop lines: provider/model key N, the outcome in colour, the time; a last line counts the rest */
function hopLines(m, w, max = 2) {
  const hops = hopsOf(m);
  const shown = hops.filter(h => !h.more).slice(0, max);
  const all = hops.filter(h => !h.more).length;
  const rest = all - shown.length + +(/\d+/.exec(hops.find(h => h.more)?.more ?? '')?.[0] ?? 0);
  const out = shown.map(h => `${dim('↳')} ${bold(h.platform)}${dim('/')}${clip(h.model, Math.max(8, w - 30))} ${dim(`key${h.key}`)} ${col(OUTCOME[h.outcome] ?? '248;113;113', h.outcome)}${h.ms != null ? dim(` ${h.ms}ms`) : ''}`);
  if(rest > 0) out.push(dim(`↳ +${rest} more`));
  return out;
}

/** the lines describing one request inside a box, w cells wide */
function requestLines(r, w, now) {
  const m = r.meta;
  const el = (r.endedAt ?? now) - r.t0;
  const out = [];
  const route = m.routedVia && m.routedVia !== m.requested ? `${m.requested} → ${m.routedVia}` : (m.requested ?? '?');

  if(r.done) {
    const bad = m.error || (m.status && m.status >= 400);
    out.push(`${bad ? col('248;113;113', '✗') : col('74;222;128', '✔')} ${m.status ?? ''} ${secs(el)} ${dim(`↓ ${bytes(m.bytesIn)}`)} ${clip(route, w - 20)}`.replace(/\s+/g, ' '));
    if(m.error) out.push(col('248;113;113', clip(m.error, w)));
    if(m.subject) out.push(dim('↑ ') + col('251;191;36', clip(m.subject, w - 3)));
    out.push(...hopLines(m, w));
    return out;
  }

  const limit = 90000; /* the first token is due within this, then the gap between chunks */
  out.push(`${bold(`${r.phase ?? 'waiting'}`)} ${dim(`${r.label}`)} ${clip(route, w - 24)}`);
  out.push(`${meter(Math.min(1, el / limit), Math.max(6, Math.min(16, w - 24)))} ${secs(el)}${m.ttfbMs != null ? dim(` headers ${secs(m.ttfbMs)}`) : ''}${m.chunks ? dim(` ${m.chunks} chunks ${(m.chunks / Math.max(0.001, el / 1000)).toFixed(1)}/s`) : ''}`);
  out.push(...hopLines(m, w, 1));
  if(m.url) out.push(dim(`POST ${clip(pathOf(m.url), w - 5)}${m.status ? `  → ${m.status}` : ''}`));
  if(m.subject) out.push(dim('↑ ') + col('251;191;36', clip(m.subject, w - 3)) + (m.bytesOut ? dim(` · ${bytes(m.bytesOut)}`) : ''));
  else if(m.request) out.push(dim('↑ ') + col('251;191;36', peek(m.request, w - 3)));
  if(m.tailReasoning && !m.tail) out.push(dim('◌ ') + col('125;211;252', peek(m.tailReasoning, w - 3)));
  if(m.tail) out.push(dim('↓ ') + col('163;230;53', peek(m.tail, w - 3)));
  return out;
}

/**
 * @param {number} width       cells of the pane
 * @param {object[]} sockets   ownSockets() result, rates annotated
 * @param {object[]} records   NetActivity#records
 */
/** the kinds of connection: background colour (dark, text stays readable), name */
export const TYPES = {
  model: ['#0f3d3a', 'model'],
  sub: ['#17304f', 'sub-agent'],
  standby: ['#2b2350', 'standby'],
  explore: ['#4a3410', 'exploration'],
  compact: ['#43204a', 'compaction'],
  cdp: ['#15401f', 'CDP'],
  http: ['#1d3347', 'http'],
  tcp: ['#2a2a2a', 'tcp'],
};

/** the type of a connection: what the request on it is for, else what its port says */
export function kindOf(port, label) {
  if(String(port) === '9222') return 'cdp';
  if(/explor/i.test(label ?? '')) return 'explore';
  if(/brief|compact|handoff/i.test(label ?? '')) return 'compact';
  if(/sub-agent/i.test(label ?? '')) return 'sub';
  if(/standby/i.test(label ?? '')) return 'standby';
  if(label) return 'model';
  if(['11434', '3001'].includes(String(port))) return 'model';
  return ['80', '443', '8080'].includes(String(port)) ? 'http' : 'tcp';
}

const rgb = hex => `${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}`;
const strip = s => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/**
 * a rectangle: a plain terminal/widgets panel on the background of the type, the first line its bold title, one
 * blank row above and below; the lines are cut and padded to the width so every card is as wide as the pane
 */
export function block(kind, lines, width) {
  const inner = width - 2;
  const [title, ...rest] = lines.map(l => {
    const t = fitLine(l, inner);
    return t + ' '.repeat(Math.max(0, inner - [...strip(t)].length));
  });

  return panel(title, rest.join('\n'), width + 1, { kind: 'plain', background: TYPES[kind][0] }).split('\n');
}

/**
 * @param {number} width       cells of the pane
 * @param {object[]} sockets   ownSockets() result, rates annotated
 * @param {object[]} records   NetActivity#records
 */
export function netPaneLines(width, sockets, records, now = Date.now()) {
  const W = Math.max(24, width - 1); /* a rectangle */
  const w = W - 2; /* inside it */
  const tcp = sockets.filter(s => s.kind === 'tcp');
  const live = records.filter(r => !r.done);
  const recent = records.filter(r => r.done && now - r.endedAt < 60000).reverse();
  const used = new Set();
  const out = [`${bold(col('45;212;191', 'network'))} ${dim(`${tcp.length} connections, ${live.length} requests active`)}`];
  const blocks = [];
  const seen = new Set();

  const add = (kind, lines) => {
    seen.add(kind);
    blocks.push(block(kind, lines, W));
  };

  /* sockets with a running request first, then the others */
  const withReq = s => records.filter(r => !used.has(r) && portOf(r.meta.url) === /:(\d+)$/.exec(s.peer)?.[1]);
  const ordered = [...tcp].sort((a, b) => (withReq(b).some(r => !r.done) ? 1 : 0) - (withReq(a).some(r => !r.done) ? 1 : 0));

  for(const s of ordered) {
    const port = /:(\d+)$/.exec(s.peer)?.[1];
    const name = PORT_NAMES[port] ?? '';
    const rs = withReq(s).filter(r => !r.done).concat(withReq(s).filter(r => r.done).slice(-1));
    for(const r of rs) used.add(r);
    const kind = kindOf(port, (rs.find(r => !r.done) ?? rs[0])?.label);

    add(kind, [
      `${bold(`${TYPES[kind][1]}${name && name !== TYPES[kind][1] ? ` · ${name}` : ''}${rs.some(r => !r.done) ? ' ●' : ''}`)} ${dim(s.state)}`,
      dim(`${s.local} → ${s.peer}`),
      `${col('163;230;53', `↑ ${bytes(s.sent)}`)}${s.upRate ? dim(` ${bytes(s.upRate)}/s`) : ''}  ${col('125;211;252', `↓ ${bytes(s.received)}`)}${s.downRate ? dim(` ${bytes(s.downRate)}/s`) : ''}${s.rtt != null ? dim(`  rtt ${s.rtt}ms`) : ''}`,
      ...(s.sendQ || s.recvQ ? [dim(`queued ${s.sendQ} out / ${s.recvQ} in`)] : []),
      ...rs.flatMap(r => [dim('╌'.repeat(Math.min(w, 24))), ...requestLines(r, w, now)]),
    ]);
  }

  /* requests whose connection is gone or not listed: still worth a rectangle */
  for(const r of [...live, ...recent].filter(r => !used.has(r))) {
    const port = portOf(r.meta.url);
    const kind = kindOf(port, r.label);
    add(kind, [`${bold(`${TYPES[kind][1]} · ${PORT_NAMES[port] ?? `:${port}`} · ${r.label}${r.done ? '' : ' ●'}`)}`, ...requestLines(r, w, now)]);
  }

  if(!blocks.length) out.push('', dim('(no connection open, no request yet)'));
  else out.push([...seen].map(k => `\x1b[48;2;${rgb(TYPES[k][0])}m ${TYPES[k][1]} \x1b[0m`).join(' '));
  return [...out, ...blocks.flat()];
}
