/**
 * ip-check: the external IPv4 address, direct or through a SOCKS proxy, asked of a list of "what is my IP"
 * hosts one after the other until one answers with a public address - the way the shell function inet_extip
 * does it (checkip.dyndns.org www.getip.com ...), with curl instead of lynx.
 *
 * ```js
 * const { ip, host } = await externalIp({ proxy: 'socks5h://127.0.0.1:9050' });   // { ip: '185.220.101.4', host: 'https://api.ipify.org' }
 * parseIp('Current IP Address: 203.0.113.7');                                      // '203.0.113.7'
 * ```
 *
 * A reply may be a page: the first dotted quad on a line that is not loopback or private (127., 10.,
 * 192.168., 172.16-31., 169.254., 0.) counts, the others are skipped.
 */
import { runCommand } from './run-command.js';

/** plain-text services first, then the pages of inet_extip's list */
export const IP_HOSTS = ['https://api.ipify.org', 'https://icanhazip.com', 'https://ifconfig.me/ip', 'http://checkip.dyndns.org', 'http://www.getip.com', 'http://whatismyip.com', 'http://www.ip-adress.com', 'http://www.ipchicken.com', 'http://ip.ubergizmo.com', 'http://www.formyip.com/iplookup.php'];

const QUAD = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g;

/** a public IPv4 address: four octets 0-255, not loopback, private, link-local or 0.x */
export function isPublicIp(ip) {
  const o = String(ip).split('.').map(Number);
  if(o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = o;
  return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224);
}

/** the first public IPv4 address in a text, null if there is none */
export function parseIp(text) {
  for(const line of String(text ?? '').split('\n'))
    for(const m of line.matchAll(QUAD)) if(isPublicIp(m[0])) return m[0];
  return null;
}

/**
 * @param {object} [o]
 * @param {string} [o.proxy]     a SOCKS proxy URL to go through, none: the direct address
 * @param {string[]} [o.hosts]
 * @param {number} [o.timeoutS]  per host
 * @returns {Promise<{ip: string, host: string}|null>} null when no host answered with a public address
 */
export async function externalIp({ proxy, hosts = IP_HOSTS, timeoutS = 8 } = {}) {
  const via = proxy ? `--proxy '${proxy.replace(/'/g, '')}' ` : '';

  for(const host of hosts) {
    const { output, status } = await runCommand(`curl -sL -m ${timeoutS} ${via}'${host}'`, { timeoutMs: (timeoutS + 4) * 1000 }).catch(() => ({ output: '', status: 1 }));
    const ip = status === 0 ? parseIp(output) : null;
    if(ip) return { ip, host };
  }

  return null;
}
