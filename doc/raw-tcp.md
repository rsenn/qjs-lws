# Raw TCP

libwebsockets supports "raw" sockets — plain TCP without HTTP /
WebSocket framing. qjs-lws exposes this through the same protocol
table by selecting the `raw-skt` role and using the `onRaw*`
callbacks.

## Raw client

```js
import { LWSContext, toArrayBuffer, toString } from 'lws';

const ctx = new LWSContext({
  protocols: [{
    name: 'raw',
    onConnecting(wsi, fd)        { /* socket() just returned */ },
    onRawConnected(wsi)          { wsi.write(toArrayBuffer('GET / HTTP/1.0\r\n\r\n')); },
    onRawRx(wsi, data)           { console.log(toString(data)); },
    onRawWriteable(wsi)          { /* called when send buffer drains */ },
    onRawClose(wsi, errno)       { ctx.cancelService(); },
  }],
});

ctx.clientConnect({
  address: 'example.com',
  port:    80,
  method:  'RAW',
  protocol: 'raw',
});
```

`method: 'RAW'` triggers raw mode; `protocol` is the name lookup
into the JS protocols table.

## Raw listener

`tcpsocket.js` shows the pattern: pass
`LWS_SERVER_OPTION_ONLY_RAW | LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG`
in `options` so the listener accepts plain TCP and routes new
connections through the protocol named in `listenAcceptProtocol`.

```js
import {
  createServer, toString,
  LWS_SERVER_OPTION_ONLY_RAW,
  LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
} from 'lws';

createServer({
  port: 1234,
  options: LWS_SERVER_OPTION_ONLY_RAW
         | LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
  listenAcceptRole:     'raw-skt',
  listenAcceptProtocol: 'echo',
  protocols: [{
    name: 'echo',
    onRawAdopt(wsi)        { console.log('accept', wsi.peer?.host); },
    onRawRx(wsi, data)     { wsi.write(data); },
    onRawClose(wsi)        { console.log('close'); },
  }],
});
```

## Raw vs. WebSocket lifecycle

| Event | Raw                 | WebSocket |
|-------|---------------------|-----------|
| Accept new conn | `onRawAdopt`  | `onEstablished` |
| Outbound connected | `onRawConnected` | `onClientEstablished` |
| Bytes available | `onRawRx`     | `onReceive` / `onClientReceive` |
| Ready to write | `onRawWriteable` | `onServerWriteable` / `onClientWriteable` |
| Closed | `onRawClose(errno)`  | `onClosed` / `onClientClosed` |

Raw sockets have no framing — `wsi.write(data)` writes the bytes as
is, no `LWS_PRE` padding is added (the binding only adds it for the
WebSocket role).

## Mixed listener (HTTP + raw fall-back)

`LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG` lets a
single port serve HTTP **and** drop to raw mode when the first
bytes don't look like HTTP:

```js
import { createServer, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG } from 'lws';

createServer({
  port: 8080,
  options: LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
  listenAcceptRole:     'raw-skt',
  listenAcceptProtocol: 'raw-echo',
  protocols: [
    { name: 'http',     onHttp(wsi)   { /* … */ } },
    { name: 'raw-echo', onRawRx(wsi, d) { wsi.write(d); } },
  ],
});
```

## Always-raw listener (even for HTTP-looking traffic)

`LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG` above only
drops to raw when the first bytes *fail* to parse as HTTP. To route
*every* connection to raw unconditionally - including one that starts
with a well-formed `GET / HTTP/1.1`  - use
`LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG` instead:

```js
import { createServer, LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG } from 'lws';

createServer({
  port: 8080,
  options: LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG,
  listenAcceptRole:     'raw-skt',
  listenAcceptProtocol: 'raw',
  protocols: [
    { name: 'raw',  onRawRx(wsi, d) { wsi.write(d); } }, // must come first - see below
    { name: 'http', onHttp(wsi)     { /* never reached while raw is adopting everything */ } },
  ],
});
```

**Gotcha, confirmed empirically against this vendored lws build:**
even though `listen_accept_role`/`listen_accept_protocol` are given
explicitly (so lws's own docs say the protocol is looked up by name,
not position), `LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG`
only actually binds new connections to the named raw protocol when
that protocol is `protocols[0]`. With an `'http'` (or any other)
protocol listed first, adopted connections are silently dropped -
none of `onRawAdopt`/`onRawRx`/`onHttp` ever fire for them. This is a
libwebsockets behavior, not something these C bindings do - nothing
in `protocols_fromarray()`/`protocol_from()` (`lws-context.c`) treats
array position specially.

`lib/serve.js`'s `raw: { always: true }` option takes care of this
ordering for you:

```js
import { serve, Response } from './lib/serve.js';
import { TCPSocket } from './lib/tcpsocket.js';

serve({
  port: 8080,
  raw: { always: true }, // every connection is raw, even HTTP-looking ones
  fetch: x => (x instanceof TCPSocket ? x.addEventListener('message', e => x.send(e.data)) : new Response('unreachable')),
});
```

Plain `raw: true` (or `raw: { protocol: 'name' }`) keeps the
fallback-only behavior instead - HTTP still works normally, and only
non-HTTP-looking connections fall through to the raw handler; see
`serve()`'s own doc comment in `lib/serve.js` for the full option
shape.

## High-level wrappers: `lib/tcpsocket.js` / `lib/tcpsocketstream.js`

`TCPSocket` (`lib/tcpsocket.js`) wraps the raw protocol with an
EventTarget view. `TCPSocketStream` (`lib/tcpsocketstream.js`) is a
separate, independent WHATWG-streams view - it doesn't wrap `TCPSocket`,
it talks to the raw protocol directly via `lib/lws/protocols.js`.

```js
import { toString } from 'lws';
import { TCPSocket } from './lib/tcpsocket.js';

const s = new TCPSocket('example.com', 80);
s.addEventListener('open',    () => s.send('GET / HTTP/1.0\r\n\r\n'));
s.addEventListener('message', e => console.log(toString(e.data)));
s.addEventListener('close',   () => console.log('closed'));
```
