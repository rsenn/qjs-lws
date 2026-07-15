# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/);
this project doesn't cut versioned releases yet, so entries accumulate
under `Unreleased` until that changes.

## Unreleased

### Added

- `lib/lws/url.js`: a conforming subset of the WHATWG URL Standard —
  `URL` and `URLSearchParams`, implemented from the spec's basic URL
  parser state machine (special schemes, relative resolution,
  IPv4/IPv6 hosts, `file:`/opaque-path URLs, percent-encoding per
  component). `URLSearchParams` writes back through to its parent
  `URL`'s `search`/`href`. Known deviation: no IDNA/Punycode (non-ASCII
  domain labels stay as lowercased UTF-8 rather than `xn--` form).
  See [doc/helpers.md](doc/helpers.md#liblwsurljs).
- `Response` gained a `redirected` property (default `false`,
  preserved by `clone()`); `lib/fetch.js` sets it to `true` when lws
  follows a redirect.
- New `USE_EPOLL` CMake option (default `OFF`, Linux-only): routes
  pollfd management through a single `epoll(7)` instance
  (`lws-epoll.c`/`lws-epoll.h`) instead of one `os.setReadHandler`/
  `setWriteHandler` registration per fd. Previously these sources
  existed but were unconditionally excluded from the build. See
  [doc/event-loop.md](doc/event-loop.md#optional-epoll7-backend-use_epoll).
- Traffic logging under `LLL_USER`: every payload actually handed to
  `lws_write()` via `wsi.write()`/`wsi.respond()` now logs a `TX <n>
  bytes (proto=<p>): <preview>` line (`lws-socket.c`), and every
  `LWS_CALLBACK_{CLIENT_RECEIVE,CLIENT_RECEIVE_PONG,MQTT_CLIENT_RX,
  RAW_PROXY_CLI_RX,RAW_PROXY_SRV_RX,RAW_RX,RAW_RX_FILE,RECEIVE,
  RECEIVE_CLIENT_HTTP,RECEIVE_CLIENT_HTTP_READ,RECEIVE_PONG}` fires a
  matching `RX <reason>: <n> bytes: <preview>` line (`lws-context.c`,
  `callback_protocol()`). The preview is the first 40 bytes with
  non-printable bytes replaced by `.` (`log_preview()`, `lws.h`) — no
  new logging plumbing, this rides the existing `logLevel()`
  mechanism, so it's silent unless `LLL_USER` is enabled (as
  `lib/lws/context.js`'s default logger already does when `DEBUG` is
  set) and colorized/filtered the same way any other `LLL_USER`
  message is.

### Fixed

- `lib/lws/body.js`: `Body.prototype.text()` called
  `TextEncoder.encode()` instead of `TextDecoder.decode()`, so
  `response.text()`/`.json()` returned garbage instead of the actual
  body for every real `fetch()` response.
- `lib/lws/stream-utils.js`: `concatArrayBuffer()` passed a raw
  `ArrayBuffer` chunk straight to `Uint8Array.prototype.set()`, which
  silently copies nothing (a bare `ArrayBuffer` has no indexed
  properties) — bodies constructed directly from an `ArrayBuffer`
  (e.g. `new Response(arrayBuffer)`) decoded to all-zero bytes.
- `lib/lws/body.js`: the `Body` constructor only treated `undefined`
  as "no body", not `null` — `Response.error()` and `new
  Response(null)` (the standard no-body idiom, e.g. for 204/304
  responses) always threw `TypeError: bad body: object`.
- `lib/lws/response.js`: `Response.redirect(url)` had no default
  `status`, so omitting it threw instead of defaulting to 302 per
  spec.
- `lib/lws/headers.js`: `Headers` values were never validated —
  `normalizeValue()` now trims leading/trailing HTTP whitespace and
  throws `TypeError` on embedded NUL/CR/LF, matching the Fetch spec
  and closing a header-injection gap (an untrusted value containing
  `"\r\n"` could otherwise smuggle extra headers onto the wire via
  `wsi.addHeader`).

- `LWSSocket` gained `pipelineLeader`, `isPipelineLeader`, and
  `pipelineQueueDepth` accessors for introspecting libwebsockets'
  `LCCSCF_PIPELINE` client connection queueing/muxing (h1 pipelining,
  h2 mux streams) — previously this state was private to `struct lws`
  and unobservable from JS. See
  [doc/LWSSocket.md](doc/LWSSocket.md#pipelining--keep-alive-introspection)
  and
  [doc/http-client.md](doc/http-client.md#connection-pipelining--keep-alive).
- Requires a small patch to the vendored libwebsockets adding the
  underlying `lws_get_txn_queue_leader()`, `lws_wsi_is_txn_queue_leader()`,
  and `lws_get_txn_queue_depth()` C accessors (not present upstream).
  Applied on the `libwebsockets` submodule's `txn-queue-introspection`
  branch; see `patches/0001-libwebsockets-txn-queue-introspection.patch`.
- `lib/fetch.js` now reuses one `LWSContext` (and its single `'http'`
  protocol registration) across calls by default, and sets
  `LCCSCF_PIPELINE`, so repeated `fetch()` calls to the same origin queue
  (h1) or mux (h2) onto an existing connection instead of always opening
  a new one — the point being a crawler that does many requests without
  a new TCP connection per request. Per-request state (`req`/`resp`/
  `resolve`/`reject`/`controller`) moved from closure variables onto the
  `wsi` object `clientConnect()` returns, since many requests now share
  one protocol object and every callback for a connection receives that
  same wrapper. Pass `keepAlive: false`, or a custom `tls` option, to get
  the previous one-off-context-per-call behaviour. The exported
  `fetch(url, options)` signature and `Response`/`Request`/`Headers`
  shapes are unchanged (still WHATWG/W3C-shaped).
- Added `tests/test-fetch.js`: a same-host crawler demo. Fetches an HTML
  fixture, RegExp-scans it for `<a href>`, `<img src>`, `<script src>`,
  `<link href>`, CSS `url(...)`, and bare `http(s)://` URLs, queues and
  fetches same-origin links, reports (without fetching) foreign-origin
  ones, and reports how many distinct TCP connections (`wsi.network.fd`)
  the whole crawl actually used — ideally one. Serves its own tiny fixed
  fixture site via an `LWSMPRO_FILE` mount so the crawl is deterministic
  and needs no network access.

**Not yet verified live**: the `qjs-lws` C build was mid-edit (unrelated,
in-progress work) for the whole time this was written, so `fetch.js`'s
new connection-reuse path and `tests/test-fetch.js` have not actually
been run yet. Re-run `tests/test-fetch.js` once the build is stable and
confirm the summary line reports exactly one distinct TCP connection.
