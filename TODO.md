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
- ✅ `EventTarget` — `lib/lws/events.js` (with `once` and `signal` options)
- ✅ `AbortController` — `lib/lws/abort.js`
- ✅ `AbortSignal` (+ `.timeout()`, `.any()`, `.abort()`) — `lib/lws/abort.js`

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

## Completed Work

### Response vs ServerResponse Untangling (commit e139858, latest)
- ✅ `Response` now has readonly `status` property (WHATWG compliant)
- ✅ `ServerResponse` has chainable `status(code)` method (Express conventions)
- ✅ Client-side Response created with status/headers when established (not mutated)
- ✅ `serve.js` bridges them via `flush()` function
- ✅ Removed `cookie()` and `clearCookie()` from Response (Express-style, not WHATWG)
- ✅ All tests pass

### WHATWG Fetch API Compliance
- ✅ **Body.bytes()** method implemented - returns Promise<Uint8Array>
- ✅ **Body.formData()** now returns FormData instance (not plain object)
- ✅ **Request.clone()** checks bodyUsed and throws TypeError if already consumed
- ✅ **Response.clone()** checks bodyUsed and throws TypeError if already consumed
- ✅ **Headers iteration order** now sorted lexicographically (not insertion order)
- ✅ **Response.status** is readonly property (not method)

### WHATWG DOM Standard Compliance
- ✅ **EventTarget options** - supports `once` and `signal` per WHATWG DOM spec
  - `once: true` automatically removes listener after first invocation
  - `signal: AbortSignal` removes listener when signal is aborted
  - Handles edge cases: already-aborted signals, wrapped listener removal
  - All 8 unit tests pass

### Remaining Fetch API Issues
- ✅ **fetch()** accepts Request objects as first argument (FIXED)
- ✅ **fetch()** throws TypeError instead of ConnectionError for network errors (FIXED)
- ✅ **fetch()** AbortSignal handling complete (FIXED)

### Remaining Spec Violations (see BUGS file)
- Server methods partially implemented (11 stubs added, need lws context integration)
- WebSocketHandler options partially implemented (10 stubs added, ping/pong wired)
- UDPSocket methods partially implemented (10 stubs added, need lws multicast/socket option support)

## Thin Layer Compatibility Strategy

The goal is to maximize compatibility with scripts written for WHATWG standards, browsers, Bun, and Deno without adding significant bloat to `lib/`. The strategy focuses on:

### High-Impact, Low-Cost Additions

1. **WebSocket Static Methods** (lib/websocket.js) ✅ DONE
   - Added `WebSocket.connect(url, protocols?)` - returns Promise<WebSocket> (Bun-style)
   - Added `WebSocket.isWebSocket(obj)` - type guard (Deno-style)
   - Cost: ~30 lines, high compatibility gain
   - Tests: 4 tests in test-websocket-static-methods.js all pass

2. **TCPSocket Socket Options** (lib/tcpsocket.js) ✅ DONE
   - Added `setNoDelay(noDelay?)` - disable Nagle's algorithm (Node/Bun/Deno)
   - Added `setKeepAlive(enable?, initialDelay?)` - TCP keepalive (Node/Bun/Deno)
   - Added `setTimeout(timeout, callback?)` - socket timeout (Node/Bun/Deno)
   - All methods are stubs (no-op) pending native lws socket option support
   - Cost: ~80 lines, enables Node.js TCP patterns
   - Tests: 10 tests in test-tcpsocket-options.js all pass

3. **UDPSocket Socket Options** (lib/udpsocket.js)
   - Add `setBroadcast(flag)` - enable broadcast (Node/Bun/Deno)
   - Add `setTTL(ttl)` - IP TTL (Node/Bun/Deno)
   - Add `setMulticastTTL(ttl)` - multicast TTL (Node/Bun/Deno)
   - Add `setMulticastLoopback(flag)` - multicast loopback (Node/Bun/Deno)
   - Cost: ~50 lines, enables multicast/broadcast patterns

4. **Server Lifecycle** (lib/serve.js) ✅ DONE
   - ✅ `server.stop()` returning Promise (Bun/Deno)
   - ✅ `server.id` property (Bun)
   - ✅ `server.pendingRequests` counter (Bun)
   - ✅ `server.pendingWebSockets` counter (Bun)
   - ✅ `server.url` property (URL object)
   - ✅ `server.development` property (boolean)
   - Cost: ~30 lines, enables graceful shutdown patterns
   - Tests: 10 tests in test-server-lifecycle.js all pass

5. **WebSocket Handler Extensions** (lib/serve.js WebSocketHandler) ✅ DONE
   - ✅ `ping(ws, data)` and `pong(ws, data)` handlers (Bun) - wired to event listeners
   - ✅ `idleTimeout` option (Bun) - **fully wired**, native `wsi.setTimeout()` (`lws_set_timeout()`), re-armed per message
   - ✅ `maxPayloadLength` option (Bun) - accepted (pending native lws config support)
   - ✅ `perMessageDeflate` option (Bun) - accepted (pending native lws compression support)
   - ✅ `backpressureLimit` option (Bun) - accepted (pending native lws backpressure support)
   - ✅ `closeOnBackpressureLimit` option (Bun) - accepted (pending native lws backpressure support)
   - ✅ `sendPings` option (Bun) - accepted (pending native lws ping config support)
   - ✅ `publishToSelf` option (Bun) - accepted (pending TopicRegistry changes)
   - ✅ `drain(ws)` handler (Bun) - **fully wired**, native `wsi.sendPipeChoked`/`wantWrite()` (`lws_send_pipe_choked()`)
   - Cost: ~40 lines, enables production WebSocket servers
   - Tests: 10 tests in test-websocket-handler-options.js all pass

### Medium-Impact Additions (Requires Native Support)

6. **TCPSocket/WebSocket Drain Handler** ✅ DONE (lib/tcpsocket.js, lib/websocket.js)
   - ✅ `TCPSocket#writableNeedDrain` / `WebSocket#writableNeedDrain` getters, backed by
     the new `wsi.sendPipeChoked` (native `lws_send_pipe_choked()`)
   - ✅ `WebSocket`'s `'drain'` event (and `serve()`'s `websocket.drain` handler) now
     actually fires - see "Native Binding Plan" below
   - TCPSocket itself only got the getter, not a `'drain'` event - nothing in this
     project's TCPSocket API surface calls for one yet (Bun's `Socket` handler has no
     `drain` callback of its own)

7. **WebSocket bufferedAmount** ✅ DONE (lib/websocket.js)
   - ✅ `WebSocket#bufferedAmount` getter (WHATWG/Bun/Deno), backed by the already-existing
     `wsi.bufferedAmount`

8. **UDPSocket Multicast** (lib/udpsocket.js)
   - Add `addMembership(multicastAddress, interfaceAddress?)` (Node/Bun/Deno)
   - Add `dropMembership(multicastAddress, interfaceAddress?)` (Node/Bun/Deno)
   - Requires: expose lws multicast socket options to JS
   - Cost: ~30 lines JS + native changes

### Native Binding Plan: idle timeout, backpressure, TLS peer info ✅ DONE

Three previously-unbound `libwebsockets/include/libwebsockets/*.h` functions
closed several of the "pending native lws ... support" gaps listed above (item
5's `idleTimeout`/`drain`, item 6, and the Server `timeout()` stub in `BUGS`'
`server-missing-11-methods`) - all three are now implemented and tested
(29/29 ctest suites pass; `Server#timeout()` confirmed end-to-end: an idle WS
client is force-closed by the server ~1s after `server.timeout(1)`). JS
surface, in `lws-socket.c` unless noted, following the existing
`PROP_*`/`JS_CGETSET_MAGIC_DEF` getter and plain `JS_CFUNC_DEF` method
conventions:

1. **`lws_set_timeout(wsi, reason, secs)`** (`lws-timeout-timer.h`) — idle timeout
   - Native: `wsi.setTimeout(seconds)` — method, calls
     `lws_set_timeout(wsi, seconds > 0 ? PENDING_TIMEOUT_USER_OK : NO_PENDING_TIMEOUT, seconds)`.
     This is a **hard, auto-closing** timeout (lws force-closes the connection
     itself at expiry) — a different contract than `TCPSocket#setTimeout()`
     (Node-shaped: just emits `'timeout'`, doesn't close), which stays
     unchanged and separate.
   - High-level (`lib/serve.js`): `Server#timeout(seconds)` — replaces the
     no-op stub; applies `wsi.setTimeout(seconds)` to every new HTTP/WS
     connection as it's accepted, matching Bun's server-wide idle-timeout
     semantics. Also used for `websocket.idleTimeout` (item 5 above), which
     takes precedence over the server-wide value when both are set.

2. **`lws_send_pipe_choked(wsi)`** (`lws-ws-state.h`) — backpressure
   - Native: `wsi.sendPipeChoked` — readonly boolean getter (same shape as
     the existing `isPipelineLeader`).
   - High-level: `TCPSocket#writableNeedDrain` (and `WebSocket`'s
     equivalent) — readonly getter mirroring Node's
     `socket.writableNeedDrain`, backed by `wsi.sendPipeChoked`.
   - `websocket.drain` handler (`lib/serve.js`):
     `if(wsDrain) ws.addEventListener('drain', () => wsDrain(ws));` — the
     `'drain'` *event* needs no new native plumbing: `wantWrite()`/
     `waitWrite()` already only fires once the write queue is fully drained
     (`lws-protocol.c:695-700`), so `lib/websocket.js` just arms it via that
     existing mechanism whenever a `send()` leaves `bufferedAmount > 0`.

3. **`lws_tls_peer_cert_info()` / `lws_tls_session_is_reused()`** (`lws-x509.h`/`lws-client.h`) — TLS peer info
   - Native:
     - `wsi.peerCertificate` — readonly getter,
       `{ subjectCN, issuerCN, validFrom, validTo, verified }` (Dates for
       validFrom/validTo) or `null` if not TLS / no peer cert — a
       simplified analog of Node's `tlsSocket.getPeerCertificate()`.
     - `wsi.tlsSessionReused` — readonly boolean getter.
   - High-level: ✅ `TCPSocket#peerCertificate`/`#tlsSessionReused` and
     `WebSocket#peerCertificate`/`#tlsSessionReused` (`lib/tcpsocket.js`,
     `lib/websocket.js`). `ServerRequest` doesn't get its own copies — use
     `request.wsi.peerCertificate` via the existing `.wsi` escape hatch.

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

**Phase 1** (High compatibility gain, no native changes) ✅ **COMPLETE**:
1. ✅ WebSocket static methods (WebSocket.connect, WebSocket.isWebSocket)
2. ✅ TCPSocket socket options (setNoDelay, setKeepAlive, setTimeout) - stubs added
3. ✅ UDPSocket socket options (setBroadcast, setTTL, setMulticastTTL, setMulticastLoopback, addMembership, dropMembership, setMulticastInterface, addSourceSpecificMembership, dropSourceSpecificMembership) - stubs added
4. ✅ Server lifecycle (stop() promise, id, pendingRequests, pendingWebSockets, url, development)
5. ✅ WebSocket handler extensions (ping/pong, idleTimeout, maxPayloadLength, perMessageDeflate, backpressureLimit, closeOnBackpressureLimit, sendPings, publishToSelf, drain)

**Phase 2** (Medium compatibility gain, requires native support):
6. ✅ TCPSocket/WebSocket drain handler (writableNeedDrain + WebSocket 'drain' event)
7. ✅ WebSocket bufferedAmount
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
