#ifndef QJS_LWS_CRYPTO_H
#define QJS_LWS_CRYPTO_H

#include <quickjs.h>
#include <libwebsockets.h>

/**
 * @file lws-crypto.h
 *
 * Native crypto primitives for building WebCrypto's crypto.subtle in JS.
 * Bytes in and out are ArrayBuffer / TypedArray / DataView, errors are
 * exceptions. Needs OpenSSL 3; without it the object is empty.
 *
 * Exported as `crypto` from the 'lws' module:
 *
 *   digest(alg, data)                         -> ArrayBuffer
 *   hmac(alg, key, data)                      -> ArrayBuffer
 *   ecGenerateKey(curve)                      -> { d, x, y }
 *   ecPublicKey(curve, d)                     -> { x, y }
 *   ecValidatePoint(curve, x, y)              -> boolean
 *   ecSign(curve, d, hashAlg, data)           -> ArrayBuffer (r||s)
 *   ecVerify(curve, x, y, hashAlg, sig, data) -> boolean
 *   pbkdf2(hashAlg, password, salt, iterations, length) -> ArrayBuffer
 *   hkdf(hashAlg, key, salt, info, length)    -> ArrayBuffer
 *   scrypt(password, salt, { N, r, p, length }) -> ArrayBuffer
 *   argon2id(password, salt, { memoryCost, timeCost, parallelism,
 *            hashLength })                    -> ArrayBuffer (raw hash)
 *
 * alg / hashAlg: SHA-1, SHA-256, SHA-384, SHA-512. curve: P-256, P-384,
 * P-521. d, x, y are big-endian, fixed size (32, 48, 66 bytes); d may be
 * shorter, x and y may not.
 */
JSValue lwsjs_crypto_object(JSContext*);

#endif /* QJS_LWS_CRYPTO_H */
