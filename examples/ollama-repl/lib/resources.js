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
 * Sockets come from ss (iproute2): -tinp gives TCP with tcp_info (bytes
 * sent and received, rtt), -xp the unix sockets. Only those whose users
 * name this pid are kept. An idle lws context holds just a netlink socket,
 * which ss -t and -x do not list.
 */
import { open } from 'std';
import { readdir } from 'os';
import { runCommand } from './run-command.js';

/** what a peer port usually is here */
export const PORT_NAMES = { 3001: 'gateway', 9222: 'browser CDP', 9050: 'socks proxy', 9051: 'proxy control', 11434: 'ollama', 443: 'https', 80: 'http' };

const num = (info, key) => {
  const m = new RegExp(`\\b${key}:([\\d.]+)`).exec(info);
  return m ? +m[1] : undefined;
};

/** ms until the next ss poll of a split pane: 1 s with a request in flight, else 3 s, never under 5 times the last poll's duration */
export const pollDelay = (activeRequests, lastMs = 0) => Math.max(activeRequests ? 1000 : 3000, 5 * lastMs);

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

  return out;
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
