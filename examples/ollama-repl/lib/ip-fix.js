/**
 * ip-fix: the keyless providers of a freellmapi gateway that are limited per IP address and could work again
 * through another one, and the per-key proxy that sends them through the anonymizing SOCKS proxy (Tor / anon,
 * its exit address changed by NEWNYM on the control port, /proxy exit).
 *
 * ```js
 * const rows = ipCandidates(keys, av);                  // the keyless keys whose models are limited right now
 * await setKeyProxy(gateway, rows.map(r => r.id), 'socks5h://127.0.0.1:9050');
 * await setKeyProxy(gateway, ids, '');                  // back to no proxy of its own
 * ```
 *
 * A keyless key is the anonymous sentinel row of a provider that works without an account (Kilo, OVH, AI Horde,
 * ...): its quotas are counted per IP address. Such a provider counts as limited by IP when its models are blocked
 * by a window, a cooldown, exhaustion or the errors that name the address - not by credits, tier or key state,
 * which another address does not change.
 */

/** the default SOCKS proxy: socks5h lets the proxy resolve host names, nothing leaks to the local resolver */
export const ANON_PROXY = 'socks5h://127.0.0.1:9050';

/** the kinds of limit (lib/availability.js) a new IP address can lift */
const IP_KINDS = new Set(['ip', 'rpm', 'tpm', 'rpd', 'cooldown', 'exhausted']);

const hostPort = url => /^[a-z0-9+.-]+:\/\/(?:[^@/]*@)?([^/]+)/i.exec(String(url ?? ''))?.[1] ?? '';

/**
 * @param {object[]} keys  GET /api/keys
 * @param {{byModel: Map<string, object>}} av  loadAvailability() result
 * @param {string} [proxyUrl]  the proxy a key is sent through, to tell which already are
 * @returns {{id: number, platform: string, label: string, blocked: number, limitedIds: string[], total: number, kinds: string[], until: number|null, via: string, routed: boolean}[]}
 *   the keyless keys with limited models, the most limited first
 */
export function ipCandidates(keys, av, proxyUrl = ANON_PROXY) {
  const rows = [];

  for(const k of keys ?? []) {
    if(!k.keyless || !k.enabled) continue;

    const models = [...(av?.byModel ?? [])].filter(([, e]) => e.platforms?.includes(k.platform));
    const limited = models.filter(([, e]) => e.blocked && e.kinds?.some(x => IP_KINDS.has(x)));
    if(!limited.length) continue;

    const untils = limited.map(([, e]) => e.until).filter(u => u != null);
    rows.push({
      id: k.id,
      platform: k.platform,
      label: k.label ?? '',
      blocked: limited.length,
      limitedIds: limited.map(([id]) => id),
      total: models.length,
      kinds: [...new Set(limited.flatMap(([, e]) => e.kinds.filter(x => IP_KINDS.has(x))))],
      until: untils.length ? Math.min(...untils) : null,
      via: k.maskedProxyUrl ?? '',
      routed: !!k.maskedProxyUrl && hostPort(k.maskedProxyUrl) === hostPort(proxyUrl),
    });
  }

  return rows.sort((a, b) => b.blocked / b.total - a.blocked / a.total || a.platform.localeCompare(b.platform));
}

/** the keyless keys that are routed through `proxyUrl` now (to take them off it again) */
export function routedKeys(keys, proxyUrl = ANON_PROXY) {
  return (keys ?? []).filter(k => k.keyless && k.maskedProxyUrl && hostPort(k.maskedProxyUrl) === hostPort(proxyUrl));
}

/**
 * sets (or with '' clears) the proxy of own of keys: PATCH /api/keys/:id {proxyUrl}
 *
 * @returns {Promise<{id: number, ok: boolean, error?: string}[]>}
 */
export async function setKeyProxy(gateway, ids, proxyUrl) {
  const out = [];

  for(const id of ids) {
    try {
      await gateway.api(`/api/keys/${id}`, { method: 'PATCH', body: { proxyUrl } });
      out.push({ id, ok: true });
    } catch(e) {
      out.push({ id, ok: false, error: (e.detail ?? e.message ?? String(e)).split('\n')[0].slice(0, 100) });
    }
  }

  return out;
}

/** lets the keys' cooldowns go (DELETE /api/keys/:id/cooldowns), so the next request tries them at once */
export async function clearCooldowns(gateway, ids) {
  const out = [];

  for(const id of ids) {
    try {
      await gateway.api(`/api/keys/${id}/cooldowns`, { method: 'DELETE' });
      out.push({ id, ok: true });
    } catch(e) {
      out.push({ id, ok: false, error: (e.detail ?? e.message ?? String(e)).split('\n')[0].slice(0, 100) });
    }
  }

  return out;
}
