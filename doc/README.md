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
| [module.md](module.md)       | Module exports: top-level functions and constants |
| [LWSContext.md](LWSContext.md) | The libwebsockets context wrapper |
| [LWSVhost.md](LWSVhost.md)     | Virtual host objects |
| [LWSSocket.md](LWSSocket.md)   | Per-connection `wsi` object passed to callbacks |
| [LWSSPA.md](LWSSPA.md)         | Server-side multipart/POST form parser |
| [LWSSockAddr46.md](LWSSockAddr46.md) | IPv4/IPv6 socket address helper |
| [protocols.md](protocols.md)   | Protocol handler objects and callback reasons |
| [callbacks.md](callbacks.md)   | Per-reason callback signatures and meaning |
| [mounts.md](mounts.md)         | HTTP mount points (static files, redirects, callbacks) |
| [tls.md](tls.md)               | TLS / SSL configuration |
| [event-loop.md](event-loop.md) | Integration with `os.setReadHandler` / `os.setWriteHandler` |
| [ws-server.md](ws-server.md)   | WebSocket server example |
| [ws-client.md](ws-client.md)   | WebSocket client example |
| [http-server.md](http-server.md) | HTTP server example |
| [http-client.md](http-client.md) | HTTP client (fetch-like) example |
| [raw-tcp.md](raw-tcp.md)       | Raw TCP server / client |
| [constants.md](constants.md)   | Enumerated constants exported by the module |
| [helpers.md](helpers.md)       | JS helpers shipped under `lib/` (fetch, serve, WebSocket, TCPSocket) |
| [examples.md](examples.md)     | Twelve copy-paste examples covering every role |
| [building.md](building.md)     | Build instructions and CMake options |

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
See [event-loop.md](event-loop.md).

## Quick example

```js
import { LWSContext } from 'lws';

const ctx = new LWSContext({
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
