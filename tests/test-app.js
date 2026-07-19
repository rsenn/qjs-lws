/**
 * Exercises lib/lws/app.js - compilePath()'s path-matching rules directly
 * (no network), then App/Router routing, middleware chaining, error
 * handling and sub-router mounting end-to-end through a single real HTTP
 * server (App.listen()) hit with real fetch() requests.
 */
import { tests, eq, assert, assertStrictEquals, fail } from './unittests/tinytest.js';
import { freePort } from './unittests/subprocess-utils.js';
import { compilePath, App, Router } from '../lib/lws/app.js';
import { fetch as rawFetch } from '../lib/fetch.js';
import * as std from 'std';

/* ------------------------------------------------------------------ *
 * one shared app + server, covering routing/middleware/errors/mounting
 * ------------------------------------------------------------------ */

/* ServerResponse (lib/lws/response.js) answers every request with
   Connection: close - there's no keep-alive to reuse - so keepAlive:false
   here just matches reality instead of leaving fetch() try (and fail) to
   pipeline a second request onto a connection the server already closed. */
const fetch = (url, opts = {}) => rawFetch(url, { keepAlive: false, ...opts });

const port = freePort();
const base = `http://localhost:${port}`;
const app = new App();

/* global middleware - runs for every request, tags the response. Must be
   registered before the routes it should apply to: dispatch() runs layers
   in registration order and stops at the first one that doesn't call
   next(), so a use() registered *after* a terminal route would never run
   for requests that route already answered - same as Express. */
app.use((req, res, next) => {
  res.set('x-global-mw', '1');
  next();
});

/* path-scoped middleware - only for requests under /scoped */
app.use('/scoped', (req, res, next) => {
  res.set('x-scoped-mw', '1');
  next();
});
app.get('/scoped/inside', (req, res) => res.send('inside'));
app.get('/outside', (req, res) => res.send('outside'));

app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));
app.get('/users/:id/:action', (req, res) => res.json({ id: req.params.id, action: req.params.action }));
app.get('/search', (req, res) => res.json({ q: req.query.q ?? null, tag: req.query.tag ?? null }));
app.get('/assets/*', (req, res) => res.type('text/plain').send('asset:' + req.path));

app.get(
  '/multi',
  (req, res, next) => {
    req.a = 1;
    next();
  },
  (req, res, next) => {
    req.b = 2;
    next();
  },
  (req, res) => res.json({ a: req.a, b: req.b }),
);

app.post('/echo-method', (req, res) => res.json({ method: req.method, path: req.path }));

app.all('/any', (req, res) => res.json({ method: req.method }));

/* thrown error -> caught by the error middleware registered below */
app.get('/boom', () => {
  throw new Error('kaboom-top');
});

/* error middleware must be registered after the routes it should catch */
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

/* sub-router: no error middleware of its own -> falls back to the
   framework's default 500, independent of the parent's error middleware
   above (a thrown error inside a mounted Router is caught by that
   Router's own dispatch(), which never propagates it up to the parent). */
const api = new Router();
api.get('/profile', (req, res) => res.json({ mounted: true, path: req.path }));
api.get('/fallthrough', (req, res, next) => next());
api.get('/boom', () => {
  throw new Error('kaboom-sub');
});
app.use('/api', api);
app.get('/api/fallthrough', (req, res) => res.send('parent handled it'));

/* sub-router WITH its own error middleware - independent of both the
   parent's error middleware and the sibling sub-router's default 500. */
const api2 = new Router();
api2.get('/boom', () => {
  throw new Error('kaboom-sub2');
});
api2.use((err, req, res, next) => res.status(599).json({ apiError: err.message }));
app.use('/api2', api2);

const ctx = app.listen({ port });

await tests({
  /* -------------------------------------------------------------- *
   * compilePath() - pure path-matching logic, no network
   * -------------------------------------------------------------- */

  'compilePath: static path matches exactly, with optional trailing slash'() {
    const { regex, keys } = compilePath('/hello');
    eq(0, keys.length);
    assert(regex.test('/hello'), 'expected /hello to match');
    assert(regex.test('/hello/'), 'expected trailing slash to still match');
    assert(!regex.test('/hello/world'), 'expected /hello/world not to match');
    assert(!regex.test('/helloX'), 'expected /helloX not to match');
  },

  'compilePath: "" and "/" both match only the root'() {
    for(const pattern of ['', '/']) {
      const { regex } = compilePath(pattern);
      assert(regex.test('/'), `expected "${pattern}" to match "/"`);
      assert(!regex.test('/x'), `expected "${pattern}" not to match "/x"`);
    }
  },

  'compilePath: :param captures a single path segment'() {
    const { regex, keys } = compilePath('/users/:id');
    eq('id', keys[0]);
    const m = regex.exec('/users/42');
    assert(m, 'expected a match');
    eq('42', m[1]);
    assert(!regex.test('/users/42/extra'), 'a :param must not span a "/"');
  },

  'compilePath: multiple :params are captured in order'() {
    const { regex, keys } = compilePath('/products/:cat/:id');
    eq('cat,id', keys.join(','));
    const m = regex.exec('/products/tools/99');
    eq('tools', m[1]);
    eq('99', m[2]);
  },

  'compilePath: non-identifier characters are stripped from the param name'() {
    // ':id?' is *not* treated as an optional param - the '?' is just
    // stripped from the captured *name*, matching is unaffected (still
    // mandatory, still a plain [^/]+ segment).
    const { regex, keys } = compilePath('/users/:id?');
    eq('id', keys[0]);
    assert(regex.test('/users/42'), 'expected the segment to still match like a normal :param');
  },

  'compilePath: trailing "*" captures the rest of the path (uncaptured)'() {
    const { regex, keys } = compilePath('/files/*');
    eq(0, keys.length);
    assert(regex.test('/files/a/b/c.txt'), 'expected a nested path to match');
    assert(regex.test('/files/'), 'expected the bare mount point (with slash) to match');
    assert(!regex.test('/files'), 'expected the mount point without a trailing slash NOT to match');
  },

  'compilePath: bare "*" matches anything'() {
    const { regex, keys } = compilePath('*');
    eq(0, keys.length);
    assert(regex.test('/anything/at/all'));
    assert(regex.test(''));
  },

  'compilePath: end=false anchors at a "/" boundary (mount prefix)'() {
    const { regex } = compilePath('/api', false);
    assert(regex.test('/api'), 'expected the bare prefix to match');
    assert(regex.test('/api/users'), 'expected a nested path to match');
    assert(!regex.test('/apiextra'), 'expected a same-prefix-but-different segment NOT to match');
  },

  'compilePath: "/" with end=false matches any path (root mount)'() {
    const { regex } = compilePath('/', false);
    assert(regex.test('/anything'));
  },

  'compilePath: regex metacharacters in a literal segment are escaped'() {
    const { regex } = compilePath('/a.b+c');
    assert(regex.test('/a.b+c'), 'expected the literal path to match');
    assert(!regex.test('/aXb+c'), 'expected "." to be treated literally, not as a wildcard');
    assert(!regex.test('/a.bbbc'), 'expected "+" to be treated literally, not as a quantifier');
  },

  /* -------------------------------------------------------------- *
   * routing
   * -------------------------------------------------------------- */

  async 'App: :param route populates req.params, decoded'() {
    const res = await fetch(`${base}/users/hello%20world`);
    eq(200, res.status);
    eq('hello world', (await res.json()).id);
  },

  async 'App: multiple :param segments are all populated'() {
    const res = await fetch(`${base}/users/7/promote`);
    const body = await res.json();
    eq('7', body.id);
    eq('promote', body.action);
  },

  async 'App: query string is parsed onto req.query, repeats become arrays'() {
    const res = await fetch(`${base}/search?q=widgets&tag=a&tag=b`);
    const body = await res.json();
    eq('widgets', body.q);
    eq('a,b', body.tag.join(','));
  },

  async 'App: wildcard route matches nested paths'() {
    const res = await fetch(`${base}/assets/js/app.js`);
    eq('asset:/assets/js/app.js', await res.text());
  },

  async 'App: a route only matches its declared HTTP method'() {
    const getRes = await fetch(`${base}/users/1`);
    eq(200, getRes.status);
    const postRes = await fetch(`${base}/users/1`, { method: 'POST', body: 'x' });
    eq(404, postRes.status);
  },

  async 'App: multiple handlers on one route run in order via next()'() {
    const res = await fetch(`${base}/multi`);
    const body = await res.json();
    eq(1, body.a);
    eq(2, body.b);
  },

  async 'App: app.post() only matches POST'() {
    const res = await fetch(`${base}/echo-method`, { method: 'POST', body: 'x' });
    const body = await res.json();
    eq('POST', body.method);
    eq('/echo-method', body.path);
  },

  async 'App: app.all() matches every HTTP method'() {
    for(const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const res = await fetch(`${base}/any`, method === 'GET' ? {} : { method, body: method === 'GET' ? undefined : 'x' });
      eq(method, (await res.json()).method);
    }
  },

  async 'App: unmatched route yields a 404'() {
    const res = await fetch(`${base}/does-not-exist`);
    eq(404, res.status);
  },

  /* -------------------------------------------------------------- *
   * middleware chaining / scoping
   * -------------------------------------------------------------- */

  async 'App: app.use() with no path applies to every request'() {
    const res = await fetch(`${base}/users/1`);
    eq('1', res.headers.get('x-global-mw'));
  },

  async 'App: app.use(path, mw) only applies under that path prefix'() {
    const inside = await fetch(`${base}/scoped/inside`);
    eq('1', inside.headers.get('x-scoped-mw'));

    const outside = await fetch(`${base}/outside`);
    eq(null, outside.headers.get('x-scoped-mw'));
    // global middleware still applies outside the scoped prefix
    eq('1', outside.headers.get('x-global-mw'));
  },

  /* -------------------------------------------------------------- *
   * error handling
   * -------------------------------------------------------------- */

  async 'App: a thrown error is routed to the error-handling (4-arg) middleware'() {
    const res = await fetch(`${base}/boom`);
    eq(500, res.status);
    eq('kaboom-top', (await res.json()).error);
  },

  /* -------------------------------------------------------------- *
   * sub-router mounting (app.use(path, subApp))
   * -------------------------------------------------------------- */

  async 'App: a mounted sub-router sees a path stripped of its mount prefix'() {
    const res = await fetch(`${base}/api/profile`);
    const body = await res.json();
    eq(true, body.mounted);
    eq('/profile', body.path);
  },

  async "App: a sub-router route that calls next() without responding falls through to the parent's next handler"() {
    const res = await fetch(`${base}/api/fallthrough`);
    eq(200, res.status);
    eq('parent handled it', await res.text());
  },

  async "App: an error thrown inside a sub-router with no error middleware of its own gets that sub-router's default 500, not the parent's error middleware"() {
    const res = await fetch(`${base}/api/boom`);
    eq(500, res.status);
    eq('text/plain', res.headers.get('content-type').split(';')[0]);
    const text = await res.text();
    assert(text.length > 0, 'expected a non-empty default 500 body');
    // the parent's JSON error middleware never ran - a JSON error body would
    // have been `{"error":"..."}`, not the framework's own plain-text default.
    assert(!/^\{/.test(text), 'expected the plain-text default 500, not the parent JSON error handler, got: ' + text);
  },

  async "App: a sub-router's own error middleware handles its own errors independently"() {
    const res = await fetch(`${base}/api2/boom`);
    eq(599, res.status);
    eq('kaboom-sub2', (await res.json()).apiError);
  },
});

ctx.destroy();

/* Each keepAlive:false fetch() call above created (and never destroyed -
   fetch() doesn't expose it) its own one-off LWSContext; the event loop
   would otherwise never fully drain. Mirrors the same std.exit(0) used by
   tests/unittests/test-websocket(stream).js for their own leaked-context
   reason. */
std.exit(0);
