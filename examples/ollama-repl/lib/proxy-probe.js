/**
 * proxy-probe: the socks proxy freellmapi sends its upstream requests
 * through (here the anon service, tor-based), and what it costs in
 * latency.
 *
 * ```js
 * const p = await proxySettings(gateway);          // { url, active, bypass, keyProxies }
 * proxied(p, 'kilo');                              // true
 * const m = await measure(p.url);                  // direct vs proxied timings
 * await newExit();                                 // tor-change-exitnode.sh
 * ```
 *
 * measure() runs curl to one upstream LLM host, direct and through the
 * proxy, a few times each, and compares the medians. Time to first byte
 * is what a model request feels: TCP and TLS setup plus the upstream's
 * answer, all of it through the proxy's circuit.
 */
import { runCommand } from './run-command.js';

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
  const { output, status } = await runCommand(`curl -s -m 20 --proxy '${proxyUrl.replace(/'/g, '')}' ${EXIT_IP_URL}`, { timeoutMs: 25000 });
  return status === 0 && /^[\d.:a-f]+$/i.test(output.trim()) ? output.trim() : null;
}

/** asks the proxy for a new circuit (tor-change-exitnode.sh, NEWNYM on the control port) */
export async function newExit() {
  const { output, status } = await runCommand('CTRLPASS= tor-change-exitnode.sh', { timeoutMs: 15000 });
  if(status !== 0 || !/250 OK/.test(output)) throw new Error(`tor-change-exitnode.sh failed: ${output.trim().split('\n').pop() ?? status}`);
}
