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
   item 5 below).

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

3. **`lib/lws/app.js`, `middleware.js`, `session.js` have no
   `tests/unittests/` coverage** - only the informal `tests/test-app.js`
   (root-level).

4. **`lib/lws/byte-queue.js` and `subprocess-stream.js` have zero test
   coverage anywhere.**

5. **`tests/test-{app,client,server,websocket,fetch,serve}.js` (repo root)
   aren't wired into the automated run** - `CMakeLists.txt`'s `DO_TESTS`
   only globs `tests/unittests/test-*.js`. Worth a deliberate call:
   promote these into the automated suite (`test-serve.js` already is
   `tinytest`-shaped in spirit, just not using the `tinytest.js` harness;
   the rest are mostly demo/manual scripts today), or document clearly
   that they're manual-only.

6. **No example for the new `lib/serve.js` API.** `examples/` has
   `debugger/`, `raw-proxy-fallback/`, `websocket-chat/` - all built
   directly on the low-level `createServer()` API. A `examples/serve/`
   showing the Bun-shaped `serve(options, fetch)` (and maybe the
   async-iterator form) would be the most direct proof this session's main
   deliverable is actually pleasant to use.

7. **`examples/debugger/` has what look like accidental artifacts** -
   `core.2404642` (a core dump), `gmon.out` (gprof output), a
   `*.sublime-workspace` file - probably shouldn't be tracked in the repo.

## 4. Libwebsockets: unbound subsystems worth extending

`binding_coverage.js` (repo root) currently shows 155/808 (~19%) of
libwebsockets' public API bound. Most of the remaining 653 functions are
genuinely not worth binding (see "Skip" at the end), but a meaningful
slice is - either as new methods on an already-bound class
(`LWSContext`/`LWSVhost`/`LWSSocket`, keyed off which struct their first
argument takes), or as a new small class/module when the function's
"self" type isn't anything currently wrapped.

Sorted by leverage (usefulness to a JS server/client author, weighed
against binding effort) - highest first. Every function named below is
currently unimplemented per `binding_coverage.json`.

**Bind first - high value, low-to-moderate effort:**

1. **[Implemented]** Persistent cookie jar for `fetch()`. `lws-context.c`'s creation-info
   parser already reads dozens of fields like this one; this is five more
   (`http_nsc_filepath`, `http_nsc_heap_max_footprint`, `_max_items`,
   `_max_payload`) plus one new `LCCSCF_CACHE_COOKIES` flag on client
   connect - no new functions to bind at all, `lws-tls.c`'s existing
   `str_property`/flag-OR machinery covers it. Gives `fetch()` persistent,
   automatic cookie sessions across process restarts.
   ```js
   const ctx = createServer({
     port: 8443,
     cookieJar: { path: './cookies.jar', maxItems: 500 }, // http_nsc_* fields
   });

   await fetch('https://example.com/login', { cacheCookies: true, credentials: 'include' });
   await fetch('https://example.com/dashboard', { cacheCookies: true }); // session cookie reused
   ```

2. **Broadcast to every connection of a protocol.**
   `lws_callback_on_writable_all_protocol(context, protocol)` /
   `_vhost(vhost, protocol)` (`lws-writeable.h`) - the real gap identified
   earlier in this project's own session notes: today a chat-room/pub-sub
   server has to hand-roll its own client registry in JS since there's no
   way to nudge every connection of a protocol writable at once. Two
   functions, both extend `LWSContext`/`LWSVhost`.
   ```js
   protocols: [{
     name: 'chat',
     onReceive(wsi, data) {
       this._last = data;
       ctx.broadcast('chat');          // lws_callback_on_writable_all_protocol
     },
     onWritable(wsi) {
       if (this._last) wsi.write(this._last, LWS_WRITE_TEXT);
     },
   }]
   ```

3. **[Implemented]** Per-connection timing diagnostics (conmon). `lws_conmon_wsi_take(wsi,
   &dest)` (`lws-conmon.h`, needs `LWS_WITH_CONMON` + `LCCSCF_CONMON` on
   connect) hands back DNS/TCP-connect/TLS-handshake/time-to-first-byte
   timing plus the actual peer address used - a single getter on the
   already-bound `LWSSocket`, and it reuses the already-bound
   `LWSSockAddr46` wrapper for the peer address.
   ```js
   client.clientConnect('https://example.com/', { method: 'GET', protocol: 'http', conmon: true });
   // ...
   onEstablishedClientHttp(wsi, status) {
     const { dnsUs, connectUs, tlsUs, firstByteUs, peer } = wsi.conmon;
     console.log(`DNS ${dnsUs}us connect ${connectUs}us TLS ${tlsUs}us TTFB ${firstByteUs}us`);
   }
   ```

4. **[Implemented]** Reconnect backoff / connection-validity policy. `lws-retry.h`'s
   `lws_retry_bo_t` is a POD struct hookable onto context/vhost/client-
   connect info exactly like the option objects `tls_creation_info_fromobj`
   already parses - the ping/hangup-liveness half is fully automatic once
   set; the backoff-delay half needs one more function bound
   (`lws_retry_get_delay_ms`) since lws computes the delay but doesn't
   reconnect for you.
   Also settable at context/vhost-creation time (`new LWSContext({ retry })`),
   applying to every connect call on that context unless overridden per-call.
   ```js
   const policy = { retryMsTable: [1000, 2000, 5000, 10000, 30000], jitterPercent: 20, concealCount: 5 };
   client.clientConnect('wss://example.com/feed', {
     protocol: 'ws', localProtocolName: 'ws',
     retry: policy,
   });
   // in your own reconnect loop:
   const { delayMs, tryCount, conceal } = ctx.retryDelay(policy, attemptNumber);
   ```

5. **[Implemented]** Async DNS resolve as a first-class call. `lws_async_dns_query()`
   (`lws-async-dns.h`) - there's already a hand-rolled DNS-over-UDP client
   at repo root (`dns-client.js`) proving the demand; this replaces it with
   lws's own non-blocking, cached, multi-server resolver. One `LWSContext`
   method, returning numeric address strings (not `LWSSockAddr46` - no port
   for a bare resolve() to carry).
   ```js
   const addrs = await ctx.resolve('example.com', { type: 'AAAA' });
   // -> ['2606:2800:220:1:248:1893:25c8:1946']
   ```
   Known issue: querying the same name with both `type: 'A'` and `type:
   'AAAA'` returns the union of both record types instead of just the
   requested one - see BUGS (async-dns-qtype-ignored-on-cache-fill), a
   pre-existing libwebsockets-side issue, not this binding's.

**Bind next - high value, more effort:**

6. **[Implemented]** Native event-loop timers. `lws_sul_schedule(ctx, tsi, sul, cb, us)`
   / `lws_sul_cancel(sul)` (`lws-timeout-timer.h`) - the correct backing
   for JS-level scheduling that shares lws's own event loop instead of a
   second timer source via `os.setTimeout`. One `LWSContext` method
   returning a cancellable handle; the binding owns one opaque wrapper
   (a sul struct + a rooted `JSValue` callback) per scheduled call.
   ```js
   const timer = ctx.schedule(() => console.log('fired'), 5000); // ms delay
   timer.cancel();
   ```

7. **JWK + JWT session auth.** `lws-jwk.h` (`lws_jwk_generate`/`_import`/
   `_export`/`_rfc7638_fingerprint`) as a new `LWSJWK` class, then
   `lws-jwt-auth.h`/`lws_jwt_*` (`lws-jws.h`) on top: `lws_jwt_sign_compact`,
   `lws_jwt_signed_validate`, and the two wsi-scoped cookie helpers
   `lws_jwt_sign_token_set_http_cookie`/`lws_jwt_get_http_cookie_validate_jwt`
   that mint/read a hardened (secure/httpOnly/sameSite), alg-pinned session
   cookie in one call. Needs `LWS_WITH_JOSE`+`LWS_WITH_GENCRYPTO`. Session
   auth is the single most commonly-needed and most commonly-misimplemented
   feature a JS server author reaches for.
   ```js
   import { LWSJWK, jwtSign, jwtVerify } from 'lws.so';

   const key = LWSJWK.generate({ kty: 'oct', bits: 256 });
   const token = jwtSign(key, { sub: 'user-42', exp: Math.floor(Date.now() / 1000) + 3600 });
   const claims = jwtVerify(key, token, { alg: ['HS256'] }); // throws if invalid/expired/wrong alg

   // wsi-scoped, inside an onHttp handler:
   wsi.setJwtCookie(key, { sub: user.id }, { name: 'session', secure: true, httpOnly: true, sameSite: 'Strict' });
   const claims2 = wsi.getJwtCookie(key, { name: 'session' }); // null if missing/invalid/expired
   ```

8. **Generic crypto: hash / HMAC / HKDF / AES.** `lws-genhash.h`
   (`lws_genhash_init`/`_update`/`_destroy`, `lws_genhmac_*`,
   `lws_genhkdf_*`) and `lws-genaes.h` (`lws_genaes_create`/`_crypt`/
   `_destroy`) as new `Hash`/`Hmac` classes - QuickJS has no WebCrypto, and
   this is a ~3-function wrapper per algorithm over `ArrayBuffer`. RSA/EC
   (`lws-genrsa.h`/`lws-genec.h`) are lower priority - reach them via JWK
   (#7) once that exists, since they share the same key-element
   representation.
   ```js
   import { Hash, Hmac } from 'lws.so';

   const digest = new Hash('sha256').update('hello').update(' world').digest(); // ArrayBuffer
   const mac = new Hmac('sha256', key).update(body).digest('hex');
   ```

9. **Metrics, read path only.** `lws_metrics_foreach(ctx, user, cb)` +
   `lws_metrics_format()` (`lws-metrics.h`, needs `LWS_WITH_SYS_METRICS`) -
   enumerate lws's own built-in per-layer instrumentation (DNS/connect/
   TLS/http counters, means, histograms) as plain JS objects. Skip the
   policy/reporting/caliper side, which is much more work for much less
   value than just reading what's already being measured.
   ```js
   for (const m of ctx.metrics()) console.log(m.name, m.count, m.mean, m.buckets);
   ```

**Conditional / opportunistic:**

10. **WebTransport.** `lws_wt_create_stream(session, unidi)` /
    `lws_wt_get_session_wsi(wsi)` / `lws_wt_is_session(wsi)` /
    `lws_wt_is_unidi(wsi)` (RFC 9297 over HTTP/3 + QUIC datagrams) - tiny
    API surface, all wsi-scoped so it drops straight onto the existing
    `LWSSocket`/protocol-callback dispatch, but entirely gated on whether
    the vendored libwebsockets build has QUIC/H3 enabled (a much bigger
    dependency question than the binding itself - check
    `cmake/BuildLibwebsockets.cmake`). Cheap and differentiating if H3 is
    on; zero value if not.
    ```js
    protocols: [{
      name: 'wt',
      onEstablished(session) {                    // session wsi, promoted from H3 CONNECT
        const stream = session.createStream({ unidi: false });
        stream.write(data);
      },
      onReceive(wsi, data) {
        if (wsi.isWtSession) { /* unreliable datagram */ }
        else { /* reliable stream data; wsi.wtSession gives the owning session */ }
      },
    }]
    ```

11. **TLS session resumption save/load.** `lws_tls_session_dump_save`/
    `_load(vhost, host, port, cb, opaque)` (`lws-tls-sessions.h`) - the
    caching itself is already on by default (just expose the two
    `info.tls_session_cache_max`/`tls_session_timeout` knobs); these two
    functions let a short-lived JS CLI process persist sessions to disk
    for sub-RTT reconnects across runs. Both vhost-scoped.
    ```js
    writeFileSync('./session.bin', vhost.dumpTlsSession('example.com', 443));
    // next process start:
    vhost.loadTlsSession('example.com', 443, readFileSync('./session.bin'));
    ```

12. **Vhost dynamic mounts + proxy/SOCKS.** `lws_vhost_set_mounts(v,
    mounts)`, `lws_set_proxy(vhost, url)`, `lws_set_socks(vhost, url)`
    (`lws-context-vhost.h`) - today mounts and outbound proxying are
    creation-time-only options; these let a long-lived `LWSVhost` be
    reconfigured at runtime.
    ```js
    vhost.setMounts([{ mountpoint: '/static', origin: './public', originProtocol: LWSMPRO_FILE }]);
    vhost.setProxy('http://proxy.local:3128');
    ```

13. **Streaming JSON parser (LEJP).** `lejp_construct`/`lejp_parse`/
    `_destruct` (`lws-lejp.h`) - `JSON.parse` needs the whole string
    buffered first; LEJP parses arbitrary-size, slowly-arriving JSON (e.g.
    a large streamed request body) in bounded memory via path-matched
    callbacks. Only worth it if streaming bodies are an actual use case -
    `JSON.parse` covers everything else.
    ```js
    import { JSONStreamParser } from 'lws.so';

    const parser = new JSONStreamParser(['user.name', 'user.email', 'items[]']);
    parser.on('user.name', v => console.log('name:', v));
    for await (const chunk of req.body) parser.write(chunk);
    ```

14. **SMD (in-process pub/sub for lws's own events).**
    `lws_smd_register(ctx, flags, class_filter, cb)` / `lws_smd_msg_printf`
    (`lws-smd.h`) - payloads are already JSON, so the binding is almost
    free; the real value is receiving lws's own system/network/metrics
    events as structured data instead of parsing log lines. A pure-JS
    `EventTarget` covers JS-to-JS pub/sub already, so bind the subscribe
    side for lws-originated messages and treat the publish side as a
    freebie.
    ```js
    ctx.smd.on('network', msg => console.log('network event:', msg));
    ctx.smd.emit('user', { kind: 'signup', id: 42 });
    ```

15. **Small utility grab-bag.** Cheap, standalone, no state: `lws_is_lan_address`/
    `lws_is_local_address`/`lws_parse_cidr` (`lws-network-helper.h`, useful
    for JS-side access-control decisions), `lws_strcmp_wildcard`
    (`lws-tokenize.h` - the *exact* glob matcher lws itself uses for vhost
    names, mount paths and cert SAN matching, so routing logic written in
    JS provably agrees with what lws will do), and `lws_upng_get_width`/
    `_height`/`lws_jpeg_get_width`/`_height` (metadata-only, no pixel
    decode - lets an upload handler learn image dimensions from the first
    few KB without a full image library).
    ```js
    import { isLanAddress, isLocalAddress, matchWildcard, imageSize } from 'lws.so';

    isLanAddress('192.168.1.5');                        // true
    matchWildcard('*.example.com', 'api.example.com');   // true
    imageSize(uploadedBuffer);                           // { width, height, format }, no full decode
    ```

**Lower priority - real but niche:**

16. **VFS passthrough.** `lws_set_fops(ctx, fops)` (`lws-vfs.h`) would let
    a JS-implemented virtual filesystem (in-memory assets, a bundler
    output, a database) be served through lws's fully-featured static
    file mount - ranges, compression negotiation, caching headers, all for
    free. Attractive, but lws calling back into JS mid-file-service
    (possibly reentrantly) is the trickiest reentrancy problem in this
    entire list. Don't attempt without a clear plan for that.

17. **TTL cache.** `lws_cache_create`/`_write_through`/`_item_get`
    (`lws-cache-ttl.h`) as a new `LWSCache` class. JS already has `Map`;
    the only non-duplicative part is TTL expiry + LRU footprint capping,
    and cached-pointer-valid-only-until-you-return-to-the-event-loop
    doesn't survive contact with JS values without an extra copy anyway.
    Bind only if someone actually asks for it.

18. **Fault injection.** `lws_fi_deserialize(fic, "namespace/fault(30%)")`
    (`lws-fault-injection.h`, needs `LWS_WITH_SYS_FAULT_INJECTION`) - one
    function, whole config surface is a string. Genuinely useful for
    testing *qjs-lws's own* error-path handling (does JS do the right
    thing when TLS fails on purpose?) but it's a test tool, not something
    a server ships - low priority, bind cheaply if at all.

**Skip - deliberately not worth it:**

Secure Streams (`lws-secure-streams*.h`) is a whole parallel API surface
with its own JSON policy language and state machine that duplicates,
rather than complements, the wsi/protocol-callback model qjs-lws already
exposes - big effort for redundant payoff. Display list objects
(`lws-dlo.h`, 41 unimplemented functions) and image *rendering*
(`lws-upng.h`/`lws-jpeg.h` past the metadata scan in #15) are the
rasterization half of lws's HTML-to-e-ink-panel stack - line-by-line
output to a physical display driver, no framebuffer, no "render to a
buffer and serve it" exit path - confirmed embedded-GUI-only, not useful
headless. Backtrace/crash diagnostics (`lws-backtrace.h`) produce C frame
addresses meaningless to a JS author who already has QuickJS's own stack
traces. The old `lws-diskcache.h` is undocumented and redundant with #17.
`lws-struct.h` (C struct↔JSON↔sqlite3 mapping) exists to give C code the
JSON story JS already has natively. Generic containers (`lws-map.h`,
`lws-dll2.h`, `lws-lwsac.h`) are internal-use-only - `lws_dll2` is
intrusive by design (lives *inside* a C struct, no JS analogue) and JS's
own `Map`/`Array`/GC beat an FFI round-trip per operation; keep using them
internally in the binding, don't expose them. Threadpool
(`lws-threadpool.h`) has the right shape (wsi-bound task completion
reenters the event loop as a writable callback) but tasks run on another
OS thread and a `JSContext` isn't thread-safe - don't bind this until/
unless qjs-lws grows a worker story; binding it naively produces race
crashes. System state/lifecycle machinery (`lws-system.h`/`lws-state.h`)
is almost entirely about embedded bring-up (no clock yet, no DHCP lease
yet, no policy yet) - irrelevant to a Linux process that's already
booted, though `README.lifecycle.md`'s role→callback-reason table is
worth reading as reference material for qjs-lws's own callback docs.

Most of the "bind first"/"bind next" items above are optional cmake
features in libwebsockets itself (`LWS_WITH_SYS_METRICS`,
`LWS_WITH_CONMON`, `LWS_WITH_SYS_ASYNC_DNS`, `LWS_WITH_JOSE`,
`LWS_WITH_GENCRYPTO`, `LWS_WITH_CACHE_NSCOOKIEJAR`) - whichever of these
get bound will need `#ifdef` guards and should probably surface a
capability object so JS can feature-detect rather than crash on a build
that doesn't have them enabled.
