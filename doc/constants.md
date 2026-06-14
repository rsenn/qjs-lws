# Constants

All constants below are integers exported on the `lws` module. They
mirror the macros of the same name from `libwebsockets.h`.

## Log levels (`LLL_*`)

`LLL_ERR`, `LLL_WARN`, `LLL_NOTICE`, `LLL_INFO`, `LLL_DEBUG`,
`LLL_PARSER`, `LLL_HEADER`, `LLL_EXT`, `LLL_CLIENT`, `LLL_LATENCY`,
`LLL_USER`, `LLL_THREAD`, `LLL_COUNT`.

Use as a bitmask:

```js
logLevel(LLL_USER | LLL_ERR | LLL_WARN);
```

## Write protocols (`LWS_WRITE_*`)

| Constant | Purpose |
|----------|---------|
| `LWS_WRITE_TEXT`        | UTF-8 WebSocket frame |
| `LWS_WRITE_BINARY`      | Binary WebSocket frame |
| `LWS_WRITE_CONTINUATION`| Continuation fragment |
| `LWS_WRITE_HTTP`        | HTTP body chunk |
| `LWS_WRITE_HTTP_HEADERS`| HTTP header block |
| `LWS_WRITE_HTTP_HEADERS_CONTINUATION` | Continued header block |
| `LWS_WRITE_HTTP_FINAL`  | Last HTTP body chunk |
| `LWS_WRITE_PING`        | Ping control frame |
| `LWS_WRITE_PONG`        | Pong control frame |
| `LWS_WRITE_BUFLIST`     | Use the wsi's queued buflist |
| `LWS_WRITE_NO_FIN`      | Don't set FIN bit |
| `LWS_WRITE_H2_STREAM_END`| Close an HTTP/2 stream |
| `LWS_WRITE_CLIENT_IGNORE_XOR_MASK` | Skip masking |
| `LWS_WRITE_RAW`         | Send bytes verbatim |

Also `LWS_PRE` — the number of leading bytes lws reserves for
framing. The binding handles this for `wsi.write()` so you do not
have to allocate `LWS_PRE` slack manually.

## Context port

`CONTEXT_PORT_NO_LISTEN` — pass as `port` for a pure client context.
The binding defaults to this when `port` is omitted from the info
object.

## Server options (`LWS_SERVER_OPTION_*`)

A large catalogue, OR'ed into the `options` field. Highlights:

| Constant | Purpose |
|----------|---------|
| `LWS_SERVER_OPTION_REQUIRE_VALID_OPENSSL_CLIENT_CERT` | Require mTLS |
| `LWS_SERVER_OPTION_SKIP_SERVER_CANONICAL_NAME` | Skip CN check |
| `LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT`  | Mixed plaintext/TLS on one port |
| `LWS_SERVER_OPTION_LIBEV`                       | Use libev event loop |
| `LWS_SERVER_OPTION_DISABLE_IPV6`                | IPv4 only |
| `LWS_SERVER_OPTION_DISABLE_OS_CA_CERTS`         | Don't load OS CA store |
| `LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED`      | Don't require peer cert |
| `LWS_SERVER_OPTION_VALIDATE_UTF8`               | Validate UTF-8 in WS text |
| `LWS_SERVER_OPTION_SSL_ECDH`                    | Enable ECDH |
| `LWS_SERVER_OPTION_LIBUV`                       | Use libuv event loop |
| `LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS`      | Auto-redirect plain to TLS |
| `LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT`          | Initialise OpenSSL |
| `LWS_SERVER_OPTION_EXPLICIT_VHOSTS`             | Don't create default vhost |
| `LWS_SERVER_OPTION_UNIX_SOCK`                   | Listen on a UNIX socket |
| `LWS_SERVER_OPTION_STS`                         | HSTS header |
| `LWS_SERVER_OPTION_IPV6_V6ONLY_MODIFY`          | Set IPV6_V6ONLY |
| `LWS_SERVER_OPTION_IPV6_V6ONLY_VALUE`           | Value for the above |
| `LWS_SERVER_OPTION_UV_NO_SIGSEGV_SIGFPE_SPIN`   | libuv: no signal spin |
| `LWS_SERVER_OPTION_JUST_USE_RAW_ORIGIN`         | Raw mode |
| `LWS_SERVER_OPTION_FALLBACK_TO_RAW`             | Fall back to raw |
| `LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG` | Pair with listenAcceptRole/Protocol |
| `LWS_SERVER_OPTION_LIBEVENT`                    | Use libevent |
| `LWS_SERVER_OPTION_ONLY_RAW`                    | Raw-only listener |
| `LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG` | Apply listen config on adopt |
| `LWS_SERVER_OPTION_ALLOW_LISTEN_SHARE`          | SO_REUSEPORT |
| `LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX`        | Create SSL context per vhost |
| `LWS_SERVER_OPTION_SKIP_PROTOCOL_INIT`          | Skip PROTOCOL_INIT calls |
| `LWS_SERVER_OPTION_IGNORE_MISSING_CERT`         | Don't fail on missing cert |
| `LWS_SERVER_OPTION_VHOST_UPG_STRICT_HOST_CHECK` | Strict Host header check |
| `LWS_SERVER_OPTION_HTTP_HEADERS_SECURITY_BEST_PRACTICES_ENFORCE` | Hardened headers |
| `LWS_SERVER_OPTION_ALLOW_HTTP_ON_HTTPS_LISTENER`| Mixed mode |
| `LWS_SERVER_OPTION_FAIL_UPON_UNABLE_TO_BIND`    | Hard-fail on bind |
| `LWS_SERVER_OPTION_H2_JUST_FIX_WINDOW_UPDATE_OVERFLOW` | Workaround |
| `LWS_SERVER_OPTION_VH_H2_HALF_CLOSED_LONG_POLL` | Long-poll over H2 |
| `LWS_SERVER_OPTION_GLIB`                        | Use glib loop |
| `LWS_SERVER_OPTION_H2_PRIOR_KNOWLEDGE`          | H2 prior knowledge |
| `LWS_SERVER_OPTION_NO_LWS_SYSTEM_STATES`        | Skip system states |
| `LWS_SERVER_OPTION_SS_PROXY`                    | Secure-streams proxy |
| `LWS_SERVER_OPTION_SDEVENT`                     | Use sdevent loop |
| `LWS_SERVER_OPTION_ULOOP`                       | Use uloop |
| `LWS_SERVER_OPTION_DISABLE_TLS_SESSION_CACHE`   | No TLS session cache |
| `LWS_ILLEGAL_HTTP_CONTENT_LEN`                  | Sentinel "unknown content-length" |

## Mount protocol (`LWSMPRO_*`)

`LWSMPRO_HTTP`, `LWSMPRO_HTTPS`, `LWSMPRO_FILE`, `LWSMPRO_CGI`,
`LWSMPRO_REDIR_HTTP`, `LWSMPRO_REDIR_HTTPS`, `LWSMPRO_CALLBACK`,
`LWSMPRO_NO_MOUNT`.

See [mounts.md](mounts.md) for their meaning.

## Client connect flags (`LCCSCF_*`)

`USE_SSL`, `ALLOW_SELFSIGNED`, `SKIP_SERVER_CERT_HOSTNAME_CHECK`,
`ALLOW_EXPIRED`, `ALLOW_INSECURE`, `H2_QUIRK_NGHTTP2_END_STREAM`,
`H2_QUIRK_OVERFLOWS_TXCR`, `H2_AUTH_BEARER`, `H2_HEXIFY_AUTH_TOKEN`,
`H2_MANUAL_RXFLOW`, `HTTP_MULTIPART_MIME`,
`HTTP_X_WWW_FORM_URLENCODED`, `HTTP_NO_FOLLOW_REDIRECT`,
`HTTP_NO_CACHE_CONTROL`, `ALLOW_REUSE_ADDR`,
`IPV6_PREFER_PUBLIC_ADDR`, `PIPELINE`, `MUXABLE_STREAM`,
`H2_PRIOR_KNOWLEDGE`, `WAKE_SUSPEND__VALIDITY`, `PRIORITIZE_READS`,
`SECSTREAM_CLIENT`, `SECSTREAM_PROXY_LINK`, `SECSTREAM_PROXY_ONWARD`,
`IP_LOW_LATENCY`, `IP_HIGH_THROUGHPUT`, `IP_HIGH_RELIABILITY`,
`IP_LOW_COST`, `CONMON`, `ACCEPT_TLS_DOWNGRADE_REDIRECTS`,
`CACHE_COOKIES`.

See [tls.md](tls.md) for usage.

## HTTP header tokens (`WSI_TOKEN_*`)

The full `enum lws_token_indexes` is exported. Notable groups:

- Method/URI: `WSI_TOKEN_GET_URI`, `WSI_TOKEN_POST_URI`,
  `WSI_TOKEN_OPTIONS_URI` (optional), `WSI_TOKEN_PUT_URI`,
  `WSI_TOKEN_PATCH_URI`, `WSI_TOKEN_DELETE_URI`,
  `WSI_TOKEN_HEAD_URI`, `WSI_TOKEN_CONNECT`.
- Common request headers: `WSI_TOKEN_HOST`, `WSI_TOKEN_CONNECTION`,
  `WSI_TOKEN_UPGRADE`, `WSI_TOKEN_ORIGIN`,
  `WSI_TOKEN_HTTP_USER_AGENT`, `WSI_TOKEN_HTTP_COOKIE`,
  `WSI_TOKEN_HTTP_ACCEPT`, `WSI_TOKEN_HTTP_ACCEPT_ENCODING`, …
- Response headers: `WSI_TOKEN_HTTP_SET_COOKIE`,
  `WSI_TOKEN_HTTP_LOCATION`, `WSI_TOKEN_HTTP_CONTENT_TYPE`,
  `WSI_TOKEN_HTTP_CONTENT_LENGTH`, …
- WebSocket-specific (when built with `LWS_ROLE_WS`):
  `WSI_TOKEN_KEY`, `WSI_TOKEN_VERSION`, `WSI_TOKEN_PROTOCOL`,
  `WSI_TOKEN_EXTENSIONS`, `WSI_TOKEN_ACCEPT`.
- HTTP/2 pseudo-headers: `WSI_TOKEN_HTTP_COLON_AUTHORITY`,
  `_COLON_METHOD`, `_COLON_PATH`, `_COLON_SCHEME`, `_COLON_STATUS`.
- Sentinels: `WSI_TOKEN_COUNT`, `WSI_TOKEN_NAME_PART`,
  `WSI_TOKEN_SKIPPING*`, `WSI_PARSING_COMPLETE`,
  `WSI_INIT_TOKEN_MUXURL`.

`getTokenName(WSI_TOKEN_HOST)` returns the literal header string
("Host") — useful for debugging.

## HTTP methods (`LWSHUMETH_*`)

`LWSHUMETH_GET`, `_POST`, `_OPTIONS`, `_PUT`, `_PATCH`, `_DELETE`,
`_CONNECT`, `_HEAD`, `_COLON_PATH`.
