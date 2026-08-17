# Bun-compatible API (`lib/serve.js`, `lib/lws/response.js`, `lib/lws/request.js`, `lib/websocket.js`)

`serve()` (`lib/serve.js`) is a deliberately [Bun.serve()](https://bun.com/docs/api/http)-shaped
HTTP(+WS+raw) server, built on `createContext()`/`lib/lws/protocols.js`'s
`http()` adapter. The goal: the same application code that calls
`Bun.serve({...})` should run against qjs-lws with a single import-line
switch (`import { serve } from 'bun'` -> `import { serve } from
'qjs-lws/lib/serve.js'`), as far as lws's underlying primitives allow.

This file lists exactly what matches Bun's real API/semantics, what's
close-but-not-identical, and what's a known, documented constraint of
lws's model rather than an oversight. When something can't be made to
behave exactly like Bun, that's called out explicitly here rather than
silently shipping a different API under the same name.

## `serve(options[, fetch])`

```js
import { serve, Response } from './lib/serve.js';

const server = serve({ port: 8080 }, req => new Response('hello'));
```

Matches Bun:

- `port`, `hostname`/`host`, `tls` (`{cert, key}` - constructs an
  SSL-capable vhost; **see "TLS" below, a real vhost-construction bug
  exists right now**).
- `fetch(request, server)` - called once per HTTP request, `(request: Request)
  => Response | Promise<Response>`. The second argument is the `Server`
  this `serve()` call returns (see `server.upgrade()`/`server.publish()`
  below).
- `routes` - `{ '/path/:id': handler | Response | {GET, POST, ...} }`,
  tried before `fetch`, `req.params` populated from `:name` segments,
  method dispatch with an automatic 405 (`allow` header) and `HEAD` ->
  `GET` fallback, matching Bun.
- Returned `Server` has `.stop()`, `.port`, `.hostname`.
- A response with no `content-length` header streams as
  `Transfer-Encoding: chunked` as the body is produced, not buffered
  first to compute a length - same as Bun. Set `content-length` yourself
  if you already know it and want it declared instead (streamed as-is,
  unchanged).

Not from Bun, additive (documented in `serve()`'s own doc comment,
`lib/serve.js`):

- No callback at all -> `serve()` returns an async-iterable instead
  (`for await(const x of serve({port}))`) - a lower-level escape hatch,
  not part of Bun's API.
- `options.raw` - non-HTTP-looking raw TCP connections on the same port.
- `options.mounts`/`options.protocols` - drop to lws's own mount/protocol
  config directly when the high-level API isn't enough.
- `options.{headers,html,access,auth}` - rarer server-side lws callbacks
  (`ADD_HEADERS`/`PROCESS_HTML`/`CHECK_ACCESS_RIGHTS`/
  `VERIFY_BASIC_AUTHORIZATION`) with no Bun equivalent.

## `Request`/`Response`/`Headers` (`lib/lws/request.js`, `lib/lws/response.js`, `lib/lws/headers.js`)

Standard WHATWG `fetch()` shapes (same classes `fetch()`, `lib/fetch.js`,
uses on the client side) - `new Request(url, {method, headers, body})`,
`new Response(body, {status, headers})`, `.text()`/`.json()`/
`.arrayBuffer()`/`.formData()`, `Response.json()`/`.redirect()`. `Response`
also carries a couple of Express-style conveniences Bun doesn't have
(`.status(code)`/`.cookie()`/`.clearCookie()`, chainable) - additive, not a
conflict, since `status` used as a *property* (not called) is a WHATWG
`Response` method here, not a number; use `.statusCode` for the number if
you're not calling `.status(...)` as a setter.

## `server.upgrade(request, options)` - dynamic per-request WS upgrade

```js
serve({
  websocket: {
    open(ws)            { ws.subscribe('room:' + ws.data.room); },
    message(ws, data)   { ws.publish('room:' + ws.data.room, data); },
    close(ws)            {},
  },
  fetch(req, server) {
    const url = new URL(req.url);

    if(url.pathname === '/ws')     return server.upgrade(req, { data: { room: 'lobby' } }) ? undefined : new Response('upgrade failed', { status: 500 });
    if(url.pathname === '/serial') return server.upgrade(req, { data: { room: 'serial' } }) ? undefined : new Response('upgrade failed', { status: 500 });

    return new Response('plain http');
  },
});
```

Matches Bun: `fetch` decides, per request (URL/headers/auth/whatever),
whether to promote *this* connection to a WebSocket, instead of a single
fixed mountpoint chosen up front. `server.upgrade()` returns `true`/`false`
matching Bun exactly; `options.data` becomes `ws.data`, readable in
`open`/`message`/`close`, same as Bun. There's still only **one** shared
`open`/`message`/`close` handler set (configured once, at the top of
`serve()`'s own options) - exactly like Bun, which also has no
per-endpoint handlers, only per-connection `ws.data` to differentiate
behavior (as in the example above).

**Requires** `websocket` to be configured in Bun's evented shape
(`{open, message, close}`) - `.upgrade()` is a no-op returning `false`
with a plain `Class`/mountpoint-only `websocket` option, or with no
`fetch` handler (iterator-mode `serve()`) at all.

**Must be called synchronously** - before `fetch`'s first `await` if it's
`async` - matching Bun's own contract. This one isn't optional cosmetics
here: it's how `.upgrade()` is actually implemented (see "How it works"
below), and it's a hard requirement of the underlying native callback.

### How it works (and its real constraints)

lws never fires `LWS_CALLBACK_HTTP` (`fetch` normally) for a genuine
upgrade request at all - confirmed directly against lws's own
`lib/roles/http/server/server.c`: an `Upgrade` header routes straight to
`LWS_CALLBACK_HTTP_CONFIRM_UPGRADE`, then lws's own native WS handshake,
entirely bypassing the normal HTTP-request dispatch. `server.upgrade()`
is built by treating *that* callback as the "call `fetch`, see if it
upgraded" dispatch point instead - synthesizing a `Request` from the
still-unestablished connection's already-parsed headers/URL/method, and
checking - strictly synchronously - whether `fetch`'s call made
`server.upgrade()` accept.

This has two real, load-bearing consequences, not just implementation
trivia:

1. **A `fetch` that rejects an upgrade** (didn't call `.upgrade()`) has to
   answer back through the same synchronous native callback. Only a
   plain, already-in-memory `Response` returned *synchronously* (not a
   `Promise`, not a streamed body) can be sent as that reply - lws's
   contract for a confirm-upgrade rejection requires the response already
   fully written by the time the callback returns, and there is no way to
   defer that from JS. An `async fetch` (or a streamed rejection body)
   can't satisfy this, so that case hangs up the connection outright
   instead of risking a malformed response. In practice this covers the
   overwhelmingly common case (`return new Response('Unauthorized',
   {status: 401})`) fine; it's a real gap for anything fancier.

2. **Which protocol an accepted upgrade actually binds to** is resolved by
   lws purely by matching the client's `Sec-WebSocket-Protocol` header
   against registered protocol *names* (or the vhost's first/default
   protocol if that header is absent) - confirmed empirically to be
   completely independent of mount/URL. `server.upgrade()` accepting the
   request doesn't override this. The ordinary `new WebSocket(url)` case
   (no `Sec-WebSocket-Protocol` header sent) is unaffected; a client that
   explicitly passes custom `protocols` to `new WebSocket(url, protocols)`
   naming something this vhost never registered will fail the native
   handshake regardless of what `fetch` decided.

**Status:** implemented and confirmed working in every focused test
(a single WS endpoint, `ws.data` round-tripping correctly, a plain HTTP
request handled alongside it) - but a fuller multi-endpoint integration
test hit an unresolved hang, not yet root-caused. See `BUGS:
serve-upgrade-hangs-in-fuller-scenario` in this project's `BUGS` file
before relying on more than one `.upgrade()`-accepting endpoint per
server.

## WS pub/sub - `ws.subscribe()`/`.unsubscribe()`/`.publish()`, `server.publish()`

```js
serve({
  websocket: {
    open(ws)          { ws.subscribe('chat'); },
    message(ws, data) { ws.publish('chat', data); }, // -> everyone in 'chat' except ws itself
    close(ws)         {}, // subscriptions are dropped automatically
  },
  fetch(req, server) {
    server.publish('chat', 'a message from outside any connection'); // -> everyone in 'chat', nobody excluded
    return new Response('ok');
  },
});
```

Matches Bun's signatures and exclusion semantics exactly:

- `ws.subscribe(topic)` / `ws.unsubscribe(topic)` / `ws.isSubscribed(topic)`
- `ws.publish(topic, message)` - broadcasts to `topic`'s subscribers,
  **excluding** the calling socket (matches Bun)
- `server.publish(topic, message)` - same, but excludes nobody

A server-wide `topic -> Set<WebSocket>` registry (`TopicRegistry`,
`lib/websocket.js`) backs this - the app doesn't track its own list of
live sockets, and a closed socket's subscriptions are dropped
automatically.

**Return value note:** all three return the total bytes handed to
`wsi.write()` across every recipient - "bytes attempted", not a
confirmed-delivered count, since lws doesn't expose a per-write
backpressure/delivery result to JS the way Bun's (uWebSockets-backed)
exact accounting does. Close enough for "did this reach anyone" (`0`
means no subscribers), not for precise flow-control decisions.

Only available on the evented `WebSocket` class (`lib/websocket.js`) -
i.e. `websocket: {open, message, close}` (Bun's own shape) or a
`server.upgrade()`-accepted connection (which uses the same class
underneath). A plain `Class`/`WebSocketStream`-shaped `websocket` option
doesn't get these methods, matching how Bun's own pub/sub is specifically
a `ServerWebSocket` feature.

## Idle timeout, backpressure, TLS peer info

- `server.timeout(seconds)` - server-wide idle timeout, matching Bun's
  semantics: applied (and re-armed on every request/WS message) via the
  native `wsi.setTimeout()` binding (`lws_set_timeout()`,
  `doc/native/LWSSocket.md`), which force-closes an idle connection - `0`
  disables it.
- `websocket.idleTimeout` - same mechanism, per-WS-handler; takes
  precedence over `server.timeout()` when both are set on the same
  connection.
- `websocket.drain(ws)` - now actually fires: `ws.send()` arms a one-shot
  native "write queue fully flushed" callback whenever it leaves data
  buffered, which dispatches the `'drain'` event.
- `WebSocket#writableNeedDrain` / `TCPSocket#writableNeedDrain` - Node's
  `socket.writableNeedDrain` equivalent (`wsi.sendPipeChoked`) - true if a
  `send()`/`write()` right now would buffer instead of going out
  immediately.
- `WebSocket#bufferedAmount` - WHATWG/Bun/Deno standard property, bytes
  still queued to be sent (`wsi.bufferedAmount`).
- TLS peer certificate info: `TCPSocket#peerCertificate`/`#tlsSessionReused`
  and `WebSocket#peerCertificate`/`#tlsSessionReused` (Node's
  `tlsSocket.getPeerCertificate()`/`.isSessionReused()` equivalents, see
  `doc/native/LWSSocket.md`). `ServerRequest` doesn't get its own copies -
  use `request.wsi.peerCertificate` via the existing `.wsi` escape hatch.

## TLS

`serve({ tls: {cert, key} })` constructs an SSL-capable vhost, matching
Bun's `tls` option shape (`lib/lws/tls.js`'s `tlsContextOptions()`).
**Currently segfaults during vhost construction** - see `BUGS:
serve-tls-option-segfaults` in this project's `BUGS` file. Not
root-caused; found while verifying the streaming-response fix, out of
scope to fix as part of that work.

## Known gaps not covered by this file

See `TODO.md` item 2.3/2.4 in this project (`serve()`'s section) for
smaller, longer-standing gaps against Bun: no bound-port reporting when
`port: 0` is requested, no `Bun.serve({static: {...}})`-equivalent static
file convenience (drop to `options.mounts` by hand for now), and
`HttpClientProtocol.connect()` (the client side, `fetch()`) always
buffers the whole request body up front rather than streaming an
unknown-length one.
