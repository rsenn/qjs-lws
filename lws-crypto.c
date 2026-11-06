#include "lws-crypto.h"
#include "js-utils.h"
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#if defined(LWS_WITH_TLS) && !defined(LWS_WITH_MBEDTLS) && !defined(LWS_WITH_GNUTLS)
#include <openssl/opensslv.h>
#endif

#if defined(LWS_WITH_TLS) && defined(OPENSSL_VERSION_NUMBER) && OPENSSL_VERSION_NUMBER >= 0x30000000L

#include <openssl/bn.h>
#include <openssl/ec.h>
#include <openssl/ecdsa.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/kdf.h>
#include <openssl/core_names.h>
#include <openssl/param_build.h>

/* Everything here is built on OpenSSL 3 directly (EVP, HMAC, EC_GROUP/
   EC_POINT/BIGNUM, OSSL_PARAM) instead of lws_genhash/genec/genrsa: lws's
   gencrypto layer has no DER-free ECDSA, no point validation and no way to
   derive a public point from d, all of which WebCrypto needs. */

static const EVP_MD*
crypto_md(JSContext* ctx, JSValueConst value) {
  const char* name = JS_ToCString(ctx, value);
  const EVP_MD* md = 0;
  char norm[16];
  size_t n = 0;

  if(!name)
    return 0;

  /* "SHA-256", "sha256" and "SHA256" are all accepted */
  for(const char* p = name; *p && n < sizeof(norm) - 1; p++)
    if(*p != '-')
      norm[n++] = *p >= 'A' && *p <= 'Z' ? *p + 32 : *p;

  norm[n] = 0;
  JS_FreeCString(ctx, name);

  if(!strcmp(norm, "sha1"))
    md = EVP_sha1();
  else if(!strcmp(norm, "sha256"))
    md = EVP_sha256();
  else if(!strcmp(norm, "sha384"))
    md = EVP_sha384();
  else if(!strcmp(norm, "sha512"))
    md = EVP_sha512();
  else
    JS_ThrowTypeError(ctx, "unsupported hash algorithm");

  return md;
}

/* Bytes of an ArrayBuffer, TypedArray or DataView; throws TypeError and
   returns NULL for anything else. An empty view yields a non-NULL pointer. */
static const uint8_t*
crypto_bytes(JSContext* ctx, JSValueConst value, size_t* lenp) {
  static const uint8_t empty[1] = {0};
  const uint8_t* ptr = get_buffer(ctx, 1, &value, lenp);

  if(!ptr) {
    if(!JS_HasException(ctx))
      JS_ThrowTypeError(ctx, "expected ArrayBuffer or view");
    return 0;
  }

  return *lenp ? ptr : empty;
}

static JSValue
crypto_throw_ssl(JSContext* ctx, const char* what) {
  char buf[128] = "";
  unsigned long e = ERR_get_error();

  if(e)
    ERR_error_string_n(e, buf, sizeof(buf));
  ERR_clear_error();

  return JS_ThrowInternalError(ctx, "%s failed%s%s", what, *buf ? ": " : "", buf);
}

typedef struct {
  EC_GROUP* group;
  size_t size; /* field size in bytes: 32, 48, 66 */
  const char* name;
} CryptoCurve;

static int
crypto_curve(JSContext* ctx, JSValueConst value, CryptoCurve* c) {
  const char* name = JS_ToCString(ctx, value);
  int nid = 0;

  if(!name)
    return -1;

  if(!strcmp(name, "P-256"))
    nid = NID_X9_62_prime256v1, c->name = "P-256";
  else if(!strcmp(name, "P-384"))
    nid = NID_secp384r1, c->name = "P-384";
  else if(!strcmp(name, "P-521"))
    nid = NID_secp521r1, c->name = "P-521";

  JS_FreeCString(ctx, name);

  if(!nid) {
    JS_ThrowTypeError(ctx, "unsupported curve (P-256, P-384, P-521)");
    return -1;
  }

  if(!(c->group = EC_GROUP_new_by_curve_name(nid))) {
    crypto_throw_ssl(ctx, "EC_GROUP_new_by_curve_name");
    return -1;
  }

  c->size = (EC_GROUP_get_degree(c->group) + 7) / 8;
  return 0;
}

static JSValue
crypto_buffer(JSContext* ctx, const BIGNUM* bn, size_t size) {
  uint8_t buf[66];

  if(BN_bn2binpad(bn, buf, size) < 0)
    return JS_ThrowRangeError(ctx, "number does not fit the curve size");

  return JS_NewArrayBufferCopy(ctx, buf, size);
}

/* Public point of d. Out: x and y as fixed-size big-endian bytes. */
static int
crypto_point_of(JSContext* ctx, const CryptoCurve* c, const BIGNUM* d, BIGNUM* x, BIGNUM* y) {
  EC_POINT* pt = EC_POINT_new(c->group);
  BN_CTX* bc = BN_CTX_new();
  int ok = pt && bc && EC_POINT_mul(c->group, pt, d, 0, 0, bc) && EC_POINT_get_affine_coordinates(c->group, pt, x, y, bc);

  EC_POINT_free(pt);
  BN_CTX_free(bc);

  if(!ok)
    crypto_throw_ssl(ctx, "EC_POINT_mul");

  return ok ? 0 : -1;
}

/* d must be in [1, n-1] */
static BIGNUM*
crypto_private(JSContext* ctx, const CryptoCurve* c, JSValueConst value) {
  size_t len;
  const uint8_t* ptr = crypto_bytes(ctx, value, &len);
  BIGNUM* d;

  if(!ptr)
    return 0;

  if(len == 0 || len > c->size || !(d = BN_bin2bn(ptr, len, 0))) {
    JS_ThrowRangeError(ctx, "invalid private key length");
    return 0;
  }

  if(BN_is_zero(d) || BN_cmp(d, EC_GROUP_get0_order(c->group)) >= 0) {
    BN_free(d);
    JS_ThrowRangeError(ctx, "private key out of range");
    return 0;
  }

  return d;
}

/* Uncompressed SEC1 point 04||x||y from two JS byte arguments, checked to
   be on the curve. Returns 0 on success, 1 if not a valid point (no
   exception pending), -1 with an exception pending. */
static int
crypto_public(JSContext* ctx, const CryptoCurve* c, JSValueConst xv, JSValueConst yv, uint8_t* out) {
  size_t xl, yl;
  const uint8_t *x = crypto_bytes(ctx, xv, &xl), *y;
  EC_POINT* pt;
  BN_CTX* bc;
  int ok;

  if(!x || !(y = crypto_bytes(ctx, yv, &yl)))
    return -1;

  if(xl != c->size || yl != c->size)
    return 1;

  out[0] = 4;
  memcpy(out + 1, x, xl);
  memcpy(out + 1 + xl, y, yl);

  pt = EC_POINT_new(c->group);
  bc = BN_CTX_new();
  /* oct2point rejects a point that is not on the curve; the infinity
     point cannot be encoded in this form */
  ok = pt && bc && EC_POINT_oct2point(c->group, pt, out, 1 + 2 * c->size, bc) == 1;

  EC_POINT_free(pt);
  BN_CTX_free(bc);
  ERR_clear_error();

  return ok ? 0 : 1;
}

/* EVP_PKEY from the public point and, if d is not NULL, the private key. */
static EVP_PKEY*
crypto_pkey(JSContext* ctx, const CryptoCurve* c, const BIGNUM* d, const uint8_t* pub) {
  OSSL_PARAM_BLD* bld = OSSL_PARAM_BLD_new();
  OSSL_PARAM* params = 0;
  EVP_PKEY_CTX* pc = 0;
  EVP_PKEY* pkey = 0;

  if(bld && OSSL_PARAM_BLD_push_utf8_string(bld, OSSL_PKEY_PARAM_GROUP_NAME, c->name, 0) &&
     OSSL_PARAM_BLD_push_octet_string(bld, OSSL_PKEY_PARAM_PUB_KEY, pub, 1 + 2 * c->size) && (!d || OSSL_PARAM_BLD_push_BN(bld, OSSL_PKEY_PARAM_PRIV_KEY, d)) &&
     (params = OSSL_PARAM_BLD_to_param(bld)) && (pc = EVP_PKEY_CTX_new_from_name(0, "EC", 0)) && EVP_PKEY_fromdata_init(pc) == 1 &&
     EVP_PKEY_fromdata(pc, &pkey, d ? EVP_PKEY_KEYPAIR : EVP_PKEY_PUBLIC_KEY, params) == 1) {
  } else {
    pkey = 0;
    crypto_throw_ssl(ctx, "EVP_PKEY_fromdata");
  }

  OSSL_PARAM_free(params);
  OSSL_PARAM_BLD_free(bld);
  EVP_PKEY_CTX_free(pc);
  return pkey;
}

/* digest(alg, data) -> ArrayBuffer */
static JSValue
lwsjs_crypto_digest(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  const EVP_MD* md;
  const uint8_t* data;
  size_t len;
  uint8_t out[EVP_MAX_MD_SIZE];
  unsigned outlen = 0;

  if(argc < 2)
    return JS_ThrowTypeError(ctx, "digest(alg, data)");
  if(!(md = crypto_md(ctx, argv[0])) || !(data = crypto_bytes(ctx, argv[1], &len)))
    return JS_EXCEPTION;
  if(EVP_Digest(data, len, out, &outlen, md, 0) != 1)
    return crypto_throw_ssl(ctx, "EVP_Digest");

  return JS_NewArrayBufferCopy(ctx, out, outlen);
}

/* hmac(alg, key, data) -> ArrayBuffer */
static JSValue
lwsjs_crypto_hmac(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  const EVP_MD* md;
  const uint8_t *key, *data;
  size_t keylen, len;
  uint8_t out[EVP_MAX_MD_SIZE];
  unsigned outlen = 0;

  if(argc < 3)
    return JS_ThrowTypeError(ctx, "hmac(alg, key, data)");
  if(!(md = crypto_md(ctx, argv[0])) || !(key = crypto_bytes(ctx, argv[1], &keylen)) || !(data = crypto_bytes(ctx, argv[2], &len)))
    return JS_EXCEPTION;
  if(!HMAC(md, key, keylen, data, len, out, &outlen))
    return crypto_throw_ssl(ctx, "HMAC");

  return JS_NewArrayBufferCopy(ctx, out, outlen);
}

/* ecGenerateKey(curve) -> { d, x, y } */
static JSValue
lwsjs_crypto_ec_generate_key(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  CryptoCurve c = {0};
  BIGNUM *d = BN_new(), *x = BN_new(), *y = BN_new();
  JSValue ret = JS_EXCEPTION;

  if(argc < 1) {
    JS_ThrowTypeError(ctx, "ecGenerateKey(curve)");
    goto end;
  }
  if(crypto_curve(ctx, argv[0], &c))
    goto end;

  /* d uniform in [1, n-1] */
  do {
    if(!BN_priv_rand_range(d, EC_GROUP_get0_order(c.group))) {
      crypto_throw_ssl(ctx, "BN_priv_rand_range");
      goto end;
    }
  } while(BN_is_zero(d));

  if(crypto_point_of(ctx, &c, d, x, y))
    goto end;

  ret = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, ret, "d", crypto_buffer(ctx, d, c.size));
  JS_SetPropertyStr(ctx, ret, "x", crypto_buffer(ctx, x, c.size));
  JS_SetPropertyStr(ctx, ret, "y", crypto_buffer(ctx, y, c.size));

end:
  BN_clear_free(d);
  BN_free(x);
  BN_free(y);
  EC_GROUP_free(c.group);
  return ret;
}

/* ecPublicKey(curve, d) -> { x, y } */
static JSValue
lwsjs_crypto_ec_public_key(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  CryptoCurve c = {0};
  BIGNUM *d = 0, *x = BN_new(), *y = BN_new();
  JSValue ret = JS_EXCEPTION;

  if(argc < 2) {
    JS_ThrowTypeError(ctx, "ecPublicKey(curve, d)");
    goto end;
  }
  if(crypto_curve(ctx, argv[0], &c) || !(d = crypto_private(ctx, &c, argv[1])) || crypto_point_of(ctx, &c, d, x, y))
    goto end;

  ret = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, ret, "x", crypto_buffer(ctx, x, c.size));
  JS_SetPropertyStr(ctx, ret, "y", crypto_buffer(ctx, y, c.size));

end:
  BN_clear_free(d);
  BN_free(x);
  BN_free(y);
  EC_GROUP_free(c.group);
  return ret;
}

/* ecValidatePoint(curve, x, y) -> boolean (false for a wrong length or a
   point that is not on the curve; throws only for a bad curve name or
   non-byte arguments) */
static JSValue
lwsjs_crypto_ec_validate_point(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  CryptoCurve c = {0};
  uint8_t pub[133];
  JSValue ret = JS_EXCEPTION;
  int r;

  if(argc < 3)
    return JS_ThrowTypeError(ctx, "ecValidatePoint(curve, x, y)");
  if(crypto_curve(ctx, argv[0], &c))
    return JS_EXCEPTION;

  if((r = crypto_public(ctx, &c, argv[1], argv[2], pub)) >= 0)
    ret = JS_NewBool(ctx, r == 0);

  EC_GROUP_free(c.group);
  return ret;
}

/* ecSign(curve, d, hashAlg, data) -> ArrayBuffer (r||s, fixed size each) */
static JSValue
lwsjs_crypto_ec_sign(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  CryptoCurve c = {0};
  BIGNUM *d = 0, *x = BN_new(), *y = BN_new();
  uint8_t pub[133];
  const EVP_MD* md;
  const uint8_t* data;
  size_t len, siglen = 0;
  EVP_PKEY* pkey = 0;
  EVP_MD_CTX* mc = 0;
  ECDSA_SIG* sig = 0;
  uint8_t *der = 0, out[132];
  const uint8_t* dp;
  const BIGNUM *r, *s;
  JSValue ret = JS_EXCEPTION;

  if(argc < 4) {
    JS_ThrowTypeError(ctx, "ecSign(curve, d, hashAlg, data)");
    goto end;
  }
  if(crypto_curve(ctx, argv[0], &c) || !(d = crypto_private(ctx, &c, argv[1])) || !(md = crypto_md(ctx, argv[2])) || !(data = crypto_bytes(ctx, argv[3], &len)) ||
     crypto_point_of(ctx, &c, d, x, y))
    goto end;

  pub[0] = 4;
  BN_bn2binpad(x, pub + 1, c.size);
  BN_bn2binpad(y, pub + 1 + c.size, c.size);

  if(!(pkey = crypto_pkey(ctx, &c, d, pub)))
    goto end;

  if(!(mc = EVP_MD_CTX_new()) || EVP_DigestSignInit(mc, 0, md, 0, pkey) != 1 || EVP_DigestSign(mc, 0, &siglen, data, len) != 1 || !(der = malloc(siglen)) ||
     EVP_DigestSign(mc, der, &siglen, data, len) != 1) {
    crypto_throw_ssl(ctx, "EVP_DigestSign");
    goto end;
  }

  dp = der;
  if(!(sig = d2i_ECDSA_SIG(0, &dp, siglen))) {
    crypto_throw_ssl(ctx, "d2i_ECDSA_SIG");
    goto end;
  }

  ECDSA_SIG_get0(sig, &r, &s);
  BN_bn2binpad(r, out, c.size);
  BN_bn2binpad(s, out + c.size, c.size);
  ret = JS_NewArrayBufferCopy(ctx, out, 2 * c.size);

end:
  ECDSA_SIG_free(sig);
  free(der);
  EVP_MD_CTX_free(mc);
  EVP_PKEY_free(pkey);
  BN_clear_free(d);
  BN_free(x);
  BN_free(y);
  EC_GROUP_free(c.group);
  return ret;
}

/* ecVerify(curve, x, y, hashAlg, sig, data) -> boolean. A signature of the
   wrong length is simply false; an invalid public point throws. */
static JSValue
lwsjs_crypto_ec_verify(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  CryptoCurve c = {0};
  uint8_t pub[133], *der = 0;
  const EVP_MD* md;
  const uint8_t *sigb, *data;
  size_t siglen, len;
  EVP_PKEY* pkey = 0;
  EVP_MD_CTX* mc = 0;
  ECDSA_SIG* sig = 0;
  BIGNUM *r = 0, *s = 0;
  int derlen, pr;
  JSValue ret = JS_EXCEPTION;

  if(argc < 6) {
    JS_ThrowTypeError(ctx, "ecVerify(curve, x, y, hashAlg, sig, data)");
    goto end;
  }
  if(crypto_curve(ctx, argv[0], &c))
    goto end;
  if((pr = crypto_public(ctx, &c, argv[1], argv[2], pub))) {
    if(pr > 0)
      JS_ThrowRangeError(ctx, "public key is not a point on the curve");
    goto end;
  }
  if(!(md = crypto_md(ctx, argv[3])) || !(sigb = crypto_bytes(ctx, argv[4], &siglen)) || !(data = crypto_bytes(ctx, argv[5], &len)))
    goto end;

  if(siglen != 2 * c.size) {
    ret = JS_FALSE;
    goto end;
  }

  if(!(pkey = crypto_pkey(ctx, &c, 0, pub)))
    goto end;

  /* P1363 r||s to the DER the EVP API expects */
  if(!(sig = ECDSA_SIG_new()) || !(r = BN_bin2bn(sigb, c.size, 0)) || !(s = BN_bin2bn(sigb + c.size, c.size, 0)) || !ECDSA_SIG_set0(sig, r, s)) {
    BN_free(r);
    BN_free(s);
    crypto_throw_ssl(ctx, "ECDSA_SIG_set0");
    goto end;
  }

  if((derlen = i2d_ECDSA_SIG(sig, &der)) <= 0 || !(mc = EVP_MD_CTX_new()) || EVP_DigestVerifyInit(mc, 0, md, 0, pkey) != 1) {
    crypto_throw_ssl(ctx, "EVP_DigestVerifyInit");
    goto end;
  }

  ret = JS_NewBool(ctx, EVP_DigestVerify(mc, der, derlen, data, len) == 1);
  ERR_clear_error();

end:
  ECDSA_SIG_free(sig);
  OPENSSL_free(der);
  EVP_MD_CTX_free(mc);
  EVP_PKEY_free(pkey);
  EC_GROUP_free(c.group);
  return ret;
}

/* ---- key derivation ---------------------------------------------------
   pbkdf2, hkdf and scrypt go through EVP_KDF. Argon2id is implemented
   here (RFC 9106, version 0x13) because EVP_KDF only has ARGON2 from
   OpenSSL 3.2 and 3.0 is still common. Lanes are filled one after the
   other, which gives the same hash as a threaded run. */

static int
crypto_opt_u32(JSContext* ctx, JSValueConst obj, const char* name, uint32_t def, uint32_t* out) {
  JSValue v = JS_IsObject(obj) ? js_get_property(ctx, obj, name) : JS_UNDEFINED;
  int ret = 0;

  *out = def;

  if(!JS_IsUndefined(v) && JS_ToUint32(ctx, out, v))
    ret = -1;

  JS_FreeValue(ctx, v);
  return ret;
}

/* Runs the KDF `name` with `params` and returns `len` bytes as ArrayBuffer */
static JSValue
crypto_kdf(JSContext* ctx, const char* name, OSSL_PARAM* params, size_t len) {
  EVP_KDF* kdf = EVP_KDF_fetch(0, name, 0);
  EVP_KDF_CTX* kc = kdf ? EVP_KDF_CTX_new(kdf) : 0;
  uint8_t* out = len ? js_malloc(ctx, len) : 0;
  JSValue ret;

  if(!len || !out) {
    EVP_KDF_CTX_free(kc);
    EVP_KDF_free(kdf);
    return len ? JS_EXCEPTION : JS_ThrowRangeError(ctx, "length must be positive");
  }

  if(kc && EVP_KDF_derive(kc, out, len, params) > 0)
    ret = JS_NewArrayBufferCopy(ctx, out, len);
  else
    ret = crypto_throw_ssl(ctx, name);

  OPENSSL_cleanse(out, len);
  js_free(ctx, out);
  EVP_KDF_CTX_free(kc);
  EVP_KDF_free(kdf);
  return ret;
}

static int
crypto_len(JSContext* ctx, JSValueConst value, size_t max, size_t* out) {
  uint32_t n;

  if(JS_ToUint32(ctx, &n, value))
    return -1;
  if(!n || n > max) {
    JS_ThrowRangeError(ctx, "length out of range");
    return -1;
  }
  *out = n;
  return 0;
}

/* pbkdf2(hashAlg, password, salt, iterations, length) -> ArrayBuffer */
static JSValue
lwsjs_crypto_pbkdf2(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  const EVP_MD* md;
  const uint8_t *pw, *salt;
  size_t pwlen, saltlen, len;
  uint32_t iter;
  int pkcs5 = 1;
  OSSL_PARAM params[6], *p = params;

  if(argc < 5)
    return JS_ThrowTypeError(ctx, "pbkdf2(hashAlg, password, salt, iterations, length)");
  if(!(md = crypto_md(ctx, argv[0])) || !(pw = crypto_bytes(ctx, argv[1], &pwlen)) || !(salt = crypto_bytes(ctx, argv[2], &saltlen)))
    return JS_EXCEPTION;
  if(JS_ToUint32(ctx, &iter, argv[3]) || crypto_len(ctx, argv[4], 1 << 24, &len))
    return JS_EXCEPTION;
  if(!iter)
    return JS_ThrowRangeError(ctx, "iterations must be positive");

  *p++ = OSSL_PARAM_construct_utf8_string(OSSL_KDF_PARAM_DIGEST, (char*)EVP_MD_get0_name(md), 0);
  *p++ = OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_PASSWORD, (void*)pw, pwlen);
  *p++ = OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_SALT, (void*)salt, saltlen);
  *p++ = OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_ITER, &iter);
  *p++ = OSSL_PARAM_construct_int(OSSL_KDF_PARAM_PKCS5, &pkcs5);
  *p = OSSL_PARAM_construct_end();

  return crypto_kdf(ctx, "PBKDF2", params, len);
}

/* hkdf(hashAlg, key, salt, info, length) -> ArrayBuffer */
static JSValue
lwsjs_crypto_hkdf(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  const EVP_MD* md;
  const uint8_t *key, *salt, *info;
  size_t keylen, saltlen, infolen, len;
  int mode = EVP_KDF_HKDF_MODE_EXTRACT_AND_EXPAND;
  OSSL_PARAM params[7], *p = params;

  if(argc < 5)
    return JS_ThrowTypeError(ctx, "hkdf(hashAlg, key, salt, info, length)");
  if(!(md = crypto_md(ctx, argv[0])) || !(key = crypto_bytes(ctx, argv[1], &keylen)) || !(salt = crypto_bytes(ctx, argv[2], &saltlen)) ||
     !(info = crypto_bytes(ctx, argv[3], &infolen)))
    return JS_EXCEPTION;
  if(crypto_len(ctx, argv[4], 255 * (size_t)EVP_MD_get_size(md), &len))
    return JS_EXCEPTION;

  *p++ = OSSL_PARAM_construct_int(OSSL_KDF_PARAM_MODE, &mode);
  *p++ = OSSL_PARAM_construct_utf8_string(OSSL_KDF_PARAM_DIGEST, (char*)EVP_MD_get0_name(md), 0);
  *p++ = OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_KEY, (void*)key, keylen);
  *p++ = OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_SALT, (void*)salt, saltlen);
  *p++ = OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_INFO, (void*)info, infolen);
  *p = OSSL_PARAM_construct_end();

  return crypto_kdf(ctx, "HKDF", params, len);
}

/* scrypt(password, salt, { N, r, p, length }) -> ArrayBuffer */
static JSValue
lwsjs_crypto_scrypt(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  const uint8_t *pw, *salt;
  size_t pwlen, saltlen, len;
  uint32_t n, r, par, l;
  uint64_t N, maxmem;
  OSSL_PARAM params[8], *p = params;

  if(argc < 2)
    return JS_ThrowTypeError(ctx, "scrypt(password, salt, { N, r, p, length })");
  if(!(pw = crypto_bytes(ctx, argv[0], &pwlen)) || !(salt = crypto_bytes(ctx, argv[1], &saltlen)))
    return JS_EXCEPTION;

  if(crypto_opt_u32(ctx, argc > 2 ? argv[2] : JS_UNDEFINED, "N", 16384, &n) || crypto_opt_u32(ctx, argc > 2 ? argv[2] : JS_UNDEFINED, "r", 8, &r) ||
     crypto_opt_u32(ctx, argc > 2 ? argv[2] : JS_UNDEFINED, "p", 1, &par) ||
     crypto_opt_u32(ctx, argc > 2 ? argv[2] : JS_UNDEFINED, "length", 64, &l))
    return JS_EXCEPTION;
  if(crypto_len(ctx, JS_NewUint32(ctx, l), 1 << 24, &len))
    return JS_EXCEPTION;
  if(n < 2 || (n & (n - 1)) || !r || !par)
    return JS_ThrowRangeError(ctx, "scrypt: N must be a power of two >= 2, r and p positive");

  N = n;
  /* OpenSSL's default memory cap is 32 MiB; allow what the cost asks for */
  maxmem = 128ull * r * (N + par + 2) + (1u << 20);

  *p++ = OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_PASSWORD, (void*)pw, pwlen);
  *p++ = OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_SALT, (void*)salt, saltlen);
  *p++ = OSSL_PARAM_construct_uint64(OSSL_KDF_PARAM_SCRYPT_N, &N);
  *p++ = OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_SCRYPT_R, &r);
  *p++ = OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_SCRYPT_P, &par);
  *p++ = OSSL_PARAM_construct_uint64(OSSL_KDF_PARAM_SCRYPT_MAXMEM, &maxmem);
  *p = OSSL_PARAM_construct_end();

  return crypto_kdf(ctx, "SCRYPT", params, len);
}

/* BLAKE2b (RFC 7693), unkeyed, 1..64 byte output */
typedef struct {
  uint64_t h[8], t;
  uint8_t buf[128];
  size_t n, outlen;
} Blake2b;

static const uint64_t blake2b_iv[8] = {
    0x6a09e667f3bcc908ull, 0xbb67ae8584caa73bull, 0x3c6ef372fe94f82bull, 0xa54ff53a5f1d36f1ull,
    0x510e527fade682d1ull, 0x9b05688c2b3e6c1full, 0x1f83d9abfb41bd6bull, 0x5be0cd19137e2179ull,
};

static const uint8_t blake2b_sigma[12][16] = {
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}, {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
    {11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4}, {7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8},
    {9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13}, {2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9},
    {12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11}, {13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10},
    {6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5}, {10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0},
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}, {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
};

#define ROTR64(x, n) (((x) >> (n)) | ((x) << (64 - (n))))

static uint64_t
load64le(const uint8_t* p) {
  uint64_t v = 0;
  for(int i = 7; i >= 0; i--)
    v = (v << 8) | p[i];
  return v;
}

static void
store64le(uint8_t* p, uint64_t v) {
  for(int i = 0; i < 8; i++, v >>= 8)
    p[i] = v & 0xff;
}

static void
blake2b_compress(Blake2b* b, const uint8_t* block, int last) {
  uint64_t m[16], v[16];

  for(int i = 0; i < 16; i++)
    m[i] = load64le(block + 8 * i);
  for(int i = 0; i < 8; i++)
    v[i] = b->h[i], v[i + 8] = blake2b_iv[i];

  v[12] ^= b->t;
  if(last)
    v[14] = ~v[14];

#define B2G(a, b_, c, d, x, y) \
  do { \
    v[a] += v[b_] + (x); \
    v[d] = ROTR64(v[d] ^ v[a], 32); \
    v[c] += v[d]; \
    v[b_] = ROTR64(v[b_] ^ v[c], 24); \
    v[a] += v[b_] + (y); \
    v[d] = ROTR64(v[d] ^ v[a], 16); \
    v[c] += v[d]; \
    v[b_] = ROTR64(v[b_] ^ v[c], 63); \
  } while(0)

  for(int r = 0; r < 12; r++) {
    const uint8_t* s = blake2b_sigma[r];
    B2G(0, 4, 8, 12, m[s[0]], m[s[1]]);
    B2G(1, 5, 9, 13, m[s[2]], m[s[3]]);
    B2G(2, 6, 10, 14, m[s[4]], m[s[5]]);
    B2G(3, 7, 11, 15, m[s[6]], m[s[7]]);
    B2G(0, 5, 10, 15, m[s[8]], m[s[9]]);
    B2G(1, 6, 11, 12, m[s[10]], m[s[11]]);
    B2G(2, 7, 8, 13, m[s[12]], m[s[13]]);
    B2G(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
#undef B2G

  for(int i = 0; i < 8; i++)
    b->h[i] ^= v[i] ^ v[i + 8];
}

static void
blake2b_init(Blake2b* b, size_t outlen) {
  memset(b, 0, sizeof(*b));
  memcpy(b->h, blake2b_iv, sizeof(b->h));
  b->h[0] ^= 0x01010000 ^ outlen;
  b->outlen = outlen;
}

static void
blake2b_update(Blake2b* b, const void* in, size_t len) {
  const uint8_t* p = in;

  while(len) {
    if(b->n == 128) {
      b->t += 128;
      blake2b_compress(b, b->buf, 0);
      b->n = 0;
    }
    size_t k = 128 - b->n < len ? 128 - b->n : len;
    memcpy(b->buf + b->n, p, k);
    b->n += k, p += k, len -= k;
  }
}

static void
blake2b_final(Blake2b* b, uint8_t* out) {
  uint8_t full[64];

  b->t += b->n;
  memset(b->buf + b->n, 0, 128 - b->n);
  blake2b_compress(b, b->buf, 1);

  for(int i = 0; i < 8; i++)
    store64le(full + 8 * i, b->h[i]);
  memcpy(out, full, b->outlen);
}

/* Argon2 H': variable-length hash of in1||in2 */
static void
argon2_hprime(uint8_t* out, size_t outlen, const void* in, size_t inlen) {
  Blake2b b;
  uint8_t le[4] = {outlen & 0xff, (outlen >> 8) & 0xff, (outlen >> 16) & 0xff, outlen >> 24}, v[64];

  if(outlen <= 64) {
    blake2b_init(&b, outlen);
    blake2b_update(&b, le, 4);
    blake2b_update(&b, in, inlen);
    blake2b_final(&b, out);
    return;
  }

  blake2b_init(&b, 64);
  blake2b_update(&b, le, 4);
  blake2b_update(&b, in, inlen);
  blake2b_final(&b, v);
  memcpy(out, v, 32);
  out += 32, outlen -= 32;

  while(outlen > 64) {
    blake2b_init(&b, 64);
    blake2b_update(&b, v, 64);
    blake2b_final(&b, v);
    memcpy(out, v, 32);
    out += 32, outlen -= 32;
  }

  blake2b_init(&b, outlen);
  blake2b_update(&b, v, 64);
  blake2b_final(&b, out);
}

#define ARGON2_BLOCK_WORDS 128

typedef uint64_t Argon2Block[ARGON2_BLOCK_WORDS];

static uint64_t
argon2_mka(uint64_t x, uint64_t y) {
  return x + y + 2 * (x & 0xffffffffull) * (y & 0xffffffffull);
}

#define A2G(a, b, c, d) \
  do { \
    a = argon2_mka(a, b); \
    d = ROTR64(d ^ a, 32); \
    c = argon2_mka(c, d); \
    b = ROTR64(b ^ c, 24); \
    a = argon2_mka(a, b); \
    d = ROTR64(d ^ a, 16); \
    c = argon2_mka(c, d); \
    b = ROTR64(b ^ c, 63); \
  } while(0)

#define A2P(v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15) \
  do { \
    A2G(v0, v4, v8, v12); \
    A2G(v1, v5, v9, v13); \
    A2G(v2, v6, v10, v14); \
    A2G(v3, v7, v11, v15); \
    A2G(v0, v5, v10, v15); \
    A2G(v1, v6, v11, v12); \
    A2G(v2, v7, v8, v13); \
    A2G(v3, v4, v9, v14); \
  } while(0)

/* next = G(prev, ref), xored into the old next when `xor_next` */
static void
argon2_fill_block(const Argon2Block prev, const Argon2Block ref, Argon2Block next, int xor_next) {
  Argon2Block R, T;

  for(int i = 0; i < ARGON2_BLOCK_WORDS; i++)
    R[i] = ref[i] ^ prev[i], T[i] = xor_next ? R[i] ^ next[i] : R[i];

  for(int i = 0; i < 8; i++)
    A2P(R[16 * i], R[16 * i + 1], R[16 * i + 2], R[16 * i + 3], R[16 * i + 4], R[16 * i + 5], R[16 * i + 6], R[16 * i + 7], R[16 * i + 8],
        R[16 * i + 9], R[16 * i + 10], R[16 * i + 11], R[16 * i + 12], R[16 * i + 13], R[16 * i + 14], R[16 * i + 15]);

  for(int i = 0; i < 8; i++)
    A2P(R[2 * i], R[2 * i + 1], R[2 * i + 16], R[2 * i + 17], R[2 * i + 32], R[2 * i + 33], R[2 * i + 48], R[2 * i + 49], R[2 * i + 64],
        R[2 * i + 65], R[2 * i + 80], R[2 * i + 81], R[2 * i + 96], R[2 * i + 97], R[2 * i + 112], R[2 * i + 113]);

  for(int i = 0; i < ARGON2_BLOCK_WORDS; i++)
    next[i] = T[i] ^ R[i];
}

static void
argon2_next_addresses(Argon2Block address, Argon2Block input) {
  static const Argon2Block zero = {0};

  input[6]++;
  argon2_fill_block(zero, input, address, 0);
  argon2_fill_block(zero, address, address, 0);
}

/* argon2id: raw hash of `len` bytes. m in KiB. Returns 0, or -1 when memory
   cannot be allocated. */
static int
argon2id_hash(uint8_t* out, uint32_t len, const uint8_t* pw, size_t pwlen, const uint8_t* salt, size_t saltlen, uint32_t m, uint32_t t, uint32_t lanes) {
  Argon2Block *mem, address, input;
  uint32_t lane_len, seg_len, total;
  uint8_t h0[72], init[64];
  Blake2b b;
  uint32_t u[6] = {lanes, len, m, t, 0x13, 2};

  total = m / (4 * lanes) * (4 * lanes);
  lane_len = total / lanes;
  seg_len = lane_len / 4;

  if(!(mem = malloc((size_t)total * sizeof(Argon2Block))))
    return -1;

  blake2b_init(&b, 64);
  for(int i = 0; i < 6; i++) {
    uint8_t le[4] = {u[i] & 0xff, (u[i] >> 8) & 0xff, (u[i] >> 16) & 0xff, u[i] >> 24};
    blake2b_update(&b, le, 4);
  }
  for(int i = 0; i < 2; i++) {
    const uint8_t* d = i ? salt : pw;
    size_t n = i ? saltlen : pwlen;
    uint8_t le[4] = {n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >> 24};
    blake2b_update(&b, le, 4);
    blake2b_update(&b, d, n);
  }
  memset(init, 0, 8); /* empty secret and associated data: two zero lengths */
  blake2b_update(&b, init, 8);
  blake2b_final(&b, h0);

  for(uint32_t l = 0; l < lanes; l++)
    for(uint32_t k = 0; k < 2; k++) {
      uint8_t blk[1024];
      h0[64] = k, h0[65] = h0[66] = h0[67] = 0;
      h0[68] = l & 0xff, h0[69] = (l >> 8) & 0xff, h0[70] = (l >> 16) & 0xff, h0[71] = l >> 24;
      argon2_hprime(blk, 1024, h0, 72);
      for(int i = 0; i < ARGON2_BLOCK_WORDS; i++)
        mem[l * lane_len + k][i] = load64le(blk + 8 * i);
    }

  for(uint32_t pass = 0; pass < t; pass++)
    for(uint32_t slice = 0; slice < 4; slice++)
      for(uint32_t l = 0; l < lanes; l++) {
        int independent = pass == 0 && slice < 2;
        uint32_t start = 0, curr, prev;

        if(independent) {
          memset(input, 0, sizeof(input));
          input[0] = pass, input[1] = l, input[2] = slice, input[3] = total, input[4] = t, input[5] = 2;
        }
        if(pass == 0 && slice == 0) {
          start = 2;
          if(independent)
            argon2_next_addresses(address, input);
        }

        curr = l * lane_len + slice * seg_len + start;
        prev = curr % lane_len == 0 ? curr + lane_len - 1 : curr - 1;

        for(uint32_t i = start; i < seg_len; i++, curr++, prev++) {
          uint64_t rnd, rel, area;
          uint32_t ref_lane, ref_index, first;

          if(curr % lane_len == 1)
            prev = curr - 1;

          if(independent) {
            if(i % ARGON2_BLOCK_WORDS == 0)
              argon2_next_addresses(address, input);
            rnd = address[i % ARGON2_BLOCK_WORDS];
          } else
            rnd = mem[prev][0];

          ref_lane = pass == 0 && slice == 0 ? l : (uint32_t)((rnd >> 32) % lanes);

          if(pass == 0) {
            if(slice == 0)
              area = i - 1;
            else if(ref_lane == l)
              area = slice * seg_len + i - 1;
            else
              area = slice * seg_len - (i == 0);
          } else if(ref_lane == l)
            area = lane_len - seg_len + i - 1;
          else
            area = lane_len - seg_len - (i == 0);

          rel = rnd & 0xffffffffull;
          rel = (rel * rel) >> 32;
          rel = area - 1 - ((area * rel) >> 32);
          first = pass == 0 || slice == 3 ? 0 : (slice + 1) * seg_len;
          ref_index = (first + rel) % lane_len;

          argon2_fill_block(mem[prev], mem[ref_lane * lane_len + ref_index], mem[curr], pass > 0);
        }
      }

  {
    Argon2Block c;
    uint8_t blk[1024];

    memcpy(c, mem[lane_len - 1], sizeof(c));
    for(uint32_t l = 1; l < lanes; l++)
      for(int i = 0; i < ARGON2_BLOCK_WORDS; i++)
        c[i] ^= mem[l * lane_len + lane_len - 1][i];
    for(int i = 0; i < ARGON2_BLOCK_WORDS; i++)
      store64le(blk + 8 * i, c[i]);
    argon2_hprime(out, len, blk, 1024);
    OPENSSL_cleanse(blk, sizeof(blk));
    OPENSSL_cleanse(c, sizeof(c));
  }

  OPENSSL_cleanse(mem, (size_t)total * sizeof(Argon2Block));
  free(mem);
  return 0;
}

/* argon2id(password, salt, { memoryCost, timeCost, parallelism, hashLength })
   -> ArrayBuffer. Defaults as Bun.password: 65536 KiB, 2, 1, 32. */
static JSValue
lwsjs_crypto_argon2id(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  const uint8_t *pw, *salt;
  size_t pwlen, saltlen;
  uint32_t m, t, par, len;
  JSValueConst opts = argc > 2 ? argv[2] : JS_UNDEFINED;
  uint8_t* out;
  JSValue ret;

  if(argc < 2)
    return JS_ThrowTypeError(ctx, "argon2id(password, salt, { memoryCost, timeCost, parallelism, hashLength })");
  if(!(pw = crypto_bytes(ctx, argv[0], &pwlen)) || !(salt = crypto_bytes(ctx, argv[1], &saltlen)))
    return JS_EXCEPTION;
  if(crypto_opt_u32(ctx, opts, "memoryCost", 65536, &m) || crypto_opt_u32(ctx, opts, "timeCost", 2, &t) ||
     crypto_opt_u32(ctx, opts, "parallelism", 1, &par) || crypto_opt_u32(ctx, opts, "hashLength", 32, &len))
    return JS_EXCEPTION;

  if(saltlen < 8)
    return JS_ThrowRangeError(ctx, "argon2id: salt must be at least 8 bytes");
  if(len < 4 || len > (1 << 24))
    return JS_ThrowRangeError(ctx, "argon2id: hashLength must be 4..16777216");
  if(!t)
    return JS_ThrowRangeError(ctx, "argon2id: timeCost must be positive");
  if(!par || par > 0xffffff)
    return JS_ThrowRangeError(ctx, "argon2id: parallelism must be 1..16777215");
  if(m < 8 * par || m > (1u << 22))
    return JS_ThrowRangeError(ctx, "argon2id: memoryCost must be 8*parallelism..4194304 KiB");

  if(!(out = js_malloc(ctx, len)))
    return JS_EXCEPTION;

  if(argon2id_hash(out, len, pw, pwlen, salt, saltlen, m, t, par))
    ret = JS_ThrowRangeError(ctx, "argon2id: out of memory");
  else
    ret = JS_NewArrayBufferCopy(ctx, out, len);

  OPENSSL_cleanse(out, len);
  js_free(ctx, out);
  return ret;
}

static const JSCFunctionListEntry lwsjs_crypto_funcs[] = {
    JS_CFUNC_DEF("digest", 2, lwsjs_crypto_digest),
    JS_CFUNC_DEF("hmac", 3, lwsjs_crypto_hmac),
    JS_CFUNC_DEF("ecGenerateKey", 1, lwsjs_crypto_ec_generate_key),
    JS_CFUNC_DEF("ecPublicKey", 2, lwsjs_crypto_ec_public_key),
    JS_CFUNC_DEF("ecValidatePoint", 3, lwsjs_crypto_ec_validate_point),
    JS_CFUNC_DEF("ecSign", 4, lwsjs_crypto_ec_sign),
    JS_CFUNC_DEF("ecVerify", 6, lwsjs_crypto_ec_verify),
    JS_CFUNC_DEF("pbkdf2", 5, lwsjs_crypto_pbkdf2),
    JS_CFUNC_DEF("hkdf", 5, lwsjs_crypto_hkdf),
    JS_CFUNC_DEF("scrypt", 3, lwsjs_crypto_scrypt),
    JS_CFUNC_DEF("argon2id", 3, lwsjs_crypto_argon2id),
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "LWSCrypto", JS_PROP_CONFIGURABLE),
};

JSValue
lwsjs_crypto_object(JSContext* ctx) {
  JSValue obj = JS_NewObject(ctx);

  JS_SetPropertyFunctionList(ctx, obj, lwsjs_crypto_funcs, countof(lwsjs_crypto_funcs));
  return obj;
}

#else

JSValue
lwsjs_crypto_object(JSContext* ctx) {
  /* no OpenSSL 3: export an empty object so `import { crypto }` still works */
  return JS_NewObject(ctx);
}

#endif
