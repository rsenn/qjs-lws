#include "lws-crypto.h"
#include "js-utils.h"
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

static const JSCFunctionListEntry lwsjs_crypto_funcs[] = {
    JS_CFUNC_DEF("digest", 2, lwsjs_crypto_digest),
    JS_CFUNC_DEF("hmac", 3, lwsjs_crypto_hmac),
    JS_CFUNC_DEF("ecGenerateKey", 1, lwsjs_crypto_ec_generate_key),
    JS_CFUNC_DEF("ecPublicKey", 2, lwsjs_crypto_ec_public_key),
    JS_CFUNC_DEF("ecValidatePoint", 3, lwsjs_crypto_ec_validate_point),
    JS_CFUNC_DEF("ecSign", 4, lwsjs_crypto_ec_sign),
    JS_CFUNC_DEF("ecVerify", 6, lwsjs_crypto_ec_verify),
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
