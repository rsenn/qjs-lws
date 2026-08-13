# `LWSContext`

A wrapper around `struct lws_context`. The context owns the default
vhost, the listener (if any), the protocol callback table, and any
mounts. Implemented in `lws-context.c`.

## Construction

```js
const ctx = new LWSContext(info);
```

`createServer(info)` (exported from `'lws'`) is a thin alias for the
same constructor call — `JS_CallConstructor` on `LWSContext` under
the hood — meant for call sites where `info.port` is set, i.e. the
context will listen. It's purely a naming convenience; the two are
otherwise identical, and either is fine for a client-only context
too.

`info` is a plain object mapped to `struct lws_context_creation_info`.
**Properties whose JS name is `camelCase` are also accepted in their
underscore form** (e.g. `vhostName` or `vhost_name`), thanks to the
`camelize` lookup in `js-utils.c`.

Whenever a property is not provided **and `port` is missing**, the
context is created with `port = CONTEXT_PORT_NO_LISTEN` (no listener
— suitable for pure clients).

### Common properties

| Property | C field | Description |
|----------|---------|-------------|
| `port`               | `port`               | TCP port to listen on (`CONTEXT_PORT_NO_LISTEN` to disable) |
| `iface`              | `iface`              | Interface address or name to bind |
| `vhostName` / `vhost_name` | `vhost_name`   | Default vhost name |
| `protocols`          | `protocols`          | Array of protocol handler objects, see [protocols.md](protocols.md) |
| `mounts`             | `mounts`             | HTTP mount points (array or `{ '/path': mount }` object) |
| `headers`            | `headers`            | `lws_protocol_vhost_options` — default response headers |
| `pvo`                | `pvo`                | Per-vhost options |
| `rejectServiceKeywords` | `reject_service_keywords` | List of keywords to reject |
| `httpProxyAddress`   | `http_proxy_address` | HTTP proxy host |
| `httpProxyPort`      | `http_proxy_port`    | HTTP proxy port |
| `keepaliveTimeout`   | `keepalive_timeout`  | TCP keepalive seconds |
| `logFilepath`        | `log_filepath`       | Server log file |
| `serverString`       | `server_string`      | `Server:` header |
| `errorDocument404`   | `error_document_404` | URL for 404 errors |
| `vhListenSockfd`     | `vh_listen_sockfd`   | Pre-allocated listen fd |
| `defaultLoglevel`    | `default_loglevel`   | Per-context log level |
| `options`            | `options`            | OR-mask of `LWS_SERVER_OPTION_*` constants |
| `listenAcceptRole`   | `listen_accept_role` | Role applied when `FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG` or `ADOPT_APPLY_LISTEN_ACCEPT_CONFIG` is set (e.g. `'raw-skt'`) |
| `listenAcceptProtocol` | `listen_accept_protocol` | Protocol name applied with the role. Can be anywhere in the `protocols` array. |
| `asyncDnsServers`    | `async_dns_servers`  | Array of DNS server strings (built with `LWS_WITH_SYS_ASYNC_DNS`) |

### TLS properties

Built only when libwebsockets is compiled with `LWS_WITH_TLS`. Each
of `serverSsl*` / `clientSsl*` may be **either** a file path string
(`*_filepath`) **or** an `ArrayBuffer` containing the certificate or
key material (`*_mem` / `*_mem_len` set accordingly). The
`str_or_buf_property()` helper picks the right field automatically:

| Property | C field(s) |
|----------|------------|
| `sslPrivateKeyPassword`      | `ssl_private_key_password` |
| `serverSslCert`              | `ssl_cert_filepath` *or* `server_ssl_cert_mem` |
| `serverSslPrivateKey`        | `ssl_private_key_filepath` *or* `server_ssl_private_key_mem` |
| `serverSslCa`                | `ssl_ca_filepath` *or* `server_ssl_ca_mem` |
| `sslCipherList`              | `ssl_cipher_list` |
| `tls13PlusCipherList` / `tls1_3_plus_cipher_list` | `tls1_3_plus_cipher_list` |
| `clientSslPrivateKeyPassword`| `client_ssl_private_key_password` |
| `clientSslCert`              | `client_ssl_cert_filepath` *or* `client_ssl_cert_mem` |
| `clientSslPrivateKey`        | `client_ssl_private_key_filepath` *or* `client_ssl_key_mem` |
| `clientSslCa`                | `client_ssl_ca_filepath` *or* `client_ssl_ca_mem` |
| `clientSslCipherList`        | `client_ssl_cipher_list` |
| `clientTls13PlusCipherList`  | `client_tls_1_3_plus_cipher_list` |

### SOCKS5

Built only with `LWS_WITH_SOCKS5`:

| Property | C field |
|----------|---------|
| `socksProxyAddress` | `socks_proxy_address` |
| `socksProxyPort`    | `socks_proxy_port` |

### WebSocket extensions

| Property | C field | Description |
|----------|---------|-------------|
| `permessageDeflate` | `extensions` | Boolean. When true (and the build has `LWS_ROLE_WS`), installs the `permessage-deflate` extension with the parameters `client_no_context_takeover; client_max_window_bits`. **Off by default** — decompression-chunk boundaries don't line up with WS message/frame boundaries (`lws_is_final_fragment()` tracks the former), so a large message sent with compression on can arrive as several separate `onReceive`/`onClientReceive` calls that JS has no reliable way to tell belong together. Only opt in if you don't depend on message/fragment boundaries, or you handle reassembly yourself. |

## Instance methods

| Method | Notes |
|--------|-------|
| `destroy()`                         | Calls `lws_context_destroy()`; sets internal pointer to NULL. Returns `true`. |
| `getVhostByName(name)`              | Returns the matching `LWSVhost` or `undefined`. |
| `adoptSocket(fd)`                   | Adopts an existing OS socket; returns `LWSSocket`. Throws if `fd` is already adopted. |
| `adoptSocketReadbuf(fd, buf)`       | Same as above but with pre-buffered read data. |
| `cancelService()`                   | `lws_cancel_service()` and cleans up io handlers. |
| `clientConnect(uriOrInfo [, info])` | Initiates an outbound client connection. See below. |
| `getRandom(buf)`                    | Fills the ArrayBuffer with libwebsockets random bytes. |
| `asyncDnsServerAdd(addr)`           | `LWSSockAddr46`-style; returns int. |
| `asyncDnsServerRemove(addr)`        | Removes a previously added DNS server. |
| `wsiFromFd(fd)`                     | Looks up the `LWSSocket` for an OS fd, or `undefined`. |
| `createUdp(options)`                | Creates (and, unless `bind` is set, connects) a UDP socket via `lws_create_adopt_udp()`. Built only with `LWS_WITH_UDP`. See below. |

### `clientConnect`

Two call styles:

```js
ctx.clientConnect('https://example.com/path');
ctx.clientConnect('wss://example.com/ws', { protocol: 'chat' });
ctx.clientConnect({
  address: 'example.com',
  port: 443,
  path: '/foo',
  ssl: true,
  protocol: 'http',
});
```

Recognised properties on the info object:

| Property | C field |
|----------|---------|
| `context`            | `context` (auto-filled with `this.ctx`) |
| `address`            | `address` |
| `port`               | `port` |
| `sslConnection` / `ssl_connection` | `ssl_connection` (OR'd) |
| `ssl`                | shortcut: `true` → standard insecure SSL flags; number → OR'd into `ssl_connection` |
| `path`               | `path` |
| `host`               | `host` |
| `origin`             | `origin` |
| `protocol`           | `protocol` (wire WebSocket subprotocol, or "http"/"raw"/...) |
| `method`             | `method` (e.g. `'GET'`, `'POST'`, `'RAW'`) |
| `iface`              | `iface` |
| `localPort` / `local_port` | `local_port` |
| `localProtocolName` / `local_protocol_name` | `local_protocol_name` (which JS protocol callback to invoke) |
| `alpn`               | `alpn` (e.g. `'h2,http/1.1'`) |
| `keepWarmSecs` / `keep_warm_secs` | `keep_warm_secs` |
| `authUsername` / `auth_username` | `auth_username` |
| `authPassword` / `auth_password` | `auth_password` |

When a URI string is passed, the scheme decides:
`http*` → `method = 'GET'`; `https`/`wss` → `ssl_connection` is set
to a permissive default (`USE_SSL | ALLOW_SELFSIGNED | ALLOW_EXPIRED
| SKIP_SERVER_CERT_HOSTNAME_CHECK | ALLOW_INSECURE`).

Returns the freshly created `LWSSocket`. Even on failure the socket
object exists; you observe failures via the protocol's
`onClientConnectionError` callback.

### `createUdp`

UDP is connectionless, so both "bind a listening socket that
receives datagrams from any peer" and "create a socket pre-connected
to one fixed remote peer" go through this single entry point,
distinguished by whether `address` is given / `bind` is set:

```js
const listener = ctx.createUdp({ protocol: 'udp-echo', bind: true, port: 9002 });
const client = ctx.createUdp({ protocol: 'udp-echo', address: '127.0.0.1', port: 9002 });
```

Recognised properties on the options object:

| Property | C field / meaning |
|----------|--------------------|
| `protocol`   | Name of a protocol on the vhost (**required**) |
| `address`    | Remote address to pre-connect to; omitted (or `bind: true`) binds a listener on any interface instead |
| `port`       | UDP port |
| `iface`      | Interface address or name to bind |
| `vhost`      | Vhost name to look the protocol up on (defaults to the context's default vhost) |
| `bind`       | Boolean — force `LWS_CAUDP_BIND` even when `address` is given |
| `broadcast`  | Boolean — sets `LWS_CAUDP_BROADCAST` |
| `parentWsi` / `parent_wsi` | An existing `LWSSocket` to link the new UDP wsi under (`lws_create_adopt_udp()`'s `parent_wsi` argument) |

A single UDP wsi, unlike TCP, never gets one child wsi per peer —
see `onRawRx`'s extra `LWSSockAddr46` argument
([callbacks.md](callbacks.md)) for how a listener tells its many
peers apart, and `wsi.write(data, sockaddr)` (see
[LWSSocket.md](LWSSocket.md)) for targeting a reply back at one of
them.

Throws `TypeError` if `protocol` is missing, `InternalError` if the
named vhost doesn't exist or `lws_create_adopt_udp()` fails.

## Instance accessors (read-only)

| Property | Returns |
|----------|---------|
| `hostname`   | Canonical hostname (`lws_canonical_hostname`) |
| `deprecated` | Boolean — context replaced by a newer one |
| `euid`       | Effective uid |
| `egid`       | Effective gid |
| `protocols`  | Array of protocol descriptor objects (see [protocols.md](protocols.md)) |

The `info` property is also set during construction — it's the
original options object, **kept alive** for the lifetime of the
context (`JS_PROP_CONFIGURABLE`).

## Lifecycle

- The context is finalised when the JS object is garbage collected,
  which triggers `lws_context_destroy()` automatically.
- `destroy()` is safe to call early; subsequent method calls throw
  `InternalError("LWSContext internal lws_context has been destroyed")`.
- The constructor may **trigger callbacks before returning**, because
  `lws_create_context()` is the last step performed.
