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
`lib/lws/streams.js`.

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

### `lib/websocketstream.js`

WebSocket-stream proposal: pairs a `ReadableStream` with a
`WritableStream` on top of a `WebSocket`.

### `lib/tcpSocket.js`

EventTarget-style raw TCP socket plus a Streams-based
`TCPSocketStream`:

```js
import { toString } from 'lws';
import { TCPSocket, TCPSocketStream } from './lib/tcpSocket.js';

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
| `body.js`          | Body mixin used by `Request`/`Response` |
| `request.js`       | `Request` (subset of WHATWG `Request`) |
| `response.js`      | `Response` (subset of WHATWG `Response`) |
| `headers.js`       | `Headers` (case-insensitive map) |
| `streams.js`       | A self-contained `ReadableStream`/`WritableStream`/`TransformStream` implementation |
| `stream-utils.js`  | Reader/writer helpers |
| `simple-queue.js`  | Queue used by `streams.js` |
| `list.js`          | Linked-list helpers |
| `mimetypes.js`     | Extension→mimetype table suitable for `mounts[].extraMimetypes` |
| `assert.js`        | Trivial `assert` helper |
| `abort.js`         | `AbortController`/`AbortSignal` |

Most of these are exported as a side effect of `createContext` /
`fetch` / `serve` and rarely need to be imported directly.
