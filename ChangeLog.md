# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/);
this project doesn't cut versioned releases yet, so entries accumulate
under `Unreleased` until that changes.

## Unreleased

### Added

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
