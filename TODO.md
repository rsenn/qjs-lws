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

---

## Footnote: current repo state

- `callback_protocol()` in `lws-context.c` is a ~280-line if/else cascade;
  per-reason marshaller functions would make new reasons safer to add.
- `LWSContext.vhost` getter is commented out (`lws-context.c:1234`);
  `serve()` cannot report the actual bound port for ephemeral ports.
- `HttpClientProtocol.connect()` buffers the full request body to know
  `content-length` before sending (no chunked-encoding path).
- Option-object key casing is inconsistent between `client_connect_info_fromobj()`
  (snake_case) and other option parsers (camelCase); wrong keys are silently
  ignored rather than rejected.
- `lib/lws/mimetypes.js` extra list is dev-specific (`.sublime-project` etc).
- Root-level `tests/test-{app,client,server,websocket,fetch,serve}.js` are
  not wired into `DO_TESTS` (only `tests/unittests/test-*.js` are).
- `examples/debugger/` contains tracked artifacts (core dump, gmon.out).
- 19% of libwebsockets' public C API is bound (155/808, see `binding_coverage.json`).
