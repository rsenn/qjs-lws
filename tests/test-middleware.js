/**
 * Exercises every export of lib/lws/middleware.js - json(), urlencoded(),
 * raw(), text(), cookies(), cors(), logger(), secure() - end-to-end through
 * a single real HTTP server (App.listen()) hit with real fetch() requests,
 * one distinct route per scenario.
 */
import { tests, eq, assert, assertStrictEquals, fail } from './unittests/tinytest.js';
import { freePort } from './unittests/subprocess-utils.js';
import { App } from '../lib/lws/app.js';
import { json, urlencoded, raw, text, cookies, cors, logger, secure } from '../lib/lws/middleware.js';
import { fetch as rawFetch } from '../lib/fetch.js';
import * as std from 'std';

/* ServerResponse (lib/lws/response.js) answers every request with
   Connection: close - see tests/test-app.js's equivalent note - so each
   request here gets its own fresh connection rather than asking fetch() to
   (futilely) pipeline onto one the server already closed. */
const fetch = (url, opts = {}) => rawFetch(url, { keepAlive: false, ...opts });

const port = freePort();
const base = `http://localhost:${port}`;
const app = new App();

/* ---- json() ---------------------------------------------------- */

app.use('/json', json());
app.post('/json', (req, res) => res.json({ received: req.body }));

app.use('/json-vendor', json());
app.post('/json-vendor', (req, res) => res.json({ received: req.body }));

app.use('/json-loose', json({ strict: false }));
app.post('/json-loose', (req, res) => res.json({ received: req.body }));

app.use('/json-limit', json({ limit: 8 }));
app.post('/json-limit', (req, res) => res.json({ received: req.body }));

app.use('/json-passthrough', json());
app.post('/json-passthrough', (req, res) => res.json({ bodyUntouched: typeof req.body?.getReader === 'function' }));

/* ---- urlencoded() ------------------------------------------------ */

app.use('/urlencoded', urlencoded());
app.post('/urlencoded', (req, res) => res.json({ received: req.body }));

/* ---- raw() -------------------------------------------------------- */

app.use('/raw', raw());
app.post('/raw', (req, res) => res.json({ length: req.body.byteLength }));

app.use('/raw-limit', raw({ limit: 4 }));
app.post('/raw-limit', (req, res) => res.json({}));

/* ---- text() --------------------------------------------------------- */

app.use('/text', text());
app.post('/text', (req, res) => res.json({ received: req.body }));

app.use('/text-passthrough', text());
app.post('/text-passthrough', (req, res) => res.json({ bodyUntouched: typeof req.body?.getReader === 'function' }));

/* ---- cookies() -------------------------------------------------------- */

app.use('/cookies', cookies());
app.get('/cookies', (req, res) => res.json({ ...req.cookies }));

/* ---- cors() ---------------------------------------------------------- */

app.use('/cors-default', cors());
app.get('/cors-default', (req, res) => res.send('ok'));

app.use('/cors-origin', cors({ origin: 'https://allowed.example' }));
app.get('/cors-origin', (req, res) => res.send('ok'));

app.use('/cors-array', cors({ origin: ['https://a.example', 'https://b.example'] }));
app.get('/cors-array', (req, res) => res.send('ok'));

app.use('/cors-regex', cors({ origin: /\.example$/ }));
app.get('/cors-regex', (req, res) => res.send('ok'));

app.use('/cors-fn', cors({ origin: reqOrigin => reqOrigin === 'https://fn.example' }));
app.get('/cors-fn', (req, res) => res.send('ok'));

app.use('/cors-creds', cors({ origin: 'https://c.example', credentials: true, exposedHeaders: ['x-total-count'], maxAge: 600 }));
app.get('/cors-creds', (req, res) => res.send('ok'));

/* ---- logger() --------------------------------------------------------- */

const captured = [];
app.use('/logger', logger(entry => captured.push(entry)));
app.get('/logger', (req, res) => res.send('logged'));

app.use('/logger-tiny', logger());
app.get('/logger-tiny', (req, res) => res.send('ok'));

/* ---- secure() ---------------------------------------------------------- */

app.use('/secure-default', secure());
app.get('/secure-default', (req, res) => res.send('ok'));

app.use('/secure-override', secure({ 'x-frame-options': 'DENY', 'x-xss-protection': false }));
app.get('/secure-override', (req, res) => res.send('ok'));

app.use('/secure-preset', (req, res, next) => {
  res.set('x-frame-options', 'ALREADY-SET');
  next();
});
app.use('/secure-preset', secure());
app.get('/secure-preset', (req, res) => res.send('ok'));

const ctx = app.listen({ port });

await tests({
  /* -------------------------------------------------------------- *
   * json()
   * -------------------------------------------------------------- */

  async 'json(): parses a valid JSON body onto req.body'() {
    const res = await fetch(`${base}/json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1,"b":[2,3]}' });
    const body = await res.json();
    eq(1, body.received.a);
    eq('2,3', body.received.b.join(','));
  },

  async 'json(): matches "application/vnd.api+json"-style +json content types'() {
    const res = await fetch(`${base}/json-vendor`, { method: 'POST', headers: { 'content-type': 'application/vnd.api+json' }, body: '{"ok":true}' });
    const body = await res.json();
    eq(true, body.received.ok);
  },

  async 'json(): strict mode (default) rejects a body not starting with { or ['() {
    const res = await fetch(`${base}/json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '5' });
    eq(400, res.status);
    assert((await res.text()).includes('strict JSON'), 'expected a strict-JSON error message');
  },

  async 'json({ strict: false }): accepts a bare top-level JSON value'() {
    const res = await fetch(`${base}/json-loose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '5' });
    eq(200, res.status);
    eq(5, (await res.json()).received);
  },

  async 'json(): an empty body sets req.body to null instead of parsing'() {
    const res = await fetch(`${base}/json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '' });
    eq(200, res.status);
    eq(null, (await res.json()).received);
  },

  async 'json(): malformed JSON yields a 400'() {
    const res = await fetch(`${base}/json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not valid' });
    eq(400, res.status);
    assert((await res.text()).includes('Bad JSON'), 'expected a Bad JSON error message');
  },

  async 'json({ limit }): a body over the limit yields a 413'() {
    const res = await fetch(`${base}/json-limit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"abcdefgh":1}' });
    eq(413, res.status);
  },

  async 'json(): a non-matching content-type is passed through untouched'() {
    const res = await fetch(`${base}/json-passthrough`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"a":1}' });
    eq(200, res.status);
    eq(true, (await res.json()).bodyUntouched);
  },

  /* -------------------------------------------------------------- *
   * urlencoded()
   * -------------------------------------------------------------- */

  async 'urlencoded(): parses form fields, repeated keys become arrays'() {
    const res = await fetch(`${base}/urlencoded`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=alice&tag=a&tag=b&city=New%20York',
    });
    const body = (await res.json()).received;
    eq('alice', body.name);
    eq('a,b', body.tag.join(','));
    eq('New York', body.city);
  },

  /* -------------------------------------------------------------- *
   * raw()
   * -------------------------------------------------------------- */

  async 'raw(): buffers the body as an ArrayBuffer regardless of content-type'() {
    const res = await fetch(`${base}/raw`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'hello' });
    eq(5, (await res.json()).length);
  },

  async 'raw({ limit }): a body over the limit yields a 413'() {
    const res = await fetch(`${base}/raw-limit`, { method: 'POST', body: 'hello' });
    eq(413, res.status);
  },

  /* -------------------------------------------------------------- *
   * text()
   * -------------------------------------------------------------- */

  async 'text(): buffers a text/* body as a string'() {
    const res = await fetch(`${base}/text`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'plain text body' });
    eq('plain text body', (await res.json()).received);
  },

  async 'text(): a non-text content-type is passed through untouched'() {
    const res = await fetch(`${base}/text-passthrough`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'x' });
    eq(true, (await res.json()).bodyUntouched);
  },

  /* -------------------------------------------------------------- *
   * cookies()
   * -------------------------------------------------------------- */

  async 'cookies(): req.cookies parses the Cookie header'() {
    const res = await fetch(`${base}/cookies`, { headers: { cookie: 'a=1; b=two' } });
    const body = await res.json();
    eq('1', body.a);
    eq('two', body.b);
  },

  /* -------------------------------------------------------------- *
   * cors()
   * -------------------------------------------------------------- */

  async 'cors(): default origin "*" is reflected and the request still reaches the handler'() {
    const res = await fetch(`${base}/cors-default`, { headers: { origin: 'https://anywhere.example' } });
    eq('*', res.headers.get('access-control-allow-origin'));
    eq('ok', await res.text());
  },

  async 'cors(): a preflight OPTIONS request short-circuits with the configured status'() {
    const res = await fetch(`${base}/cors-default`, {
      method: 'OPTIONS',
      headers: { origin: 'https://anywhere.example', 'access-control-request-method': 'POST' },
    });
    eq(204, res.status);
    assert(res.headers.get('access-control-allow-methods').includes('POST'), 'expected allow-methods to include POST');
  },

  async 'cors({ origin: string }): a matching origin is echoed back exactly'() {
    const res = await fetch(`${base}/cors-origin`, { headers: { origin: 'https://allowed.example' } });
    eq('https://allowed.example', res.headers.get('access-control-allow-origin'));
    eq('Origin', res.headers.get('vary'));
  },

  async 'cors({ origin: string }): a non-matching origin gets no ACAO header, request still proceeds'() {
    const res = await fetch(`${base}/cors-origin`, { headers: { origin: 'https://evil.example' } });
    eq(null, res.headers.get('access-control-allow-origin'));
    eq(200, res.status);
  },

  async 'cors({ origin: array }): matches any listed origin'() {
    const res = await fetch(`${base}/cors-array`, { headers: { origin: 'https://b.example' } });
    eq('https://b.example', res.headers.get('access-control-allow-origin'));
  },

  async 'cors({ origin: RegExp }): matches by pattern'() {
    const res = await fetch(`${base}/cors-regex`, { headers: { origin: 'https://sub.example' } });
    eq('https://sub.example', res.headers.get('access-control-allow-origin'));
  },

  async 'cors({ origin: function }): matches via a predicate'() {
    const allowed = await fetch(`${base}/cors-fn`, { headers: { origin: 'https://fn.example' } });
    eq('https://fn.example', allowed.headers.get('access-control-allow-origin'));

    const denied = await fetch(`${base}/cors-fn`, { headers: { origin: 'https://other.example' } });
    eq(null, denied.headers.get('access-control-allow-origin'));
  },

  async 'cors({ credentials, exposedHeaders, maxAge }): sets the extra headers on a preflight'() {
    const res = await fetch(`${base}/cors-creds`, {
      method: 'OPTIONS',
      headers: { origin: 'https://c.example', 'access-control-request-method': 'PUT' },
    });
    eq('true', res.headers.get('access-control-allow-credentials'));
    eq('x-total-count', res.headers.get('access-control-expose-headers'));
    eq('600', res.headers.get('access-control-max-age'));
  },

  /* -------------------------------------------------------------- *
   * logger()
   * -------------------------------------------------------------- */

  async 'logger(sinkFn): captures one entry per request with method/url/status/duration'() {
    const res = await fetch(`${base}/logger`);
    await res.text();
    eq(1, captured.length);
    eq('GET', captured[0].method);
    eq('/logger', captured[0].url);
    eq(200, captured[0].status);
    assert(typeof captured[0].durationMs === 'number', 'expected a numeric durationMs');
  },

  async 'logger(): default "tiny" format logs a line to console.log'() {
    const orig = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));
    try {
      const res = await fetch(`${base}/logger-tiny`);
      await res.text();
    } finally {
      console.log = orig;
    }
    assert(lines.length >= 1, 'expected at least one logged line');
    assert(/GET \/logger-tiny 200/.test(lines.join('\n')), 'expected a tiny-format line, got: ' + lines.join('\n'));
  },

  /* -------------------------------------------------------------- *
   * secure()
   * -------------------------------------------------------------- */

  async 'secure(): sets the default security header bundle'() {
    const res = await fetch(`${base}/secure-default`);
    eq('nosniff', res.headers.get('x-content-type-options'));
    eq('SAMEORIGIN', res.headers.get('x-frame-options'));
    eq('0', res.headers.get('x-xss-protection'));
    eq('no-referrer', res.headers.get('referrer-policy'));
    assert(res.headers.get('strict-transport-security').includes('max-age'), 'expected an HSTS header');
  },

  async 'secure(opts): overrides a header value, false disables it entirely'() {
    const res = await fetch(`${base}/secure-override`);
    eq('DENY', res.headers.get('x-frame-options'));
    eq(null, res.headers.get('x-xss-protection'));
  },

  async 'secure(): never overwrites a header a prior middleware already set'() {
    const res = await fetch(`${base}/secure-preset`);
    eq('ALREADY-SET', res.headers.get('x-frame-options'));
  },
});

ctx.destroy();

/* Each keepAlive:false fetch() call above created (and never destroyed -
   fetch() doesn't expose it) its own one-off LWSContext; the event loop
   would otherwise never fully drain. Mirrors the same std.exit(0) used by
   tests/unittests/test-websocket(stream).js for their own leaked-context
   reason. */
std.exit(0);
