# TODO

Grounded in issues actually hit and gaps actually observed while building
`lib/lws/protocols.js`, `lib/serve.js`, and the `fetch`/`WebSocket(Stream)`/
`TCPSocket(Stream)` rewrites, plus a targeted read of the native `.c`/`.h`
files (excluding vendored `libwebsockets/`).

## 1. C: refactoring + more native binding

Sorted by leverage - highest-impact / most-likely-to-bite-someone-again first.

1. **Standardize option-object key casing across the native parsers.**
   `client_connect_info_fromobj()` (`lws-context.c`) reads snake_case keys
   (`local_protocol_name`, `ssl_connection`, `local_port`, `keep_warm_secs`,
   `auth_username`, `auth_password`), while other option objects
   (`createContext()`'s info, `sslCa`/`clientSslCa`, `vhostName`, ...) lean
   camelCase. A wrong-cased key is silently *ignored*, not rejected - this
   caused a real, multi-hour-to-diagnose hang this session
   (`localProtocolName` vs `local_protocol_name` in
   `HttpClientProtocol.connect()`, `lib/lws/protocols.js`): the connection
   opened, negotiated, and then just sat there because no protocol object
   ever got bound. Either make these `_fromobj` parsers accept both
   casings, or - cheaper and safer - throw/warn on any object key that
   isn't a recognized option name, so a typo fails loud instead of silent.

2. **`wsi.close()` segfaults when called synchronously from the raw
   role's very first callback** (`onRawAdopt` server-side, `onRawConnected`
   client-side) - confirmed directly and reproducibly, both directions,
   in isolation against a plain `createServer()`/`LWSContext` pair (see
   `tests/unittests/test-tcpsocket.js`'s comments on the two tests that
   had to route around it). Closing from a *later* callback (`onRawRx`,
   or a `setTimeout(() => wsi.close(), 0)`-deferred call right after
   adopt/connect) works fine - only the immediate, same-call-stack close
   crashes. Smells like a use-after-free/double-free in wsi teardown
   racing the adopt/connect callback's own still-in-progress bookkeeping.
   Not chased further at the C level this session (scope was JS-side
   wrapper classes + tests), but a real crash, not just a hang - highest
   severity of anything in this file, even though the trigger is narrow.

3. **`toString()` (`lws.c`, `FUNCTION_TO_STRING`) silently returns
   `undefined` for typed-array views** instead of accepting them or
   throwing. Confirmed directly: `toString(new Uint8Array(...))` →
   `undefined`, `toString(view.buffer)` → the correct string. This is what
   caused `lib/lws/stream-utils.js`'s `concatArrayBuffer()` (which used to
   return a `Uint8Array`, not the `ArrayBuffer` its own JSDoc promised) to
   silently break `Body.text()`/`.json()` for *every* body, everywhere,
   with no error to point at - just a body that read back as `undefined`.
   Either accept `ArrayBuffer`-backed views directly, or throw a
   `TypeError` for unsupported input so a similar future mismatch fails at
   the call site instead of several layers up.

4. **Break up `callback_protocol()`** (`lws-context.c:1456-1736`, ~280
   lines) - one long if/else-if cascade doing per-`reason` argument
   marshalling for the JS callback dispatch (deciding whether `in`/`len`
   become a string, an ArrayBuffer, an int, a `[buf, len]` pair to mutate,
   etc., case by case). A `{reason: marshaller}` table (or one small static
   function per special-cased reason instead of one branch each in a
   shared function) would make it far easier to correctly add a new
   reason's argument shape without re-deriving the whole cascade - this is
   exactly the class of bug that ate the most debugging time this session.

5. **Break up `lwsjs_socket_methods()` / `lwsjs_socket_get()`**
   (`lws-socket.c`, ~470 / ~460 lines) - same shape, same rationale: one
   giant `magic`-keyed switch each for every `LWSSocket` method/property.

6. **`LWSContext.vhost` getter is commented out**
   (`lws-context.c:1234`). Right now the only way to reach a vhost object
   is `ctx.getVhostByName(name)`, and `serve()` (`lib/serve.js`) has no
   reliable way to report the *actual* bound port - `Server.port` just
   echoes back whatever was requested, including `0` for an OS-assigned
   ephemeral port. Uncommenting this (or exposing "the default vhost" when
   only one exists) is a small, contained win that unblocks a real gap in
   `lib/serve.js` (see §2).

7. **MQTT is only reachable generically.** `LWS_CALLBACK_MQTT_*` reasons
   are named in the reason table (`lws.c`) so they already dispatch through
   the generic `on<CamelCase>` mechanism, but there's no MQTT-specific
   convenience surface (subscribe/publish/QoS, `lws_mqtt_client_send_publish`,
   etc.) the way HTTP/WS/RAW get via `client_connect_info_fromobj()`'s
   `method`/`protocol` handling. Lowest leverage here since MQTT probably
   isn't a primary use case - but worth an explicit "not supported yet"
   decision rather than leaving an accidental half-surface.

## 2. JS: wrappers / auxiliary functions

1. **`serve()` can't report the real bound port** (`lib/serve.js`,
   `Server` class) - depends on C §1.5 above, but even a workaround
   (`ctx.getVhostByName(host)` right after `createContext()`, falling back
   to the requested port) would be a real improvement over echoing back a
   possibly-`0` port.

2. **`Body.text()`/`.arrayBuffer()`/`.json()` throw on a `null` body**
   (`lib/lws/body.js`) instead of resolving to `''`/an empty buffer like a
   real WHATWG `Request`/`Response` does (`new Request(url).text()` is
   `''`, not a throw). Hit directly this session and had to work around it
   in `serve()`'s own request handler (`req.body ? await req.text() : ''`).
   `arrayBuffer()` should just treat `this.body == null` as "empty" rather
   than calling `readWholeStream(null)`.

3. **No static-file convenience in `serve()`.** The low-level mount API
   (`LWSMPRO_FILE`) already serves files efficiently at the C level, but
   the new Bun-shaped `serve()` has no ergonomic "serve this directory"
   option the way `Bun.serve({ static: {...} })` / a `Bun.file()`-backed
   `Response` does - right now static serving means dropping to
   `options.mounts` by hand.

4. **`serve()`'s WS support is mount-path-only, not `server.upgrade()`-style.**
   Bun's `fetch(req, server)` decides *dynamically*, per request, whether
   to call `server.upgrade(req)`; our `serve()` only upgrades connections
   that hit a statically-configured mount path (`/ws` by default) - a
   deliberate scoping call made when `serve()` was first written, listed
   here as a known, real gap rather than an oversight.

5. **`HttpClientProtocol.connect()` always buffers the whole request body**
   (`lib/lws/protocols.js`) before sending, to know `content-length` up
   front (see C §1 - lws's client body write has no chunked-encoding
   fallback). Fine for typical bodies; there's no path for streaming a
   body of unknown size without buffering it entirely in memory first.

6. **Duplicated wsi-introspection helpers.** Now that `WebSocketStream`/
   `TCPSocketStream` are independent of `WebSocket`/`TCPSocket` (as of the
   last two commits), the small `protocol`/`extensions` getters and
   `peer`/`local`-address readers are defined twice each, once per
   evented/streamed pair. Worth pulling into one shared
   `lib/lws/wsi-info.js` now that there's no other reason for the
   duplication.

7. **`lib/lws/mimetypes.js`'s `extraMimetypes` list is tiny and oddly
   personal** (`.sublime-project`, `.sublime-workspace` alongside `.md`/
   `.c`/`.h`) - reads like a dev's local leftovers rather than a general
   table. Either expand it into a real common-mimetypes list or document
   that it's meant to be supplied/extended per app.

## 3. Tests / examples

1. **`lib/serve.js` has real assertion-based coverage now**
   (`tests/test-serve.js`, 27+ `tinytest`-style cases: callback mode,
   iterator mode, WS-via-iterator, raw fallback vs. `raw: { always }`,
   `Class` selection, `content-length` handling) - but it's root-level,
   not `tests/unittests/`, so it's still not wired into `DO_TESTS` (see
   item 6 below).

2. **No dedicated `tests/unittests/` coverage for `lib/lws/protocols.js`.**
   `HttpProtocol`/`HttpClientProtocol`/`WsProtocol`/`WsClientProtocol`/
   `RawProtocol`/`StreamAdapter` are only exercised indirectly (through
   `test-websocketstream.js`/`test-tcpsocket.js`/`test-websocket.js` and
   `test-client.js`'s low-level scenarios). The newer hooks specifically
   (`redirect`/`read`/`handshake`/`filter` on the client side,
   `headers`/`html`/`access`/`upgrade`/`auth` on the server side) have
   essentially zero automated coverage - `headers`/`upgrade`/etc. weren't
   even confirmed to *fire* under any tested mount configuration, only
   confirmed not to crash when wired in (confirmed *not* to fire for a
   `LWSMPRO_CALLBACK` mount specifically - see `test-serve.js`'s note next
   to its dropped `options.headers` test).

3. **No `tests/unittests/` coverage for `lib/fetch.js`** - only the manual,
   non-assertion-based crawl script `tests/test-fetch.js` (root-level, not
   in `unittests/`). The redirect-following and POST-body-actually-gets-sent
   behavior added/fixed this session have no regression test pinning them
   down.

4. **`lib/lws/app.js`, `middleware.js`, `session.js` have no
   `tests/unittests/` coverage** - only the informal `tests/test-app.js`
   (root-level).

5. **`lib/lws/byte-queue.js` and `subprocess-stream.js` have zero test
   coverage anywhere.**

6. **`tests/test-{app,client,server,websocket,fetch,serve}.js` (repo root)
   aren't wired into the automated run** - `CMakeLists.txt`'s `DO_TESTS`
   only globs `tests/unittests/test-*.js`. Worth a deliberate call:
   promote these into the automated suite (`test-serve.js` already is
   `tinytest`-shaped in spirit, just not using the `tinytest.js` harness;
   the rest are mostly demo/manual scripts today), or document clearly
   that they're manual-only.

7. **No example for the new `lib/serve.js` API.** `examples/` has
   `debugger/`, `raw-proxy-fallback/`, `websocket-chat/` - all built
   directly on the low-level `createServer()` API. A `examples/serve/`
   showing the Bun-shaped `serve(options, fetch)` (and maybe the
   async-iterator form) would be the most direct proof this session's main
   deliverable is actually pleasant to use.

8. **`examples/debugger/` has what look like accidental artifacts** -
   `core.2404642` (a core dump), `gmon.out` (gprof output), a
   `*.sublime-workspace` file - probably shouldn't be tracked in the repo.
