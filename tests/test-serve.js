/**
 * Exercises lib/serve.js - the Bun-shaped `serve()` wrapper - across every
 * shape it accepts: options-object vs string/URL first argument, a fetch
 * callback vs the no-callback async-iterator form, plain HTTP request/
 * response handling (including error/404/content-length edge cases), the
 * `headers` hook, WebSocket connections (default + custom mountpoints +
 * disabled + Bun's evented `open`/`message`/`close` shape), raw TCP
 * fallback connections, `options.routes` (static/param/per-method entries,
 * 405s, fallthrough to `fetch`), a custom `mounts` array, and TLS vhost
 * construction.
 *
 * Runs entirely in-process: the server side is a real `serve()` instance,
 * the client side is this project's own high-level client classes (`fetch`,
 * `WebSocketStream`, `TCPSocket`) - both halves share this process's single
 * event loop, same pattern as tests/test-fetch.js.
 */
import { serve, Request, Response } from '../lib/serve.js';
import { fetch } from '../lib/fetch.js';
import { WebSocket } from '../lib/websocket.js';
import { WebSocketStream } from '../lib/websocketstream.js';
import { TCPSocket } from '../lib/tcpsocket.js';
import { TCPSocketStream } from '../lib/tcpsocketstream.js';
import { URL } from '../lib/lws/url.js';
import { generateSelfSignedCert } from '../lib/lws/tls.js';
import { toString, logLevel, LLL_ERR, LLL_USER, LWSMPRO_CALLBACK } from 'lws.so';
import { TextDecoder } from 'textcode';
import * as std from 'std';

logLevel(LLL_ERR | LLL_USER);

function assert(cond, message) {
  if(!cond) throw new Error('assertion failed: ' + message);
}

function eq(expected, actual, label) {
  if(expected !== actual) throw new Error(`expected ${label ? label + ' ' : ''}${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const dec = new TextDecoder();
const asText = value => (typeof value === 'string' ? value : dec.decode(value));

let PORT = 18930;
const nextPort = () => PORT++;

/** Reads and echoes back exactly one WS message, prefixed - used by every WebSocket callback-mode test below. */
async function wsEchoOnce(wss) {
  const { readable, writable } = await wss.opened;
  const writer = writable.getWriter();
  const reader = readable.getReader();
  const { value } = await reader.read();
  await writer.write('echo:' + asText(value));
}

const TESTS = {
  async 'callback mode: options object + separate callback argument'() {
    const port = nextPort();
    const server = serve({ port, hostname: 'localhost' }, () => new Response('hello-from-callback'));

    const resp = await fetch(`http://127.0.0.1:${port}/`);
    eq(200, resp.status);
    eq('hello-from-callback', await resp.text());

    server.stop();
  },

  async 'callback mode: options.fetch, and a plain object return value is coerced into a Response'() {
    const port = nextPort();
    const server = serve({ port, hostname: 'localhost', fetch: () => ({ status: 201, headers: { 'x-test': 'yes' }, body: 'obj-response' }) });

    const resp = await fetch(`http://127.0.0.1:${port}/`);
    eq(201, resp.status);
    eq('yes', resp.headers.get('x-test'));
    eq('obj-response', await resp.text());

    server.stop();
  },

  async 'callback mode: a string URL as the first argument (urlToOptions) sets hostname/port'() {
    const port = nextPort();
    const server = serve(`http://127.0.0.1:${port}`, () => new Response('via-string-url'));

    const resp = await fetch(`http://127.0.0.1:${port}/`);
    eq('via-string-url', await resp.text());

    server.stop();
  },

  async 'callback mode: a URL instance as the first argument'() {
    const port = nextPort();
    const server = serve(new URL(`http://127.0.0.1:${port}`), () => new Response('via-URL-instance'));

    const resp = await fetch(`http://127.0.0.1:${port}/`);
    eq('via-URL-instance', await resp.text());

    server.stop();
  },

  async 'callback mode: serve() returns a Server exposing context/port/hostname/stop()'() {
    const port = nextPort();
    const server = serve({ port, hostname: 'localhost', fetch: () => new Response('ok') });

    assert(typeof server.stop === 'function', 'expected a .stop() method');
    assert(server.context !== undefined, 'expected a .context');
    eq(port, server.port);
    eq('localhost', server.hostname);

    server.stop();
  },

  async 'callback mode: a null/undefined return value yields a 404'() {
    const port = nextPort();
    const server = serve({ port, hostname: 'localhost', fetch: () => undefined });

    const resp = await fetch(`http://127.0.0.1:${port}/`);
    eq(404, resp.status);

    server.stop();
  },

  async 'callback mode: a handler that throws (async) yields a 500 with the error in the body'() {
    const port = nextPort();
    const server = serve({
      port,
      hostname: 'localhost',
      fetch: async () => {
        throw new Error('boom');
      },
    });

    const resp = await fetch(`http://127.0.0.1:${port}/`);
    eq(500, resp.status);
    // Not asserting the literal "boom" text: quickjs's Error.stack is just
    // frames, no leading "Error: message" line (unlike V8) - so all this
    // 500 body reliably carries is a non-empty stack trace.
    assert((await resp.text()).length > 0, 'expected a non-empty 500 body');

    server.stop();
  },

  async 'callback mode: GET requests have no body on the Request handed to the handler'() {
    const port = nextPort();
    let seenBody = 'not-set';
    const server = serve({
      port,
      hostname: 'localhost',
      fetch: req => {
        seenBody = req.body;
        return new Response('ok');
      },
    });

    await fetch(`http://127.0.0.1:${port}/`);
    eq(null, seenBody);

    server.stop();
  },

  async 'callback mode: a POST request body streams through to the handler'() {
    const port = nextPort();
    const server = serve({ port, hostname: 'localhost', fetch: async req => new Response(await req.text()) });

    const resp = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: 'ping-pong-body' });
    eq('ping-pong-body', await resp.text());

    server.stop();
  },

  async 'callback mode: req.body is a real ReadableStream - reads the POST body incrementally, not buffered whole'() {
    // A large-enough body that it can't possibly arrive in a single socket
    // read (confirmed empirically: ~4KB reads off the wire, so a 500KB body
    // lands in ~120+ separate LWS_CALLBACK_HTTP_BODY events) - proves
    // req.body's reader sees chunks as lws hands them off, rather than
    // req.stream() (lib/lws/app.js) silently waiting for the whole upload
    // to finish before ever enqueuing anything.
    const port = nextPort();
    let chunkCount = 0;

    const server = serve({
      port,
      hostname: 'localhost',
      fetch: async req => {
        const reader = req.body.getReader();
        const chunks = [];
        let total = 0;

        for(;;) {
          const { value, done } = await reader.read();
          if(done) break;

          chunkCount++;
          chunks.push(value);
          total += value.byteLength;
        }

        const merged = new Uint8Array(total);
        let offset = 0;
        for(const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }

        return new Response(merged);
      },
    });

    const body = '0123456789'.repeat(50000); // 500,000 bytes
    const resp = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body });
    const received = await resp.text();

    assert(received.length === body.length, `expected ${body.length} bytes back, got ${received.length}`);
    assert(received === body, 'expected the reconstructed body to match what was sent, byte for byte');
    assert(chunkCount > 1, `expected the body to arrive as more than one chunk (streaming), got ${chunkCount}`);

    server.stop();
  },

  async 'callback mode: an explicit content-length header streams the body as-is'() {
    const port = nextPort();
    const body = 'exact-length-body';
    const server = serve({ port, hostname: 'localhost', fetch: () => new Response(body, { headers: { 'content-length': String(body.length) } }) });

    const resp = await fetch(`http://127.0.0.1:${port}/`);
    eq(String(body.length), resp.headers.get('content-length'));
    eq(body, await resp.text());

    server.stop();
  },

  async 'callback mode: a missing content-length header is computed automatically'() {
    const port = nextPort();
    const body = 'auto-computed-length';
    const server = serve({ port, hostname: 'localhost', fetch: () => new Response(body) });

    const resp = await fetch(`http://127.0.0.1:${port}/`);
    eq(String(body.length), resp.headers.get('content-length'));
    eq(body, await resp.text());

    server.stop();
  },

  // Note: options.headers (LWS_CALLBACK_ADD_HEADERS) is *not* covered here -
  // confirmed separately (against the raw createServer() API, bypassing
  // serve() entirely) that onAddHeaders simply never fires for a
  // LWSMPRO_CALLBACK-mounted dynamic response, matching the gap TODO.md
  // already flags ("headers/upgrade/etc. weren't even confirmed to fire
  // under any tested mount configuration"). That's a pre-existing
  // protocols.js/native-level gap, not something serve() itself controls,
  // so there's no serve()-level behavior here worth pinning down yet.

  async 'iterator mode: no-callback serve() exposes context/port/hostname/stop()'() {
    const port = nextPort();
    const server = serve({ port, hostname: 'localhost' });

    assert(typeof server.stop === 'function', 'expected a .stop() method');
    assert(server.context !== undefined, 'expected a .context');
    eq(port, server.port);
    eq('localhost', server.hostname);

    server.stop();
  },

  async 'iterator mode: consecutive requests are each yielded once, in order, via .respond()'() {
    // keepAlive: false on each fetch - reusing one pipelined connection for
    // a second request against a serve() server currently trips a native
    // read-state bug ("lws_read_h1: Unhandled state 282") unrelated to
    // serve() itself (reproduces against a plain callback-mode serve() with
    // two sequential fetches too); sidestepped here by giving each request
    // its own connection instead of exercising it.
    const port = nextPort();
    const server = serve({ port, hostname: 'localhost' });
    const it = server[Symbol.asyncIterator]();

    const r1 = fetch(`http://127.0.0.1:${port}/one`, { keepAlive: false });
    const { value: req1, done: done1 } = await it.next();
    assert(!done1, 'iterator should not be done yet');
    assert(req1 instanceof Request, 'expected a Request instance');
    eq('/one', new URL(req1.url).pathname);
    req1.respond(new Response('1'));
    eq('1', await (await r1).text());

    const r2 = fetch(`http://127.0.0.1:${port}/two`, { keepAlive: false });
    const { value: req2 } = await it.next();
    eq('/two', new URL(req2.url).pathname);
    req2.respond(new Response('2'));
    eq('2', await (await r2).text());

    server.stop();
  },

  async 'WebSocket (callback mode): fetch handler receives a WebSocketStream at the default /ws mount'() {
    const port = nextPort();
    const server = serve({
      port,
      hostname: 'localhost',
      fetch: x => (x instanceof WebSocketStream ? wsEchoOnce(x) : new Response('not-ws')),
    });

    const client = new WebSocketStream(`ws://127.0.0.1:${port}/ws`);
    const { readable, writable } = await client.opened;
    const writer = writable.getWriter();
    const reader = readable.getReader();

    await writer.write('ping');
    const { value } = await reader.read();
    eq('echo:ping', asText(value));

    client.close();
    server.stop();
  },

  async 'WebSocket (iterator mode): the async iterator also yields WebSocketStream connections'() {
    const port = nextPort();
    const server = serve({ port, hostname: 'localhost' });
    const it = server[Symbol.asyncIterator]();

    const client = new WebSocketStream(`ws://127.0.0.1:${port}/ws`);
    const { value: wss } = await it.next();
    assert(wss instanceof WebSocketStream, 'expected a WebSocketStream from the iterator');
    wsEchoOnce(wss);

    const { readable, writable } = await client.opened;
    const writer = writable.getWriter();
    const reader = readable.getReader();

    await writer.write('iter-ping');
    const { value } = await reader.read();
    eq('echo:iter-ping', asText(value));

    client.close();
    server.stop();
  },

  async 'WebSocket: the `websocket` option as a string sets a custom mountpoint'() {
    const port = nextPort();
    const server = serve({
      port,
      hostname: 'localhost',
      websocket: '/chat',
      fetch: x => (x instanceof WebSocketStream ? wsEchoOnce(x) : new Response('not-ws')),
    });

    const client = new WebSocketStream(`ws://127.0.0.1:${port}/chat`);
    const { readable, writable } = await client.opened;
    const writer = writable.getWriter();
    const reader = readable.getReader();

    await writer.write('hi');
    const { value } = await reader.read();
    eq('echo:hi', asText(value));

    client.close();
    server.stop();
  },

  async 'WebSocket: the `websocket` option as {mountpoint} sets a custom mountpoint'() {
    const port = nextPort();
    const server = serve({
      port,
      hostname: 'localhost',
      websocket: { mountpoint: '/chat2' },
      fetch: x => (x instanceof WebSocketStream ? wsEchoOnce(x) : new Response('not-ws')),
    });

    const client = new WebSocketStream(`ws://127.0.0.1:${port}/chat2`);
    const { readable, writable } = await client.opened;
    const writer = writable.getWriter();
    const reader = readable.getReader();

    await writer.write('hi2');
    const { value } = await reader.read();
    eq('echo:hi2', asText(value));

    client.close();
    server.stop();
  },

  async 'WebSocket: the `websocket` option as {Class} selects the evented WebSocket instead of WebSocketStream'() {
    const port = nextPort();
    let seenClass = null;

    const server = serve({
      port,
      hostname: 'localhost',
      websocket: { Class: WebSocket },
      fetch: x => {
        if(x instanceof WebSocket) {
          seenClass = 'WebSocket';
          x.addEventListener('message', e => x.send('echo:' + (typeof e.data === 'string' ? e.data : toString(e.data))));
          return;
        }
        return new Response('not-ws');
      },
    });

    const client = new WebSocketStream(`ws://127.0.0.1:${port}/ws`);
    const { readable, writable } = await client.opened;
    const writer = writable.getWriter();
    const reader = readable.getReader();

    await writer.write('class-ping');
    const { value } = await reader.read();

    eq('WebSocket', seenClass);
    eq('echo:class-ping', asText(value));

    client.close();
    server.stop();
  },

  async 'WebSocket: options.websocket.{open,message,close} wires an evented WebSocket directly, bypassing fetch/iterator'() {
    const port = nextPort();
    const events = [];
    let closeInfo;
    let resolveClosed;
    const closed = new Promise(resolve => (resolveClosed = resolve));

    const server = serve({
      port,
      hostname: 'localhost',
      websocket: {
        open(ws) {
          ws.data = { greeted: false };
          events.push('open');
          ws.send('hello');
        },
        message(ws, data) {
          ws.data.greeted = true;
          events.push('message:' + asText(data));
          ws.send('echo:' + asText(data));
        },
        close(ws, code, reason) {
          events.push('close');
          closeInfo = { code, reason: asText(reason), greeted: ws.data.greeted };
          resolveClosed();
        },
      },
      // A fetch/iterator-mode handler must never see this connection - Bun-style
      // websocket handlers take the mount over entirely.
      fetch: () => new Response('should not be reached'),
    });

    const client = new WebSocketStream(`ws://127.0.0.1:${port}/ws`);
    const { readable, writable } = await client.opened;
    const writer = writable.getWriter();
    const reader = readable.getReader();

    const { value: greeting } = await reader.read();
    eq('hello', asText(greeting), 'open() greeting');

    await writer.write('ping');
    const { value: echoed } = await reader.read();
    eq('echo:ping', asText(echoed), 'message() echo');

    client.close({ closeCode: 1000, reason: 'bye' });
    await closed;

    eq(JSON.stringify(['open', 'message:ping', 'close']), JSON.stringify(events), 'open/message/close fired once each, in order');
    assert(closeInfo, 'expected close() to have fired');
    eq(1000, closeInfo.code, 'close() code');
    assert(closeInfo.greeted, 'expected ws.data set in open() to still be visible in close()');

    server.stop();
  },

  async 'WebSocket: `websocket: false` disables the special mount - the path is handled as plain HTTP'() {
    const port = nextPort();
    const server = serve({
      port,
      hostname: 'localhost',
      websocket: false,
      fetch: req => new Response('plain-http:' + new URL(req.url).pathname),
    });

    const resp = await fetch(`http://127.0.0.1:${port}/ws`);
    eq(200, resp.status);
    eq('plain-http:/ws', await resp.text());

    server.stop();
  },

  async 'Raw TCP (callback mode): fetch handler receives a TCPSocket when raw:true, for non-HTTP bytes'() {
    // `raw: true` wires up LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG:
    // the listener assumes HTTP until it's actually seen bytes that don't
    // look like an HTTP request line, and only *then* falls back to the raw
    // role and fires its "connected" callback - the server-side socket
    // doesn't exist yet, and can't be waited on, until the client has
    // already sent something. So the client fires its (disposable) trigger
    // bytes as soon as it's locally connected, and the test instead
    // verifies the round trip via a message the *server* sends back, which
    // the client is already listening for before it ever connects.
    const port = nextPort();
    const server = serve({
      port,
      hostname: 'localhost',
      raw: true,
      fetch: x => {
        if(x instanceof TCPSocket) x.send('hello-from-server');
        else return new Response('not-raw');
      },
    });

    const client = new TCPSocket('127.0.0.1', port);
    client.addEventListener('open', () => client.send('raw-hello'));

    const received = new Promise((resolve, reject) => {
      client.addEventListener('message', e => resolve(toString(e.data)));
      client.addEventListener('error', e => reject(new Error(e.message)));
    });

    eq('hello-from-server', await received);

    server.stop();
  },

  async 'Raw TCP (iterator mode): the async iterator also yields TCPSocket connections'() {
    const port = nextPort();
    const server = serve({ port, hostname: 'localhost', raw: true });
    const it = server[Symbol.asyncIterator]();

    const client = new TCPSocket('127.0.0.1', port);
    client.addEventListener('open', () => client.send('iter-raw')); // trigger bytes - see the note in the callback-mode raw test above

    const received = new Promise((resolve, reject) => {
      client.addEventListener('message', e => resolve(toString(e.data)));
      client.addEventListener('error', e => reject(new Error(e.message)));
    });

    const { value: socket } = await it.next();
    assert(socket instanceof TCPSocket, 'expected a TCPSocket from the iterator');
    socket.send('hello-from-server');

    eq('hello-from-server', await received);

    server.stop();
  },

  async 'Raw TCP: plain raw:true still lets a genuinely valid HTTP request through to onRequest (regression guard)'() {
    const port = nextPort();
    const server = serve({ port, hostname: 'localhost', raw: true, fetch: () => new Response('http-ok') });

    const resp = await fetch(`http://127.0.0.1:${port}/`, { keepAlive: false });
    eq(200, resp.status);
    eq('http-ok', await resp.text());

    server.stop();
  },

  async 'Raw TCP: raw:{always:true} treats every connection as raw, even ones that look like valid HTTP'() {
    // Unlike plain raw:true (LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
    // which only falls back to raw once the first bytes fail to parse as
    // HTTP), always:true uses LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG -
    // every connection is bound to raw unconditionally. Send an actual,
    // well-formed HTTP request line and confirm it reaches the TCPSocket
    // handler verbatim rather than being parsed as HTTP.
    const port = nextPort();
    let httpFired = false;

    const server = serve({
      port,
      hostname: 'localhost',
      raw: { always: true },
      fetch: x => {
        if(x instanceof TCPSocket) x.addEventListener('message', e => x.send('raw-saw:' + toString(e.data)));
        else {
          httpFired = true;
          return new Response('should not happen');
        }
      },
    });

    const client = new TCPSocket('127.0.0.1', port);
    const httpLooking = 'GET / HTTP/1.1\r\nHost: x\r\n\r\n';
    client.addEventListener('open', () => client.send(httpLooking));

    const received = new Promise((resolve, reject) => {
      client.addEventListener('message', e => resolve(toString(e.data)));
      client.addEventListener('error', e => reject(new Error(e.message)));
    });

    eq('raw-saw:' + httpLooking, await received);
    assert(!httpFired, 'expected the HTTP-looking request to be treated as raw, not parsed as HTTP');

    server.stop();
  },

  async 'Raw TCP: the `raw` option as {Class} selects TCPSocketStream instead of TCPSocket'() {
    const port = nextPort();
    let seenClass = null;

    const server = serve({
      port,
      hostname: 'localhost',
      raw: { Class: TCPSocketStream },
      fetch: x => {
        if(x instanceof TCPSocketStream) {
          seenClass = 'TCPSocketStream';
          x.opened.then(async ({ readable, writable }) => {
            const reader = readable.getReader();
            const writer = writable.getWriter();
            const { value } = await reader.read();
            await writer.write('echo:' + toString(value.buffer ?? value));
          });
          return;
        }
        return new Response('not-raw');
      },
    });

    const client = new TCPSocket('127.0.0.1', port);
    client.addEventListener('open', () => client.send('raw-class-ping'));

    const received = new Promise((resolve, reject) => {
      client.addEventListener('message', e => resolve(toString(e.data)));
      client.addEventListener('error', e => reject(new Error(e.message)));
    });

    eq('echo:raw-class-ping', await received);
    eq('TCPSocketStream', seenClass);

    server.stop();
  },

  async 'routes: a static Response entry is served as-is, for any method'() {
    const port = nextPort();
    const server = serve({
      port,
      hostname: 'localhost',
      routes: { '/api/status': Response.json({ ok: true }) },
      fetch: () => new Response('should not be reached'),
    });

    const resp = await fetch(`http://127.0.0.1:${port}/api/status`);
    eq(200, resp.status);
    eq(JSON.stringify({ ok: true }), await resp.text());

    server.stop();
  },

  async 'routes: a static Response entry is reusable across multiple requests'() {
    // keepAlive: false on each fetch - see the note on the iterator-mode
    // "consecutive requests" test above (reusing a connection for a second
    // request trips an unrelated native read-state bug).
    const port = nextPort();
    const server = serve({
      port,
      hostname: 'localhost',
      routes: { '/api/status': Response.json({ ok: true }) },
    });

    const r1 = await fetch(`http://127.0.0.1:${port}/api/status`, { keepAlive: false });
    eq(JSON.stringify({ ok: true }), await r1.text());

    const r2 = await fetch(`http://127.0.0.1:${port}/api/status`, { keepAlive: false });
    eq(JSON.stringify({ ok: true }), await r2.text());

    server.stop();
  },

  async 'routes: a `:param` route handler gets req.params populated'() {
    const port = nextPort();
    const server = serve({
      port,
      hostname: 'localhost',
      routes: { '/users/:id': req => new Response(`user:${req.params.id}`) },
    });

    const resp = await fetch(`http://127.0.0.1:${port}/users/42`);
    eq('user:42', await resp.text());

    server.stop();
  },

  async 'routes: a {METHOD: handler} entry dispatches by request method'() {
    const port = nextPort();
    const server = serve({
      port,
      hostname: 'localhost',
      routes: {
        '/api/posts': {
          GET: () => new Response('list-posts'),
          POST: async req => new Response('created:' + (await req.text())),
        },
      },
    });

    const getResp = await fetch(`http://127.0.0.1:${port}/api/posts`, { keepAlive: false });
    eq('list-posts', await getResp.text());

    const postResp = await fetch(`http://127.0.0.1:${port}/api/posts`, { method: 'POST', body: 'hi', keepAlive: false });
    eq('created:hi', await postResp.text());

    server.stop();
  },

  async 'routes: a {METHOD: handler} entry 405s (with an Allow header) for an unhandled method'() {
    const port = nextPort();
    const server = serve({
      port,
      hostname: 'localhost',
      routes: {
        '/api/posts': {
          GET: () => new Response('list-posts'),
          POST: () => new Response('created'),
        },
      },
    });

    const resp = await fetch(`http://127.0.0.1:${port}/api/posts`, { method: 'DELETE' });
    eq(405, resp.status);
    eq('GET, POST', resp.headers.get('allow'));

    server.stop();
  },

  async 'routes: a path matching no route falls through to fetch'() {
    const port = nextPort();
    const server = serve({
      port,
      hostname: 'localhost',
      routes: { '/api/status': Response.json({ ok: true }) },
      fetch: req => new Response('fallback:' + new URL(req.url).pathname, { status: 404 }),
    });

    const resp = await fetch(`http://127.0.0.1:${port}/nope`);
    eq(404, resp.status);
    eq('fallback:/nope', await resp.text());

    server.stop();
  },

  async 'options.mounts, when given, is used instead of the automatic default mount'() {
    // Only asserts that a custom mount is honored and reachable - *not*
    // that an un-mounted path misses it. lws's LWSMPRO_CALLBACK dispatch
    // turns out not to filter by mountpoint prefix the way a static
    // LWSMPRO_FILE mount does (confirmed separately: a request to a
    // completely different path still reaches this same callback), so
    // there's no reliable black-box way to observe "the automatic mount is
    // gone" through HTTP behavior alone.
    const port = nextPort();
    const server = serve({
      port,
      hostname: 'localhost',
      mounts: [{ mountpoint: '/only', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }],
      fetch: req => new Response('reached:' + new URL(req.url).pathname),
    });

    const resp = await fetch(`http://127.0.0.1:${port}/only/thing`);
    eq('reached:/only/thing', await resp.text());

    server.stop();
  },

  async 'tls option constructs an SSL-capable vhost (server-side construction only)'() {
    // A real client<->server TLS handshake against a local self-signed
    // qjs-lws server has a known, separately-tracked issue (see TODO.md,
    // and tests/unittests/test-server.js's HTTPS test) - this is limited to
    // confirming server-side SSL vhost construction succeeds and is
    // reachable, without throwing.
    const port = nextPort();
    const { cert, key } = generateSelfSignedCert({ commonName: 'localhost', altNames: ['localhost', '127.0.0.1'] });

    const server = serve({ port, hostname: 'localhost', tls: { cert, key }, fetch: () => new Response('secure') });

    const vh = server.context.getVhostByName('localhost');
    assert(vh !== undefined, 'expected the SSL-enabled vhost to exist');

    server.stop();
  },
};

async function main() {
  let passed = 0,
    failed = 0;

  for(const [name, fn] of Object.entries(TESTS)) {
    try {
      await fn();
      passed++;
      console.log('PASS -', name);
    } catch(e) {
      failed++;
      console.log('FAIL -', name);
      console.log('     ', e?.message ?? e);
      if(e?.stack) console.log(e.stack);
    }
  }

  console.log(`\n${passed}/${passed + failed} passed`);
  return failed;
}

main()
  .then(failed => std.exit(failed ? 1 : 0))
  .catch(e => {
    console.log('TEST RUNNER CRASHED:', e, e?.stack);
    std.exit(1);
  });
