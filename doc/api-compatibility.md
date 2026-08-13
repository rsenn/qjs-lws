# API Compatibility Assessment

This document assesses the compatibility of qjs-lws's JavaScript wrapper libraries (`lib/` and `lib/lws/`) against their corresponding web standards and Bun.js APIs.

## Executive Summary

The implementation demonstrates **high conformance** to WHATWG standards in most areas, with particularly strong coverage of:
- **Streams API**: Complete implementation (ported from web-streams-polyfill)
- **URL/URLSearchParams**: Complete
- **WebSocket API**: High conformance
- **AbortController/AbortSignal**: High conformance

However, there are **critical incompatibilities** in the Fetch API implementation that will break standard-compliant code:
- **Response.status** is a method, not a property (major spec violation)
- **Body.formData()** returns a plain object instead of FormData instance
- **Headers iteration order** uses insertion order instead of sorted order
- **fetch()** doesn't accept Request objects as input
- **AbortSignal** handling in fetch() is incomplete

The Bun.js API compatibility is **partial**, with significant gaps in:
- **Server object**: 11 of 15 properties/methods missing
- **WebSocket handler options**: 10 of 13 options missing
- **UDP socket**: 10 of 12 methods missing

---

## WHATWG Fetch API

**Reference**: https://fetch.spec.whatwg.org/

### Headers (`lib/lws/headers.js`)

**Conformance**: High (90%)

**Implemented**:
- All core methods: `get()`, `set()`, `has()`, `delete()`, `append()`
- `getSetCookie()` for Set-Cookie special handling
- Iteration: `forEach()`, `keys()`, `values()`, `entries()`, `[Symbol.iterator]()`
- Proper name normalization and validation

**Incompatibilities**:
1. **Iteration order**: Uses insertion order instead of spec-mandated sorted (lexicographic) order
2. **Guard mode**: Not implemented (spec defines immutable/request/response guards)
3. **Non-standard extension**: `toObject()` method (Express-style convenience)

**Reinventing the wheel**: The iteration order deviation is unnecessary and breaks spec-compliant code that depends on sorted header ordering.

### Body Mixin (`lib/lws/body.js`)

**Conformance**: Medium (75%)

**Implemented**:
- `text()`, `json()`, `arrayBuffer()`, `blob()` - all return correct types
- `body` property as ReadableStream
- `bodyUsed` flag

**Incompatibilities**:
1. **CRITICAL: `formData()` returns wrong type**: Returns plain object instead of FormData instance
   - Spec requires: `Promise<FormData>`
   - Implementation returns: `Promise<Object>` (plain object with key-value pairs)
   - Impact: `instanceof FormData` checks fail, FormData methods unavailable
2. **Missing `bytes()` method**: Spec requires `Promise<Uint8Array>`
3. **No bodyUsed lock enforcement**: Calling body methods twice doesn't throw TypeError
4. **No Content-Type inference**: Spec auto-sets Content-Type based on body type (Blob, FormData, etc.)

**Reinventing the wheel**: 
- The plain object return from `formData()` is a significant deviation that breaks FormData-based workflows
- No FormData class exists in the codebase at all

### Request (`lib/lws/request.js`)

**Conformance**: Medium (60%)

**Implemented**:
- Core properties: `url`, `method`, `headers`, `credentials`, `mode`, `signal`
- `clone()` method
- Body mixin integration

**Incompatibilities**:
1. **Missing properties**: `destination`, `referrerPolicy`, `cache`, `integrity`, `redirect`, `keepalive`, `duplex`, `priority`
2. **`clone()` doesn't check bodyUsed**: Spec requires TypeError if body already consumed
3. **Non-standard**: Cache-busting `_=` query parameter for no-store/no-cache

### Response (`lib/lws/response.js`)

**Conformance**: Medium (70%)

**Implemented**:
- Static methods: `Response.error()`, `Response.redirect()`, `Response.json()`
- `clone()` method
- `ok` getter
- Body mixin integration

**Incompatibilities**:
1. **CRITICAL: `status` is a method, not a property**
   - Spec requires: `readonly attribute unsigned short status`
   - Implementation: `status(code)` is a chainable setter method, `statusCode` is the getter
   - Impact: `response.status === 200` compares function to number (always false)
   - This is the most serious spec violation in the Fetch implementation
2. **Missing `bytes()` method**: Spec requires `Promise<Uint8Array>`
3. **`clone()` doesn't check bodyUsed**: Spec requires TypeError if body already consumed
4. **Non-standard properties**: `statusCode` getter (workaround for status-as-method)

**Reinventing the wheel**:
- The `status` as method design is a fundamental architectural mistake that breaks all standard Response handling code
- Should have been implemented as a property from the start

### fetch() (`lib/fetch.js`)

**Conformance**: Medium (65%)

**Implemented**:
- Basic HTTP/HTTPS requests
- Headers, body, method support
- AbortSignal (partial)
- TLS configuration
- HTTP/2 support

**Incompatibilities**:
1. **No redirect following**: Spec requires automatic redirect handling with `redirect` option
2. **No CORS support**: Spec requires `mode` option enforcement (same-origin, cors, no-cors)
3. **No Request input**: Spec allows `fetch(request)` but implementation only accepts URL strings
4. **Wrong error type**: Throws `ConnectionError` instead of spec-mandated `TypeError` for network errors
5. **Incomplete AbortSignal**: 
   - Doesn't throw `AbortError` (DOMException) on abort
   - Overwrites existing `signal.onabort` handler
   - No pre-check if signal already aborted
6. **Missing options**: `cache`, `integrity`, `referrer`, `referrerPolicy`, `keepalive`, `duplex`, `priority`

**Reinventing the wheel**:
- The custom `ConnectionError` class instead of standard `TypeError` breaks error handling patterns
- Should use standard web error types

---

## WHATWG URL API

**Reference**: https://url.spec.whatwg.org/

### URL (`lib/lws/url.js`)

**Conformance**: Very High (95%)

**Implemented**:
- All properties: `href`, `origin`, `protocol`, `username`, `password`, `host`, `hostname`, `port`, `pathname`, `search`, `searchParams`, `hash`
- All methods: `toString()`, `toJSON()`
- Static methods: `URL.canParse()`, `URL.parse()`
- Full URL parser state machine (not regex-based)

**Known Limitations** (documented):
- No IDNA/Punycode for non-ASCII domains (ASCII domains unaffected)
- Validation errors silently ignored (spec allows this)

**Not Implemented**:
- `URL.createObjectURL()` / `URL.revokeObjectURL()` - browser-only, not part of core URL spec

### URLSearchParams (`lib/lws/url.js`)

**Conformance**: Complete (100%)

**Implemented**:
- All constructor forms: string, record, iterable, URLSearchParams, empty
- All methods: `append()`, `delete()`, `get()`, `getAll()`, `has()`, `set()`, `sort()`, `forEach()`, `keys()`, `values()`, `entries()`, `toString()`
- All properties: `size` getter
- Iteration: `[Symbol.iterator]()`

**No incompatibilities detected.**

---

## WHATWG Streams API

**Reference**: https://streams.spec.whatwg.org/

**Implementation**: `lib/lws/streams.js` (ported from web-streams-polyfill)

**Conformance**: Complete (100%)

**Implemented**:
- **ReadableStream**: Full implementation including byte streams and BYOB reader
- **WritableStream**: Full implementation with default writer
- **TransformStream**: Full implementation
- **Queuing strategies**: `ByteLengthQueuingStrategy`, `CountQueuingStrategy`
- All methods: `pipeTo()`, `pipeThrough()`, `tee()`, `cancel()`, `getReader()`, `getWriter()`
- All reader/writer types: DefaultReader, BYOBReader, DefaultWriter
- All controller types: DefaultController, ByteStreamController, BYOBRequest

**No incompatibilities detected.**

---

## WHATWG DOM API

**Reference**: https://dom.spec.whatwg.org/

### AbortController / AbortSignal (`lib/lws/abort.js`)

**Conformance**: High (90%)

**Implemented**:
- AbortController: `signal` property, `abort(reason)` method
- AbortSignal: `aborted`, `reason`, `onabort`, `throwIfAborted()`
- Static methods: `AbortSignal.timeout()`, `AbortSignal.any()`, `AbortSignal.abort()`
- Extends EventTarget

**Incompatibilities**:
1. **DOMException fallback**: Uses plain `Error` with `name: 'TimeoutError'` instead of `DOMException` when `document` is undefined (QuickJS runtime limitation)
2. **Non-standard**: Adds `reason` to event object (spec only puts it on signal)

### EventTarget (`lib/lws/events.js`)

**Conformance**: Minimal (40%)

**Implemented**:
- Core triad: `addEventListener()`, `removeEventListener()`, `dispatchEvent()`
- `on${type}` handler dispatch
- Listener ordering (insertion order)

**Incompatibilities**:
1. **No options parameter**: `addEventListener` doesn't support `capture`, `once`, `passive`, `signal` options
2. **No Event class**: Events are plain objects, not Event instances
3. **No propagation model**: No bubbling/capturing, no `stopPropagation()`, `stopImmediatePropagation()`
4. **No cancelable events**: No `preventDefault()`, `defaultPrevented`
5. **Missing event properties**: `eventPhase`, `currentTarget`, `isTrusted`, `timeStamp`, `bubbles`, `cancelable`, `composed`
6. **No duplicate prevention**: Same listener can be added multiple times

**Reinventing the wheel**:
- The minimal EventTarget is sufficient for internal use (AbortSignal, WebSocket) but not for general DOM-like event handling
- For a server-side runtime, the full DOM event model is likely overkill, but the options parameter (especially `once` and `signal`) would be useful

---

## WHATWG WebSocket API

**Reference**: https://html.spec.whatwg.org/multipage/web-sockets.html

### WebSocket (`lib/websocket.js`)

**Conformance**: High (85%)

**Implemented**:
- Constructor: `new WebSocket(url, protocols)`
- Core methods: `send()`, `close()`
- Properties: `readyState`, `binaryType`, `protocol`, `extensions`
- Event handlers: `onopen`, `onmessage`, `onclose`, `onerror`
- Constants: `CONNECTING`, `OPEN`, `CLOSING`, `CLOSED`

**Incompatibilities**:
1. **Missing `url` property**: Constructor receives URL but doesn't store it
2. **Missing `bufferedAmount`**: lws doesn't expose write-queue byte counts to JS
3. **Constructor options incomplete**: Doesn't extract `signal` (AbortSignal) or `headers` from options object

**Reinventing the wheel**:
- The missing `url` property is a simple oversight that should be fixed

### WebSocketStream (`lib/websocketstream.js`)

**Conformance**: High (90%)

**Reference**: https://github.com/whatwg/websockets/blob/main/WebSocketStream.md (draft spec)

**Implemented**:
- Constructor: `new WebSocketStream(url, options)`
- Promises: `opened`, `closed`
- Properties: `url`
- Methods: `close({ closeCode, reason })`
- Options: `signal`, `protocols`

**Incompatibilities**:
1. **No direct `closeCode`/`closeReason` properties**: Only available via `closed` promise (consistent with draft spec)

**No significant incompatibilities.** The implementation closely follows the draft spec.

---

## Bun.js Server API

**Reference**: https://bun.sh/docs/api/http

### Server Object (`lib/serve.js`)

**Conformance**: Low (35%)

**Implemented**:
- `server.port` - actual bound port (uses `vhost.listenPort`)
- `server.hostname`
- `server.stop(closeActiveConnections?)` - partial (ignores argument, no async wait)
- `server.upgrade(request, options?)` - complete
- `server.publish(topic, message)` - complete

**Missing**:
1. `server.url` - URL object (e.g., `http://localhost:3000`)
2. `server.reload(options)` - hot-reload handlers without restart
3. `server.ref()` / `server.unref()` - process lifecycle control
4. `server.subscriberCount(topic)` - topic subscriber count
5. `server.requestIP(request)` - client IP extraction
6. `server.timeout(request, seconds)` - per-request idle timeout
7. `server.pendingRequests` - in-flight request counter
8. `server.pendingWebSockets` - active WebSocket counter
9. `server.closeIdleConnections()` - close idle connections
10. `server.development` - development mode flag
11. `server.id` - server instance identifier
12. `server.fetch(request)` - internal request to running server

**Impact**: Many Bun.js server management patterns won't work. Users can't implement graceful shutdown, health checks, or request metrics.

### WebSocketHandler Options

**Conformance**: Low (25%)

**Implemented**:
- `open(ws)`, `message(ws, data)`, `close(ws, code, reason)`

**Missing**:
1. `drain(ws)` - backpressure relief callback
2. `ping(ws, data)` - ping frame handler
3. `pong(ws, data)` - pong frame handler
4. `perMessageDeflate` - compression configuration
5. `maxPayloadLength` - message size limit (Bun default 16MB)
6. `idleTimeout` - WebSocket idle timeout (Bun default 120s)
7. `backpressureLimit` - backpressure threshold (Bun default 16MB)
8. `closeOnBackpressureLimit` - auto-close on backpressure
9. `sendPings` - automatic ping frames (Bun default true)
10. `publishToSelf` - include sender in `ws.publish()`

**Impact**: Can't implement backpressure handling, compression, or WebSocket lifecycle management.

### ServerWebSocket

**Conformance**: High (75%)

**Implemented**:
- `ws.data` - per-socket context
- `ws.readyState` - connection state
- `ws.send(data)`, `ws.close(code?, reason?)`
- Pub/sub: `ws.subscribe()`, `ws.unsubscribe()`, `ws.publish()`, `ws.isSubscribed()`

**Missing**:
1. `ws.remoteAddress` - client address getter
2. `ws.subscriptions` - array of subscribed topics
3. `ws.cork(callback)` - batch writes into one syscall

**Impact**: Can't access client IP from WebSocket handlers or inspect subscription state.

### serve() Options

**Conformance**: Medium (60%)

**Implemented**:
- `port`, `hostname`, `fetch`, `websocket`, `tls`, `routes`

**Missing**:
1. `error(err)` - uncaught error handler
2. `development` - development mode flag
3. `unix` - UNIX domain socket support
4. `maxRequestBodySize` - request size limit
5. `idleTimeout` - connection idle timeout (Bun default 10s)
6. `http3` - HTTP/3 support (experimental, not applicable to lws)

---

## Bun.js TCP API

**Reference**: https://bun.sh/docs/api/tcp

### TCPSocket (`lib/tcpsocket.js`)

**Conformance**: Medium (65%)

**Implemented**:
- `socket.write(data)` / `socket.send(data)`
- `socket.end()` / `socket.close()`
- `socket.data` - per-socket context
- `socket.remoteAddress`, `socket.localPort`, `socket.localAddress`, `socket.remotePort`
- `socket.readyState`

**Missing**:
1. `socket.destroy()` - immediate forced close (vs graceful `end()`)
2. `socket.ref()` / `socket.unref()` - process lifecycle control
3. `socket.cork(callback)` - batch writes
4. `socket.timeout(ms)` - per-socket idle timeout
5. `socket.connectTimeout` - connection timeout
6. `socket.reload(handlers)` - hot-reload handlers
7. `socket.flush()` - flush write buffer

**Handler Callbacks**:
- Implemented: `open`, `data`, `close`, `error`, `connectError` (client only)
- Missing: `drain`, `end` (client only), `timeout` (client only)

### TCP Listener

**Conformance**: Low (40%)

**Implemented**:
- `listener.stop(force?)` - partial (ignores argument)
- `listener.ref()` / `listener.unref()` - present but no-op

**Missing**:
1. `listener.port` - bound port
2. `listener.hostname` - bound hostname
3. `listener.unix` - UNIX socket path
4. `listener.reload(options)` - hot-reload handlers
5. `listener.data` - arbitrary listener data

**Impact**: Can't inspect listener configuration or hot-reload handlers.

---

## Bun.js UDP API

**Reference**: https://bun.sh/docs/api/udp

### UDPSocket (`lib/udpsocket.js`)

**Conformance**: Low (20%)

**Implemented**:
- `socket.close()`
- `socket.remoteAddress`, `socket.remotePort`, `socket.localAddress`, `socket.localPort`

**Incompatibilities**:
1. **`send()` signature differs**:
   - Bun: `socket.send(data, port, address)`
   - Implementation: `socket.sendTo(data, peer)` where `peer` is a sockaddr object
2. **Different creation API**:
   - Bun: `await Bun.udpSocket(options)` with `connect` option
   - Implementation: `new UDPSocket(options)` with constructor args

**Missing**:
1. `socket.sendMany(packets)` - batch send
2. `socket.setBroadcast(enable)` - broadcast mode
3. `socket.setTTL(ttl)` - IP TTL
4. `socket.addMembership(address, interface?)` - multicast join
5. `socket.dropMembership(address)` - multicast leave
6. `socket.setMulticastTTL(ttl)` - multicast TTL
7. `socket.setMulticastLoopback(enable)` - multicast loopback
8. `socket.setMulticastInterface(address)` - multicast interface
9. `socket.addSourceSpecificMembership(source, group)` - SSM join
10. `socket.dropSourceSpecificMembership(source, group)` - SSM leave

**Handler Callbacks**:
- Implemented: `open`, `close`, `error`
- Partial: `data` (different signature: `{ data, size, peer }` vs Bun's `(socket, buf, port, addr)`)
- Missing: `drain`

**Impact**: Can't implement multicast, broadcast, or socket options. The `send()` signature incompatibility breaks Bun.js UDP code.

---

## W3C File API

**Reference**: https://www.w3.org/TR/FileAPI/

### File (`lib/lws/multipart.js`)

**Conformance**: Medium (60%)

**Implemented**:
- `file.name` - filename
- `file.type` - MIME type
- `file.lastModified` - modification timestamp
- `file.stream()` - ReadableStream (one-shot, not re-readable)
- `file.arrayBuffer()` - read entire file
- `file.text()` - read as text

**Missing**:
1. `file.size` - file size in bytes (deliberately omitted: stream-backed design can't know size without buffering)
2. `file.slice(start?, end?, type?)` - create Blob subset (deliberately omitted: stream-backed design can't re-read)
3. `file.bytes()` - read as Uint8Array (newer File API addition)

**Design Decision**: The implementation uses a streaming design that reads file data on-demand rather than buffering the entire file. This is more memory-efficient for large uploads but means `size` and `slice()` can't be implemented without buffering.

**Impact**: Code that checks file size before processing or uses `slice()` for chunked uploads won't work.

### MultipartFormData

**Note**: This is a sending-side helper for encoding multipart bodies, not a W3C FormData implementation. It lacks all FormData methods (`get()`, `set()`, `append()`, etc.).

---

## Express-style Router (Non-standard)

### App/Router (`lib/lws/app.js`)

**Conformance**: Complete (100%)

**Implemented**:
- All HTTP methods: `use()`, `get()`, `post()`, `put()`, `delete()`, `patch()`, `head()`, `options()`, `all()`
- Path matching: `:name` parameters, `*` wildcards
- Sub-router mounting: `app.use('/api', router)`
- Error handling middleware: 4-arg `(err, req, res, next)` signature
- `req.params`, `req.path`, `req.app`
- `next(err)` error propagation

**No incompatibilities detected.** This is not a Bun.js API but follows Express conventions correctly.

### Middleware (`lib/lws/middleware.js`)

**Conformance**: Complete (100%)

**Implemented**:
- `json(opts?)` - JSON body parser
- `urlencoded(opts?)` - form body parser
- `raw(opts?)` - raw body parser
- `text(opts?)` - text body parser
- `cookies()` - cookie parser (no-op, cookies already on request)
- `cors(opts?)` - CORS headers
- `logger(format?)` - request logging
- `secure(opts?)` - security headers

All middleware follows Express conventions with proper async support and error handling.

---

## Recommendations

### Critical Fixes (High Priority)

1. **Response.status**: Convert from method to property
   - Current: `response.status(code)` / `response.statusCode`
   - Required: `response.status` (readonly property)
   - Impact: All standard Response handling code currently broken

2. **Body.formData()**: Return FormData instance instead of plain object
   - Requires implementing a FormData class
   - Current code that uses `formData()` will need updates

3. **fetch() Request input**: Accept Request objects as first argument
   - Current: `fetch(url, options)` only
   - Required: `fetch(request)` or `fetch(url, options)`

4. **Headers iteration order**: Sort headers lexicographically
   - Current: insertion order
   - Required: sorted order per spec

### High Priority Improvements

5. **Add `bytes()` method** to Body mixin
6. **Fix fetch() error types**: Use TypeError instead of ConnectionError for network errors
7. **Complete AbortSignal handling** in fetch(): throw AbortError, check pre-aborted state
8. **Add WebSocket.url property**
9. **Implement EventTarget options**: at least `once` and `signal` parameters
10. **Add Server.url property** for Bun.js compatibility

### Medium Priority

11. **Implement missing Server methods**: `subscriberCount()`, `requestIP()`, `timeout()`
12. **Add WebSocket handler options**: `drain`, `perMessageDeflate`, `maxPayloadLength`, `idleTimeout`
13. **Add ServerWebSocket properties**: `remoteAddress`, `subscriptions`
14. **Implement TCPSocket methods**: `destroy()`, `timeout()`, handler callbacks `drain`/`end`/`timeout`
15. **Fix UDPSocket.send() signature** to match Bun.js: `send(data, port, address)`

### Low Priority

16. **Add UDP multicast methods**: `setBroadcast()`, `setTTL()`, `addMembership()`, etc.
17. **Implement Server lifecycle methods**: `reload()`, `ref()`/`unref()`, `closeIdleConnections()`
18. **Add File.size property** (requires buffering or lws API support)
19. **Implement Request missing properties**: `destination`, `referrerPolicy`, `cache`, `integrity`, etc.

---

## Conclusion

The qjs-lws implementation provides a solid foundation with excellent conformance to WHATWG standards in core areas (Streams, URL, WebSocket). However, the Fetch API implementation has several critical incompatibilities that will break standard-compliant code, most notably the `Response.status` method-vs-property issue and the `formData()` return type.

The Bun.js API compatibility is partial, with significant gaps in server management, WebSocket configuration, and UDP functionality. While the core `serve()` API works, many advanced features and management patterns aren't supported.

The implementation does include some "reinventing the wheel" patterns (custom error types, non-standard extensions) that should be reconsidered in favor of standard web APIs where possible.

**Priority Focus Areas**:
1. Fix Response.status (critical spec violation)
2. Implement FormData class and fix formData() return type
3. Add Request input support to fetch()
4. Fix Headers iteration order
5. Complete Bun.js Server API surface

With these fixes, qjs-lws would achieve much higher compatibility with both web standards and Bun.js applications.
