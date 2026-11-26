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
export const IP_KINDS = new Set(['ip', 'rpm', 'tpm', 'rpd', 'cooldown', 'exhausted']);

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

/**
 * whether every keyless provider is exhausted: each enabled keyless key's platform has models and all of them are blocked
 * by a limit a new IP address can lift. One provider that still has a usable model, or no keyless key at all, is not it.
 *
 * @returns {{keys: {id: number, platform: string, routed: boolean}[], platforms: string[]}|null}
 */
export function keylessExhausted(keys, av, proxyUrl = ANON_PROXY) {
  const mine = (keys ?? []).filter(k => k.keyless && k.enabled);
  const platforms = [...new Set(mine.map(k => k.platform))];
  if(!platforms.length) return null;

  for(const p of platforms) {
    const models = [...(av?.byModel ?? [])].filter(([, e]) => e.platforms?.includes(p));
    if(!models.length || !models.every(([, e]) => e.blocked && e.kinds?.some(x => IP_KINDS.has(x)))) return null;
  }

  return { keys: mine.map(k => ({ id: k.id, platform: k.platform, routed: !!k.maskedProxyUrl && hostPort(k.maskedProxyUrl) === hostPort(proxyUrl) })), platforms };
}

/** every key that is routed through `proxyUrl` now, keyless or not (to take them off it again) */
export function routedAll(keys, proxyUrl = ANON_PROXY) {
  return (keys ?? []).filter(k => k.maskedProxyUrl && hostPort(k.maskedProxyUrl) === hostPort(proxyUrl));
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

/**
 * the keys that go through the anonymizing proxy by themselves, and have no proxy yet: every enabled keyless key (its
 * quotas are counted per IP address), and every enabled key of a provider that has several enabled keys, but only while
 * a model of that provider is limited per IP address (a second address helps then). A keyed provider that is not IP-limited
 * goes direct: the proxy only adds latency. A key that is sent through some proxy already, or whose provider is, is left alone.
 *
 * @returns {{id: number, platform: string, label: string, why: 'keyless'|'multi-key'}[]}
 */
export function ipProxyTargets(keys, av, proxyUrl = ANON_PROXY, isProxied = () => false) {
  const count = new Map();
  for(const k of keys ?? []) if(k.enabled && !k.keyless) count.set(k.platform, (count.get(k.platform) ?? 0) + 1);
  const limited = ipLimitedPlatforms(av);

  const out = [];
  for(const k of keys ?? []) {
    if(!k.enabled || k.maskedProxyUrl || isProxied(k.platform)) continue;
    if(k.keyless) out.push({ id: k.id, platform: k.platform, label: k.label ?? '', why: 'keyless' });
    else if(count.get(k.platform) > 1 && limited.has(k.platform)) out.push({ id: k.id, platform: k.platform, label: k.label ?? '', why: 'multi-key' });
  }

  return out;
}

/** how long a keyed provider's keys stay on the proxy after its last IP limit */
export const RELEASE_AFTER_MS = 30 * 60e3;

/**
 * the keyed keys of a provider with several keys that go through `proxyUrl` although the provider has not been limited per IP
 * address for RELEASE_AFTER_MS: they go direct again. `limitedAt` maps a platform to when it was last seen IP-limited
 * (absent: not in this session, so the keys the old policy put on the proxy are released at once).
 *
 * @returns {{id: number, platform: string, label: string}[]}
 */
export function ipProxyReleases(keys, av, proxyUrl = ANON_PROXY, limitedAt = new Map(), now = Date.now()) {
  const count = new Map();
  for(const k of keys ?? []) if(k.enabled && !k.keyless) count.set(k.platform, (count.get(k.platform) ?? 0) + 1);
  const limited = ipLimitedPlatforms(av);

  return routedAll(keys, proxyUrl)
    .filter(k => k.enabled && !k.keyless && count.get(k.platform) > 1 && !limited.has(k.platform) && now - (limitedAt.get(k.platform) ?? 0) >= RELEASE_AFTER_MS)
    .map(k => ({ id: k.id, platform: k.platform, label: k.label ?? '' }));
}

/** the platforms whose models are all blocked by a limit a new IP address can lift (exhausted, as far as an address goes) */
export function exhaustedPlatforms(av) {
  const by = new Map();

  for(const [, e] of av?.byModel ?? [])
    for(const p of e.platforms ?? []) {
      const x = by.get(p) ?? { n: 0, bad: 0 };
      x.n++;
      if(e.blocked && e.kinds?.some(k => IP_KINDS.has(k))) x.bad++;
      by.set(p, x);
    }

  return new Set([...by].filter(([, x]) => x.bad === x.n).map(([p]) => p));
}

/** the platforms that have a model limited as an IP matter now */
export function ipLimitedPlatforms(av) {
  const out = new Set();
  for(const [, e] of av?.byModel ?? []) if(e.blocked && e.kinds?.includes('ip')) for(const p of e.platforms ?? []) out.add(p);
  return out;
}
