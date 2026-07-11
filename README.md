# qjs-lws

[libwebsockets](https://libwebsockets.org/) bindings for QuickJS.

Build instructions: [`doc/building.md`](doc/building.md).
Full API reference: [`doc/`](doc/README.md).

```js
import { LWSContext } from 'lws';
```

## `LWSContext`

```js
const ctx = new LWSContext(info);
```

`info` mirrors `struct lws_context_creation_info`. Recognised keys
(see [`doc/LWSContext.md`](doc/LWSContext.md) for the full list):

| Property | Type | Description |
|----------|------|-------------|
| `port`                 | number | TCP port to listen on (omit for a client-only context) |
| `vhostName`            | string | Virtual host name |
| `iface`                | string | Interface to bind |
| `options`              | number | OR-mask of `LWS_SERVER_OPTION_*` |
| `mounts`               | array  | HTTP mount points — see [`doc/mounts.md`](doc/mounts.md) |
| `protocols`            | array  | Protocol handler objects (below) |
| `listenAcceptRole`     | string | Role applied with `LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG` |
| `listenAcceptProtocol` | string | Protocol applied with the role |
| `serverSslCert` / `serverSslPrivateKey` / `serverSslCa` | string \| ArrayBuffer | TLS material — see [`doc/tls.md`](doc/tls.md) |

Property names accept both `camelCase` and `snake_case`.

### Protocol handler

Each entry of `protocols` maps to one `struct lws_protocols`. You
can implement either a single generic `callback` or named
`onEventName` handlers (mix as needed):

```js
{
  name: 'my-protocol',

  // Named handler — receives only the event-specific args.
  onEstablished(wsi)             { /* `this` is per-connection state */ },
  onReceive(wsi, data, len)      { wsi.write(data); },
  onClosed(wsi)                  { },

  // Generic fall-back. Receives the integer reason explicitly.
  callback(wsi, reason, ...args) { return 0; },
}
```

- `wsi` is an `LWSSocket` — see [`doc/LWSSocket.md`](doc/LWSSocket.md).
- The handler's `this` is a per-connection plain object the binding
  allocates automatically (libwebsockets `user` data); use it to
  carry connection-local state.
- The named handler is derived from the `LWS_CALLBACK_*` enum by
  camelCasing and prefixing with `on`:
  `LWS_CALLBACK_CLIENT_ESTABLISHED` → `onClientEstablished`.
  Lookup table is in `lws_callback_names[]` (`lws.c`); the
  conversion is exposed at runtime as `getCallbackName(n)` and
  `getCallbackNumber(name)`.

Common reason constants (exported on the module — `import {…} from 'lws'`):

| Constant | Value | When |
|----------|-------|------|
| `LWS_CALLBACK_ESTABLISHED`        |  0 | New WS connection established (server side) |
| `LWS_CALLBACK_CLIENT_ESTABLISHED` |  3 | Outbound WS connection established |
| `LWS_CALLBACK_CLOSED`             |  4 | Connection closed |
| `LWS_CALLBACK_RECEIVE`            |  6 | Server: WS data received |
| `LWS_CALLBACK_CLIENT_RECEIVE`     |  8 | Client: WS data received |
| `LWS_CALLBACK_SERVER_WRITEABLE`   | 11 | Server: connection is writeable |
| `LWS_CALLBACK_HTTP`               | 12 | HTTP request arrived (server) |

The full table is in [`doc/callbacks.md`](doc/callbacks.md).

## Minimal WebSocket server

```js
import { LWSContext, LWSMPRO_NO_MOUNT } from 'lws';

new LWSContext({
  port: 8080,
  vhostName: 'localhost',
  mounts: [{ mountpoint: '/chat', protocol: 'chat', originProtocol: LWSMPRO_NO_MOUNT }],
  protocols: [{
    name: 'chat',
    onEstablished(wsi)    { console.log('connect from', wsi.peer?.host); },
    onReceive(wsi, data)  { wsi.write(data); },          // echo (text or binary)
    onClosed(wsi)         { console.log('closed'); },
  }],
});

console.log('listening on ws://localhost:8080/chat');
```

## Minimal HTTP server

```js
import { LWSContext, LWSMPRO_CALLBACK, LWS_WRITE_HTTP_FINAL } from 'lws';

new LWSContext({
  port: 3000,
  vhostName: 'localhost',
  mounts: [{ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }],
  protocols: [{
    name: 'http',
    onHttp(wsi /*, uri */) {
      const { method, uri, headers } = wsi;          // wsi.uri is always correct
      console.log(method, uri);

      const body = `hello ${uri}\n`;

      wsi.respond(200, { 'content-type': 'text/plain' });
      wsi.write(body, LWS_WRITE_HTTP_FINAL);
    },
  }],
});
```

## Minimal HTTP client

```js
import { LWSContext, toString } from 'lws';

const ctx = new LWSContext({
  protocols: [{
    name: 'http',
    onEstablishedClientHttp(wsi, status) { console.error('status', status); },
    onReceiveClientHttp(wsi) {
      const buf = new ArrayBuffer(64 * 1024);
      if(wsi.httpClientRead(buf)) this.onReceiveClientHttpRead(wsi, buf);
    },
    onReceiveClientHttpRead(wsi, buf, len) { console.log(toString(buf, 0, len)); },
    onClosedClientHttp(wsi)                 { ctx.cancelService(); },
    onClientConnectionError(wsi, msg)       { console.error(msg); ctx.cancelService(); },
  }],
});

ctx.clientConnect('https://example.com/');
```

## Notes

- qjs-lws does **not** run `lws_service()` in a JS loop. It hooks
  the libwebsockets pollfd callbacks and registers fds via
  QuickJS's own `os.setReadHandler` / `os.setWriteHandler`. The
  script stays alive while any fd is registered. See
  [`doc/event-loop.md`](doc/event-loop.md).
- Convenience wrappers (`fetch`, `serve`, `WebSocket`, `TCPSocket`,
  `TCPSocketStream`, `URL`/`URLSearchParams`) live under
  [`lib/`](lib/) and are documented in
  [`doc/helpers.md`](doc/helpers.md).
- `lib/lws/url.js` is a from-spec implementation of the WHATWG URL
  Standard's basic URL parser — special schemes, relative-URL
  resolution, IPv4/IPv6 hosts, `file:`/opaque-path URLs, and a
  `URLSearchParams` that writes back through to the parent `URL`.
  `fetch`'s `Request`/`Response`/`Headers`/body-reading are a
  conforming *subset* of WHATWG Fetch (no CORS/cache/service-worker
  semantics — this runs server-side, not in a browser sandbox), with
  spec-checked behaviour where they do overlap: `Headers` rejects
  header-injection attempts (embedded CR/LF/NUL in values), body
  reading (`text()`/`json()`/`arrayBuffer()`) is UTF-8-correct for
  both string and binary bodies, and `Response.redirected` reflects
  whether `fetch()` actually followed a redirect.
- More end-to-end examples in [`doc/examples.md`](doc/examples.md).
