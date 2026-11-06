# crypto

Native crypto primitives exported from `lws` as `crypto`, meant as the
engine under a JS `crypto.subtle`. Built on OpenSSL 3 directly (not
`lws_gencrypto`, which lacks point validation and DER-free ECDSA); with
another TLS backend the object is empty.

Bytes go in as `ArrayBuffer`, `TypedArray` or `DataView` and come out as
`ArrayBuffer`. Errors are exceptions (`TypeError` for bad arguments,
`RangeError` for bad keys).

| Function | Result |
|---|---|
| `digest(alg, data)` | `ArrayBuffer` |
| `hmac(alg, key, data)` | `ArrayBuffer` |
| `ecGenerateKey(curve)` | `{ d, x, y }` |
| `ecPublicKey(curve, d)` | `{ x, y }` |
| `ecValidatePoint(curve, x, y)` | `boolean` (wrong length or off curve is `false`) |
| `ecSign(curve, d, hashAlg, data)` | `ArrayBuffer`, `r\|\|s` (IEEE P1363, as JWS/WebCrypto) |
| `ecVerify(curve, x, y, hashAlg, sig, data)` | `boolean`; bad signature length is `false`, an invalid point throws |
| `pbkdf2(hashAlg, password, salt, iterations, length)` | `ArrayBuffer` |
| `hkdf(hashAlg, key, salt, info, length)` | `ArrayBuffer` (extract and expand, RFC 5869) |
| `scrypt(password, salt, { N, r, p, length })` | `ArrayBuffer`; defaults `N` 16384, `r` 8, `p` 1, `length` 64 |
| `argon2id(password, salt, { memoryCost, timeCost, parallelism, hashLength })` | `ArrayBuffer`, the raw hash |

`argon2id` defaults are those of `Bun.password`: `memoryCost` 65536 KiB,
`timeCost` 2, `parallelism` 1, `hashLength` 32. The salt must be at least
8 bytes; bad costs throw `RangeError`. It is implemented in the module
(RFC 9106, version 0x13, no secret or associated data) because OpenSSL
only has Argon2 from 3.2; lanes run one after the other, so a hash with
`parallelism` > 1 equals the threaded one. Output was checked against Bun
and libargon2 (PHP). The PHC string (`$argon2id$v=19$m=...`) is left to
the caller.

`alg`/`hashAlg`: `SHA-1`, `SHA-256`, `SHA-384`, `SHA-512` (case and dash
insensitive). `curve`: `P-256`, `P-384`, `P-521`. `d`, `x`, `y` are
big-endian; `x`/`y` must be exactly 32/48/66 bytes, `d` may be shorter
and must be in `[1, n-1]`.

```js
import { crypto } from 'lws';
const { d, x, y } = crypto.ecGenerateKey('P-256');
const sig = crypto.ecSign('P-256', d, 'SHA-256', data);
crypto.ecVerify('P-256', x, y, 'SHA-256', sig, data); // true
```
