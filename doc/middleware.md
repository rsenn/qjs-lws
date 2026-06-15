# Middleware (`lib/lws/app.js`)

An express-style `(req, res, next)` chain on top of qjs-lws. Pure JS —
no C-side changes needed.

## Hello world

```js
import { App } from './lib/lws/app.js';
import { json, urlencoded, cors, logger, secure, cookies } from './lib/lws/middleware.js';

const app = new App();

app.use(logger());
app.use(secure());
app.use(cors({ origin: '*' }));
app.use(json({ limit: 1 << 16 }));
app.use(urlencoded());
app.use(cookies());

app.get('/',                  (req, res) => res.send('hello'));
app.get('/users/:id',         (req, res) => res.json({ id: req.params.id }));
app.post('/echo',             (req, res) => res.json({ you_sent: req.body }));
app.get('/admin/*',  requireAuth, (req, res) => res.send('admin only'));

// Sub-router (the API surface is the same — Router is just an App).
import { Router } from './lib/lws/app.js';
const api = new Router();
api.get('/health', (req, res) => res.json({ ok: true }));
app.use('/api', api);

// Default 404 if no route matched — the chain emits it for you.
app.use((req, res) => res.status(404).type('text/plain').end('Not Found'));

// Centralised error handler (4-arg signature).
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen({ port: 8080, vhostName: 'localhost' });
```

## How a handler runs

```js
(req, res, next) => {              // normal middleware
  req.requestId = uuid();
  await next();                     // continue down the chain
  console.log('after', res.statusCode);
}
```

```js
(err, req, res, next) => {         // error middleware (4 args)
  // err is thrown / propagated from a prior handler
}
```

- Throwing inside a handler is equivalent to `next(err)`.
- A handler that responds (`res.json(...)`, `res.send(...)`, `res.end()`)
  and doesn't call `next()` ends the chain.
- A handler that does nothing falls through to the next layer.
- If the stack drains without a response, the chain emits a 404.
- If the stack drains with an unhandled error, the chain emits a 500.

## The request object

```js
req.method        // 'GET' | 'POST' | …
req.url           // original URL with query string
req.originalUrl   // never modified by sub-routers (req.path is)
req.path          // /users/42                 — modified inside Router mounts
req.params        // { id: '42' }              — populated by the matcher
req.query         // { q: 'hello', limit: 5 }  — parsed lazily on first access
req.headers       // { 'content-type': ..., ... } — lowercased
req.cookies       // { sid: 'abc' }            — parsed lazily on first access
req.body          // populated by json() / urlencoded() / raw() / text()
req.rawBody       // populated when readBody() has been awaited
req.wsi           // raw LWSSocket — escape hatch
```

Body helpers (await one of these from your own middleware):

```js
await req.readText(limit?);   // → string
await req.readJson(limit?);   // → parsed JSON
await req.readBody(limit?);   // → ArrayBuffer
```

All three reject with a Payload-Too-Large error once the accumulated
chunks exceed `limit` (default 1 MiB).

## The response object

```js
res.status(code)                  // chainable
res.statusCode                    // number — set, read whenever
res.set(name, value)              // chainable
res.append(name, value)           // chainable (for Set-Cookie etc.)
res.removeHeader(name)
res.getHeader(name)
res.type(mimeType)                // shortcut for set('content-type', …)

res.cookie(name, value, opts?)    // Set-Cookie with maxAge / domain / path /
                                   //   expires / httpOnly / secure / sameSite
res.clearCookie(name, opts?)

res.redirect(url)                 // 302
res.redirect(301, url)            // explicit status

res.json(value)                   // JSON.stringify + content-type
res.send(body)                    // auto content-type for strings/buffers/objects
res.write(chunk)                  // streaming — flushes headers on first call
res.end(lastChunk?)               // finalise

res.headersSent                   // true once res.write / res.end / res.send fired
res.sent                          // true once res.end / res.send completed
res.headers                       // the Headers instance — passes through to wsi.respond
```

Headers and status are **buffered until the first flush**. You can
chain `.set()` / `.cookie()` calls freely up to `res.end()`. After that,
mutating headers throws.

## Built-in middleware

| Factory | Purpose |
|---|---|
| `json({ limit, type, strict })`         | Parse JSON body into `req.body` |
| `urlencoded({ limit, type })`           | Parse `application/x-www-form-urlencoded` |
| `raw({ limit, type })`                  | Buffer body as `ArrayBuffer` |
| `text({ limit, type })`                 | Buffer body as text |
| `cookies()`                             | No-op compat shim; `req.cookies` is lazy already |
| `cors({ origin, methods, allowedHeaders, exposedHeaders, credentials, maxAge })` | CORS preflight + headers |
| `logger('tiny' \| 'common' \| fn)`     | Request log line per response |
| `secure({ …overrides })`                | Helmet-style baseline of security headers |

For multipart bodies use `LWSSPA` directly inside your handler — see
[`LWSSPA.md`](LWSSPA.md). Doing it here would mean shipping a second
parser that competes with the C one.

## Mounting sub-routers

```js
const api = new Router();
api.get('/users', listUsers);
api.post('/users', createUser);

app.use('/v1/api', api);     // /v1/api/users etc.
```

The mount prefix is stripped from `req.path` inside the router and
restored on the way out, so nested matchers see relative paths.

## Sessions (`lib/lws/session.js`)

```js
import { session, MemoryStore } from './lib/lws/session.js';

app.use(session({
  store:   new MemoryStore(),
  name:    'sid',
  cookie:  { maxAge: 86_400_000, httpOnly: true, sameSite: 'Lax', path: '/' },
  resave:           false,
  saveUninitialized: false,
  rolling:          true,
}));

app.post('/login',  (req, res) => { req.session.user = { id: 1 }; res.json({ ok: true }); });
app.get ('/me',     (req, res) => req.session.user ? res.json(req.session.user) : res.status(401).end());
app.post('/logout', async (req, res) => { await req.session.destroy(); res.json({ ok: true }); });
```

The `req.session` API is a plain object with non-enumerable helper
methods attached:

| Member | Description |
|---|---|
| `req.session.<key>`     | Read/write user data. Stored under the session ID. |
| `req.sessionID`         | Current session ID (read-only) |
| `req.session.save()`    | Force a save even if nothing was touched |
| `req.session.touch()`   | Extend store TTL without rewriting the value |
| `req.session.destroy()` | Remove from store + emit a `Set-Cookie` that clears the cookie |
| `req.session.regenerate()` | New SID, data preserved — use after login to defeat session-fixation |

### Pluggable store

Implement four methods to drop in Redis / SQLite / LMDB:

```js
class MyStore {
  async get(sid)              { /* return data or null */ }
  async set(sid, data, ttlMs) { /* upsert */ }
  async destroy(sid)          { /* remove */ }
  async touch(sid, ttlMs)     { /* extend expiry; no-op acceptable */ }
}
```

`MemoryStore` ships in the same module: lazy expiration on `get()` and
a `sweep()` for periodic GC.

### Crypto-grade random IDs

The default `genId` calls `LWSContext.getRandom()` (libwebsockets's
CSPRNG) — that's reachable because `App.listen()` records the context
on `app.context` and `req.app = app` is set on every request. If you
dispatch by hand without going through `listen`, pass `genId` yourself
or attach an `app.context = { getRandom(buf) {…} }` shim. Without
either, the middleware falls back to `Math.random()` and prints a
one-time stderr warning.

### Rolling cookies + `regenerate`

When `rolling: true` (default), every request refreshes the cookie's
`Max-Age` so the session stays alive while the user is active.
`regenerate()` also writes a fresh `Set-Cookie`, so a `POST /rotate`
response carries **two** `Set-Cookie` lines — the rolling refresh of
the old SID and the new one. HTTP says last-write-wins; every browser
implementation keeps the second.

## What's NOT here (yet)

- **Compression**: requires either streaming gzip in JS (slow) or a
  C-side wrapper over libwebsockets's deflate. Open question.
- **Rate limiting**: pure JS, ~20 lines, no library decision needed.
- **CSRF**: pure JS now that sessions exist; default-deny strategy on
  state-changing methods, token in `req.session._csrf`.

## Architecture notes

- `LWSContext` is created inside `App.listen()` with a single mount
  routing `/` to a hidden `__app` protocol whose `onHttp`,
  `onHttpBody`, `onHttpBodyCompletion` callbacks pipe each request into
  the chain. Pass `protocols: [...]` / `mounts: [...]` to `listen` to
  add WebSocket protocols or static-file mounts beside the app.
- Each request gets a fresh `ServerRequest` / `ServerResponse` pair.
  Per-connection state lives on the wsi's `this` from C-side as usual;
  per-request state goes on the `req` object.
- The body stream is buffered into memory. For huge uploads use
  `LWSSPA` (multipart) or read incrementally via your own
  `onHttpBody` in a co-mounted protocol.
