# TODO

## Main quest: public API spec compliance

Every class and function in `lib/**/*.js` that corresponds to a WHATWG spec or
Bun.js API must behave as a user would expect reading those docs. Audit each
one for conformance: correct method signatures, property names, return types,
error types, iteration protocols, event semantics, and edge cases documented
in the relevant spec.

### Fetch API (WHATWG Fetch Standard)
- `fetch()` — `lib/fetch.js`
- `Request` — `lib/lws/request.js`
- `Response` — `lib/lws/response.js`
- `Headers` — `lib/lws/headers.js`
- `Body` mixin — `lib/lws/body.js`

### URL Standard (WHATWG)
- `URL` — `lib/lws/url.js`
- `URLSearchParams` — `lib/lws/url.js`

### Streams API (WHATWG)
- `ReadableStream`, `ReadableStreamDefaultReader`, `ReadableStreamBYOBReader` — `lib/lws/streams.js`
- `ReadableByteStreamController`, `ReadableStreamDefaultController` — `lib/lws/streams.js`
- `WritableStream`, `WritableStreamDefaultWriter`, `WritableStreamDefaultController` — `lib/lws/streams.js`
- `TransformStream`, `TransformStreamDefaultController` — `lib/lws/streams.js`
- `ByteLengthQueuingStrategy`, `CountQueuingStrategy` — `lib/lws/streams.js`

### DOM / Events (WHATWG DOM Standard)
- `EventTarget` — `lib/lws/events.js`
- `AbortController` — `lib/lws/abort.js`
- `AbortSignal` (+ `.timeout()`, `.any()`, `.abort()`) — `lib/lws/abort.js`

### WebSocket APIs
- `WebSocket` (WHATWG + Bun pub/sub) — `lib/websocket.js`
- `WebSocketStream` (Chromium API) — `lib/websocketstream.js`

### File API (W3C)
- `File` (streaming subset) — `lib/lws/multipart.js`

### Bun.js APIs
- `Bun.serve()` — `lib/serve.js` (fetch handler, websocket config, `server.upgrade()`, `server.publish()`)
- `Bun.connect()` / `Bun.listen()` — `lib/tcpsocket.js` (`TCPSocket`)
- `Bun.udpSocket()` — `lib/udpsocket.js` (`UDPSocket`)

### Server-side (Bun/Express conventions)
- `ServerRequest`, `ServerResponse` — `lib/lws/request.js`, `lib/lws/response.js`
- `App` / `Router` — `lib/lws/app.js`
- Middleware: `json`, `urlencoded`, `raw`, `text`, `cookies`, `cors`, `logger`, `secure` — `lib/lws/middleware.js`
- `session` / `MemoryStore` — `lib/lws/session.js`

## Reference URLs

### WHATWG Specifications
- **Fetch Standard** (Request, Response, Headers, Body, fetch()): https://fetch.spec.whatwg.org/
- **URL Standard** (URL, URLSearchParams): https://url.spec.whatwg.org/
- **Streams Standard** (ReadableStream, WritableStream, TransformStream, etc.): https://streams.spec.whatwg.org/
- **DOM Standard** (EventTarget, AbortController, AbortSignal): https://dom.spec.whatwg.org/
- **WebSocket Standard** (WebSocket): https://websockets.spec.whatwg.org/
- **WebSocketStream**: Chromium proposal, no WHATWG spec yet (see [explainer](https://developer.chrome.com/blog/websocketstream))
- **File API** (W3C, File): https://w3c.github.io/FileAPI/

### Bun.js Documentation
- **Bun.serve()** (HTTP server): https://bun.sh/docs/runtime/http/server
- **WebSockets** (server-side WS with pub/sub): https://bun.sh/docs/runtime/http/websockets
- **Fetch** (client-side HTTP): https://bun.sh/docs/runtime/networking/fetch
- **TCP** (Bun.connect/Bun.listen, Socket): https://bun.sh/docs/runtime/networking/tcp
- **UDP** (Bun.udpSocket): https://bun.sh/docs/runtime/networking/udp

### Test Suites
- **web-platform-tests (wpt)**: https://github.com/web-platform-tests/wpt
  - Results dashboard: https://wpt.fyi/
  - Test paths:
    - `/fetch/` — Fetch API tests
    - `/url/` — URL API tests
    - `/streams/` — Streams API tests
    - `/dom/` — DOM API tests (EventTarget, AbortController, AbortSignal)
    - `/websockets/` — WebSocket API tests
    - `/FileAPI/` — File API tests

---

## Footnote: current repo state

- `lwsjs_callback_protocol()` in `lws-protocol.c` is a ~460-line function;
  per-reason marshaller functions would make new reasons safer to add.
- `serve()` cannot report actual bound port for ephemeral ports (port: 0).
  `LWSContext.getVhostByName()` returns undefined for vhosts created
  internally by `createContext()` because those vhosts don't have a JS
  user pointer set. Needs C API work: either modify `lws_vhost_object()`
  to create an LWSVhost wrapper when no user pointer exists, or add a
  `port` property directly to LWSContext.
- `HttpClientProtocol.connect()` buffers the full request body to know
  `content-length` before sending (no chunked-encoding path).
- `lib/lws/mimetypes.js` extra list is dev-specific (`.sublime-project` etc).
- Root-level `tests/test-{app,client,fetch,keepalive,middleware,serve,websocket}.js`
  are not wired into `DO_TESTS` (only `tests/unittests/test-*.js` are).
- 19% of libwebsockets' public C API is bound (162/847, see `binding_coverage.json`).
