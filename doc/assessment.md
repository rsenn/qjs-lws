# Architecture Assessment

Date: 2026-07-23. Based on a read of the native bindings (`*.c`/`*.h`,
excluding vendored `libwebsockets/`), the JS layer (`lib/`), build
config (`CMakeLists.txt`), docs (`doc/`), tests (`tests/`), and
`TODO.md`/`ChangeLog.md`.

## 1. What this project is

qjs-lws is a QuickJS native module (`lws.so`) that binds
[libwebsockets](https://libwebsockets.org/) (HTTP/1.1, HTTP/2,
WebSocket, raw TCP, MQTT, TLS) into JavaScript, plus a JS-side
standard-library layer (`lib/`) that turns the low-level binding into
Bun/Web-platform-shaped APIs (`fetch`, `serve`, `WebSocket`,
`WebSocketStream`, `TCPSocket`, `URL`, streams).

It is two co-designed layers, not one:

```
lib/              ← ergonomic, spec-shaped JS API (fetch, serve, WebSocket, streams, …)
  lws/*.js
lws.c, lws-context.c,   ← native binding: struct lws_context / lws / lws_vhost
lws-socket.c, lws-vhost.c   wrapped as JSValue objects, callbacks dispatched into JS
libwebsockets/    ← vendored upstream C library (git submodule, plus patches/)
```

## 2. Native layer

| File | Role |
|---|---|
| `lws.c` (~40K) | Module entry point, top-level exports, constants, `LWS_CALLBACK_*` name table, plugin `#include`s |
| `lws-context.c` (~58K, largest file) | `LWSContext` (`struct lws_context`) wrapper: creation-info parsing, the pollfd→event-loop bridge, and `callback_protocol()` — the single dispatcher that turns every libwebsockets callback reason into a JS call |
| `lws-socket.c` (~33K) | `LWSSocket` (`wsi`) wrapper: ~470/460-line magic-keyed method/property tables |
| `lws-vhost.c`, `lws-spa.c`, `lws-tls.c`, `lws-sockaddr46.c` | Vhost, multipart-form parser, TLS config, sockaddr helpers |
| `lws-epoll.c`/`.h` | Optional single-epoll-instance pollfd backend (`USE_EPOLL`) |
| `js-utils.c`/`.h` | Generic QuickJS interop helpers (property/array/buffer marshalling) shared across the binding |

**Event loop model** (documented in `doc/event-loop.md`, and it's the
most important architectural decision in the codebase): qjs-lws never
calls `lws_service()` in a script loop. It forwards libwebsockets's
`ADD_POLL_FD`/`CHANGE_MODE_POLL_FD`/`DEL_POLL_FD` callbacks to
QuickJS's own `os.setReadHandler`/`os.setWriteHandler`, so the
*script's* event loop drives the C library, and the process stays
alive exactly as long as there's a registered fd. This is elegant —
no busy-poll, no second thread, no manual pump — but it does mean the
binding leans on an implicit invariant: user code must never touch
`os.setReadHandler`/`setWriteHandler` on an lws-owned fd, and there's
no assertion or guard enforcing that. The optional `USE_EPOLL` backend
(off by default) collapses N per-fd JS closures into one epoll fd,
which is the right shape for high-connection-count servers but is
newer/less exercised than the default path.

**Callback dispatch — `callback_protocol()`** (`lws-context.c:1417`,
42 `case LWS_CALLBACK_*` branches) is the crux of the binding: for
every reason it decides whether `in`/`len` become a string, an
`ArrayBuffer`, an int, or a mutate-in-place `[buf, len]` pair, then
calls into the user's `callback`/`on<Reason>` JS function. `TODO.md`
already flags this as the single highest-leverage refactor target — a
long if/else cascade where adding a new reason's argument shape means
re-deriving the whole thing, and where a past debugging session lost
the most time. I'd weight this the same way: it's correct today, but
it's the one function in the codebase where a mistake is both easy to
make and expensive to find, because the failure mode is silent
(wrong/missing argument), not a crash.

**Plugin architecture**: libwebsockets's stock protocol plugins
(`deaddrop`, `raw-proxy`, `mirror`, `lws-status`, ACME, sshd, …) are
pulled in via `#include` of their `.c` files directly into `lws.c`,
gated by `PLUGIN_PROTOCOL_*` defines set from `CMakeLists.txt`
`plugin(...)` macro calls. This is a simple, working answer to "how do
we get lws's example protocols into a QuickJS module" but it does mean
the module's object file is textually assembled from vendored sources
at every build — any plugin bug becomes a qjs-lws build bug, and
there's no isolation between plugin code and binding code (shared
translation unit).

**Vendoring**: `libwebsockets/` is a git submodule with a `patches/`
directory (`0001-libwebsockets-txn-queue-introspection.patch`,
`epoll.diff`, `lws-epoll.diff`) applied on top — small, targeted
patches, which is the right way to carry local changes against a
submodule rather than a fork-and-diverge. Worth confirming these are
applied by an automated step (not just documented) so a fresh
`git submodule update` doesn't silently regress.

## 3. JS layer (`lib/`)

Two tiers:

- **`lib/*.js`** (`fetch.js`, `serve.js`, `websocket.js`,
  `websocketstream.js`, `tcpsocket.js`, `tcpsocketstream.js`) — the
  public, spec-shaped surface.
- **`lib/lws/*.js`** (~10.9K lines) — the implementation underneath:
  `protocols.js` (611 lines — `HttpProtocol`/`HttpClientProtocol`/
  `WsProtocol`/`WsClientProtocol`/`RawProtocol`/`StreamAdapter`, the
  glue between native callbacks and the `fetch`/`WebSocket` surface),
  `request.js`/`response.js`/`body.js`/`headers.js`/`multipart.js`
  (WHATWG Fetch primitives), `url.js` (a from-spec WHATWG URL basic
  parser, ~950 lines), `middleware.js`/`session.js`/`app.js` (an
  Express/Koa-shaped middleware stack on top of `serve()`), and
  **`streams.js` (3,881 lines, 158K — by far the largest file in the
  repo)**, a full WHATWG Streams (`ReadableStream`/`WritableStream`/
  `TransformStream`) implementation, evidently ported from
  `web-streams-polyfill` (structure and comments like `// src/lib/...`
  match that project 1:1).

This is a deliberate, coherent choice: rather than a thin native
binding plus "bring your own stdlib," the project ships a
conformance-minded Web-platform layer in JS, with the native code only
providing sockets/TLS/HTTP framing. It raises the bar for what
"correct" means (spec-checked `Headers` injection rejection, UTF-8
correctness, `Response.redirected`, `URLSearchParams` write-through)
but also means `lib/` now carries near-vendored complexity
(`streams.js`) that the project didn't design and must keep in sync
with upstream spec/polyfill fixes by hand, since it's inlined rather
than pulled in as a dependency.

**`app.js`/`middleware.js`/`session.js`** layer a conventional
request-pipeline (routes, middleware chain, sessions) on top of
`serve()`. This is the newest, least-tested tier: per `TODO.md` §3.3,
it has no `tests/unittests/` coverage, only an informal root-level
`tests/test-app.js`.

## 4. Casing/validation inconsistency (real, already diagnosed)

`TODO.md` §1.1 documents a concrete failure: option-object parsers are
split between camelCase (`vhostName`, `sslCa`) and snake_case
(`client_connect_info_fromobj()`'s `local_protocol_name`,
`ssl_connection`, `auth_username`, …), and an unrecognized/wrong-cased
key is silently dropped rather than rejected. This is the kind of bug
that's invisible in code review (the call *looks* right) and only
surfaces as a hang or no-op at runtime. It's the top item in the
existing TODO for a reason — I'd treat "reject unknown option keys" as
higher leverage than "accept both casings everywhere," since the
former turns every future instance of this class of bug into an
immediate loud failure instead of requiring it to be rediscovered.

## 5. Correctness gaps already tracked

`TODO.md` is unusually good source material here — it reads as a real
debugging log, not a wishlist — and I largely agree with its
prioritization. Highlights, most severe first:

1. **`wsi.close()` segfault** when called synchronously from the raw
   role's first callback (`onRawAdopt`/`onRawConnected`) — a real,
   reproducible crash (likely use-after-free racing adopt/connect
   bookkeeping), not just a rough edge. This is the one item in the
   whole assessment I'd call a release blocker if raw-role code paths
   are in active use, since every other issue here is a hang, silent
   drop, or missing feature — this is the only crash.
2. **`toString()` silently returns `undefined`** for typed-array views
   instead of throwing — already caused one real, hard-to-trace
   correctness bug in `stream-utils.js`'s body handling.
3. `callback_protocol()` and `lwsjs_socket_methods()`/`_get()`
   (`lws-socket.c`, ~470/460-line magic-keyed switches) both have the
   "add a case, hope you got the argument shape right" shape described
   in §2 above.
4. `LWSContext.vhost` getter is commented out, which blocks
   `serve()` from reporting the real bound port for ephemeral
   (`port: 0`) listeners — a small, contained fix that unblocks a real
   product gap.

## 6. Test coverage

- `tests/unittests/` (wired into `DO_TESTS`/CMake, using a small
  in-repo `tinytest.js` harness) covers the native primitives well:
  `LWSContext`, `LWSSockAddr46`, `LWSSPA`, `WebSocket`,
  `WebSocketStream`, `TCPSocket`, streams, URL, headers, body,
  request/response.
- `tests/*.js` at repo root (`test-app.js`, `test-middleware.js`,
  `test-serve.js` — the largest at 28.5K, `test-fetch.js`,
  `test-websocket.js`, `test-client.js`, `test-server.js`) are
  substantial and assertion-based but **not** wired into the automated
  `DO_TESTS` run, which only globs `tests/unittests/test-*.js`
  (confirmed in `CMakeLists.txt`). This means the newest and highest
  application-level surface (`serve()`, `app.js`/`middleware.js`) is
  the *least* protected by CI — it has real tests, they're just not
  running automatically. This is a low-cost, high-value fix (move the
  files or add a second glob) and I'd prioritize it above most
  code-level TODOs, since untested-but-tests-exist is pure waste.
- Zero coverage anywhere for `lib/lws/byte-queue.js` and
  `subprocess-stream.js`.
- No dedicated coverage for `protocols.js`'s newer hooks
  (`redirect`/`read`/`handshake`/`filter` client-side,
  `headers`/`html`/`access`/`upgrade`/`auth` server-side) — some were
  only confirmed *not to crash*, not confirmed to actually fire.

## 7. Build system

`CMakeLists.txt` (~18K) is a fairly traditional C/CMake project:
option-gated plugins, in-tree (`BUILD_LIBWEBSOCKETS`) or
system-found libwebsockets, optional in-tree cURL, QuickJS
found/configured via `cmake/FindQuickJS.cmake`, cross-compile support
(mingw/w64 log present in the tree). Builds either a `MODULE` or
`SHARED` library depending on platform — appropriate for a QuickJS
native-module target. Nothing here looks over-engineered; it's
proportionate to a project vendoring two C dependencies with several
optional subsystems (TLS backend, curl, epoll, plugins).

One repo-hygiene note, not architectural: the working tree has
build/debug artifacts checked in or present at the root
(`gmon.out`, `strace.log`, `claude.log`, `core.2404642` under
`examples/debugger/` per `TODO.md` §3.7, plus IDE workspace files
`qjs-lws.sublime-workspace`, `lws-vhost.sublime-workspace`). Worth a
`.gitignore` pass if these aren't meant to be tracked — I did not
change anything here, just flagging it since it came up while
surveying the tree.

## 8. Overall take

This is a well-layered project for what it is: a thin, honest native
binding (native code doesn't try to be clever — it marshals and
dispatches) underneath a genuinely spec-conformant JS platform layer.
The event-loop integration (piggybacking on QuickJS's own `os`
handlers instead of a service loop) is the standout design decision
and is documented well enough to onboard on quickly.

The risk concentration is narrow and already self-diagnosed in
`TODO.md`: almost every open correctness issue traces back to one of
two things — (a) the two giant reason/magic-keyed dispatch functions
(`callback_protocol()`, `lwsjs_socket_methods/get()`) where adding a
case is manual and error-prone, or (b) inconsistent input validation
(casing, `null` vs `undefined`, typed-array vs `ArrayBuffer`) that
fails silently instead of loudly. Neither is a design flaw in the
architecture itself — both are exactly the kind of thing that
accretes in a binding grown callback-by-callback over time, and both
have a clear, incremental fix (table-driven dispatch; reject-unknown
validation) that doesn't require restructuring anything. The
`wsi.close()` segfault (§5.1) is the one item that stands apart from
this pattern — an actual crash rather than a hang or silent drop — and
is worth chasing at the C level before it's hit in production.

The test-infrastructure gap (§6) — good tests that exist but aren't
wired into `DO_TESTS` — is the single cheapest improvement available:
it costs a CMakeLists glob change, not new test-writing effort, and
immediately upgrades CI coverage of `serve()`/`app.js`/`middleware.js`,
today's newest and least-protected code.
