# TLS / SSL configuration

qjs-lws inherits libwebsockets's TLS stack. Server and client roles
share the same `LWSContext` info object. Implemented in
`lws-context.c` (`context_creation_info_fromobj` `#ifdef LWS_WITH_TLS`
block).

## Server certificates

Each cert / key / CA can be supplied either as a **file path
string** or as an **ArrayBuffer** holding the PEM (or DER) bytes.
The `str_or_buf_property()` helper in `js-utils.c` picks the right
field — file path or `*_mem` + `*_mem_len`.

```js
import { createServer, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX } from 'lws';

createServer({
  port: 443,
  options: LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT |
           LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX,
  serverSslCert:       'localhost.crt',
  serverSslPrivateKey: 'localhost.key',
  serverSslCa:         'ca.crt',
  sslPrivateKeyPassword: 'pass',
  sslCipherList: 'HIGH:!aNULL:!MD5',
  tls13PlusCipherList: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256',
  protocols: [/* ... */],
});
```

In-memory form:

```js
import { readFileSync } from 'fs';
import { createServer } from 'lws';

createServer({
  serverSslCert: readFileSync('localhost.crt'),       // ArrayBuffer
  serverSslPrivateKey: readFileSync('localhost.key'), // ArrayBuffer
});
```

## Client certificates

```js
new LWSContext({
  clientSslCa:                'ca.crt',
  clientSslCert:              'client.crt',
  clientSslPrivateKey:        'client.key',
  clientSslPrivateKeyPassword: 'pw',
  clientSslCipherList:        'HIGH:!aNULL',
  clientTls13PlusCipherList:  'TLS_AES_256_GCM_SHA384',
});
```

Same dual-mode (file path or ArrayBuffer).

## Server options

Common `options` flags for TLS server contexts (OR them together):

| Constant | Purpose |
|----------|---------|
| `LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT`            | Initialise OpenSSL — needed once |
| `LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX`          | Create a per-vhost SSL context |
| `LWS_SERVER_OPTION_REQUIRE_VALID_OPENSSL_CLIENT_CERT` | Mutual TLS — require client cert |
| `LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED`        | Disable peer-cert verification |
| `LWS_SERVER_OPTION_IGNORE_MISSING_CERT`           | Don't fail vhost creation when cert files missing |
| `LWS_SERVER_OPTION_SSL_ECDH`                      | Enable ECDH |
| `LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS`        | 301 plaintext to TLS |
| `LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT`     | Accept plaintext on a TLS port |
| `LWS_SERVER_OPTION_ALLOW_HTTP_ON_HTTPS_LISTENER`  | Same idea for vhost listener |
| `LWS_SERVER_OPTION_STS`                           | Send HSTS header |
| `LWS_SERVER_OPTION_HTTP_HEADERS_SECURITY_BEST_PRACTICES_ENFORCE` | Hardened default headers |

## Client connection flags (`ssl_connection`)

Used per outbound `ctx.clientConnect()` via the `sslConnection`
or `ssl` info property. All `LCCSCF_*` constants are exported:

| Constant | Meaning |
|----------|---------|
| `LCCSCF_USE_SSL`                              | Initiate TLS |
| `LCCSCF_ALLOW_SELFSIGNED`                     | Accept self-signed peer certs |
| `LCCSCF_ALLOW_EXPIRED`                        | Accept expired certs |
| `LCCSCF_SKIP_SERVER_CERT_HOSTNAME_CHECK`      | Skip CN/SAN check |
| `LCCSCF_ALLOW_INSECURE`                       | Accept other TLS failures |
| `LCCSCF_H2_PRIOR_KNOWLEDGE`                   | Send HTTP/2 prior-knowledge upgrade |
| `LCCSCF_HTTP_MULTIPART_MIME`                  | `multipart/form-data` POST |
| `LCCSCF_HTTP_X_WWW_FORM_URLENCODED`           | `application/x-www-form-urlencoded` POST |
| `LCCSCF_HTTP_NO_FOLLOW_REDIRECT`              | Don't follow 3xx |
| `LCCSCF_HTTP_NO_CACHE_CONTROL`                | Skip cache-control hints |
| `LCCSCF_CACHE_COOKIES`                        | Persist `Set-Cookie` |
| `LCCSCF_ACCEPT_TLS_DOWNGRADE_REDIRECTS`       | Allow https→http redirect |
| `LCCSCF_IP_LOW_LATENCY` / `_HIGH_THROUGHPUT` / `_HIGH_RELIABILITY` / `_LOW_COST` | DSCP hint |

Quick form: supplying `ssl: true` in `clientConnect()` is shorthand
for `LCCSCF_USE_SSL | LCCSCF_ALLOW_SELFSIGNED | LCCSCF_ALLOW_INSECURE
| LCCSCF_ALLOW_EXPIRED | LCCSCF_SKIP_SERVER_CERT_HOSTNAME_CHECK`
(see `client_connect_info_fromobj`).

```js
ctx.clientConnect('https://self-signed.example/', {
  ssl: true,                            // permissive
  // or:
  // sslConnection: LCCSCF_USE_SSL,    // strict
});
```

## Verification hook

You can override the server certificate check with a JS callback:

```js
{
  name: 'http',
  onOpensslPerformServerCertVerification(wsi, sslPtr, preverify_ok) {
    return 0;     // accept
  },
}
```

The handler is called for `LWS_CALLBACK_OPENSSL_PERFORM_SERVER_CERT_VERIFICATION`;
returning non-zero rejects the certificate.
