# TLS / SSL configuration

qjs-lws inherits libwebsockets's TLS stack. Server and client roles
share the same `LWSContext` info object. Option parsing is
implemented in `lws-tls.c` (`tls_creation_info_fromobj`,
`tls_connect_info_fromobj`), called from `lws-context.c`.

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

## Generating a self-signed certificate

```js
import { generateSelfSignedCert } from 'lws';

const { cert, key } = generateSelfSignedCert({
  commonName: 'localhost',        // default: 'localhost'
  altNames: ['localhost', '127.0.0.1'], // optional; falls back to commonName
  days: 825,                      // default: 825
  keyBits: 2048,                  // default: 2048
});
// cert, key: PEM-encoded ArrayBuffer, pass straight to serverSslCert / serverSslPrivateKey
```

Plain OpenSSL API use (RSA + SHA-256), not an lws facility. Only
built against the OpenSSL TLS backend; on other backends it throws
`InternalError("generateSelfSignedCert: not supported by this
build's TLS backend")`.

## Verification hook

You can override the certificate check with a JS callback:

```js
{
  name: 'http',
  onOpensslPerformServerCertVerification(wsi, cert, tlsSocket, preverifyOk) {
    console.log(cert.subject, cert.fingerprint256, preverifyOk);

    if(!preverifyOk && cert.checkHost('example.com'))
      cert.error = 0;       // X509_V_OK - overrule an otherwise-failing check

    return 0;                // 0 accepts, non-zero rejects
  },
}
```

Two reasons fire this shape of callback:

| Constant | Handler | Fires when |
|----------|---------|------------|
| `LWS_CALLBACK_OPENSSL_PERFORM_SERVER_CERT_VERIFICATION` | `onOpensslPerformServerCertVerification` | A client verifies the server's certificate. `wsi` is set. |
| `LWS_CALLBACK_OPENSSL_PERFORM_CLIENT_CERT_VERIFICATION` | `onOpensslPerformClientCertVerification` | A server (with `LWS_SERVER_OPTION_REQUIRE_VALID_OPENSSL_CLIENT_CERT`) verifies a client's certificate. **`wsi` is `null` per libwebsockets** for this reason, and this binding currently resolves the JS callback to invoke *through* the wsi — so in practice this handler is not reachable yet; the connection falls back to OpenSSL's own verification result. |

`cert` is an `X509Certificate` and `tlsSocket` a `TLSSocket` — both
described below. `preverifyOk` is OpenSSL's own verification result
(`0` or `1`) going into the callback; returning `0` from the handler
accepts the certificate regardless (matching lws' own "return 0 to
mean the cert is OK" convention), but to actually *overrule* an
OpenSSL-detected error (rather than merely ignoring it) you must also
set `cert.error = 0` — see `X509_STORE_CTX_set_error()`'s role in
`SSL_CTX_set_verify(3)`.

### `X509Certificate`

Wraps OpenSSL's `X509*`, modeled closely on Node's
[`crypto.X509Certificate`](https://nodejs.org/api/crypto.html#class-x509certificate).
Implemented in `lws-tls.c`. Constructible directly, not just from the
verification hook:

```js
import { X509Certificate } from 'lws';

const cert = new X509Certificate(pemStringOrDerArrayBuffer);
```

Every wrapped certificate is reference-counted (`X509_up_ref()`) and
freed by its finalizer, so — unlike the raw `X509_STORE_CTX*`/`SSL*`
libwebsockets hands the verification callback — an `X509Certificate`
is safe to keep around past the callback that produced it.

#### Properties

| Property | Type | Description |
|----------|------|--------------|
| `ca`               | boolean | `X509_check_ca()` — whether this is a CA certificate |
| `fingerprint`       | string | SHA-1 digest, colon-separated hex |
| `fingerprint256`    | string | SHA-256 digest |
| `fingerprint512`    | string | SHA-512 digest |
| `infoAccess`        | string \| undefined | Authority Information Access extension, as text |
| `issuer`            | string | Issuer distinguished name (`CN=..\nO=..\n...`) |
| `issuerCertificate` | `X509Certificate` \| undefined | Only resolved for a self-signed certificate (points at itself); this binding doesn't carry the full verified chain the way Node's TLS layer does |
| `keyUsage`          | string[] \| undefined | Key Usage extension bits, e.g. `['digitalSignature', 'keyEncipherment']` |
| `publicKey`         | `ArrayBuffer` | SPKI DER — **deviation**: Node returns a `KeyObject`, which this binding has no equivalent of |
| `raw`               | `ArrayBuffer` | DER-encoded certificate |
| `serialNumber`      | string | Hex serial number |
| `subject`           | string | Subject distinguished name |
| `subjectAltName`    | string \| undefined | Subject Alternative Name extension, as text |
| `validFrom` / `validTo`         | string | Validity period, OpenSSL text format |
| `validFromDate` / `validToDate` | `Date` | Same, as `Date` objects |
| `error`             | number | **Not part of Node's API.** Get/set the enclosing `X509_STORE_CTX`'s verification error (`X509_STORE_CTX_get/set_error()`) — only meaningful (and settable) on a certificate handed to the verification hook above; `undefined`/no-op otherwise |
| `errorDepth`        | number | Same caveat — `X509_STORE_CTX_get_error_depth()` |

#### Methods

| Method | Description |
|--------|-------------|
| `checkHost(name [, options])`  | `X509_check_host()`. Returns the matched name (string) or `undefined`. `options`: `{ subject: 'default'\|'always'\|'never', wildcards, partialWildcards, multiLabelWildcards, singleLabelSubdomains }` (all booleans except `subject`) |
| `checkEmail(email [, options])`| `X509_check_email()`. `options`: `{ subject }` |
| `checkIP(ip)`                  | `X509_check_ip_asc()`. Returns `ip` on match, else `undefined` |
| `checkIssued(otherCert)`       | `X509_check_issued(this, otherCert)` — is `this` the issuer of `otherCert`? |
| `checkPrivateKey(key)`         | `X509_check_private_key()`. **Deviation**: `key` is a PEM string or DER `ArrayBuffer`, not a `KeyObject` |
| `verify(key)`                  | `X509_verify()` — verify the certificate's signature with a public key. Same PEM/DER deviation as above |
| `toString()`                   | PEM-encoded certificate |
| `toJSON()`                     | Same as `toString()` (matches Node — there's no standard JSON encoding for X.509) |
| `toLegacyObject()`             | `{ subject, issuer, subjectaltname, infoAccess, valid_from, valid_to, fingerprint, fingerprint256, fingerprint512, serialNumber, raw }` — a reduced form of Node's legacy `tls.getPeerCertificate()`-style object (no `modulus`/`bits`/`exponent`) |

### `TLSSocket`

A minimal, non-owning wrapper around the `SSL*` libwebsockets hands
to the verification hook — unlike `X509Certificate` it is **not**
safe to retain past that callback. Implemented in `lws-tls.c`.

| Property | Description |
|----------|-------------|
| `servername` | `SSL_get_servername()` — the SNI hostname the peer requested, or `null` |
