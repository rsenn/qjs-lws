# qjs-lws — JS API documentation

QuickJS bindings to [libwebsockets](https://libwebsockets.org/).
This documentation is derived from the C sources (`lws.c`, `lws-context.c`,
`lws-socket.c`, `lws-vhost.c`, `lws-spa.c`, `lws-sockaddr46.c`, `js-utils.c`)
and the helper JS modules under `lib/`.

The native module is loaded as:

```js
import { LWSContext /* … */ } from 'lws';
```

## Contents

| File | Topic |
|------|-------|
| [native/module.md](native/module.md)       | Module exports: top-level functions and constants |
| [native/LWSContext.md](native/LWSContext.md) | The libwebsockets context wrapper |
| [native/LWSVhost.md](native/LWSVhost.md)     | Virtual host objects |
| [native/LWSSocket.md](native/LWSSocket.md)   | Per-connection `wsi` object passed to callbacks |
| [native/LWSSPA.md](native/LWSSPA.md)         | Server-side multipart/POST form parser |
| [native/LWSSockAddr46.md](native/LWSSockAddr46.md) | IPv4/IPv6 socket address helper |
| [native/protocols.md](native/protocols.md)   | Protocol handler objects and callback reasons |
| [native/callbacks.md](native/callbacks.md)   | Per-reason callback signatures and meaning |
| [native/mounts.md](native/mounts.md)         | HTTP mount points (static files, redirects, callbacks) |
| [native/tls.md](native/tls.md)               | TLS / SSL configuration |
| [native/event-loop.md](native/event-loop.md) | Integration with `os.setReadHandler` / `os.setWriteHandler` |
| [native/ws-server.md](native/ws-server.md)   | WebSocket server example |
| [native/ws-client.md](native/ws-client.md)   | WebSocket client example |
| [native/http-server.md](native/http-server.md) | HTTP server example |
| [native/http-client.md](native/http-client.md) | HTTP client (fetch-like) example |
| [native/raw-tcp.md](native/raw-tcp.md)       | Raw TCP server / client |
| [native/constants.md](native/constants.md)   | Enumerated constants exported by the module |
| [js/helpers.md](js/helpers.md)       | JS helpers shipped under `lib/` (fetch, serve, WebSocket, TCPSocket) |
| [js/bun.md](js/bun.md)               | `serve()`'s Bun-compatible API surface in detail: `server.upgrade()`, WS pub/sub, chunked streaming, and their real constraints |
| [native/examples.md](native/examples.md)     | Twelve copy-paste examples covering every role |
| [native/building.md](native/building.md)     | Build instructions and CMake options |

## Architecture overview

```
   ┌──────────────────────────────────────────────────┐
   │  JavaScript                                       │
   │                                                   │
   │  import { LWSContext } from 'lws'                 │
   │  ┌──────────────┐    new LWSContext({…})          │
   │  │ user code    │──────────────────┐              │
   │  └──────┬───────┘                  ▼              │
   │         │            ┌────────────────────────┐   │
   │         │            │ LWSContext / LWSVhost   │  │
   │         │            │  LWSSocket / LWSSPA     │  │
   │         │            │  LWSSockAddr46          │  │
   │         │            └─────────────┬──────────┘   │
   │         │                          │              │
   └─────────┼──────────────────────────┼──────────────┘
             │ protocol callbacks       │ ffi
             ▼                          ▼
   ┌──────────────────────────────────────────────────┐
   │  libwebsockets (C)                                │
   │   - vhost listener / mounts                       │
   │   - HTTP/1.1, HTTP/2, WebSocket, raw TCP, MQTT    │
   │   - TLS / SSL                                     │
   └──────────────────────────────────────────────────┘
                       ▲
                       │ POLLIN / POLLOUT events
                       │
   ┌──────────────────────────────────────────────────┐
   │  QuickJS `os` module                              │
   │     os.setReadHandler(fd, fn)                     │
   │     os.setWriteHandler(fd, fn)                    │
   └──────────────────────────────────────────────────┘
```

qjs-lws does **not** call `lws_service()` in a loop. It hooks the
`LWS_CALLBACK_ADD_POLL_FD` / `LWS_CALLBACK_DEL_POLL_FD` /
`LWS_CALLBACK_CHANGE_MODE_POLL_FD` events and installs the file
descriptors via QuickJS's own `os.setReadHandler` /
`os.setWriteHandler`. The script's normal event loop drives
libwebsockets; no manual polling is needed.
See [native/event-loop.md](native/event-loop.md).

## Quick example

```js
import { createServer } from 'lws';

const ctx = createServer({
  port: 8080,
  vhostName: 'localhost',
  protocols: [{
    name: 'echo',
    onEstablished(wsi)         { console.log('open', wsi.peer?.host); },
    onReceive(wsi, data)       { wsi.write(data); },
    onClosed(wsi)              { console.log('close'); },
  }],
});
```
