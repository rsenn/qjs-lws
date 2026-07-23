/** Simple TTL cache for RRsets, keyed by "TYPE:name". Expiry is lazy - checked on get(), never swept proactively. */
export class Cache {
  #map = new Map();

  get(key) {
    const entry = this.#map.get(key);
    if(!entry)
      return null;

    const remaining = Math.floor((entry.expiresAt - Date.now()) / 1000);

    if(remaining <= 0) {
      this.#map.delete(key);
      return null;
    }

    /* Hand back copies with ttl adjusted to what's actually left, not the
       original TTL from whenever this was cached. */
    return entry.rrs.map(rr => ({ ...rr, ttl: remaining }));
  }

  set(key, rrs, ttlSeconds) {
    if(!rrs.length || ttlSeconds <= 0)
      return;

    this.#map.set(key, { rrs, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  get size() {
    return this.#map.size;
  }
}
