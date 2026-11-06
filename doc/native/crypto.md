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
