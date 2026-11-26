/**
 * resources: the sockets this process owns, with the traffic over them,
 * and its memory and descriptors, for the status pane (/split status).
 *
 * ```js
 * const socks = await ownSockets(getpid());
 * // [{ kind: 'tcp', state: 'ESTAB', local: '127.0.0.1:45678', peer: '127.0.0.1:3001', sent: 14200, received: 12100, rtt: 0.2 }, ...]
 * processInfo();   // { rssKB: 45000, fds: 12 }
 * ```
 *
 * Connections come from LWSContext.sockets() (lws.so; the harness holds no
 * reference to the contexts its clients create). ss (iproute2) adds what
 * lws cannot know: -tinp gives TCP with tcp_info (bytes sent and received,
 * rtt), -xp the unix sockets. Only those whose users name this pid are
 * kept. An ss entry matching an lws socket by local+peer address gains
 * `lws: { id, protocol, buffered }`. An idle lws context holds just a
 * netlink socket, which neither lists.
 */
import { open } from 'std';
import { LWSContext } from 'lws.so';
import { readdir } from 'os';
import { runCommand } from '../run-command.js';

/** what a peer port usually is here */
export const PORT_NAMES = { 3001: 'gateway', 9222: 'browser CDP', 9050: 'socks proxy', 9051: 'proxy control', 11434: 'ollama', 443: 'https', 80: 'http' };

const num = (info, key) => {
  const m = new RegExp(`\\b${key}:([\\d.]+)`).exec(info);
  return m ? +m[1] : undefined;
};

/** ms until the next ss poll of a split pane: 1 s with a request in flight, else 3 s, never under 5 times the last poll's duration */
export const pollDelay = (activeRequests, lastMs = 0) => Math.max(activeRequests ? 1000 : 3000, 5 * lastMs);

/** "host:port" of an ss column or an LWSSockAddr46, unbracketed, v4-mapped IPv6 as plain IPv4 */
const addrKey = (host, port) => `${String(host).replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '')}:${port}`;

const ssKey = addr => {
  const i = (addr ?? '').lastIndexOf(':');
  return i < 0 ? addr : addrKey(addr.slice(0, i), addr.slice(i + 1));
};

/** connected lws sockets as { key, id, protocol, buffered, local, peer } (empty if lws.so lacks LWSContext.sockets) */
function lwsConnections() {
  if(typeof LWSContext.sockets !== 'function') return [];

  const out = [];

  for(const s of LWSContext.sockets()) {
    const { local, peer } = s;
    if(!local || !peer) continue;

    out.push({ id: s.id, protocol: s.protocol, buffered: s.bufferedAmount, local: addrKey(local.host, local.port), peer: addrKey(peer.host, peer.port) });
  }

  return out;
}

/**
 * annotates the tcp entries of ownSockets() with their lws socket, and adds the
 * connected lws sockets ss did not list (as ESTAB with zero counters)
 * @param {object[]} entries ownSockets() entries, changed in place
 * @param {object[]} lws     lwsConnections() result
 */
export function joinLws(entries, lws) {
  const used = new Set();

  for(const e of entries) {
    if(e.kind !== 'tcp') continue;

    const m = lws.find(l => !used.has(l) && l.local === ssKey(e.local) && l.peer === ssKey(e.peer));

    if(m) {
      used.add(m);
      e.lws = { id: m.id, protocol: m.protocol, buffered: m.buffered };
    }
  }

  for(const l of lws)
    if(!used.has(l))
      entries.push({ kind: 'tcp', state: 'ESTAB', local: l.local, peer: l.peer, recvQ: 0, sendQ: 0, sent: 0, received: 0, rtt: undefined, lws: { id: l.id, protocol: l.protocol, buffered: l.buffered } });

  return entries;
}

/** TCP and unix sockets of pid, with traffic where the kernel counts it */
export async function ownSockets(pid) {
  /* filtered in the shell: a busy host (a tor relay) has thousands of sockets */
  const { output } = await runCommand(`ss -tinpH | grep -A1 -F 'pid=${pid},'; echo '--unix--'; ss -xpH | grep -F 'pid=${pid},'`, { timeoutMs: 3000 });
  const [tcp = '', unix = ''] = output.split('--unix--');
  const mine = line => line.includes(`pid=${pid},`);
  const out = [];
  const lines = tcp.split('\n');

  for(let k = 0; k < lines.length; k++) {
    if(/^\s/.test(lines[k]) || !mine(lines[k])) continue;

    const [state, recvQ, sendQ, local, peer] = lines[k].trim().split(/\s+/);
    const info = /^\s/.test(lines[k + 1] ?? '') ? lines[k + 1] : '';
    const rtt = /\brtt:([\d.]+)/.exec(info);

    out.push({ kind: 'tcp', state, local, peer, recvQ: +recvQ, sendQ: +sendQ, sent: num(info, 'bytes_sent') ?? 0, received: num(info, 'bytes_received') ?? 0, rtt: rtt ? +rtt[1] : undefined });
  }

  for(const line of unix.split('\n')) {
    if(!mine(line)) continue;

    const f = line.trim().split(/\s+/);
    out.push({ kind: 'unix', state: f[1], local: f[4] === '*' ? `inode ${f[5]}` : f[4], peer: f[6] === '*' ? `inode ${f[7]}` : f[6], recvQ: +f[2], sendQ: +f[3] });
  }

  return joinLws(out, lwsConnections());
}

/** resident memory and open descriptors of this process */
export function processInfo() {
  let rssKB;

  try {
    const f = open('/proc/self/status', 'r'); // loadFile() reads /proc files as empty
    rssKB = +(/VmRSS:\s+(\d+)/.exec(f.readAsString())?.[1] ?? NaN);
    f.close();
  } catch(e) {}

  const [fds] = readdir('/proc/self/fd');
  return { rssKB, fds: fds ? fds.filter(n => n !== '.' && n !== '..').length : undefined };
}
