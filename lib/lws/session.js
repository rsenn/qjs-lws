/**
 * Server-side session middleware compatible with the App / Router from
 * app.js. Pluggable store (memory by default), opaque random session ID
 * stored in an HttpOnly cookie, automatic save-on-response.
 *
 * Usage:
 *
 *   import { session, MemoryStore } from './lib/lws/session.js';
 *
 *   const store = new MemoryStore();
 *   app.use(session({ store, cookie: { maxAge: 3600_000, secure: true } }));
 *
 *   app.post('/login', (req, res) => {
 *     req.session.user = { id: 1, name: 'roman' };
 *     res.json({ ok: true });
 *   });
 *
 *   app.get('/me', (req, res) => {
 *     if(!req.session.user) return res.status(401).end();
 *     res.json(req.session.user);
 *   });
 *
 *   app.post('/logout', async (req, res) => {
 *     await req.session.destroy();
 *     res.json({ ok: true });
 *   });
 */

/* ---------------------------------------------------------------- *
 * In-memory store. Implements the Store contract:
 *
 *   async get(sid)            → data | null
 *   async set(sid, data, ttl) → void
 *   async destroy(sid)        → void
 *   async touch(sid, ttl)     → void   (extend expiry without rewriting)
 *
 * Drop in a Redis / SQLite / LMDB store later — the middleware only
 * relies on this surface.
 * ---------------------------------------------------------------- */

export class MemoryStore {
  #map = new Map();

  /* Lazy expiration on get(). Call sweep() periodically to reclaim
     memory held by sessions that nobody asked about. */
  async get(sid) {
    const entry = this.#map.get(sid);

    if(!entry) return null;

    if(entry.expires <= Date.now()) {
      this.#map.delete(sid);
      return null;
    }

    return entry.data;
  }

  async set(sid, data, ttlMs) {
    this.#map.set(sid, { data, expires: Date.now() + ttlMs });
  }

  async destroy(sid) {
    this.#map.delete(sid);
  }

  async touch(sid, ttlMs) {
    const entry = this.#map.get(sid);
    if(entry) entry.expires = Date.now() + ttlMs;
  }

  /** Drop every expired session. Returns number reclaimed. */
  sweep() {
    const now = Date.now();
    let n = 0;
    for(const [sid, entry] of this.#map)
      if(entry.expires <= now) {
        this.#map.delete(sid);
        n++;
      }
    return n;
  }

  /** Total entries currently held (including expired ones not yet swept). */
  get size() {
    return this.#map.size;
  }
}

/* ---------------------------------------------------------------- *
 * Random ID generation
 * ---------------------------------------------------------------- */

function bytesToHex(u8) {
  let hex = '';
  for(let i = 0; i < u8.length; i++) hex += u8[i].toString(16).padStart(2, '0');
  return hex;
}

let _warnedNoCsprng = false;

/**
 * Generate `n` random bytes as hex. Uses libwebsockets's `getRandom()`
 * (CSPRNG) when an `LWSContext` is reachable from the request — that's
 * the case whenever the middleware runs inside `App.listen()`.
 *
 * Falls back to `Math.random()` with a one-time stderr warning if no
 * CSPRNG is available. **Don't run a real auth flow on the fallback.**
 */
export function defaultGenId(n = 16, ctx) {
  if(ctx && typeof ctx.getRandom === 'function') {
    const buf = new ArrayBuffer(n);
    ctx.getRandom(buf);
    return bytesToHex(new Uint8Array(buf));
  }

  if(!_warnedNoCsprng) {
    _warnedNoCsprng = true;
    console.warn('[session] no LWSContext.getRandom() available — falling back to Math.random(). Do not use this in production.');
  }

  const u = new Uint8Array(n);
  for(let i = 0; i < n; i++) u[i] = (Math.random() * 256) & 0xff;
  return bytesToHex(u);
}

/* ---------------------------------------------------------------- *
 * The middleware
 * ---------------------------------------------------------------- */

/**
 * Build the session middleware.
 *
 * @param {object} [opts]
 *   - name:               cookie name (default 'sid')
 *   - store:              Store instance (default new MemoryStore())
 *   - cookie:             cookie attributes — `{ maxAge (ms), httpOnly,
 *                          secure, sameSite, path, domain }`. `maxAge` is
 *                          also used as the store TTL. Default 1 day,
 *                          HttpOnly, SameSite=Lax, Path=/.
 *   - genId:              fn(req) → string. Custom ID generator.
 *   - resave:             save back even if nothing changed (default false)
 *   - saveUninitialized:  save a freshly created empty session (default false)
 *   - rolling:            refresh cookie + extend TTL on every request
 *                          (default true)
 */
export function session(opts = {}) {
  const name = opts.name ?? 'sid';
  const store = opts.store ?? new MemoryStore();
  const ttlMs = opts.cookie?.maxAge ?? 86_400_000; /* 1 day */
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    ...opts.cookie,
    maxAge: Math.floor(ttlMs / 1000),
  };
  const genId = opts.genId ?? (req => defaultGenId(16, req.app?.context));
  const resave = opts.resave === true;
  const saveUninitialized = opts.saveUninitialized === true;
  const rolling = opts.rolling !== false;

  return async function sessionMiddleware(req, res, next) {
    let sid = req.cookies?.[name];
    let data = null;
    let isNew = false;

    if(sid) {
      try {
        const fetched = await store.get(sid);
        /* Shallow-copy out of the store so per-request mutations don't
           leak back into shared state (matters for in-process stores
           like MemoryStore that hand back live references). */
        if(fetched) data = snapshotKeys(fetched);
      } catch {}
    }

    if(!data) {
      sid = await genId(req);
      data = Object.setPrototypeOf({}, null);
      isNew = true;
    }

    let destroyed = false;
    const initialSnapshot = JSON.stringify(data);

    /* Install non-enumerable methods. Configurable + writable so a
       second request that loads the same session object can redefine
       them without TypeError. */
    const def = (key, value) => Object.defineProperty(data, key, { value, configurable: true, writable: true, enumerable: false });

    def('destroy', async () => {
      destroyed = true;
      try {
        await store.destroy(sid);
      } catch {}
      for(const k of Object.keys(data)) delete data[k];
      if(!res.headersSent) res.clearCookie(name, { path: cookieOpts.path, domain: cookieOpts.domain });
    });

    def('save', async () => {
      await store.set(sid, snapshotKeys(data), ttlMs);
    });

    def('touch', async () => {
      await store.touch(sid, ttlMs);
    });

    /* regenerate carries data over to the new sid — useful for the
       common post-login fixation-prevention pattern. Call destroy()
       first if you want a fresh empty session. */
    def('regenerate', async () => {
      const preserved = snapshotKeys(data);
      try {
        await store.destroy(sid);
      } catch {}
      sid = await genId(req);
      isNew = true;
      req.sessionID = sid;
      if(!res.headersSent) res.cookie(name, sid, cookieOpts);
      try {
        await store.set(sid, preserved, ttlMs);
      } catch {}
    });

    req.sessionID = sid;
    req.session = data;

    /* Eager cookie set — gets baked in before any handler flushes. */
    if(isNew || rolling) res.cookie(name, sid, cookieOpts);

    try {
      await next();
    } finally {
      if(destroyed) return;

      const populated = Object.keys(data).length > 0;
      const changed = JSON.stringify(snapshotKeys(data)) !== initialSnapshot;

      if((isNew && !populated && !saveUninitialized) || (!changed && !resave && !rolling)) return;

      try {
        if(changed || resave || !rolling) await store.set(sid, snapshotKeys(data), ttlMs);
        else await store.touch(sid, ttlMs);
      } catch {}
    }
  };
}

/* Strip the non-enumerable methods we attached so stores see plain data. */
function snapshotKeys(obj) {
  const out = Object.setPrototypeOf({}, null);
  for(const k of Object.keys(obj)) out[k] = obj[k];
  return out;
}
