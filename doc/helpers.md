# JS helpers under `lib/`

Pure-JS wrappers shipped on top of the C bindings. They are not
required — anything they do can be reproduced from the primitives
documented elsewhere — but they offer a more familiar API surface.

## High-level modules

### `lib/serve.js`

Bun-style HTTP server. `serve(opts, handler)` (or
`serve(opts)[Symbol.asyncIterator]` for pull-style) hides the
underlying `LWSContext`/protocol wiring.

```js
import { serve, Response } from './lib/serve.js';

serve({ port: 8080, host: 'localhost' }, async req => {
  if(req.url.endsWith('/health'))
    return new Response('ok', { status: 200 });
  return new Response('not found', { status: 404 });
});
```

The handler receives a `Request` and may return a `Response` (or a
plain `{ body, status, headers }` object that the helper wraps).
WebSocket connections (`options.websocket`, default mountpoint
`/ws`) and, with `options.raw` set, raw TCP connections hit the same
handler as a bare `WebSocketStream` / `TCPSocket` instead of a
`Request` - check with `instanceof`. `raw: { always: true }` treats
*every* connection as raw, even ones that look like valid HTTP; see
[`doc/raw-tcp.md`](raw-tcp.md#always-raw-listener-even-for-http-looking-traffic)
for why that needs `lib/serve.js` and can't just be a `createServer()`
option flag by itself.

`websocket`/`raw`, given as objects, also take a `Class` - the
constructor used to wrap accepted connections in place of the
defaults (`WebSocketStream` / `TCPSocket`):

```js
import { serve, Response } from './lib/serve.js';
import { WebSocket } from './lib/websocket.js';
import { TCPSocketStream } from './lib/tcpsocketstream.js';

serve({
  websocket: { Class: WebSocket },               // evented, not streams
  raw: { always: true, Class: TCPSocketStream }, // streams, not evented
  fetch: x => { /* … */ },
});
```

This works because `WebSocket`, `WebSocketStream`, `TCPSocket`, and
`TCPSocketStream` each expose a `.protocol(name, callback)` static -
see their sections below - that's an interchangeable
`createServer()`-compatible protocol descriptor, so `lib/serve.js`
just calls whichever `Class.protocol(...)` it was given.

### `lib/fetch.js`

WHATWG-`fetch`-shaped client built on `LWSContext.clientConnect`.

```js
import { toString } from 'lws';
import { fetch } from './lib/fetch.js';

const res = await fetch('https://example.com/', { tls: {} });
console.log(res.status, res.headers.get('content-type'));
for await (const chunk of res.body) console.log(toString(chunk));
```

Recognised options (subset):

| Option | Maps to |
|--------|---------|
| `method`, `headers`, `body` | `Request` |
| `signal` | `ctx.cancelService()` on abort |
| `tls`    | TLS server options + per-vhost SSL context. Sub-keys: `ca`, `cert`, `key`, `rejectUnauthorized` |
| `h2`     | `LCCSCF_H2_PRIOR_KNOWLEDGE` |
| `pwsi(wsi)` | Hook called with the freshly created `LWSSocket` |

The body is exposed as a `ReadableStream` from
`lib/lws/streams.js`. `Response.redirected` is `true` when lws
followed at least one redirect to produce the response.

### `lib/lws/url.js`

A conforming subset of the [WHATWG URL Standard](https://url.spec.whatwg.org/):
`URL` and `URLSearchParams`, implemented from the spec's own basic
URL parser state machine (not a regex approximation) — special-scheme
handling (`http`/`https`/`ws`/`wss`/`ftp`/`file`), relative-URL
resolution against a base, IPv4/IPv6 host parsing and serialization,
`file:`/opaque-path URLs (`mailto:`, …), and correct percent-encoding
per component.

```js
import { URL, URLSearchParams } from './lib/lws/url.js';

const u = new URL('/a/../b?x=1', 'https://example.com/dir/');
console.log(u.href);            // https://example.com/b?x=1
console.log(u.searchParams.get('x')); // '1'

u.searchParams.set('y', '2');
console.log(u.href);            // https://example.com/b?x=1&y=2 (searchParams writes back through)
```

Known deviation from the spec: no IDNA/Punycode — non-ASCII domain
labels are lowercased and kept as UTF-8 rather than converted to
`xn--` ASCII form. Plain ASCII domains are unaffected.

### `lib/websocket.js`

WHATWG-`WebSocket`-shaped class:

```js
import { WebSocket } from './lib/websocket.js';

const ws = new WebSocket('wss://echo.websocket.events/', ['chat']);

ws.addEventListener('open',    () => ws.send('hi'));
ws.addEventListener('message', e => console.log(e.data));
ws.addEventListener('close',   () => console.log('closed'));
ws.addEventListener('error',   e => console.error(e.message));

// or `ws.onmessage = …` style — the class extends an EventTarget
// that auto-binds property-style handlers (see lib/lws/events.js).
```

`WebSocket.lws(ws)` returns the underlying `LWSSocket` for advanced
needs. `WebSocket.waitWrite(ws)` returns a promise that resolves
when the socket is writeable.

`WebSocket.protocol(name, callback)` is the server-side counterpart:
synthesizes a `createServer()`-compatible protocol descriptor that
wraps every accepted connection as a `WebSocket` and hands it to
`callback` once established - built on `lib/lws/protocols.js`'s `ws()`
server-role adapter, same shape as `WebSocketStream.protocol()` below.

```js
import { createServer, LWSMPRO_NO_MOUNT } from 'lws';
import { WebSocket } from './lib/websocket.js';

createServer({
  port: 8080,
  mounts: [{ mountpoint: '/echo', protocol: 'echo', originProtocol: LWSMPRO_NO_MOUNT }],
  protocols: [
    WebSocket.protocol('echo', ws => ws.addEventListener('message', e => ws.send(e.data))),
  ],
});
```

### `lib/websocketstream.js`

WebSocket-stream proposal: pairs a `ReadableStream` with a
`WritableStream` on top of the WS protocol. Independent of the
EventTarget-based `WebSocket` (lib/websocket.js) - both talk to
`lib/lws/protocols.js` directly rather than one wrapping the other.
`WebSocketStream.protocol(name, callback)` is its server-side
counterpart - see `lib/serve.js`'s own use of it for the shape.

### `lib/tcpsocket.js` / `lib/tcpsocketstream.js`

EventTarget-style raw TCP socket (`TCPSocket`) and an independent
Streams-based view (`TCPSocketStream`, its own file) - same
relationship as `WebSocket`/`WebSocketStream` above. Both also expose
a `.protocol(name, callback)` static (see [doc/raw-tcp.md](raw-tcp.md)
for the underlying `raw()` role adapter) as a `createServer()`-
integrated alternative to the `TCPSocket#bind()`/`.listen()` shown
below:

```js
import { toString } from 'lws';
import { TCPSocket } from './lib/tcpsocket.js';
import { TCPSocketStream } from './lib/tcpsocketstream.js';

// Client.
const s = new TCPSocket('example.com', 80);
s.addEventListener('open',    () => s.send('GET / HTTP/1.0\r\n\r\n'));
s.addEventListener('message', e => console.log(toString(e.data)));
s.addEventListener('close',   () => console.log('closed'));

// Listener.
const server = new TCPSocket().bind('0.0.0.0', 1234);
server.addEventListener('accept', ({ socket }) => {
  socket.addEventListener('message', e => socket.send(e.data));  // echo
});
server.listen();

// Streams.
const stream = new TCPSocketStream({ host: 'example.com', port: 80 });
const { readable, writable, remoteAddress } = await stream.opened;
```

## Low-level helpers under `lib/lws/`

| Module | What it provides |
|--------|------------------|
| `context.js`       | `createContext(info)` — adds defaults (DNS servers from `/etc/resolv.conf`, `vhostName` from `/etc/hostname`, TLS options when `info.tls` is set), then `new LWSContext(info)` |
| `util.js`          | `waitWrite(wsi)`, `mapper`/`weakMapper`, `actor`, `verbose`/`debug`, state constants `CONNECTING`/`OPEN`/`CLOSING`/`CLOSED`, `ConnectionError` |
| `events.js`        | A spec-shaped `EventTarget` plus `EventTargetProperties(['open',…])` for `onfoo = …` properties |
| `body.js`          | Body mixin used by `Request`/`Response`: `arrayBuffer()`/`text()`/`json()`/`blob()`/`formData()`. `null` and `undefined` both mean "no body" |
| `request.js`       | `Request` (subset of WHATWG `Request`) |
| `response.js`      | `Response` (subset of WHATWG `Response`), including `redirected` |
| `headers.js`       | `Headers` (case-insensitive map). Values are validated per spec: leading/trailing HTTP whitespace is trimmed, embedded NUL/CR/LF throws `TypeError` (prevents header injection via untrusted values) |
| `url.js`           | `URL` / `URLSearchParams` — see above |
| `streams.js`       | A self-contained `ReadableStream`/`WritableStream`/`TransformStream` implementation |
| `stream-utils.js`  | Reader/writer helpers |
| `simple-queue.js`  | Queue used by `streams.js` |
| `list.js`          | Linked-list helpers |
| `mimetypes.js`     | Extension→mimetype table suitable for `mounts[].extraMimetypes` |
| `assert.js`        | Trivial `assert` helper |
| `abort.js`         | `AbortController`/`AbortSignal` |

Most of these are exported as a side effect of `createContext` /
`fetch` / `serve` and rarely need to be imported directly.
