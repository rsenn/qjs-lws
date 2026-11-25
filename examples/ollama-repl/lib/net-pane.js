/**
 * net-pane: the lines of the network pane (/split net), one box per TCP
 * connection of this process with its state, traffic, the request on it and
 * a peek at what flows right now.
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
import { BOX_ROUNDED, boxLines } from 'terminal';
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
    return out;
  }

  const limit = 90000; /* the first token is due within this, then the gap between chunks */
  out.push(`${bold(`${r.phase ?? 'waiting'}`)} ${dim(`${r.label}`)} ${clip(route, w - 24)}`);
  out.push(`${meter(Math.min(1, el / limit), Math.max(6, Math.min(16, w - 24)))} ${secs(el)}${m.ttfbMs != null ? dim(` headers ${secs(m.ttfbMs)}`) : ''}${m.chunks ? dim(` ${m.chunks} chunks ${(m.chunks / Math.max(0.001, el / 1000)).toFixed(1)}/s`) : ''}`);
  if(m.url) out.push(dim(`POST ${clip(pathOf(m.url), w - 5)}${m.status ? `  → ${m.status}` : ''}`));
  if(m.request) out.push(dim('↑ ') + col('251;191;36', peek(m.request, w - 3)));
  if(m.tailReasoning && !m.tail) out.push(dim('◌ ') + col('125;211;252', peek(m.tailReasoning, w - 3)));
  if(m.tail) out.push(dim('↓ ') + col('163;230;53', peek(m.tail, w - 3)));
  return out;
}

/**
 * @param {number} width       cells of the pane
 * @param {object[]} sockets   ownSockets() result, rates annotated
 * @param {object[]} records   NetActivity#records
 */
export function netPaneLines(width, sockets, records, now = Date.now()) {
  const w = Math.max(20, width - 4); /* inside a box */
  const tcp = sockets.filter(s => s.kind === 'tcp');
  const live = records.filter(r => !r.done);
  const recent = records.filter(r => r.done && now - r.endedAt < 60000).reverse();
  const used = new Set();
  const out = [`${bold(col('45;212;191', 'network'))} ${dim(`${tcp.length} connections, ${live.length} requests active`)}`];
  const boxes = [];

  const box = (title, border, lines) => boxes.push(boxLines(lines, { title, width: width - 1, chars: BOX_ROUNDED, border: { fg: border } }).join('\n'));

  /* sockets with a running request first, then the others */
  const withReq = s => records.filter(r => !used.has(r) && portOf(r.meta.url) === /:(\d+)$/.exec(s.peer)?.[1]);
  const ordered = [...tcp].sort((a, b) => (withReq(b).some(r => !r.done) ? 1 : 0) - (withReq(a).some(r => !r.done) ? 1 : 0));

  for(const s of ordered) {
    const port = /:(\d+)$/.exec(s.peer)?.[1];
    const name = PORT_NAMES[port] ?? '';
    const rs = withReq(s).filter(r => !r.done).concat(withReq(s).filter(r => r.done).slice(-1));
    for(const r of rs) used.add(r);

    const lines = [
      `${bold(s.state)} ${dim(`${s.local} → ${s.peer}`)}`.replace(/\s+/g, ' '),
      `${col('163;230;53', `↑ ${bytes(s.sent)}`)}${s.upRate ? dim(` ${bytes(s.upRate)}/s`) : ''}  ${col('125;211;252', `↓ ${bytes(s.received)}`)}${s.downRate ? dim(` ${bytes(s.downRate)}/s`) : ''}${s.rtt != null ? dim(`  rtt ${s.rtt}ms`) : ''}`,
      ...(s.sendQ || s.recvQ ? [dim(`queued ${s.sendQ} out / ${s.recvQ} in`)] : []),
      ...rs.flatMap(r => [dim('─'.repeat(Math.min(w, 24))), ...requestLines(r, w, now)]),
    ];

    box(`${name || s.peer}${rs.some(r => !r.done) ? ' ●' : ''}`, STATE_COLOR[s.state] ?? '#fbbf24', lines);
  }

  /* requests whose connection is gone or not listed: still worth a box */
  for(const r of [...live, ...recent].filter(r => !used.has(r))) {
    const port = portOf(r.meta.url);
    box(`${PORT_NAMES[port] ?? `:${port}`} · ${r.label}${r.done ? '' : ' ●'}`, r.done ? '#787878' : '#2dd4bf', requestLines(r, w, now));
  }

  if(!boxes.length) out.push('', dim('(no connection open, no request yet)'));
  return [...out, ...boxes.flatMap(b => ['', ...b.split('\n')])];
}
