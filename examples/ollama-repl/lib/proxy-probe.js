/**
 * proxy-probe: the socks proxy freellmapi sends its upstream requests
 * through (here the anon service, tor-based), and what it costs in
 * latency.
 *
 * ```js
 * const p = await proxySettings(gateway);          // { url, active, bypass, keyProxies }
 * proxied(p, 'kilo');                              // true
 * const m = await measure(p.url);                  // direct vs proxied timings
 * await newExit();                                 // NEWNYM on Tor's control port, over our own TCP connection
 * ```
 *
 * measure() runs curl to one upstream LLM host, direct and through the
 * proxy, a few times each, and compares the medians. Time to first byte
 * is what a model request feels: TCP and TLS setup plus the upstream's
 * answer, all of it through the proxy's circuit.
 */
import { getenv } from 'std';
import { setTimeout, clearTimeout } from 'os';
import { toString } from 'lws.so';
import { TCPSocket } from '../../../lib/tcpsocket.js';
import { runCommand } from './run-command.js';
import { externalIp } from './ip-check.js';

/** a small upstream answer: an LLM host's model list without a key is a short 401 */
export const PROBE_URL = 'https://api.groq.com/openai/v1/models';

/** the address that tells which exit the proxy uses */
export const EXIT_IP_URL = 'https://api.ipify.org';

/**
 * proxy settings of the gateway (dashboard session needed)
 *
 * @returns {Promise<{url: string, enabled: boolean, active: boolean, bypass: string[], keyProxies: Map<string, string>}>}
 */
export async function proxySettings(gateway) {
  const s = await gateway.api('/api/settings/proxy');
  const keys = await gateway.api('/api/keys').catch(() => []);
  const keyProxies = new Map((Array.isArray(keys) ? keys : []).filter(k => k.maskedProxyUrl).map(k => [k.platform, k.maskedProxyUrl]));

  return { url: s.proxyUrl ?? '', mode: s.proxyMode, enabled: !!s.enabled, active: !!s.active, bypass: s.bypassPlatforms ?? [], keyProxies };
}

/**
 * switches the gateway's global upstream proxy on or off (PUT /api/settings/proxy {enabled}); the proxy URL
 * stays saved. Takes effect for the next request, no gateway restart.
 *
 * @returns {Promise<object>} the new settings, as proxySettings() reads them
 */
export async function setProxyEnabled(gateway, enabled) {
  await gateway.api('/api/settings/proxy', { method: 'PUT', body: { enabled } });
  return proxySettings(gateway);
}

/** whether requests to platform go through a proxy: its key's own, else the global one unless bypassed */
export function proxied(settings, platform) {
  if(!settings || !platform) return null;
  if(settings.keyProxies.has(platform)) return true;
  return settings.active && !settings.bypass.includes(platform);
}

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/* curl's timings of one request in ms, null when it failed */
async function timing(url, proxy, timeoutS) {
  const via = proxy ? `--proxy '${proxy.replace(/'/g, '')}' ` : '';
  const { output, status } = await runCommand(`curl -so /dev/null -m ${timeoutS} ${via}-w '%{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total}' '${url}'`, { timeoutMs: (timeoutS + 5) * 1000 });
  const t = output.trim().split(/\s+/).map(Number);

  if(status !== 0 || t.length < 4 || t.some(Number.isNaN)) return null;
  return { connect: t[0] * 1000, tls: (t[1] - t[0]) * 1000, ttfb: t[2] * 1000, total: t[3] * 1000 };
}

/**
 * timings direct and through proxy, the medians of runs requests each
 *
 * @returns {Promise<{url: string, direct: object|null, proxy: object|null, overhead: number|null, at: number}>}
 *   overhead is the proxied time to first byte minus the direct one, in ms
 */
export async function measure(proxyUrl, { url = PROBE_URL, runs = 3, timeoutS = 20 } = {}) {
  const sides = { direct: [], proxy: [] };

  for(let k = 0; k < runs; k++) {
    sides.direct.push(await timing(url, null, timeoutS));
    sides.proxy.push(await timing(url, proxyUrl, timeoutS));
  }

  const summary = list => {
    const ok = list.filter(Boolean);
    if(!ok.length) return null;
    return Object.fromEntries(['connect', 'tls', 'ttfb', 'total'].map(f => [f, Math.round(median(ok.map(t => t[f])))]).concat([['failed', list.length - ok.length]]));
  };

  const direct = summary(sides.direct);
  const proxy = summary(sides.proxy);

  return { url, direct, proxy, overhead: direct && proxy ? proxy.ttfb - direct.ttfb : null, at: Date.now() };
}

/** the proxy's exit address, null when it does not answer */
export async function exitIp(proxyUrl) {
  return (await externalIp({ proxy: proxyUrl }))?.ip ?? null;
}

/**
 * asks the proxy for a new circuit: NEWNYM on Tor's control port, over a TCP connection of our own (what
 * tor-change-exitnode.sh does with nc). Host, port and password default to the script's: TORHOST (127.0.0.1),
 * CTRLPORT (9051) and CTRLPASS (empty). A Tor set up with cookie authentication refuses the empty password.
 *
 * @throws {Error} when the control port does not answer, the password is refused or Tor says no
 */
export async function newExit({ host = getenv('TORHOST') || '127.0.0.1', port = +(getenv('CTRLPORT') || 9051), password = getenv('CTRLPASS') ?? '', timeoutMs = 8000 } = {}) {
  let buf = '';
  let wake = null;

  const sock = await TCPSocket.connect({
    hostname: host,
    port,
    socket: {
      data: (_s, d) => {
        buf += typeof d === 'string' ? d : toString(d);
        wake?.();
      },
      close: () => wake?.(),
    },
  }).catch(e => {
    throw new Error(`Tor control port ${host}:${port} does not answer (${e.message})`);
  });

  /* the next final reply line, "250 OK" or "515 Authentication failed: ..." (a "250-" line is not the end) */
  const reply = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Tor control port ${host}:${port} did not answer in ${timeoutMs / 1000}s`)), timeoutMs);
      const check = () => {
        const m = /^(\d{3}) ([^\r\n]*)\r?\n/m.exec(buf);
        if(!m) return false;

        buf = buf.slice(m.index + m[0].length);
        clearTimeout(timer);
        wake = null;
        resolve({ code: +m[1], text: m[2] });
        return true;
      };

      if(!check()) wake = () => check();
    });

  const command = async (line, what) => {
    sock.write(`${line}\r\n`);
    const r = await reply();
    if(r.code !== 250) throw new Error(`Tor control port refused ${what}: ${r.code} ${r.text}`);
  };

  try {
    await command(`AUTHENTICATE "${password.replace(/["\\]/g, '\\$&')}"`, 'the password');
    await command('SIGNAL NEWNYM', 'NEWNYM');
    sock.write('QUIT\r\n');
  } finally {
    sock.close();
  }
}
