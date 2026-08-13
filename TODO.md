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
- **WebSocketStream** (Chromium proposal): https://developer.chrome.com/blog/websocketstream
- **File API** (W3C, File): https://w3c.github.io/FileAPI/

### Browser Documentation (MDN)
- **WebSocket API**: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
- **WebSocketStream API**: https://developer.mozilla.org/en-US/docs/Web/API/WebSocketStream
- **Fetch API**: https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API
- **Streams API**: https://developer.mozilla.org/en-US/docs/Web/API/Streams_API
- **EventTarget**: https://developer.mozilla.org/en-US/docs/Web/API/EventTarget

### Bun.js Documentation
- **Bun.serve()** (HTTP server): https://bun.sh/docs/runtime/http/server
- **WebSockets** (server-side WS with pub/sub): https://bun.sh/docs/runtime/http/websockets
- **Fetch** (client-side HTTP): https://bun.sh/docs/runtime/networking/fetch
- **TCP** (Bun.connect/Bun.listen, Socket): https://bun.sh/docs/runtime/networking/tcp
- **UDP** (Bun.udpSocket): https://bun.sh/docs/runtime/networking/udp
- **Sockets** (low-level TCP/UDP): https://bun.sh/docs/runtime/networking/sockets

### Deno Documentation
- **Deno.serve()**: https://docs.deno.com/api/deno/~/Deno.serve
- **Deno.connect()**: https://docs.deno.com/api/deno/~/Deno.connect
- **Deno.listen()**: https://docs.deno.com/api/deno/~/Deno.listen
- **Deno.DatagramConn** (UDP): https://docs.deno.com/api/deno/~/Deno.DatagramConn

### Node.js Documentation
- **net.Socket** (TCP client): https://nodejs.org/api/net.html#class-netsocket
- **net.Server** (TCP server): https://nodejs.org/api/net.html#class-netserver
- **dgram.Socket** (UDP): https://nodejs.org/api/dgram.html#class-dgramsocket
- **http.createServer()**: https://nodejs.org/api/http.html#httpcreateserveroptions-requestlistener

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

## Thin Layer Compatibility Strategy

The goal is to maximize compatibility with scripts written for WHATWG standards, browsers, Bun, and Deno without adding significant bloat to `lib/`. The strategy focuses on:

### High-Impact, Low-Cost Additions

1. **WebSocket Static Methods** (lib/websocket.js)
   - Add `WebSocket.connect(url, protocols?)` - returns Promise<WebSocket> (Bun-style)
   - Add `WebSocket.isWebSocket(obj)` - type guard (Deno-style)
   - Cost: ~20 lines, high compatibility gain

2. **TCPSocket Socket Options** (lib/tcpsocket.js)
   - Add `setNoDelay(noDelay?)` - disable Nagle's algorithm (Node/Bun/Deno)
   - Add `setKeepAlive(enable?, initialDelay?)` - TCP keepalive (Node/Bun/Deno)
   - Add `setTimeout(timeout, callback?)` - socket timeout (Node/Bun/Deno)
   - Cost: ~40 lines, enables Node.js TCP patterns

3. **UDPSocket Socket Options** (lib/udpsocket.js)
   - Add `setBroadcast(flag)` - enable broadcast (Node/Bun/Deno)
   - Add `setTTL(ttl)` - IP TTL (Node/Bun/Deno)
   - Add `setMulticastTTL(ttl)` - multicast TTL (Node/Bun/Deno)
   - Add `setMulticastLoopback(flag)` - multicast loopback (Node/Bun/Deno)
   - Cost: ~50 lines, enables multicast/broadcast patterns

4. **Server Lifecycle** (lib/serve.js)
   - Add `server.stop()` returning Promise (Bun/Deno)
   - Add `server.id` property (Bun)
   - Add `server.pendingRequests` counter (Bun)
   - Cost: ~30 lines, enables graceful shutdown patterns

5. **WebSocket Handler Extensions** (lib/serve.js WebSocketHandler)
   - Add `ping(ws, data)` and `pong(ws, data)` handlers (Bun)
   - Add `idleTimeout` option (Bun)
   - Add `maxPayloadLength` option (Bun)
   - Cost: ~40 lines, enables production WebSocket servers

### Medium-Impact Additions (Requires Native Support)

6. **TCPSocket Drain Handler** (lib/tcpsocket.js)
   - Add `drain` event/callback for backpressure (Bun/Node)
   - Requires: expose lws write queue state to JS
   - Cost: ~20 lines JS + native changes

7. **WebSocket bufferedAmount** (lib/websocket.js)
   - Add `bufferedAmount` property (WHATWG/Bun/Deno)
   - Requires: expose lws write queue size to JS
   - Cost: ~10 lines JS + native changes

8. **UDPSocket Multicast** (lib/udpsocket.js)
   - Add `addMembership(multicastAddress, interfaceAddress?)` (Node/Bun/Deno)
   - Add `dropMembership(multicastAddress, interfaceAddress?)` (Node/Bun/Deno)
   - Requires: expose lws multicast socket options to JS
   - Cost: ~30 lines JS + native changes

### Compatibility Patterns to Support

**Bun Patterns** (already well-supported):
```javascript
// Bun TCP server
const server = Bun.listen({ hostname: "0.0.0.0", port: 8080, socket: { data, open, message, close } });

// Bun TCP client
const socket = await Bun.connect({ hostname: "localhost", port: 8080, socket: { data, open, message, close } });

// Bun UDP
const udp = await Bun.udpSocket({ port: 0, socket: { data, open, close } });
```

**Deno Patterns** (partially supported):
```javascript
// Deno TCP server
const listener = Deno.listen({ port: 8080 });
for await (const conn of listener) { handle(conn); }

// Deno TCP client
const conn = await Deno.connect({ hostname: "localhost", port: 8080 });

// Deno UDP
const conn = Deno.listenDatagram({ port: 8080, transport: "udp" });
```

**Node.js Patterns** (partially supported):
```javascript
// Node TCP server
const server = net.createServer(socket => { socket.on('data', chunk => { ... }); });
server.listen(8080);

// Node TCP client
const socket = net.connect(8080, 'localhost');
socket.on('data', chunk => { ... });

// Node UDP
const socket = dgram.createSocket('udp4');
socket.bind(8080);
```

### Implementation Priority

**Phase 1** (High compatibility gain, no native changes):
1. WebSocket static methods
2. TCPSocket socket options (setNoDelay, setKeepAlive, setTimeout)
3. UDPSocket socket options (setBroadcast, setTTL, setMulticastTTL, setMulticastLoopback)
4. Server lifecycle (stop() promise, id, pendingRequests)
5. WebSocket handler extensions (ping/pong, idleTimeout, maxPayloadLength)

**Phase 2** (Medium compatibility gain, requires native support):
6. TCPSocket drain handler
7. WebSocket bufferedAmount
8. UDPSocket multicast (addMembership, dropMembership)

**Phase 3** (Low priority, niche use cases):
9. TCPSocket pause/resume (Node.js streams compatibility)
10. TCPSocket ref/unref (Node.js process lifecycle)
11. UDPSocket connect/disconnect (Node.js connected UDP sockets)
12. WebSocket binaryType 'blob' (currently only 'arraybuffer')

---

## Footnote: current repo state

- `lwsjs_callback_protocol()` in `lws-protocol.c` is a ~460-line function;
  per-reason marshaller functions would make new reasons safer to add.
- `HttpClientProtocol.connect()` buffers the full request body to know
  `content-length` before sending (no chunked-encoding path).
- `lib/lws/mimetypes.js` extra list is dev-specific (`.sublime-project` etc).
- Root-level `tests/test-{app,client,fetch,keepalive,middleware,serve,websocket}.js`
  are not wired into `DO_TESTS` (only `tests/unittests/test-*.js` are).
- 19% of libwebsockets' public C API is bound (162/847, see `binding_coverage.json`).
