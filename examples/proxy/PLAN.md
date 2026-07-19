# Forward proxy example (`examples/proxy/`)

## Context

The project's `examples/` directory demonstrates real usage patterns of the qjs-lws
library (`debugger`, `raw-proxy-fallback`, `websocket-chat`). None of them show a
forward proxy, which exercises a distinct set of primitives: raw byte tunneling,
manual protocol handshakes (SOCKS), and bridging between listener and onward legs.

The goal is a runnable example, modeled after Polipo, that:
- **Listens** for HTTP/1.1 (CONNECT + all other methods) and SOCKS4/5 clients.
- **Connects onward** either directly, through an upstream SOCKS4/5 proxy (the
  classic Polipo "HTTP → SOCKS bridge" use case, e.g. bridging to Tor), or through
  an upstream HTTP(S) proxy via CONNECT.
- Transparently relays HTTP POST streams, h2/long-lived connections, and
  WebSockets — for free, as a consequence of the architecture below, not as
  separate features.
- Is configured via `util.getOpt()` CLI flags and/or a Polipo-style
  (`/etc/polipo/config`) `key = value` config file.

### Two hard constraints found during research (both confirmed with the user)

1. **Absolute-URI requests get a hard 403.** `libwebsockets/lib/roles/http/server/server.c:1692-1698`
   rejects any request-target not starting with `/` *before* any JS callback fires
   — there's no hook to intercept `GET http://host/path HTTP/1.1`. Confirmed
   decision: bypass lws's HTTP role entirely for the proxy-facing listener and
   hand-parse HTTP/1.1 ourselves on a raw socket (same `raw()`/`RawProtocol`
   primitive `examples/raw-proxy-fallback/server.js` already uses, just parsing
   further into the request line/headers).
2. **HTTP/2 has no generic CONNECT-tunnel support.** `libwebsockets/lib/roles/h2/ops-h2.c:539-575`
   only implements the narrow RFC 8441 WebSocket-over-h2 upgrade, not a general
   proxy tunnel. Confirmed decision: document h2 as *tunneled-only* — a CONNECT
   tunnel is always negotiated over HTTP/1.1 (exactly how real browsers already
   talk to forward proxies), and whatever the client/origin negotiate **inside**
   that tunnel (including h2 over TLS) is fully transparent relayed bytes. No h2
   listener is implemented.

### The key architectural insight

Once a destination is known, **every** proxying mode (CONNECT tunnel, plain HTTP
forwarding, SOCKS4/5 tunnel, onward HTTP-CONNECT bridging) reduces to the exact
same operation: parse just enough of the initial bytes to learn the destination
and optionally send a synthetic handshake reply, then **pipe raw bytes
bidirectionally** until either side closes. This is why POST streaming, h2/long
polls, and WebSocket upgrades don't need special-case code — they're just bytes
flowing through an already-open pipe.

## Reusable primitives found (Explore agents)

- **`TCPSocketStream`** (`lib/tcpsocketstream.js`) and **`WebSocketStream`**
  (`lib/websocketstream.js`) both expose `{ readable, writable }` via the shared
  `StreamAdapter` (`lib/lws/protocols.js:502`, export `stream()`) — genuine
  WHATWG streams, directly `pipeTo`-compatible. No two-way pump helper exists yet
  anywhere in the repo; I'll write one small `pipePair(a, b)` utility built on
  `Promise.all([aR.pipeTo(bW), bR.pipeTo(aW)])` (each `.catch(() => {})`'d so one
  side closing doesn't unhandled-reject the other).
- **`raw()`/`RawProtocol`** (`lib/lws/protocols.js:457`) — the `{open, message,
  close, error}` adapter for raw TCP roles, exactly what `examples/raw-proxy-fallback/server.js`
  already uses for its `onRawAdopt/onRawRx/onRawClose` wiring. This is the
  primitive both the HTTP-proxy listener and the SOCKS listener build on.
- **`LWS_SERVER_OPTION_ONLY_RAW`** + `listenAcceptRole: 'raw-skt'` +
  `listenAcceptProtocol` — the exact options combination already proven in
  `tests/unittests/test-server.js`'s "Raw TCP echo server" test, for a listening
  port that's pure raw from the start (no lws HTTP-role parsing at all).
- **`socks_proxy_address`/`socks_proxy_port`** — already wired through to JS in
  `lws-context.c:744-748` (undocumented but functional, guarded by the
  already-compiled-in `LWS_WITH_SOCKS5`). This is vhost-level (applies to every
  client connection made from that vhost/context), which is actually a perfect
  fit for "bridge everything onward through one upstream SOCKS5 server" — I'll
  create a second, dedicated `LWSContext` with these fields set when
  `onward.mode` is `socks5`, and route onward connections through it.
  **No SOCKS4 support exists in libwebsockets at all** (confirmed dead enum,
  `socks5-client.c` hardcodes version 5 everywhere) — SOCKS4 onward will be
  hand-rolled (trivial protocol: an 8-9 byte request, 8 byte reply).
- **`util.getOpt(options, args)`** (`/usr/local/lib/quickjs/util.js:1319`, usage
  pattern confirmed in `qjs-net/test-rpc.js:75-93`) — `{name: [hasArg, handler,
  shortOpt]}` entries plus a `'@'` positional-args entry; returns a flat result
  object. `showHelp(opts, exitCode)` from the same module for `--help`.
- No existing key=value/INI config-file parser anywhere in the ecosystem — small
  parser written from scratch (Polipo's format: `key = value` per line, `#`
  comments, blank lines ignored).

## File layout

```
examples/proxy/
  server.js               entry point: CLI + config load, wires listeners + onward
  lib/config.js           CLI (util.getOpt) + polipo-style config file, merged
  lib/socks-protocol.js   pure SOCKS4/4a/5 message encode/decode (no I/O) - shared
                          by the SOCKS listener and the hand-rolled SOCKS4 onward client
  lib/http-proxy-listener.js   raw-socket HTTP/1.1 listener: CONNECT + all methods
  lib/socks-listener.js   raw-socket SOCKS4/5 listener
  lib/onward.js           resolves a destination -> connected {readable,writable}
                          per onward.mode (direct / socks5 / socks4 / http-connect),
                          + the pipePair() relay utility
  README.md               usage, config file format/example, and the h2/absolute-URI
                          caveats above, stated plainly
```

## Listening side

Two independently configurable ports (either can be disabled by omitting/setting
port to 0), each its own `createServer({ options: LWS_SERVER_OPTION_ONLY_RAW |
LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG, listenAcceptRole:
'raw-skt', listenAcceptProtocol, protocols: [...] })`, mirroring the proven
raw-TCP-echo-server options combination:

- **`proxyPort`** (default 8123, matching Polipo's own default) — HTTP/1.1 proxy
  listener. `onRawRx` buffers until `\r\n\r\n`, parses the request line + `Host`/
  `Content-Length`/`Transfer-Encoding` headers.
  - `CONNECT host:port HTTP/1.1` → resolve onward, and once connected reply
    `HTTP/1.1 200 Connection Established\r\n\r\n` on the client leg, then
    `pipePair()`.
  - any other method → destination from an absolute-URI target if present, else
    from `Host:` (default port 80). Once onward connects, forward the **entire
    already-buffered request** (request line + headers + any body bytes read so
    far) verbatim, then `pipePair()` for everything after. This is what makes
    POST bodies, WebSocket Upgrade requests, and pipelined/streaming traffic work
    without extra code — they're just more bytes in the same pipe.
- **`socksPort`** (default 1080, the SOCKS convention) — SOCKS4/4a/5 listener.
  Peeks the first byte: `0x04` → SOCKS4/4a (`lib/socks-protocol.js` decodes
  VER/CMD/DSTPORT/DSTIP/USERID[/DOMAIN for 4a]); `0x05` → SOCKS5 (version+method
  negotiation, replying "no auth" — documented limitation, no username/password
  supported server-side); then the CONNECT request, ATYP-aware address decoding.
  Only `CMD=CONNECT` is implemented (BIND/UDP ASSOCIATE reply "command not
  supported" — documented limitation, matches the example's scope). On success,
  writes the protocol-appropriate success reply, then `pipePair()`.

## Onward side (`lib/onward.js`)

`resolveOnward(destination, onwardConfig) -> Promise<{readable, writable}>`,
per `onwardConfig.mode`:
- `direct` (default): `new TCPSocketStream({ host, port })`, await `.opened`.
- `socks5`: a dedicated `LWSContext` created once at startup with
  `socks_proxy_address`/`socks_proxy_port` set to the configured upstream SOCKS5
  server; onward connections are plain raw `clientConnect()`s through it — lws's
  own SOCKS5 client handshake happens transparently. This is the "HTTP → SOCKS
  bridge" mode the user asked for (e.g. bridging to a local Tor SOCKS5).
- `socks4`: hand-rolled — plain `TCPSocketStream` to the configured SOCKS4
  upstream, write the encoded SOCKS4 CONNECT request (`lib/socks-protocol.js`),
  read the 8-byte reply, then treat the same stream as the onward leg.
- `http-connect`: hand-rolled — plain `TCPSocketStream` to the configured
  upstream HTTP(S) proxy, write `CONNECT host:port HTTP/1.1\r\nHost: ...\r\n\r\n`
  ourselves, read until the `200` status line + blank line, then treat the same
  stream as the onward leg. Lets the proxy chain onto another HTTP proxy.

## CLI + config (`lib/config.js`)

```js
import { getOpt, showHelp } from 'util';

const opts = getOpt({
  help: [false, (_v, _pv, o) => showHelp(o), 'h'],
  config: [true, null, 'c'],
  'proxy-port': [true, Number],
  'socks-port': [true, Number],
  'onward-mode': [true, null],       // direct | socks5 | socks4 | http-connect
  'onward-host': [true, null],
  'onward-port': [true, Number],
  verbose: [false, (a, v) => (v ?? 0) + 1, 'v'],
}, scriptArgs.slice(1));
```

Config file: default path is documented as mirroring `/etc/polipo/config`
(the example itself defaults to a local `proxy.conf` next to `server.js` unless
`--config` is given); parser strips `#` comments and blank lines, splits each
line on the first `=`, trims both sides. Precedence: built-in defaults <
config file < CLI flags.

## Verification plan

Manual smoke tests (this is an example, not part of the automated test suite):
- `curl -x http://localhost:8123 http://example.com/` — plain HTTP forwarding.
- `curl -x http://localhost:8123 https://example.com/` — CONNECT/HTTPS tunnel
  (confirms h2-over-TLS-inside-the-tunnel works transparently, e.g. via `curl -v
  --http2`).
- `curl --socks5 localhost:1080 https://example.com/` — SOCKS5 listener.
- A small scratch script using this project's own `WebSocketStream`/`WebSocket`
  configured to dial through the proxy (`CONNECT` for wss, or a plain-HTTP ws://
  upgrade through `proxyPort`) — confirms WebSocket relay.
- Onward-SOCKS5 bridging tested by running two instances: one as a plain SOCKS5
  *listener* (this same example, `socksPort` only), the other as an HTTP proxy
  with `onward.mode=socks5` pointed at the first — self-contained, no external
  SOCKS server dependency needed.
- Onward-SOCKS4 and onward-http-connect bridging tested the same self-chaining
  way, or against a real local Tor SOCKS5 (9050) / an upstream `curl`-launched
  test if convenient.

I'll run all of the above during implementation before considering the example
done, deleting any scratch verification scripts afterward.

## Implementation note: onward `socks5` ended up hand-rolled, not lws-native

The plan above (see "Onward side") called for driving libwebsockets' own
built-in SOCKS5 *client* (vhost-level `socks_proxy_address`/`socks_proxy_port`)
for onward `socks5` mode. In testing, dialing an arbitrary per-request
destination through it via a bare RAW-role `clientConnect()` didn't complete
the handshake correctly against a real SOCKS5 server (traced with a packet-
level probe to lws's client sending the greeting, getting our method-selection
reply, then never sending the actual CONNECT request before starting to relay
application bytes - looks like a real gap in how that code path is exercised
outside its more common use, routing an HTTP-role client's own connections).
Onward `socks5` is hand-rolled instead, the same shape as onward `socks4`
(`encodeSocks5Greeting`/`decodeSocks5MethodSelection`/`encodeSocks5Request`/
`decodeSocks5Reply` in `lib/socks-protocol.js`) - verified working against
both the example's own SOCKS5 listener and a real local Tor instance
(port 9050). `lib/onward.js`'s comment on `dialViaSocks5` explains this.

## Addendum: `--proxy-port` also accepts TLS, on the same port

Added after the initial build, per a follow-up request. `LWS_SERVER_OPTION_ONLY_RAW`
(needed so the vhost never runs lws's own HTTP parsing - see the absolute-URI
403 discussion above) was assumed to also skip TLS termination, since it skips
protocol *detection* generally. Checked empirically instead of guessing further:
combining it with `LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT` +
`LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT` + `LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX`
+ a server cert/key *does* still terminate TLS first - confirmed with a raw
probe script logging the decrypted bytes an `onRawRx` callback received from
both a plaintext `nc` connection and a real `openssl s_client` TLS connection,
both succeeding on the same listening port. `lws-context-vhost.h`'s own comment
on `LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG` even says as much:
"Must be combined with LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT to work with
a socket listening with tls." `server.js` now builds `serverSslCert`/
`serverSslPrivateKey` from `--tls-cert`/`--tls-key`, or auto-generates and
persists a self-signed pair via `lib/lws/tls.js`'s existing `loadOrCreateCert()`
under `--tls-dir` (default `./tls`) when none are given - reusing the same
helper `lib/lws/context.js` already uses for this, rather than re-implementing
cert handling. Verified end-to-end: plain HTTP forwarding, TLS-to-proxy plain
forwarding, and TLS-to-proxy CONNECT-tunneled HTTPS (with h2 inside) all work
simultaneously on the one port.

## Addendum: configurable onward DNS servers

Onward hostname resolution (destination host, and any onward SOCKS4/5/
http-connect upstream) already went through libwebsockets' own async DNS
resolver (`asyncDnsServers` on the `LWSContext`) - `lib/lws/context.js`'s
`createContext()` already fills that from `/etc/resolv.conf` when it's not
given. The gap: every onward dial used `TCPSocketStream`
(`lib/tcpsocketstream.js`), whose context is an internal lazy singleton with
no way to pass `asyncDnsServers` in. `onward.js` now builds its own dedicated
context (same `stream()`/`raw()` primitives `TCPSocketStream` itself uses
internally) so `--dns-servers`/`dnsServers` can actually reach it - one
context shared by every onward dial (destination *and* upstream bridge
servers alike), created lazily on first use with whatever DNS servers the
config specifies.
